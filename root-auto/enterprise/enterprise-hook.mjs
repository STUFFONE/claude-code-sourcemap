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

function envMode(name, fallback) {
  return String(process.env[name] || fallback).toLowerCase()
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

function matchesAny(text, patterns) {
  return patterns.some(pattern => pattern.test(text))
}

function textFromContent(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(item => textFromContent(item)).filter(Boolean).join('\n')
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text
    if (typeof content.content === 'string') return content.content
    if (Array.isArray(content.content)) return textFromContent(content.content)
    if (typeof content.message === 'string') return content.message
  }
  return ''
}

function lastAssistantText(input) {
  if (typeof input?.last_assistant_message === 'string' && input.last_assistant_message.trim()) {
    return input.last_assistant_message
  }

  const transcript = input?.transcript_path || input?.transcriptPath
  if (!transcript || !existsSync(transcript)) return ''

  try {
    const lines = readFileSync(transcript, 'utf8').trim().split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].trim()) continue
      const entry = JSON.parse(lines[i])
      const role = entry?.message?.role || entry?.role || entry?.type
      if (role !== 'assistant') continue
      const text = textFromContent(entry?.message?.content ?? entry?.content ?? entry?.text)
      if (text.trim()) return text
    }
  } catch {
    return ''
  }

  return ''
}

