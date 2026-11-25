// npm test: runs burn-watch against a fake transcript folder and a fake Discord webhook on 127.0.0.1.
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

for (const k of Object.keys(process.env)) if (k.startsWith('BURN_WATCH_')) delete process.env[k];
const { check, config, projectName, fmt } = require('./burn-watch.js');

const H = 3600e3;
const NOW = Date.UTC(2026, 0, 15, 12, 30, 0);    // 12:30, so half of the 11:00 hour still counts as "last hour"
const nowH = Math.floor(NOW / H);
const at = (h, minute = 30) => h * H + minute * 60e3;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-watch-test-'));
const projects = path.join(tmp, 'projects');
const home = os.homedir().replace(/[^a-zA-Z0-9]/g, '-');   // a project under the home folder
const appDir = path.join(projects, `${home}-code-my-app`);
const otherDir = path.join(projects, '-srv-other');

let seq = 0;
const iso = ms => new Date(ms).toISOString();
const user = (ms, text) => [JSON.stringify({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: text } })];
// One API response = several transcript lines with the same message id and the same usage.
function reply(ms, total, { blocks = 3, tools = [] } = {}) {
  seq++;
  const usage = { input_tokens: 10, output_tokens: 990, cache_creation_input_tokens: 0, cache_read_input_tokens: total - 1000 };
  const line = content => JSON.stringify({
    type: 'assistant', requestId: `req_${seq}`, timestamp: iso(ms),
    message: { id: `msg_${seq}`, role: 'assistant', content, usage },
  });
  const out = [];
  for (let i = 0; i < blocks; i++) out.push(line([{ type: 'text', text: 'working on it' }]));
  for (const t of tools) out.push(line([{ type: 'tool_use', id: `tool_${seq}_${t}`, name: 'Agent', input: { subagent_type: t, prompt: 'go' } }]));
  return out;
}
function write(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.join('\n') + '\n');
  fs.utimesSync(file, NOW / 1000, NOW / 1000);
}

// Session A: about 1M tokens an hour all day, then 40M in the current hour, plus 5M from a subagent.
const fileA = path.join(appDir, 'aaaaaaaa-1111-4111-8111-111111111111.jsonl');
const linesA = user(at(nowH - 25, 10), 'please refactor the payment module and add tests for it');
for (let h = nowH - 25; h <= nowH - 2; h++) linesA.push(...reply(at(h), 1e6));
linesA.push(...reply(NOW - 60e3, 40e6));
write(fileA, linesA);
write(path.join(appDir, 'aaaaaaaa-1111-4111-8111-111111111111', 'subagents', 'agent-1.jsonl'), reply(NOW - 120e3, 5e6));

// Session B: busy but steady, 40M every hour. Over the floor, but not a spike.
const fileB = path.join(appDir, 'bbbbbbbb-2222-4222-8222-222222222222.jsonl');
const linesB = user(at(nowH - 25, 5), 'keep working through the backlog');
for (let h = nowH - 25; h <= nowH; h++) linesB.push(...reply(h === nowH ? NOW - 60e3 : at(h), 40e6));
write(fileB, linesB);

// Session C: small usage, but it launched one fork (and one ordinary subagent, which is not a fork).
const fileC = path.join(otherDir, 'cccccccc-3333-4333-8333-333333333333.jsonl');
write(fileC, [...user(NOW - 600e3, 'look into the flaky test'), ...reply(NOW - 300e3, 2000, { blocks: 1, tools: ['fork', 'Explore'] })]);

