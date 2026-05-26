#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

const VERSION = '2.1.88-root-auto-enterprise-deepseek.1'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '../..')

function isTruthy(value) {
  if (value === undefined || value === null) return false
  return !/^(0|false|off|no)$/i.test(String(value))
}

function enterpriseEnabled() {
  return isTruthy(process.env.CLAUDE_CODE_ENTERPRISE ?? '1')
}

function readStdin() {
  return new Promise(resolveRead => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      data += chunk
    })
    process.stdin.on('end', () => resolveRead(data))
  })
}

function jsonOut(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function truncate(value, max = 4000) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text
}

function redactString(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, '[REDACTED_LONG_TOKEN]')
}

function redact(value, depth = 0) {
  if (depth > 8) return '[REDACTED_DEPTH]'
  if (typeof value === 'string') return redactString(truncate(value, 2000))
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redact(item, depth + 1))

  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (/(token|password|passwd|secret|authorization|api[_-]?key|auth[_-]?token|credential)/i.test(key)) {
      out[key] = '[REDACTED]'
    } else if (key === 'content' || key === 'new_string' || key === 'old_string') {
      out[key] = truncate(redactString(item), 800)
    } else {
      out[key] = redact(item, depth + 1)
    }
  }
  return out
}

function safeSessionId(input) {
  return String(input?.session_id || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)
}

function enterpriseDir(cwd) {
  return join(cwd || process.cwd(), '.claude', 'enterprise')
}

function ensureProjectFiles(cwd) {
  const dir = enterpriseDir(cwd)
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  mkdirSync(join(dir, 'browser-runs'), { recursive: true })
  if (!existsSync(join(dir, 'memory.md'))) {
    writeFileSync(join(dir, 'memory.md'), '# Enterprise Project Memory\n\n- Scope: project only.\n- Never store secrets or raw auth tokens here.\n', 'utf8')
  }
  if (!existsSync(join(dir, 'profile.json'))) {
    writeFileSync(
      join(dir, 'profile.json'),
      `${JSON.stringify({
        version: VERSION,
        repoType: 'unknown',
        testCommands: [],
        buildCommands: [],
        riskPolicy: {
          localOps: 'auto',
          remoteOps: process.env.CLAUDE_CODE_REMOTE_OPS || 'explicit',
          webPolicy: process.env.CLAUDE_CODE_WEB_POLICY || 'hybrid',
          browserBackend: process.env.CLAUDE_CODE_BROWSER_BACKEND || 'playwright',
        },
      }, null, 2)}\n`,
      'utf8',
    )
  }
  return dir
}

function statePath(input) {
  const dir = ensureProjectFiles(input.cwd)
  return join(dir, 'sessions', `${safeSessionId(input)}.json`)
}

function loadState(input) {
  const file = statePath(input)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {
      version: VERSION,
      session_id: input.session_id || 'unknown',
      turn: 0,
      current: null,
    }
  }
}

