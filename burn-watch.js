#!/usr/bin/env node
/**
 * claude-code-burn-watch
 *
 * Pings you on Discord when one Claude Code session suddenly starts burning tokens,
 * or launches a fork, so you can stop it before it eats your usage limits.
 *
 * It reads the transcripts Claude Code already writes (~/.claude/projects/<project>/<session>.jsonl),
 * continuing from where it stopped last time, adds up tokens per session per hour, and compares
 * each session's last hour with that same session's average hour over the day before.
 * It never calls Claude or any other API. The only request it makes is to your Discord webhook.
 *
 *   node burn-watch.js            check once (schedule it every 15 minutes)
 *   node burn-watch.js --loop     keep running and check every 10 minutes
 *   node burn-watch.js --report   print the current numbers, send nothing
 *   node burn-watch.js --test     send a test message to the webhook
 *
 * MIT License. Unofficial, not affiliated with Anthropic.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const H = 3600e3;
const KEEP_H = 26;                            // hourly buckets kept: this hour, the last one, a 24-hour baseline
const FIRST_READ_BYTES = 200 * 1024 * 1024;   // a file seen for the first time: read only its last 200 MB
const CHUNK_BYTES = 16 * 1024 * 1024;
const LOOP_MS = 10 * 60e3;
const LABEL_CHARS = 30;
const NEWLINE = 0x0a;

const HELP = `claude-code-burn-watch: a Discord ping when one Claude Code session suddenly burns tokens

Usage: node burn-watch.js [--report | --loop | --test] [--labels] [--projects DIR] [--state FILE]

  (no option)      check once, alert if needed (schedule it every 15 minutes)
  --loop           keep running, check every 10 minutes
  --report         print the current numbers, send nothing
  --test           send a test message to the webhook
  --labels         add the first ${LABEL_CHARS} characters of each session's first prompt to alerts
  --projects DIR   transcripts folder (default: $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects)
  --state FILE     this tool's state (default: ~/.claude-code-burn-watch/state.json)

Settings (environment variables, or a .env file next to burn-watch.js):
  BURN_WATCH_DISCORD_WEBHOOK   Discord webhook URL (without it, alerts are printed)
  BURN_WATCH_RATIO             a session's last hour vs its usual hour (default 3)
  BURN_WATCH_SESSION_FLOOR     ...and at least this many tokens (default 30000000)
  BURN_WATCH_TOTAL_FLOOR       all sessions together, same ratio, this floor (default 150000000)
  BURN_WATCH_COOLDOWN_HOURS    at most one alert per session per this many hours (default 3)
  BURN_WATCH_FORK_ALERT        0 = no alert when a session launches a fork (default 1)
  BURN_WATCH_LABELS            1 = same as --labels (default 0)
  BURN_WATCH_PROJECTS          same as --projects
  BURN_WATCH_STATE             same as --state
`;

// ---------- settings ----------

// Tiny .env reader: KEY=value per line. Variables already set in the environment win.
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function readNumber(name, def) {
  const v = (process.env[name] || '').trim();
  if (!v) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number >= 0, got "${v}"`);
  return n;
}

function readFlag(name, def) {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (!v) return def;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`${name} must be 1 or 0, got "${process.env[name]}"`);
}

function config(opts = {}) {
  const env = process.env;
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return {
    projects: path.resolve(opts.projects || env.BURN_WATCH_PROJECTS || path.join(claudeDir, 'projects')),
    state: path.resolve(opts.state || env.BURN_WATCH_STATE || path.join(os.homedir(), '.claude-code-burn-watch', 'state.json')),
    webhook: (env.BURN_WATCH_DISCORD_WEBHOOK || '').trim(),
    labels: Boolean(opts.labels) || readFlag('BURN_WATCH_LABELS', false),
    forkAlert: readFlag('BURN_WATCH_FORK_ALERT', true),
    ratio: readNumber('BURN_WATCH_RATIO', 3),
    sessionFloor: readNumber('BURN_WATCH_SESSION_FLOOR', 3e7),
    totalFloor: readNumber('BURN_WATCH_TOTAL_FLOOR', 1.5e8),
    cooldown: readNumber('BURN_WATCH_COOLDOWN_HOURS', 3) * H,
    now: opts.now === undefined ? Date.now() : opts.now,
  };
}

function parseArgs(argv) {
  const opts = { mode: 'once', labels: false };
  const modes = { '--report': 'report', '--loop': 'loop', '--test': 'test', '--help': 'help', '-h': 'help' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (modes[a]) opts.mode = modes[a];
    else if (a === '--labels') opts.labels = true;
    else if (a === '--projects' || a === '--state') {
      if (!argv[i + 1]) throw new Error(`${a} needs a path`);
      opts[a.slice(2)] = argv[++i];
    } else throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

// ---------- reading transcripts ----------

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Claude Code names each project folder after its working directory, with separators and other
// punctuation turned into "-" (C:\Users\me\app -> C--Users-me-app, /home/me/app -> -home-me-app).
// Drop the home-folder part to keep names short. Anything else is shown as it is.
function projectName(dir, home = os.homedir()) {
  const homeDir = home.replace(/[^a-zA-Z0-9]/g, '-');
  const d = dir.toLowerCase(), h = homeDir.toLowerCase();
  if (d === h) return '~';
  if (d.startsWith(h + '-') && dir.length > homeDir.length + 1) return dir.slice(homeDir.length + 1);
  return dir;
}

// <project>/<session>.jsonl, and subagents at <project>/<session>/subagents/*.jsonl,
// which count toward their parent session.
function sessionKey(file, projectsDir) {
  const rel = path.relative(projectsDir, file).split(path.sep);
  const session = rel.length > 2 ? rel[1] : path.basename(file, '.jsonl');
  return `${projectName(rel[0])}/${session.slice(0, 8)}`;
}

// The first characters of a session's first prompt (only used with --labels).
function firstPrompt(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return ''; }
  const buf = Buffer.alloc(256 * 1024);
  let n = 0;
  try { n = fs.readSync(fd, buf, 0, buf.length, 0); } catch {} finally { fs.closeSync(fd); }
  for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.isMeta) continue;
    const c = e.message && e.message.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join('') : '';
    const t = text.replace(/\s+/g, ' ').trim();
    if (t) return Array.from(t).slice(0, LABEL_CHARS).join('');
  }
  return '';
}

// Read only what was appended since last time. A half-written last line waits for the next run.
// Lines are split on the newline byte, so multi-byte characters are never cut in half.
function readNew(file, st, onLine) {
  let size;
  try { size = fs.statSync(file).size; } catch { return; }
  const known = st.offsets[file];
  const fresh = known === undefined || known > size;            // new to us, or the file was rewritten
  const start = fresh ? Math.max(0, size - FIRST_READ_BYTES) : known;
  if (size <= start) { st.offsets[file] = size; return; }
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return; }
  let pos = start, carry = Buffer.alloc(0), skipFirst = start > 0 && fresh;   // started mid-line
  try {
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CHUNK_BYTES, size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      const end = data.lastIndexOf(NEWLINE);
      if (end < 0) { carry = Buffer.from(data); continue; }
      const lines = data.subarray(0, end).toString('utf8').split('\n');
      carry = Buffer.from(data.subarray(end + 1));
      if (skipFirst) { lines.shift(); skipFirst = false; }
      for (const line of lines) onLine(line);
    }
  } finally { fs.closeSync(fd); }
  st.offsets[file] = pos - carry.length;
}

// ---------- the check ----------

const fmt = n => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
  : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? Math.round(n / 1e3) + 'K'
  : String(Math.round(n));

async function check(cfg, { notify = true } = {}) {
  let st = { offsets: {}, buckets: {}, labels: {}, alerted: {} };
  try { st = { ...st, ...JSON.parse(fs.readFileSync(cfg.state, 'utf8')) }; } catch {}
  const now = cfg.now;
  const nowH = Math.floor(now / H);
  const minH = nowH - KEEP_H;

  const files = walk(cfg.projects);
  const exists = new Set(files);
  for (const f of Object.keys(st.offsets)) if (!exists.has(f)) delete st.offsets[f];

  for (const file of files) {
    let mtime;
    try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
    if (mtime < now - KEEP_H * H) { delete st.offsets[file]; continue; }
    const key = sessionKey(file, cfg.projects);
    const isSubagent = file.includes(`${path.sep}subagents${path.sep}`);
    if (cfg.labels && !st.labels[key] && !isSubagent) st.labels[key] = firstPrompt(file) || '?';
    const seen = new Set();
    readNew(file, st, line => {
      const isAgentCall = line.includes('"subagent_type"');
      if (!isAgentCall && !line.includes('"usage"')) return;      // cheap filter before JSON.parse
      let e;
      try { e = JSON.parse(line); } catch { return; }
      const m = e && e.type === 'assistant' && e.message;
      if (!m) return;
      const h = Math.floor(Date.parse(e.timestamp) / H);
      if (!(h >= minH)) return;                                    // too old, or no timestamp
      const hours = (st.buckets[key] = st.buckets[key] || {});
      const b = (hours[h] = hours[h] || { t: 0, fork: 0 });
      // A fork starts with a copy of the whole conversation, so every launch is counted.
      if (isAgentCall && Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c && c.type === 'tool_use' && c.input && String(c.input.subagent_type).toLowerCase() === 'fork') b.fork++;
        }
      }
      const u = m.usage;
      if (!u) return;
      // One API response is written as several lines (one per content block) carrying the same usage.
      const id = `${m.id || ''}:${e.requestId || ''}`;
      if (id !== ':') { if (seen.has(id)) return; seen.add(id); }
      b.t += (u.input_tokens || 0) + (u.output_tokens || 0)
        + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    });
  }

  for (const k of Object.keys(st.buckets)) {
    for (const h of Object.keys(st.buckets[k])) if (Number(h) < minH) delete st.buckets[k][h];
    if (!Object.keys(st.buckets[k]).length) { delete st.buckets[k]; delete st.labels[k]; }
  }
  const forget = Math.max(KEEP_H * H, cfg.cooldown);
  for (const k of Object.keys(st.alerted)) if (now - st.alerted[k] > forget) delete st.alerted[k];

  // "Last hour" = this clock hour + the part of the previous clock hour still inside the last 60 minutes.
  const frac = (now % H) / H;
  const tokens = (hours, h) => (hours[h] && hours[h].t) || 0;
  const forks = (hours, h) => (hours[h] && hours[h].fork) || 0;
  const rows = Object.entries(st.buckets).map(([key, hours]) => {
    let base = 0;
    for (let h = nowH - 25; h <= nowH - 2; h++) base += tokens(hours, h);
    return {
      key,
      label: st.labels[key] || '',
      recent: tokens(hours, nowH) + tokens(hours, nowH - 1) * (1 - frac),
      base: base / 24,
      fork: forks(hours, nowH) + forks(hours, nowH - 1),
    };
  }).sort((a, b) => b.recent - a.recent);
  const total = rows.reduce((a, r) => ({ recent: a.recent + r.recent, base: a.base + r.base }), { recent: 0, base: 0 });

  const alerts = [];
  if (notify) {
    if (total.recent >= cfg.totalFloor && total.recent >= cfg.ratio * Math.max(total.base, 1)
      && now - (st.alerted._total || 0) >= cfg.cooldown) {
      st.alerted._total = now;
      alerts.push(`- All sessions: last hour **${fmt(total.recent)}** tokens (usual ${fmt(total.base)}/h, ×${(total.recent / Math.max(total.base, 1)).toFixed(1)})`);
    }
    for (const r of rows) {
      const hot = r.recent >= cfg.sessionFloor && r.recent >= cfg.ratio * Math.max(r.base, 1);
      const forked = cfg.forkAlert && r.fork > 0;
      if (!hot && !forked) continue;
      if (now - (st.alerted[r.key] || 0) < cfg.cooldown) continue;
      st.alerted[r.key] = now;
      alerts.push(sessionLine(r, cfg.labels));
    }
  }

  fs.mkdirSync(path.dirname(cfg.state), { recursive: true });
  const tmp = `${cfg.state}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st));
  try { fs.renameSync(tmp, cfg.state); }
  catch { fs.writeFileSync(cfg.state, JSON.stringify(st)); fs.rmSync(tmp, { force: true }); }   // e.g. the file is busy on Windows

  const result = { total, rows, alerts, message: '' };
  if (!alerts.length) return result;
  result.message = `⚠️ **Claude Code usage spike**\n${alerts.join('\n')}\n`
    + '→ Check that session: Esc interrupts it, /tasks shows its background agents.';
  if (!cfg.webhook) { console.log(result.message); return result; }
  try { await postDiscord(cfg.webhook, result.message); }
  catch (e) { console.error(`Discord webhook failed (${e.message}). The alert was:\n${result.message}`); }
  return result;
}

function sessionLine(r, withLabel) {
  const label = withLabel && r.label && r.label !== '?' ? ` "${r.label}"` : '';
  const usual = r.base ? `usual ${fmt(r.base)}/h, ×${(r.recent / r.base).toFixed(1)}` : 'new session';
  const fork = r.fork ? ` · **${r.fork} fork${r.fork > 1 ? 's' : ''}**` : '';
  return `- \`${r.key}\`${label} last hour **${fmt(r.recent)}** tokens (${usual})${fork}`;
}

async function postDiscord(url, content) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // allowed_mentions: never ping anyone, even if a prompt label contains @everyone
    body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(15e3),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ---------- command line ----------

function printReport(res, withLabel) {
  console.log(`All sessions: ${fmt(res.total.recent)} tokens in the last hour (usual ${fmt(res.total.base)}/h)`);
  for (const r of res.rows.slice(0, 8)) {
    const label = withLabel && r.label && r.label !== '?' ? ` "${r.label}"` : '';
    const fork = r.fork ? `, ${r.fork} fork${r.fork > 1 ? 's' : ''}` : '';
    console.log(`  ${r.key}${label}: ${fmt(r.recent)} (usual ${fmt(r.base)}/h)${fork}`);
  }
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`${e.message}\n\n${HELP}`); return 2; }
  if (opts.mode === 'help') { console.log(HELP); return 0; }
  loadEnvFile(path.join(__dirname, '.env'));
  const cfg = config(opts);

  if (opts.mode === 'test') {
    if (!cfg.webhook) {
      console.error('BURN_WATCH_DISCORD_WEBHOOK is not set (in the environment or in .env next to burn-watch.js).');
      return 1;
    }
    await postDiscord(cfg.webhook, '✅ claude-code-burn-watch: test message. Alerts will show up here.');
    console.log('Test message sent.');
    return 0;
  }
  if (!fs.existsSync(cfg.projects)) console.error(`warning: no transcripts folder at ${cfg.projects} (use --projects)`);
  if (opts.mode === 'report') { printReport(await check(cfg, { notify: false }), cfg.labels); return 0; }
  if (opts.mode === 'loop') {
    const tick = () => check(config(opts), { notify: true }).catch(e => console.error(e));
    await tick();
    setInterval(tick, LOOP_MS);
    return null;                                                  // keep running
  }
  await check(cfg, { notify: true });
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => { if (code !== null) process.exitCode = code; },
    e => { console.error(e && e.message ? e.message : e); process.exitCode = 1; },
  );
}

module.exports = { check, config, projectName, sessionKey, fmt };