function compactAssistantText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, block => block.replace(/\s+/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
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
  const reasons = []

  const explicitRemote =
    /(推送|上传\s*github|提交并推送|发布|部署|release|git push|push to|publish|deploy)/i.test(text) ||
    /\b(push|publish|release|deploy)\b/i.test(lower)

  const localStatusQuestion = matchesAny(text, [
    /(现在|当前|目前|此刻|这里).{0,24}(是不是|是否|是)?.{0,24}(ceo|super|企业|enterprise|root-auto|root auto|模式|状态|配置|版本)/i,
    /(你|claude).{0,24}(现在|当前|目前).{0,24}(什么模式|哪种模式|是不是|状态|配置|版本)/i,
    /(ceo|super|企业|enterprise|root-auto|root auto).{0,24}(模式|状态|开了吗|启用了吗|是不是)/i,
    /\b(are you|current|runtime|local).{0,40}(mode|status|enterprise|ceo|super|root-auto|version|config)\b/i,
  ])

  const chat = matchesAny(text, [
    /^(halo|hello|hi|hey|在吗|还在吗|人在吗|喂|哈喽|你好)[?？!\s。,.，]*$/i,
    /(halo|hello|hi|hey|在吗|还在吗).{0,20}(回答我|回我|在的话|还在的话)/i,
    /(我在跟你聊天|不是让你改|不需要改任何文件|先别动|别动文件|继续聊|继续讨论|你懂吗|明白吗|是不是不理解|你理解我意图)/i,
  ])

  const discussion =
    matchesAny(text, [
      /(仅讨论|只讨论|先讨论|先评估|方案|计划|评估|分析|看看能不能|可不可以|暂时不需要|不要改|别改|不需要实现|仅聊天)/,
      /\b(discuss|plan|evaluate|assess|review only|no changes|do not edit|proposal|design only)\b/i,
    ])

  const codeWriting = matchesAny(text, [
    /写(代码|测试|单测|函数|组件|页面|接口|api|API|命令|配置|插件|脚本|程序|文件|模块|类|hook|Hook)/,
    /(实现|修复|调试|跑|执行|安装|提交|推送|上传|部署|接入|落地|打包|构建|测试|重构|优化|魔改|改内核)/i,
    /(修改|创建|生成).{0,16}(代码|项目|仓库|repo|文件|功能|bug|测试|构建|脚本|依赖|组件|接口|API|配置|hook|客户端)/i,
    /\b(implement|fix|change|edit|run|install|commit|push|deploy|create|build|wire|add|refactor|debug|test|lint|patch)\b/i,
  ])

  const creative =
    matchesAny(text, [
      /(写一篇|写篇|写个|写一个|帮我写|生成一篇|创作|润色|改写|扩写|缩写).{0,24}(推特|推文|长文|文案|标题|口播|脚本|帖子|thread|tweet|article|essay|post|copy|slogan|视频|小红书|公众号|文章|邮件|故事|演讲稿)?/i,
      /(推特长文|推文|文案|标题|口播|内容创作|帖子|小红书|公众号|短视频脚本|营销文案|thread|tweet|copywriting|article|essay|blog post|script|headline|slogan)/i,
    ]) &&
    !codeWriting

  const research =
    matchesAny(text, [
      /(查一下|搜索|搜一下|联网|上网|验证一下|核实|引用来源|找资料|资料调研|对比一下|看看官网|官方文档|文档里)/,
      /\b(search|browse|look up|verify|fact check|research|cite sources|official docs|documentation)\b/i,
    ]) &&
    !localStatusQuestion

  const externalFacts = matchesAny(text, [
    /(最新|今天|昨日|昨天|明天|最近|当前价格|实时|新闻|法律|法规|政策|版本|官方文档|官网|API\s*文档|npm|pypi|release|changelog)/i,
    /\b(latest|today|yesterday|tomorrow|recent|current price|real-time|news|law|regulation|policy|version|official docs|documentation|api docs|pricing|release|changelog)\b/i,
  ])

  const engineering =
    !creative &&
    matchesAny(text, [
      /(实现|修复|调试|跑|执行|安装|提交|接入|落地|打包|构建|测试|重构|优化|检查|魔改|改内核|更新).{0,24}(代码|项目|仓库|repo|文件|功能|bug|测试|构建|脚本|依赖|组件|接口|API|配置|hook|客户端|本地|版本|分支)?/i,
      /(修改|创建|生成).{0,24}(代码|项目|仓库|repo|文件|功能|bug|测试|构建|脚本|依赖|组件|接口|API|配置|hook|客户端|本地|版本|分支)/i,
      /\b(implement|fix|change|edit|run|install|commit|create|build|wire|add|refactor|debug|test|lint|patch|modify|generate)\b/i,
    ])

  const complex =
    matchesAny(text, [
      /(复杂|企业级|全套|超级|长期|多代理|并发|架构|内核|调度|系统|全面|接近百分百|顶格|全力以赴|超级大脑|超级个体|全能手)/i,
      /\b(complete|enterprise|architecture|scheduler|multi-agent|long-running|orchestrator|end-to-end|production-grade)\b/i,
    ]) ||
    text.length > 600

  let intent = 'unknown'
  let workClass = 'none'
  if (localStatusQuestion && !engineering && !creative && !research && !explicitRemote) {
    intent = 'local_status'
    workClass = 'none'
    reasons.push('local runtime/status question')
  } else if (chat && !engineering && !creative && !research && !explicitRemote) {
    intent = 'chat'
    workClass = 'none'
    reasons.push('light chat')
  } else if (creative) {
    intent = 'creative_work'
    workClass = 'creative'
    reasons.push('content creation request')
  } else if (research || (externalFacts && !engineering && !explicitRemote)) {
    intent = 'research_work'
    workClass = 'research'
    reasons.push(research ? 'explicit research request' : 'external/current facts request')
  } else if (explicitRemote) {
    intent = 'remote_ops'
    workClass = 'remote'
    reasons.push('explicit remote operation')
  } else if (engineering) {
    intent = 'engineering_work'
    workClass = 'engineering'
    reasons.push('engineering/tool execution request')
  } else if (discussion) {
    intent = 'discussion'
    workClass = 'none'
    reasons.push('discussion/planning only')
  }

  const needsWeb = !localStatusQuestion && (research || externalFacts)
  const execution = workClass === 'engineering' || workClass === 'remote'
  const mode =
    intent === 'discussion' || intent === 'chat' || intent === 'local_status'
      ? intent
      : workClass === 'creative'
        ? 'creative'
        : workClass === 'research'
          ? 'research'
          : execution
            ? 'execution'
            : 'mixed'

  return {
    intent,
    workClass,
    mode,
    execution,
    discussion: intent === 'discussion' || discussion,
    creative,
    research: intent === 'research_work',
    localStatusQuestion,
    requiresWeb: needsWeb,
    needsWeb,
    complex,
    explicitRemote,
    confidence: reasons.length ? 'high' : 'low',
    reasons,
    gates: {
      chat: intent === 'chat' && isTruthy(process.env.CLAUDE_CODE_CHAT_GATE),
      creative: workClass === 'creative' && isTruthy(process.env.CLAUDE_CODE_CREATIVE_GATE ?? '1'),
      research: needsWeb && isTruthy(process.env.CLAUDE_CODE_RESEARCH_GATE ?? '1'),
      engineering: (workClass === 'engineering' || workClass === 'remote') && isTruthy(process.env.CLAUDE_CODE_ENGINEERING_GATE ?? '1'),
      remote: explicitRemote,
    },
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
      intent: 'unknown',
      workClass: 'none',
      mode: 'mixed',
      execution: false,
      discussion: false,
      creative: false,
      research: false,
      localStatusQuestion: false,
      requiresWeb: false,
      needsWeb: false,
      complex: false,
      explicitRemote: false,
      confidence: 'low',
      reasons: [],
      gates: {},
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
      intent: current.intent,
      workClass: current.workClass,
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

function enabledText(value, fallback = '1') {
  return isTruthy(value ?? fallback) ? 'on' : 'off'
}

function runtimeStatusText() {
  const lines = [
    `root-auto: ${enabledText(process.env.CLAUDE_CODE_ROOT_AUTO)}`,
    `enterprise: ${enabledText(process.env.CLAUDE_CODE_ENTERPRISE)}`,
    `intent router: ${process.env.CLAUDE_CODE_INTENT_ROUTER || 'smart'}`,
    `context target: ${process.env.CLAUDE_CODE_CONTEXT_WINDOW || '1000000'}`,
    `model: ${process.env.ANTHROPIC_MODEL || '[unset]'}`,
    `subagent model: ${process.env.CLAUDE_CODE_SUBAGENT_MODEL || '[unset]'}`,
    `effort: ${process.env.CLAUDE_CODE_EFFORT_LEVEL || process.env.CLAUDE_CODE_ENTERPRISE_LEVEL || 'max'}`,
    `company mode: ${process.env.CLAUDE_CODE_COMPANY_MODE || 'dynamic'}`,
    `max agents: ${process.env.CLAUDE_CODE_COMPANY_MAX_AGENTS || '6'}`,
    `todo gate: ${process.env.CLAUDE_CODE_TODO_GATE || 'complex'}`,
    `creative gate: ${enabledText(process.env.CLAUDE_CODE_CREATIVE_GATE)}`,
    `research gate: ${enabledText(process.env.CLAUDE_CODE_RESEARCH_GATE)}`,
    `engineering gate: ${enabledText(process.env.CLAUDE_CODE_ENGINEERING_GATE)}`,
    `chat gate: ${enabledText(process.env.CLAUDE_CODE_CHAT_GATE, '0')}`,
    `local-status web: ${enabledText(process.env.CLAUDE_CODE_LOCAL_STATUS_WEB, '0')}`,
    `web policy: ${process.env.CLAUDE_CODE_WEB_POLICY || 'hybrid'}`,
    `browser backend: ${process.env.CLAUDE_CODE_BROWSER_BACKEND || 'playwright'}`,
    `remote ops: ${process.env.CLAUDE_CODE_REMOTE_OPS || 'explicit'}`,
    `repo: ${REPO_ROOT}`,
  ]
  if (process.env.ANTHROPIC_AUTH_TOKEN) lines.push('auth token: [set redacted]')
  return lines.join('\n')
}

function enterpriseContext(input, state) {
  const current = state.current || {}
  const lines = [
    'Enterprise Runtime Context:',
    `- Version: ${VERSION}`,
    '- Mode: CEO scheduler with software intent router and gates.',
    '- Local root-auto actions are allowed; do not ask for yes/no confirmation for local reads, edits, installs, tests, or dev servers.',
    '- Remote side effects are explicit-only: git push, publish, release, cloud/prod changes, secret operations.',
    '- Intent routing: chat/local_status/discussion stay lightweight; creative_work delivers finished content; research_work gathers evidence; engineering_work executes with verification; remote_ops require explicit user intent.',
    '- For chat or local_status, answer directly from local runtime context. Do not browse, run tools, or create TodoWrite unless the user asks for real work.',
    '- For creative_work, treat content creation as real work: deliver the complete polished artifact now, silently self-review it, and never answer with "I can write" or "give me the topic" when the user already requested content.',
    '- For research_work or current/latest/external/version/API/docs facts, browse or use root-auto-browser and cite sources.',
    '- For engineering_work, use TodoWrite for complex/multi-file work, use Task/subagents for separable lanes, inspect diff, and run the closest test/check/build after edits.',
    '- For JS-heavy pages or unavailable WebSearch, use: root-auto-browser search|fetch|open|snapshot|screenshot|extract.',
    `- Current turn intent: ${current.intent || 'unknown'}, workClass: ${current.workClass || 'none'}, mode: ${current.mode || 'mixed'}, complex: ${Boolean(current.complex)}, needsWeb: ${Boolean(current.needsWeb ?? current.requiresWeb)}.`,
    current.reasons?.length ? `- Classifier reasons: ${current.reasons.join(', ')}.` : '- Classifier reasons: none.',
    '- Never print or store raw secrets. Ledger and memory are project-local under .claude/enterprise.',
  ]
  if (current.intent === 'local_status') {
    lines.push('Local runtime status for this answer; use this instead of web evidence:')
    lines.push(runtimeStatusText())
  }
  return lines.join('\n')
}

function preToolDecision(input) {
  const state = currentState(input)
  const current = state.current
  const tool = input.tool_name || ''
  const command = commandText(input)

  appendLedger(input, {
    event: 'pre_tool',
    turn: current.turn,
    data: { tool, intent: current.intent, workClass: current.workClass, input: summarizeToolInput(tool, input.tool_input) },
  })

  if (
    current.intent === 'local_status' &&
    !isTruthy(process.env.CLAUDE_CODE_LOCAL_STATUS_WEB ?? '0') &&
    (tool === 'WebSearch' || tool === 'WebFetch' || (tool === 'Bash' && isBrowserCommand(command)))
  ) {
    return {
      decision: 'block',
      reason: 'Local runtime/status questions must be answered from the local enterprise context; web lookup is disabled for this intent.',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Local status does not need web evidence.',
      },
    }
  }

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
  const gatesActive = []
  const gatesSkipped = []
  const needsWeb = Boolean(current.needsWeb ?? current.requiresWeb)
  const chatLike = ['chat', 'local_status', 'discussion'].includes(current.intent) && current.editCount === 0 && !needsWeb
  const engineeringGate =
    isTruthy(process.env.CLAUDE_CODE_ENGINEERING_GATE ?? '1') &&
    (current.workClass === 'engineering' || current.editCount > 0)
  const researchGate =
    isTruthy(process.env.CLAUDE_CODE_RESEARCH_GATE ?? '1') &&
    current.intent !== 'local_status' &&
    (current.workClass === 'research' || needsWeb)
  const creativeGate =
    isTruthy(process.env.CLAUDE_CODE_CREATIVE_GATE ?? '1') &&
    current.workClass === 'creative'

  if (chatLike && !isTruthy(process.env.CLAUDE_CODE_CHAT_GATE ?? '0')) {
    gatesSkipped.push('chat/local_status/discussion lightweight turn')
  }
  if (engineeringGate) gatesActive.push('engineering')
  else gatesSkipped.push('engineering')
  if (researchGate) gatesActive.push('research')
  else gatesSkipped.push('research')
  if (creativeGate) gatesActive.push('creative')
  else gatesSkipped.push('creative')

  const todoGateMode = envMode('CLAUDE_CODE_TODO_GATE', 'complex')
  const todoRequired =
    engineeringGate && todoGateMode === 'strict'
      ? current.execution || current.complex
      : todoGateMode === 'off'
        ? false
        : engineeringGate && (current.complex || changedCount >= 2 || current.editCount >= 3)

  if (engineeringGate) {
    if (todoRequired && !current.todoUsed) {
      violations.push('Create or update a TodoWrite task board before finalizing this complex or multi-file task.')
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

  if (researchGate && !current.webUsed && !current.browserUsed) {
    violations.push('Use web evidence for current/latest/external/version/API/docs facts before finalizing.')
  }

  if (creativeGate) {
    const assistantText = compactAssistantText(lastAssistantText(input))
    const prompt = String(current.prompt || '')
    const longCreative = current.complex || /(长文|长帖|完整|深度|thread|essay|article|long-form|10\s*(条|posts?)|十条)/i.test(prompt)
    const minLength = longCreative ? 300 : 80
    const nonDelivery =
      /(我可以(帮你)?写|你直接下指令|随时可以开始|告诉我(主题|方向|需求)|给我(主题|方向|素材)|我会帮你|可以开始写|需要你提供|send me|give me the topic|i can write|i can help write)/i.test(assistantText)

    if (!assistantText) {
      violations.push('Deliver the requested creative content before finalizing; the Stop hook could not find assistant output to verify.')
    } else if (nonDelivery && assistantText.length < 500) {
      violations.push('Deliver the actual requested creative content now; do not finalize with a non-answer like "I can write it".')
    } else if (assistantText.length < minLength) {
      violations.push(`Expand the creative deliverable before finalizing; this request needs at least a substantive ${longCreative ? 'long-form' : 'complete'} draft.`)
    }
  }

  appendLedger(input, {
    event: 'stop_gate',
    turn: current.turn,
    data: {
      intent: current.intent,
      workClass: current.workClass,
      gatesActive,
      gatesSkipped,
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