function saveState(input, state) {
  writeFileSync(statePath(input), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function appendLedger(input, event) {
  const dir = ensureProjectFiles(input.cwd)
  const line = {
    ts: new Date().toISOString(),
    version: VERSION,
    session_id: input.session_id || 'unknown',
    turn: event.turn ?? loadState(input).turn ?? 0,
    event: event.event,
    ...redact(event.data || {}),
  }
  appendFileSync(join(dir, 'ledger.jsonl'), `${JSON.stringify(line)}\n`, 'utf8')
}

function classifyPrompt(prompt) {
  const text = String(prompt || '')
  const lower = text.toLowerCase()
  const discussion =
    /(仅讨论|只讨论|先讨论|先评估|方案|计划|评估|分析|不要改|别改|不需要实现|暂时不需要)/.test(text) ||
    /\b(discuss|plan|evaluate|assess|review only|no changes|do not edit)\b/i.test(text)
  const execution =
    /(实现|修改|修复|写|弄|改|跑|执行|安装|提交|推送|上传|部署|生成|创建|接入|落地)/.test(text) ||
    /\b(implement|fix|change|edit|run|install|commit|push|deploy|create|build|wire|add)\b/i.test(text)
  const requiresWeb =
    /(最新|今天|现在|最近|联网|上网|查一下|搜索|验证|官网|官方文档|版本|价格|新闻|法律|法规|API|github|npm|pypi|release|current|latest|today|recent|search|browse|verify|official docs|documentation|version|pricing|news)/i.test(text)
  const complex =
    /(复杂|企业级|全套|超级|长期|多代理|并发|架构|内核|调度|系统|全面|接近百分百|complete|enterprise|architecture|scheduler|multi-agent|long-running)/i.test(text) ||
    text.length > 600
  const explicitRemote =
    /(推送|上传\s*github|提交并推送|发布|部署|release|git push|push to|publish|deploy)/i.test(text) ||
    /\b(push|publish|release|deploy)\b/i.test(lower)
  return {
    mode: discussion && !execution ? 'discussion' : execution ? 'execution' : 'mixed',
    execution,
    discussion,
    requiresWeb,
    complex,
    explicitRemote,
  }
}

function newTurn(input, prompt) {
  const state = loadState(input)
  state.version = VERSION
  state.session_id = input.session_id || state.session_id
  state.turn = (state.turn || 0) + 1
  state.current = {
    turn: state.turn,
    startedAt: new Date().toISOString(),
    prompt: truncate(redactString(prompt), 2000),
    ...classifyPrompt(prompt),
    changedFiles: [],
    editCount: 0,
    todoUsed: false,
    testRan: false,
    verificationRan: false,
    verificationFailed: false,
    diffViewed: false,
    webUsed: false,
    browserUsed: false,
    agentUsed: false,
    reviewerUsed: false,
    commandFailures: [],
    gateAttempts: 0,
  }
  saveState(input, state)
  appendLedger(input, { event: 'user_prompt', turn: state.turn, data: state.current })
  return state
}

function currentState(input) {
  const state = loadState(input)
  if (!state.current) {
    state.current = {
      turn: state.turn || 0,
      startedAt: new Date().toISOString(),
      prompt: '',
      mode: 'mixed',
      execution: false,
      discussion: false,
      requiresWeb: false,
      complex: false,
      explicitRemote: false,
      changedFiles: [],
      editCount: 0,
      todoUsed: false,
      testRan: false,
      verificationRan: false,
      verificationFailed: false,
      diffViewed: false,
      webUsed: false,
      browserUsed: false,
      agentUsed: false,
      reviewerUsed: false,
      commandFailures: [],
      gateAttempts: 0,
    }
  }
  return state
}

function summarizeToolInput(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {}
  if (toolName === 'Bash') {
    return { command: truncate(redactString(input.command || input.cmd || ''), 1200), description: truncate(input.description || '', 400) }
  }
  if (toolName === 'WebFetch') return { url: input.url, prompt: truncate(input.prompt || '', 400) }
  if (toolName === 'WebSearch') return { query: truncate(input.query || '', 400) }
  if (toolName === 'Task' || toolName === 'Agent') return { subagent_type: input.subagent_type, description: truncate(input.description || input.prompt || '', 800) }
  return redact(input)
}

function fileFromToolInput(input) {
  if (!input || typeof input !== 'object') return null
  return input.file_path || input.filePath || input.path || input.notebook_path || null
}

function rememberChangedFile(current, cwd, file) {
  if (!file) return
  const abs = String(file).startsWith('/') ? String(file) : resolve(cwd || process.cwd(), String(file))
  if (!current.changedFiles.includes(abs)) current.changedFiles.push(abs)
}

function commandText(input) {
  const value = input?.tool_input
  if (!value || typeof value !== 'object') return ''
  return String(value.command || value.cmd || '')
}

function isTestCommand(command) {
  return /\b(npm|pnpm|yarn|bun)\s+(test|run\s+(test|check|lint|build|typecheck)|exec\s+(tsc|eslint))\b/i.test(command) ||
    /\b(pytest|ruff|mypy|cargo\s+(test|check|clippy|build)|go\s+test|mvn\s+test|gradle\s+test|make\s+(test|check|lint|build)|node\s+--check|tsc\b|eslint\b|vitest|jest)\b/i.test(command)
}

function isDiffCommand(command) {
  return /\bgit\s+(diff|status|show|log)\b/i.test(command)
}

function isBrowserCommand(command) {
  return /\b(root-auto-browser|playwright|chromium|google-chrome|duckduckgo|curl|wget|lynx|w3m)\b/i.test(command)
}

function isRemoteCommand(command) {
  return /\bgit\s+push\b/i.test(command) ||
    /\bgit\s+tag\b/i.test(command) ||
    /\b(npm|pnpm|yarn)\s+publish\b/i.test(command) ||
    /\bdocker\s+push\b/i.test(command) ||
    /\bgh\s+(release|repo|secret|workflow)\b/i.test(command) ||
    /\bkubectl\s+(apply|delete|rollout|scale|patch|create)\b/i.test(command) ||
    /\bterraform\s+(apply|destroy)\b/i.test(command) ||
    /\b(vercel|fly|railway|netlify)\s+(deploy|--prod)\b/i.test(command) ||
    /\b(rsync|scp)\b[^|&;]*:/i.test(command)
}

function isDangerousOutOfProject(command, cwd) {
  if (!/\brm\s+(-[A-Za-z]*r[A-Za-z]*f|-rf|-fr)\b/.test(command)) return false
  if (/\brm\s+(-[A-Za-z]*r[A-Za-z]*f|-rf|-fr)\s+\/(\s|$)/.test(command)) return true
  if (/\brm\s+(-[A-Za-z]*r[A-Za-z]*f|-rf|-fr)\s+(~|\/root|\/home|\/etc|\/usr|\/var)\b/.test(command)) {
    return !command.includes(cwd)
  }
  return false
}

function markPostTool(input) {
  const state = currentState(input)
  const current = state.current
  const tool = input.tool_name || ''
  const toolInput = input.tool_input
  const command = commandText(input)

  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(tool)) {
    current.editCount += 1
    rememberChangedFile(current, input.cwd, fileFromToolInput(toolInput))
  }
  if (tool === 'TodoWrite') current.todoUsed = true
  if (tool === 'WebFetch' || tool === 'WebSearch') current.webUsed = true
  if (tool === 'Task' || tool === 'Agent') {
    current.agentUsed = true
    const text = JSON.stringify(summarizeToolInput(tool, toolInput))
    if (/(review|reviewer|qa|test|verify|审查|测试|验证)/i.test(text)) current.reviewerUsed = true
  }
  if (tool === 'Bash') {
    if (isTestCommand(command)) {
      current.testRan = true
      current.verificationRan = true
      const response = JSON.stringify(redact(input.tool_response || {}))
      if (/(exit\s*code[^0-9]*[1-9]|failed|error|FAIL|Command failed)/i.test(response)) current.verificationFailed = true
      else current.verificationFailed = false
    }
    if (isDiffCommand(command)) current.diffViewed = true
    if (isBrowserCommand(command)) {
      current.browserUsed = true
      current.webUsed = true
    }
  }

  saveState(input, state)
  appendLedger(input, {
    event: 'post_tool',
    turn: current.turn,
    data: {
      tool,
      input: summarizeToolInput(tool, toolInput),
      changedFiles: current.changedFiles,
      testRan: current.testRan,
      webUsed: current.webUsed,
      agentUsed: current.agentUsed,
    },
  })
}

function markToolFailure(input) {
  const state = currentState(input)
  const current = state.current
  const tool = input.tool_name || ''
  const command = commandText(input)
  current.commandFailures.push({
    tool,
    command: truncate(redactString(command), 800),
    error: truncate(redactString(input.error || ''), 800),
  })
  if (tool === 'Bash' && isTestCommand(command)) {
    current.testRan = true
    current.verificationRan = true
    current.verificationFailed = true
  }
  saveState(input, state)
  appendLedger(input, { event: 'tool_failure', turn: current.turn, data: { tool, command, error: input.error } })
}

function enterpriseContext(input, state) {
  const current = state.current || {}
  return [
    'Enterprise Runtime Context:',
    `- Version: ${VERSION}`,
    '- Mode: CEO scheduler with software gates.',
    '- Local root-auto actions are allowed; do not ask for yes/no confirmation for local reads, edits, installs, tests, or dev servers.',
    '- Remote side effects are explicit-only: git push, publish, release, cloud/prod changes, secret operations.',
    '- Required loop: intake -> classify -> plan -> delegate -> execute -> verify -> review -> finalize.',
    '- Use TodoWrite for multi-step execution. Use Task/subagents for complex, multi-file, research, test, or review lanes.',
    '- If current/latest/external/version/API/docs facts matter, browse or use root-auto-browser and cite sources.',
    '- After code edits, inspect diff and run the closest test/check/build. If no test exists, run a syntax/static check or explain the blocker after trying.',
    '- For JS-heavy pages or unavailable WebSearch, use: root-auto-browser search|fetch|open|snapshot|screenshot|extract.',
    `- Current turn mode: ${current.mode || 'mixed'}, complex: ${Boolean(current.complex)}, requiresWeb: ${Boolean(current.requiresWeb)}.`,
    '- Never print or store raw secrets. Ledger and memory are project-local under .claude/enterprise.',
  ].join('\n')
}

function preToolDecision(input) {
  const state = currentState(input)
  const current = state.current
  const tool = input.tool_name || ''
  const command = commandText(input)

  appendLedger(input, {
    event: 'pre_tool',
    turn: current.turn,
    data: { tool, input: summarizeToolInput(tool, input.tool_input) },
  })

  if (tool === 'Bash') {
    if (isDangerousOutOfProject(command, input.cwd || process.cwd())) {
      return {
        decision: 'block',
        reason: 'Enterprise remote/local safety boundary blocked a destructive rm -rf outside the active project. Ask the user for exact scope or use a safer project-local command.',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Destructive out-of-project deletion is not root-auto safe.',
        },
      }
    }
    if (isRemoteCommand(command)) {
      const remotePolicy = process.env.CLAUDE_CODE_REMOTE_OPS || 'explicit'
      const envOverride = isTruthy(process.env.CLAUDE_CODE_ALLOW_REMOTE_OPS)
      if (remotePolicy === 'explicit' && !envOverride && !current.explicitRemote) {
        return {
          decision: 'block',
          reason: 'Remote side effect blocked. The user must explicitly request this exact remote operation in the current turn, or set CLAUDE_CODE_ALLOW_REMOTE_OPS=1 for this run.',
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Remote operation requires explicit user intent.',
          },
        }
      }
    }
  }

  return {
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Root-auto enterprise local operation allowed.',
      additionalContext: enterpriseContext(input, state),
    },
  }
}

