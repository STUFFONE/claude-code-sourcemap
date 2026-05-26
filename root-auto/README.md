# Claude Code Root-Auto Super Build

This repository is marked as a local root-auto super build.

Runtime behavior:
- `claude` launches this repository's `package/cli.js` through `bin/claude-root-auto`.
- Root `--dangerously-skip-permissions` is allowed when `CLAUDE_CODE_ROOT_AUTO=1`.
- Local tool permissions are force-allowed in root-auto mode.
- Default context window is `CLAUDE_CODE_CONTEXT_WINDOW=1000000`.
- Bash and PowerShell default timeouts are extended to 3 hours, max 6 hours.
- Long blocking shell commands can auto-background, including sleep commands in root-auto mode.
- Official self-update/install commands are disabled by the wrapper.

Local entrypoint:

```bash
claude
claude --super
```

Useful environment switches:

```bash
export CLAUDE_CODE_CONTEXT_WINDOW=1000000
export BASH_DEFAULT_TIMEOUT_MS=10800000
export BASH_MAX_TIMEOUT_MS=21600000
export CLAUDE_CODE_COMPANY_MAX_AGENTS=6
```

Installed skills:
- `/super` enters CEO Company Mode.
- `/normal` exits CEO Company Mode.
- `/company` reports operating status.
- `/board` refreshes the task board.
- `/root-auto-status` checks local install status without exposing secrets.

Remote operations remain explicit-only by prompt policy: commit, push, release, secret rotation, and account operations require a direct user request.
