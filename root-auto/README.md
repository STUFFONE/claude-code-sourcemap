# Claude Code Root-Auto Enterprise DeepSeek Build

This repository is marked as a local root-auto enterprise DeepSeek build.

Runtime behavior:
- `claude` launches this repository's `package/cli.js` through `bin/claude-root-auto`.
- `claude` enters Enterprise CEO mode by default. Use `claude --normal` to opt out for one run.
- Root `--dangerously-skip-permissions` is allowed when `CLAUDE_CODE_ROOT_AUTO=1`.
- Local tool permissions are force-allowed in root-auto mode.
- Enterprise hooks are installed into `~/.claude/settings.json` idempotently at startup.
- Project-local ledger, browser artifacts, and memory live under `.claude/enterprise/`.
- Default context window is `CLAUDE_CODE_CONTEXT_WINDOW=1000000`.
- Bash and PowerShell default timeouts are extended to 3 hours, max 6 hours.
- Long blocking shell commands can auto-background, including sleep commands in root-auto mode.
- Official self-update/install commands are disabled by the wrapper.
- Web policy defaults to hybrid: built-in WebSearch/WebFetch first, local Playwright browser fallback.
- Remote side effects remain explicit-only by software gate: push, publish, release, cloud/prod, and secret operations require direct current-turn user intent.

Local entrypoint:

```bash
claude
claude --normal
claude --status-root-auto
claude --doctor-root-auto
claude --browser-smoke
```

Useful environment switches:

```bash
export CLAUDE_CODE_CONTEXT_WINDOW=1000000
export CLAUDE_CODE_ENTERPRISE=1
export CLAUDE_CODE_ENTERPRISE_LEVEL=max
export CLAUDE_CODE_WEB_POLICY=hybrid
export CLAUDE_CODE_BROWSER_BACKEND=playwright
export CLAUDE_CODE_REMOTE_OPS=explicit
export BASH_DEFAULT_TIMEOUT_MS=10800000
export BASH_MAX_TIMEOUT_MS=21600000
export CLAUDE_CODE_COMPANY_MAX_AGENTS=6
export CLAUDE_CODE_GATE_MAX_RETRIES=3
```

Installed skills:
- `/super` reinforces Enterprise CEO Company Mode.
- `/normal` exits CEO Company Mode.
- `/company` reports operating status.
- `/board` refreshes the task board.
- `/root-auto-status` checks local install status without exposing secrets.

Browser tool:

```bash
root-auto-browser search "query"
root-auto-browser fetch "https://example.com"
root-auto-browser open "https://example.com"
root-auto-browser snapshot
root-auto-browser screenshot
```

Remote operations remain explicit-only by hook policy: push, publish, release, secret rotation, cloud/prod changes, and account operations require a direct user request.
