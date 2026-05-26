---
name: root-auto-status
description: Check local root-auto Claude Code installation status without exposing secrets.
user-invocable: true
argument-hint: ""
---

Check and report the local root-auto installation status.

Useful commands:
- `command -v claude`
- `claude --version`
- `env | rg '^(CLAUDE_CODE_ROOT_AUTO|CLAUDE_CODE_CONTEXT_WINDOW|BASH_DEFAULT_TIMEOUT_MS|BASH_MAX_TIMEOUT_MS|CLAUDE_CODE_COMPANY_|IS_SANDBOX|CLAUDE_CODE_BUBBLEWRAP)='`
- `test -f /root/claude-code-sourcemap/package/cli.js && echo repo-cli-ok`

Never print auth tokens or secret-like environment variables. Redact any value that looks like a key, token, cookie, password, or credential.