function permissionDecision(input) {
  const tool = input.tool_name || ''
  const command = commandText(input)
  const state = currentState(input)
  const current = state.current
  if (tool === 'Bash' && isRemoteCommand(command) && !current.explicitRemote && !isTruthy(process.env.CLAUDE_CODE_ALLOW_REMOTE_OPS)) {
    return {
      decision: 'block',
      reason: 'Remote operation requires explicit current-turn user intent.',
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Remote operation requires explicit current-turn user intent.', interrupt: false },
      },
    }
  }
  return {
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' },
    },
  }
}

function stopGate(input) {
  const state = currentState(input)
  const current = state.current
  const violations = []
  const changedCount = current.changedFiles.length

  if (current.mode !== 'discussion') {
    if ((current.execution || current.complex) && !current.todoUsed) {
      violations.push('Create or update a TodoWrite task board before finalizing this execution task.')
    }
    if (current.editCount > 0 && !current.diffViewed) {
      violations.push('Inspect the resulting diff/status before finalizing code changes.')
    }
    if (current.editCount > 0 && !current.verificationRan) {
      violations.push('Run the closest relevant test/check/build after code changes.')
    }
    if (current.verificationFailed) {
      violations.push('A verification command failed. Fix it or clearly isolate the blocker after another targeted attempt.')
    }
    if (changedCount >= 4 && !current.reviewerUsed && !current.agentUsed) {
      violations.push('Use a reviewer/QA subagent or equivalent review pass for broad multi-file changes.')
    }
  }

  if (current.requiresWeb && !current.webUsed && !current.browserUsed) {
    violations.push('Use web evidence for current/latest/external/version/API/docs facts before finalizing.')
  }

  appendLedger(input, {
    event: 'stop_gate',
    turn: current.turn,
    data: {
      violations,
      changedFiles: current.changedFiles.map(file => relative(input.cwd || process.cwd(), file)),
      testRan: current.testRan,
      verificationRan: current.verificationRan,
      diffViewed: current.diffViewed,
      webUsed: current.webUsed,
      browserUsed: current.browserUsed,
      agentUsed: current.agentUsed,
      reviewerUsed: current.reviewerUsed,
      attempts: current.gateAttempts,
    },
  })

  if (violations.length === 0) return null

  const maxRetries = Math.max(0, Number.parseInt(process.env.CLAUDE_CODE_GATE_MAX_RETRIES || '3', 10) || 0)
  if (current.gateAttempts >= maxRetries) {
    return {
      suppressOutput: true,
      systemMessage: `Enterprise gate reached max retries. Final answer must disclose unresolved checks: ${violations.join(' | ')}`,
    }
  }

  current.gateAttempts += 1
  saveState(input, state)
  return {
    decision: 'block',
    reason: [
      `Enterprise gate attempt ${current.gateAttempts}/${maxRetries} blocked finalization.`,
      'Continue the task and satisfy these missing requirements:',
      ...violations.map(v => `- ${v}`),
      'Do not provide a final answer until the gate is satisfied or a real blocker is proven.',
    ].join('\n'),
    suppressOutput: true,
  }
}

