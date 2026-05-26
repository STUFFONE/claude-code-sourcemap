# Root-Auto Enterprise Runtime

This layer turns the local root-auto build into an enterprise DeepSeek runtime.

It is intentionally implemented outside the minified `package/cli.js` bundle so the active local `claude` command can use it immediately:

- `bin/claude-root-auto` enables enterprise mode by default.
- `install-hooks.mjs` installs global Claude Code hooks idempotently.
- `enterprise-hook.mjs` records a project-local ledger and blocks lazy finalization.
- `doctor.mjs` reports local install health without printing secrets.

Project-local runtime files are written under `.claude/enterprise/` in the current working directory. They are ignored by this repository's `.gitignore`.

TodoWrite gate defaults to `CLAUDE_CODE_TODO_GATE=complex`: only complex, multi-file, or broad edit tasks are blocked for missing TodoWrite. Use `strict` to require TodoWrite for all execution tasks, or `off` to disable that specific gate.
