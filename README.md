# codex-watch

Live-tail the newest Codex plugin background job log for the current git repo.

## What It Does

- Resolves the git repo from the terminal's current working directory.
- Follows the newest job log written by the `openai/codex-plugin-cc` Claude Code plugin.
- Auto-switches when `--resume` starts a newer job id.
- Colorizes assistant messages, command status, file changes, and job events.
- Prints a completion banner such as `✓ completed · <duration>` or `✗ <status> · <duration>`.
- Drops duplicate captured lines.

## Requirements

- Node.js 18 or newer.
- The `openai/codex-plugin-cc` Claude Code plugin producing job logs.

`codex-watch` reads job state from `$CLAUDE_PLUGIN_DATA/state/...` or, by default, `~/.claude/plugins/data/codex-openai-codex/state/`.

## Install

Global install:

```sh
npm install -g codex-watch
codex-watch
```

From source:

```sh
git clone <repo-url>
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
codex-watch --help
```

`codex-watch` starts in follow mode, tails the newest job, and keeps watching for newer jobs so a resumed Codex run switches automatically. `--once` renders the current newest job once and exits. `--help` prints usage.

Colors are enabled only on TTY output. Set `NO_COLOR=1` or pipe output to disable color.
