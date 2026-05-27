# Root-Auto Enterprise Runtime

This layer turns the local root-auto build into an enterprise DeepSeek runtime.

It is intentionally implemented outside the minified `package/cli.js` bundle so the active local `claude` command can use it immediately:

- `bin/claude-root-auto` enables enterprise mode by default.
- `install-hooks.mjs` installs global Claude Code hooks idempotently.
- `enterprise-hook.mjs` records a project-local ledger and blocks lazy finalization.
- `doctor.mjs` reports local install health without printing secrets.

Project-local runtime files are written under `.claude/enterprise/` in the current working directory. They are ignored by this repository's `.gitignore`.

Smart intent routing defaults to `CLAUDE_CODE_INTENT_ROUTER=smart`:

- `chat`, `local_status`, and `discussion` turns answer directly without random web lookup or TodoWrite gates.
- `creative_work` turns are treated as real work: the assistant must deliver complete content instead of saying it can write later.
- `research_work` turns and current/latest/external/version/API/docs facts require web or browser evidence.
- `engineering_work` turns require the engineering loop: TodoWrite for broad work, diff inspection, verification, and review for wide changes.

TodoWrite gate defaults to `CLAUDE_CODE_TODO_GATE=complex`: only complex, multi-file, or broad edit tasks are blocked for missing TodoWrite. Use `strict` to require TodoWrite for all execution tasks, or `off` to disable that specific gate.
