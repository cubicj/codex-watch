# codex-watch

Live-tail the newest Codex plugin background job log for the current git repo.

`codex-watch` is a zero-dependency terminal companion for the [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) Claude Code plugin. When Claude Code delegates work to a background Codex job, run `codex-watch` in that repo's terminal to follow the job's log live — and it keeps following across `--resume`.

![codex-watch following a background Codex job: a cancelled job, automatic switch to the new job, session info, colored command results, and the completion banner](https://raw.githubusercontent.com/cubicj/codex-watch/main/assets/screenshot.png)

## What It Does

- Resolves the git repo from the terminal's current working directory.
- Follows the newest job log written by the `openai/codex-plugin-cc` Claude Code plugin.
- Auto-switches when a `--resume` starts a newer job id, so a resumed run is picked up without restarting.
- Shows the job's model, reasoning effort, and sandbox under the header (from the Codex CLI session files in `$CODEX_HOME`, default `~/.codex`, falling back to the job record's resolved or requested settings).
- Shows the Codex thread ID when it becomes available, so the thread can be resumed later.
- Warns when a queued or running job points to a worker PID that no longer exists.
- Shows a dim `Thinking...` indicator for each reasoning stretch.
- Colorizes assistant messages, command status, file changes, and job events.
- Lists each applied file with its change type and a workspace-relative path when available.
- Prints a completion banner such as `✓ completed · <duration>` or `✗ <status> · <duration>`.
- Drops duplicate captured lines.
- Lists this repo's jobs with `--list` — newest first, with status, start time, duration, and summary.
- Pins the tail to one job with `--job <id>` (unique prefixes allowed) and exits after that job's completion banner.

## Requirements

- Node.js 18 or newer.
- The [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) Claude Code plugin producing background job logs.

`codex-watch` reads job state from `$CLAUDE_PLUGIN_DATA/state/...` or, by default, from every `~/.claude/plugins/data/*/state/` root.

## Install

Global install:

```sh
npm install -g @cubicj/codex-watch
codex-watch
```

From source:

```sh
git clone https://github.com/cubicj/codex-watch.git
cd codex-watch
npm link
codex-watch
```

You can also run it directly from the checkout:

```sh
node bin/codex-watch
```

Run `codex-watch` from inside the git repo whose Codex job you want to watch.

## Usage

```sh
codex-watch
codex-watch --once
codex-watch --list
codex-watch --job <id>
codex-watch --help
```

`codex-watch` starts in follow mode, tails the newest job, and keeps watching for newer jobs so a resumed Codex run switches automatically. `--once` renders the selected job once and exits. `--list` prints this repo's jobs, newest first, and exits. `--job <id>` pins the tail to one job (a unique id prefix works) and exits after its completion banner. `--help` prints usage.

Colors are enabled only on TTY output. Set `NO_COLOR=1` or pipe output to disable color.

## Recommended Setup

`codex-watch` is most useful as a live cockpit for background delegation with `openai/codex-plugin-cc`:

1. In Claude Code, delegate work to a Codex job in the background (for example a `--background` rescue or review) so Claude stays responsive.
2. In a second terminal opened at the repo root, run `codex-watch`. It scopes to that repo, tails the job's log as it streams, and prints the completion banner when the job finishes.
3. Steer by talking to Claude. If Claude cancels and resumes the job, `codex-watch` auto-switches to the new job id — no restart needed.

Because you invoke it once per session from the repo terminal, a short shell alias is handy if you reach for it often:

```sh
alias cw='codex-watch'
```

## License

[MIT](LICENSE)
