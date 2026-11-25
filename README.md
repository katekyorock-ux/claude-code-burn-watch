# claude-code-burn-watch

**A Discord ping when one Claude Code session suddenly starts burning tokens, or launches a fork.**

If you keep several Claude Code sessions running, one of them can quietly go into overdrive: a long
agent loop, a retry that keeps going, a fork that copies a huge conversation. Usually you find out when
you hit your usage limit. `claude-code-burn-watch` reads the transcripts Claude Code already writes and
tells you **which session** is spiking, while there is still time to stop it.

## Why

We run many sessions side by side. One day a forked agent used 14% of our weekly limit in five hours,
and we only found out afterwards. Most usage tools show totals, costs or forecasts when you look at
them. This one is for when you aren't looking.

## How it works

- Reads `~/.claude/projects/<project>/<session>.jsonl`, continuing from where it stopped last time.
- Adds up the tokens of every API response (input + output + cache writes + cache reads) per session,
  per hour. Subagent transcripts count toward their parent session.
- Compares each session's last hour with **that session's own** average hour over the 24 hours before.
- Alerts when:
  - a session's last hour is **3× its usual hour or more, and at least 30M tokens**, or
  - a session **launched a `fork`** (a fork starts with a copy of the whole conversation, so forking a
    long session is expensive), or
  - all sessions together are at 3× their usual hour or more, and at least 150M tokens.
- At most one alert per session every 3 hours.
- No Claude calls, no API key, no tmux, no dependencies. The only network request is the POST to your
  Discord webhook.

An alert looks like this in Discord:

```
⚠️ Claude Code usage spike
- code-my-app/3f2a9c1e last hour 45.0M tokens (usual 1.0M/h, ×45.0) · 1 fork
→ Check that session: Esc interrupts it, /tasks shows its background agents.
```

## Quick start

Needs Node.js 18 or newer.

```bash
git clone https://github.com/katekyorock-ux/claude-code-burn-watch
cd claude-code-burn-watch
node burn-watch.js --report      # the current numbers; sends nothing
```

Make a Discord webhook (channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL), then:

```bash
cp .env.example .env             # paste the webhook URL into .env
node burn-watch.js --test        # a test message should appear in Discord
```

Then put it on a schedule (below), or leave `node burn-watch.js --loop` running in a terminal
(it checks every 10 minutes).

## Run it on a schedule

**macOS / Linux (cron).** Run `node burn-watch.js --report` once first (it creates
`~/.claude-code-burn-watch/`), then add this with `crontab -e`:

```
*/15 * * * * /usr/local/bin/node /path/to/claude-code-burn-watch/burn-watch.js >> ~/.claude-code-burn-watch/burn-watch.log 2>&1
```

Use the node path that `which node` prints. Cron runs with almost no environment, so keep the webhook
in `.env`.

**Windows (Task Scheduler).**

```powershell
powershell -ExecutionPolicy Bypass -File windows\install-task.ps1
```

This registers a task named `claude-code-burn-watch` that runs every 15 minutes without opening a
window (through `windows\run-hidden.vbs`; `node` must be on your PATH). Output goes to
`%USERPROFILE%\.claude-code-burn-watch\burn-watch.log`. To remove it:

```powershell
Unregister-ScheduledTask -TaskName claude-code-burn-watch -Confirm:$false
```

VBScript is deprecated in Windows. If `wscript.exe` is not available on your machine, use `--loop`
instead.

## Settings

Environment variables, or a `.env` file next to `burn-watch.js`:

| Variable | Default | Meaning |
|---|---|---|
| `BURN_WATCH_DISCORD_WEBHOOK` | (none) | Discord webhook URL. Without it, alerts are printed instead. |
| `BURN_WATCH_RATIO` | `3` | Alert when a session's last hour is this many times its usual hour, |
| `BURN_WATCH_SESSION_FLOOR` | `30000000` | and at least this many tokens. |
| `BURN_WATCH_TOTAL_FLOOR` | `150000000` | The same check for all sessions together, with this floor. |
| `BURN_WATCH_COOLDOWN_HOURS` | `3` | At most one alert per session per this many hours. |
| `BURN_WATCH_FORK_ALERT` | `1` | `0` turns the fork alert off. |
| `BURN_WATCH_LABELS` | `0` | `1` adds the first 30 characters of each session's first prompt to alerts. Same as `--labels`. |
| `BURN_WATCH_PROJECTS` | `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects` | Where the transcripts are. Same as `--projects`. |
| `BURN_WATCH_STATE` | `~/.claude-code-burn-watch/state.json` | Where this tool keeps its read positions and hourly totals. Same as `--state`. |

The default floors are the ones we use with several sessions open all day. Token counts include cache
reads, which make up most of a long session, and plan limits are not published as token counts. So read
the numbers as "this session is doing 15× its normal", not as a share of your limit. `--report` shows
your usual numbers; set the floors from there.

## What leaves your machine

Only the alert text, and only to your webhook:

- the project folder name (Claude Code's folder for the working directory, with your home-folder part
  removed),
- the first 8 characters of the session ID,
- token counts and the number of forks.

Prompts are **not** sent unless you turn on `--labels` (or `BURN_WATCH_LABELS=1`), which adds the first
30 characters of each session's first prompt. Alerts never ping anyone (`allowed_mentions` is empty).

## Notes and caveats

- **Unofficial.** It reads Claude Code's transcript files, whose format is not documented and may change.
  Not affiliated with Anthropic.
- **Approximate.** "Last hour" is built from hourly buckets: this hour, plus the part of the previous
  hour that is still inside the last 60 minutes.
- **First run** reads up to the last 200 MB of each transcript changed in the past 26 hours. After that,
  only new lines.
- **New sessions** have no baseline yet, so only the floor applies to them.
- **Tested on Windows.** The code avoids platform-specific paths, but reports from macOS and Linux are
  welcome.

## Verify it works

```bash
npm test
```

`test.js` builds a fake transcript folder and a fake webhook on `127.0.0.1`. It checks that a spike and
a fork are reported once and not again during the cooldown, that a busy but steady session is not
reported, that subagent usage counts toward its parent, that repeated lines of one response are counted
once, that only new lines are read, and that prompts stay out of alerts unless `--labels` is on.

## License

MIT © TEAM ROCK