async function main() {
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { posts.push(JSON.parse(body)); res.writeHead(204); res.end(); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.BURN_WATCH_DISCORD_WEBHOOK = `http://127.0.0.1:${server.address().port}/webhook`;
  const ok = msg => console.log(`ok - ${msg}`);
  const state = path.join(tmp, 'state.json');
  const row = (res, key) => res.rows.find(r => r.key === key);
  const keyA = 'code-my-app/aaaaaaaa', keyB = 'code-my-app/bbbbbbbb', keyC = '-srv-other/cccccccc';

  try {
    // 1. First check: one Discord post with session A (spike) and session C (fork), not B.
    let res = await check(config({ projects, state, now: NOW }));
    assert.strictEqual(posts.length, 1, 'one webhook post');
    const text = posts[0].content;
    assert.deepStrictEqual(posts[0].allowed_mentions, { parse: [] }, 'alerts never ping anyone');
    assert.ok(text.includes(`\`${keyA}\``) && text.includes('**45.0M**') && text.includes('×45.0'), 'spike reported');
    assert.ok(text.includes(`\`${keyC}\``) && text.includes('**1 fork**'), 'fork reported');
    assert.ok(!text.includes('bbbbbbbb'), 'steady session not reported');
    assert.ok(!text.includes('payment'), 'no prompt text without --labels');
    assert.strictEqual(row(res, keyA).recent, 45e6, 'subagent counts toward its session; repeated lines counted once');
    assert.strictEqual(row(res, keyA).base, 1e6, 'baseline = average of the 24 hours before');
    assert.strictEqual(row(res, keyB).recent, 60e6, 'last hour = this hour + unexpired half of the previous hour');
    assert.strictEqual(row(res, keyC).fork, 1, 'only fork launches are counted');
    ok('spike and fork alerted, steady session and prompts left out');

    // 2. Same time again: nothing new is read, and the cooldown holds.
    res = await check(config({ projects, state, now: NOW }));
    assert.strictEqual(posts.length, 1, 'no second post during the cooldown');
    assert.strictEqual(row(res, keyA).recent, 45e6, 'nothing counted twice');
    ok('cooldown holds, no double counting');

    // 3. New lines are appended: only those are added.
    write(fileA, reply(NOW - 30e3, 1e6));
    res = await check(config({ projects, state, now: NOW }));
    assert.strictEqual(row(res, keyA).recent, 46e6, 'incremental read');
    assert.strictEqual(posts.length, 1, 'still in the cooldown');
    ok('reads only new lines');

    // 4. --report sends nothing.
    res = await check(config({ projects, state: path.join(tmp, 'state-report.json'), now: NOW }), { notify: false });
    assert.strictEqual(posts.length, 1, 'report mode does not post');
    assert.strictEqual(res.alerts.length, 0);
    ok('--report sends nothing');

    // 5. --labels adds the first 30 characters of the first prompt.
    await check(config({ projects, state: path.join(tmp, 'state-labels.json'), now: NOW, labels: true }));
    assert.strictEqual(posts.length, 2);
    assert.ok(posts[1].content.includes('"please refactor the payment mo"'), 'label = first 30 characters');
    ok('--labels adds the prompt snippet');

    // 6. BURN_WATCH_FORK_ALERT=0 drops the fork alert.
    process.env.BURN_WATCH_FORK_ALERT = '0';
    await check(config({ projects, state: path.join(tmp, 'state-nofork.json'), now: NOW }));
    delete process.env.BURN_WATCH_FORK_ALERT;
    assert.strictEqual(posts.length, 3);
    assert.ok(posts[2].content.includes(keyA) && !posts[2].content.includes(keyC), 'fork alert off');
    ok('fork alert can be turned off');

    // 7. Project folder names on Windows, macOS and Linux.
    assert.strictEqual(projectName('C--Users-alice-code-app', 'C:\\Users\\alice'), 'code-app');
    assert.strictEqual(projectName('c--users-alice-code-app', 'C:\\Users\\alice'), 'code-app');
    assert.strictEqual(projectName('-Users-alice-code-app', '/Users/alice'), 'code-app');
    assert.strictEqual(projectName('-home-alice-code-app', '/home/alice'), 'code-app');
    assert.strictEqual(projectName('-home-alice', '/home/alice'), '~');
    assert.strictEqual(projectName('-home-alicex-app', '/home/alice'), '-home-alicex-app');
    assert.strictEqual(projectName('-srv-app', '/home/alice'), '-srv-app');
    ok('project names on Windows, macOS and Linux');

    // 8. Number format.
    assert.deepStrictEqual([950, 12345, 45e6, 1.5e9].map(fmt), ['950', '12K', '45.0M', '1.5B']);
    ok('K / M / B');

    // 9. Bad settings are refused.
    process.env.BURN_WATCH_RATIO = 'three';
    assert.throws(() => config({ projects, state }), /BURN_WATCH_RATIO/);
    delete process.env.BURN_WATCH_RATIO;
    ok('bad settings are refused');

    console.log('PASS');
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