async function main() {
  if (process.argv.includes('--version')) {
    console.log(VERSION)
    return
  }

  const raw = await readStdin()
  if (!raw.trim() || !enterpriseEnabled()) return

  let input
  try {
    input = JSON.parse(raw)
  } catch {
    return
  }

  ensureProjectFiles(input.cwd || process.cwd())

  switch (input.hook_event_name) {
    case 'SessionStart': {
      const state = currentState(input)
      appendLedger(input, { event: 'session_start', turn: state.current.turn, data: { source: input.source, model: input.model } })
      jsonOut({
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: enterpriseContext(input, state),
        },
      })
      return
    }
    case 'UserPromptSubmit': {
      const state = newTurn(input, input.prompt || '')
      jsonOut({
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: enterpriseContext(input, state),
        },
      })
      return
    }
    case 'PreToolUse':
      jsonOut(preToolDecision(input))
      return
    case 'PermissionRequest':
      jsonOut(permissionDecision(input))
      return
    case 'PostToolUse':
      markPostTool(input)
      return
    case 'PostToolUseFailure':
      markToolFailure(input)
      return
    case 'SubagentStart': {
      const state = currentState(input)
      appendLedger(input, { event: 'subagent_start', turn: state.current.turn, data: { agent_type: input.agent_type, agent_id: input.agent_id } })
      jsonOut({
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'SubagentStart',
          additionalContext: 'Enterprise subagent: return structured summary, evidence, changed files, commands/tests, risks, and next action.',
        },
      })
      return
    }
    case 'SubagentStop': {
      const state = currentState(input)
      appendLedger(input, { event: 'subagent_stop', turn: state.current.turn, data: { agent_type: input.agent_type, agent_id: input.agent_id, last: truncate(input.last_assistant_message || '', 1200) } })
      return
    }
    case 'PreCompact': {
      const state = currentState(input)
      appendLedger(input, { event: 'pre_compact', turn: state.current.turn, data: { trigger: input.trigger } })
      jsonOut({
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'PreCompact',
          additionalContext: 'Before compaction, preserve objective, task board, changed files, test status, web evidence, and blockers in .claude/enterprise ledger/memory.',
        },
      })
      return
    }
    case 'PostCompact': {
      const state = currentState(input)
      appendLedger(input, { event: 'post_compact', turn: state.current.turn, data: { trigger: input.trigger, summary: truncate(input.compact_summary || '', 2000) } })
      return
    }
    case 'SessionEnd': {
      const state = currentState(input)
      appendLedger(input, { event: 'session_end', turn: state.current.turn, data: { reason: input.reason } })
      return
    }
    case 'Stop': {
      const result = stopGate(input)
      if (result) jsonOut(result)
      return
    }
    default:
      appendLedger(input, { event: input.hook_event_name || 'unknown', data: redact(input) })
  }
}

main().catch(error => {
  jsonOut({
    suppressOutput: true,
    systemMessage: `Enterprise hook failed safely: ${truncate(error?.message || error, 600)}`,
  })
})
