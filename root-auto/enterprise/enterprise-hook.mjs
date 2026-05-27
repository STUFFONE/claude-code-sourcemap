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

function unique(values) {
  return [...new Set((values || []).filter(Boolean))]
}

function addUnique(target, value) {
  if (!value) return
  if (!Array.isArray(target)) return
  if (!target.includes(value)) target.push(value)
}

function envInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || `${fallback}`, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function longCreativeRequest(current) {
  const prompt = String(current?.prompt || '')
  return Boolean(current?.complex) || /(长文|长帖|完整|深度|thread|essay|article|long-form|10\s*(条|posts?)|十条)/i.test(prompt)
}

function isSimpleRemotePrompt(text) {
  const value = String(text || '').trim()
  return /^(push|git\s+push|推送|上传\s*github|push\s+main|push\s+to\s+github)$/i.test(value)
}

function qualityThreshold(current) {
  if (envMode('CLAUDE_CODE_QUALITY_GATE', 'hard') === 'off') return 0
  if (current.intent === 'creative_work') return envInt('CLAUDE_CODE_QUALITY_MIN_CREATIVE', 85)
  if (current.intent === 'research_work') return envInt('CLAUDE_CODE_QUALITY_MIN_RESEARCH', 85)
  if (current.intent === 'engineering_work' || current.workClass === 'engineering' || current.editCount > 0) {
    return envInt('CLAUDE_CODE_QUALITY_MIN_ENGINEERING', 90)
  }
  if (current.intent === 'remote_ops') return current.simpleRemote ? 0 : envInt('CLAUDE_CODE_QUALITY_MIN_REMOTE', 90)
  return 0
}

function laneFromText(text) {
  const value = String(text || '')
  if (/(qa|fact.?check|fact.?checking|claim|claims|test|verify|verification|quality|测试|验证|验收|事实核查|核实|声明)/i.test(value)) return 'qa'
  if (/(reviewer|review|critic|critique|audit|审查|评审|复核|挑错|质检|评测|评估)/i.test(value)) return 'reviewer'
  if (/(architect|architecture|design|planner|规划|架构|设计|方案)/i.test(value)) return 'architect'
  if (/(research|search|evidence|web|browser|资料|调研|搜索|证据|联网)/i.test(value)) return 'research'
  if (/(ops|security|deploy|release|安全|运维|部署|发布)/i.test(value)) return 'ops_security'
  if (/(implement|code|edit|patch|build|实现|编码|修改|开发)/i.test(value)) return 'implementer'
  return 'specialist'
}

function requiredLanesFor(current) {
  const policy = envMode('CLAUDE_CODE_DELEGATION_POLICY', 'proactive')
  if (policy === 'off' || policy === 'none') return []
  if (current.intent === 'chat' || current.intent === 'local_status') return []
  if (current.intent === 'discussion' && !current.complex) return []

  const lanes = []
  if (current.intent === 'creative_work' && longCreativeRequest(current)) lanes.push('reviewer')
  if (current.intent === 'research_work' || current.needsWeb || current.requiresWeb) lanes.push('research')
  if (current.intent === 'engineering_work' || current.workClass === 'engineering' || current.editCount > 0) {
    if ((current.complex || current.changedFiles?.length >= 2 || current.editCount >= 3) && !current.todoUsed && current.editCount === 0) lanes.push('architect')
    if (current.editCount > 0) lanes.push('reviewer', 'qa')
  }
  if (current.intent === 'remote_ops' && !current.simpleRemote) lanes.push('ops_security', 'reviewer')
  return unique(lanes)
}

function requiredPhasesFor(current) {
  if (current.intent === 'chat' || current.intent === 'local_status') return ['intake', 'classify', 'finalize']
  if (current.intent === 'discussion' && !current.complex) return ['intake', 'classify', 'finalize']
  if (current.intent === 'remote_ops' && current.simpleRemote) return ['intake', 'classify', 'execute', 'finalize']

  const phases = ['intake', 'classify']
  if (current.intent === 'engineering_work' || current.intent === 'remote_ops' || (current.intent === 'research_work' && current.complex)) phases.push('plan')
  if (requiredLanesFor(current).length > 0) phases.push('delegate')
  if (current.workClass !== 'none' && current.intent !== 'research_work') phases.push('execute')
  if (current.intent === 'research_work' || current.needsWeb || current.requiresWeb || current.editCount > 0) phases.push('verify')
  if (requiredLanesFor(current).some(lane => ['reviewer', 'qa', 'ops_security'].includes(lane))) phases.push('review')
  phases.push('finalize')
  return unique(phases)
}

function initializeRuntimePlan(current) {
  current.phase = 'classify'
  current.phaseHistory = [
    { phase: 'intake', ts: new Date().toISOString(), reason: 'user_prompt' },
    { phase: 'classify', ts: new Date().toISOString(), reason: current.intent || 'unknown' },
  ]
  current.completedPhases = ['intake', 'classify']
  current.requiredPhases = requiredPhasesFor(current)
  current.expectedLanes = requiredLanesFor(current)
  current.completedLanes = []
  current.laneEvents = []
  current.activeAgents = {}
  current.toolCount = 0
  current.quality = null
}

function ensureRuntimePlan(current) {
  current.phase ||= 'classify'
  current.phaseHistory ||= []
  current.completedPhases ||= []
  current.requiredPhases ||= []
  current.expectedLanes ||= []
  current.completedLanes ||= []
  current.laneEvents ||= []
  current.activeAgents ||= {}
  current.toolCount ||= 0
  current.quality ||= null
  for (const phase of ['intake', 'classify']) addUnique(current.completedPhases, phase)
  current.requiredPhases = requiredPhasesFor(current)
  current.expectedLanes = requiredLanesFor(current)
}

function completePhase(current, phase, reason) {
  ensureRuntimePlan(current)
  addUnique(current.completedPhases, phase)
  current.phase = phase
  current.phaseHistory.push({ phase, ts: new Date().toISOString(), reason: truncate(reason || '', 160) })
}

function completeLane(current, lane, reason) {
  ensureRuntimePlan(current)
  addUnique(current.completedLanes, lane)
  current.laneEvents.push({ lane, status: 'completed', ts: new Date().toISOString(), reason: truncate(reason || '', 240) })
  completePhase(current, 'delegate', lane)
  if (lane === 'reviewer' || lane === 'qa' || lane === 'ops_security') {
    current.reviewerUsed = true
    completePhase(current, 'review', lane)
  }
  if (lane === 'research') completePhase(current, 'verify', lane)
}

function activeLanes(current) {
  const agentLanes = Object.values(current.activeAgents || {})
    .filter(agent => agent && agent.status !== 'completed')
    .map(agent => agent.lane)
  if (agentLanes.length > 0) return unique(agentLanes)

  const latest = new Map()
  for (const event of current.laneEvents || []) {
    if (!event?.lane) continue
    latest.set(event.lane, event.status || 'completed')
  }
  return [...latest.entries()].filter(([, status]) => status === 'started').map(([lane]) => lane)
}

function isProgressUpdate(text) {
  const value = String(text || '')
  if (!value.trim()) return false
  return /(等|等待|还在|正在|进行中|未完成|没回来|回来|agent|subagent|调研|处理中|running|waiting|in progress|still running|not done|pending)/i.test(value)
}

function isStatusOnlyUpdate(text) {
  const value = String(text || '')
  if (!value.trim()) return false
  const saysNotDone = /(没好|还没好|没完成|未完成|还在|正在|等通知|等待|进行中|处理中|still running|not done|not ready|pending|running|in progress)/i.test(value)
  const aboutWorkStatus = /(agent|subagent|任务|调研|搜索|web\s*search|search|reviewer|qa|instagram|输出|结果|回来|完成|好了)/i.test(value)
  const falsePositiveFinal = /(^|\s)(完成了|已完成|done|finished)(。|\.|\s|$)/i.test(value) && !/(没完成|未完成|not done)/i.test(value)
  return saysNotDone && aboutWorkStatus && !falsePositiveFinal
}

function scoreQuality(current, input) {
  ensureRuntimePlan(current)
  const assistantText = compactAssistantText(lastAssistantText(input))
  const needsWeb = Boolean(current.needsWeb ?? current.requiresWeb)
  const missingLanes = current.expectedLanes.filter(lane => !current.completedLanes.includes(lane))
  const missingPhases = current.requiredPhases.filter(phase => phase !== 'finalize' && !current.completedPhases.includes(phase))
  const longCreative = longCreativeRequest(current)
  const creativeMinLength = longCreative ? 300 : 80
  const nonDelivery =
    /(我可以(帮你)?写|你直接下指令|随时可以开始|告诉我(主题|方向|需求)|给我(主题|方向|素材)|我会帮你|可以开始写|需要你提供|send me|give me the topic|i can write|i can help write|if you want|如果你需要)/i.test(assistantText)

  let deliveryScore = 100
  if (current.intent === 'creative_work') {
    if (!assistantText) deliveryScore = 0
    else if (nonDelivery && assistantText.length < 500) deliveryScore = 15
    else if (assistantText.length < creativeMinLength) deliveryScore = longCreative ? 55 : 70
    else deliveryScore = 100
  } else if (current.workClass !== 'none' && !assistantText) {
    deliveryScore = 70
  }

  const evidenceScore = needsWeb ? (current.webUsed || current.browserUsed ? 100 : 0) : 100
  let verificationScore = 100
  if (current.editCount > 0) {
    if (current.verificationFailed) verificationScore = 20
    else if (current.diffViewed && current.verificationRan) verificationScore = 100
    else if (current.diffViewed || current.verificationRan) verificationScore = 55
    else verificationScore = 0
  }
  const completedExpectedLanes = current.expectedLanes.filter(lane => current.completedLanes.includes(lane))
  const reviewScore = current.expectedLanes.length === 0 ? 100 : Math.min(100, Math.max(0, Math.round((completedExpectedLanes.length / current.expectedLanes.length) * 100)))
  let focusScore = 100
  if ((current.intent === 'chat' || current.intent === 'local_status') && current.toolCount > 0) focusScore = 40
  if (current.intent === 'local_status' && (current.webUsed || current.browserUsed)) focusScore = 0

  let finalScore = 100
  if (current.intent === 'creative_work') {
    finalScore = Math.round(deliveryScore * 0.55 + reviewScore * 0.2 + evidenceScore * 0.15 + focusScore * 0.1)
  } else if (current.intent === 'research_work') {
    finalScore = Math.round(evidenceScore * 0.55 + reviewScore * 0.2 + deliveryScore * 0.15 + focusScore * 0.1)
  } else if (current.intent === 'engineering_work' || current.workClass === 'engineering' || current.editCount > 0) {
    finalScore = Math.round(verificationScore * 0.45 + reviewScore * 0.25 + deliveryScore * 0.1 + evidenceScore * 0.1 + focusScore * 0.1)
  } else if (current.intent === 'remote_ops') {
    finalScore = Math.round(verificationScore * 0.35 + reviewScore * 0.3 + evidenceScore * 0.15 + deliveryScore * 0.1 + focusScore * 0.1)
  }

  const quality = {
    threshold: qualityThreshold(current),
    finalScore,
    deliveryScore,
    evidenceScore,
    verificationScore,
    reviewScore,
    focusScore,
    missingLanes,
    missingPhases,
    assistantChars: assistantText.length,
    nonDelivery,
  }
  current.quality = quality
  return quality
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
        toolRegistry: {
          codeSearch: 'rg',
          diff: 'git diff/status/show',
          browser: 'root-auto-browser',
          jsCheck: 'node --check',
          shellCheck: 'bash -n',
        },
        qualityPolicy: {
          gate: process.env.CLAUDE_CODE_QUALITY_GATE || 'hard',
          creativeMin: envInt('CLAUDE_CODE_QUALITY_MIN_CREATIVE', 85),
          researchMin: envInt('CLAUDE_CODE_QUALITY_MIN_RESEARCH', 85),
          engineeringMin: envInt('CLAUDE_CODE_QUALITY_MIN_ENGINEERING', 90),
        },
        memoryScope: process.env.CLAUDE_CODE_PROJECT_MEMORY_SCOPE || 'project',
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

function readProjectMemorySummary(cwd) {
  if (!isTruthy(process.env.CLAUDE_CODE_PROJECT_MEMORY ?? '1')) return ''
  const file = join(enterpriseDir(cwd), 'memory.md')
  if (!existsSync(file)) return ''
  try {
    const lines = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(line => line.trim() && !/raw auth|token|secret/i.test(line))
      .slice(0, 18)
    return truncate(lines.join('\n'), 1200)
  } catch {
    return ''
  }
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
  const simpleRemote = explicitRemote && isSimpleRemotePrompt(text)

  const localStatusQuestion = matchesAny(text, [
    /(现在|当前|目前|此刻|这里).{0,24}(是不是|是否|是)?.{0,24}(ceo|super|企业|enterprise|root-auto|root auto|模式|状态|配置|版本)/i,
    /(你|claude).{0,24}(现在|当前|目前).{0,24}(什么模式|哪种模式|是不是|状态|配置|版本)/i,
    /(ceo|super|企业|enterprise|root-auto|root auto).{0,24}(模式|状态|开了吗|启用了吗|是不是)/i,
    /(agent|subagent|任务|调研|搜索|reviewer|qa|instagram).{0,30}(好了没|好了吗|回来了吗|完成了吗|到哪了|进度|状态|done|ready|finished)/i,
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
    /(写|创建|生成).{0,16}(skill|skills|技能)/i,
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
      /(查一下|搜索|搜一下|联网|上网|验证一下|核实|引用来源|找资料|资料调研|调研|对比一下|看看官网|官方文档|文档里)/,
      /\b(websearch|web search|search|browse|look up|verify|fact check|research|cite sources|official docs|documentation)\b/i,
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
      /(修改|创建|生成|写).{0,24}(代码|项目|仓库|repo|文件|功能|bug|测试|构建|脚本|依赖|组件|接口|API|配置|hook|客户端|本地|版本|分支|skill|skills|技能)/i,
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
  } else if (explicitRemote) {
    intent = 'remote_ops'
    workClass = 'remote'
    reasons.push('explicit remote operation')
  } else if (engineering) {
    intent = 'engineering_work'
    workClass = 'engineering'
    reasons.push('engineering/tool execution request')
    if (research || externalFacts) reasons.push('requires web evidence')
  } else if (research || externalFacts) {
    intent = 'research_work'
    workClass = 'research'
    reasons.push(research ? 'explicit research request' : 'external/current facts request')
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
    simpleRemote,
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
  initializeRuntimePlan(state.current)
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
      simpleRemote: false,
      confidence: 'low',
      reasons: [],
      gates: {},
      changedFiles: [],
      editCount: 0,
      phase: 'classify',
      phaseHistory: [],
      requiredPhases: [],
      completedPhases: ['intake', 'classify'],
      expectedLanes: [],
      completedLanes: [],
      laneEvents: [],
      activeAgents: {},
      toolCount: 0,
      quality: null,
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
  ensureRuntimePlan(state.current)
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

function isWebLookupTool(tool, command) {
  return tool === 'WebSearch' || tool === 'WebFetch' || (tool === 'Bash' && isBrowserCommand(command))
}

function webLookupText(tool, toolInput, command) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {}
  if (tool === 'WebSearch') return String(input.query || '')
  if (tool === 'WebFetch') return `${input.url || ''} ${input.prompt || ''}`
  if (tool === 'Bash') return String(command || '')
  return ''
}

function hasExplicitWebRequest(text) {
  return /(websearch|web search|web\s*搜索|用\s*web|使用\s*web|联网|上网|搜索|搜一下|查一下|browse|search|look up|research|调研)/i.test(String(text || ''))
}

function isProbablyLocalStatusLookup(text) {
  const value = String(text || '')
  return matchesAny(value, [
    /(claude|root-auto|root auto|enterprise|ceo|super).{0,50}(mode|status|config|version|模式|状态|配置|版本|开了吗|启用了吗)/i,
    /(现在|当前|目前|此刻|这里).{0,50}(claude|root-auto|root auto|enterprise|ceo|super|模式|状态|配置|版本)/i,
    /(你|assistant).{0,50}(现在|当前|目前).{0,50}(什么模式|是不是|状态|配置|版本)/i,
  ])
}

function promoteLocalStatusToResearch(current, lookupText) {
  current.intent = 'research_work'
  current.workClass = 'research'
  current.mode = 'research'
  current.execution = false
  current.discussion = false
  current.research = true
  current.localStatusQuestion = false
  current.requiresWeb = true
  current.needsWeb = true
  current.reasons ||= []
  addUnique(current.reasons, 'explicit web/external lookup override')
  completePhase(current, 'classify', `web lookup override: ${truncate(lookupText, 120)}`)
  ensureRuntimePlan(current)
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

function isGitPushCommand(command) {
  return /\bgit\s+push\b/i.test(String(command || ''))
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

  current.toolCount = (current.toolCount || 0) + 1

  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(tool)) {
    current.editCount += 1
    rememberChangedFile(current, input.cwd, fileFromToolInput(toolInput))
    completePhase(current, 'execute', tool)
    addUnique(current.completedLanes, 'implementer')
  }
  if (tool === 'TodoWrite') {
    current.todoUsed = true
    completePhase(current, 'plan', tool)
  }
  if (tool === 'WebFetch' || tool === 'WebSearch') {
    current.webUsed = true
    completePhase(current, 'verify', tool)
    completeLane(current, 'research', tool)
  }
  if (tool === 'Task' || tool === 'Agent') {
    current.agentUsed = true
    const text = JSON.stringify(summarizeToolInput(tool, toolInput))
    completeLane(current, laneFromText(text), text)
    if (/(review|reviewer|qa|test|verify|审查|测试|验证)/i.test(text)) current.reviewerUsed = true
  }
  if (tool === 'Bash') {
    completePhase(current, 'execute', 'bash')
    if (isRemoteCommand(command)) {
      current.remoteOpsRan = true
      current.remoteOpsType = isGitPushCommand(command) ? 'git_push' : 'remote'
      const response = JSON.stringify(redact(input.tool_response || {}))
      current.remoteOpsFailed = /(exit\s*code[^0-9]*[1-9]|failed|error|fatal|denied|rejected|Command failed)/i.test(response)
      if (current.simpleRemote && !current.remoteOpsFailed) completePhase(current, 'verify', 'remote command completed')
    }
    if (isTestCommand(command)) {
      current.testRan = true
      current.verificationRan = true
      completePhase(current, 'verify', 'test command')
      completeLane(current, 'qa', command)
      const response = JSON.stringify(redact(input.tool_response || {}))
      if (/(exit\s*code[^0-9]*[1-9]|failed|error|FAIL|Command failed)/i.test(response)) current.verificationFailed = true
      else current.verificationFailed = false
    }
    if (isDiffCommand(command)) {
      current.diffViewed = true
      completePhase(current, 'verify', 'diff command')
    }
    if (isBrowserCommand(command)) {
      current.browserUsed = true
      current.webUsed = true
      completePhase(current, 'verify', 'browser command')
      completeLane(current, 'research', command)
    }
  }
  ensureRuntimePlan(current)

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
      phase: current.phase,
      completedPhases: current.completedPhases,
      expectedLanes: current.expectedLanes,
      completedLanes: current.completedLanes,
    },
  })
}

function markToolFailure(input) {
  const state = currentState(input)
  const current = state.current
  const tool = input.tool_name || ''
  const command = commandText(input)
  current.toolCount = (current.toolCount || 0) + 1
  current.commandFailures.push({
    tool,
    command: truncate(redactString(command), 800),
    error: truncate(redactString(input.error || ''), 800),
  })
  if (tool === 'Bash') completePhase(current, 'execute', 'failed bash')
  if (tool === 'Bash' && isTestCommand(command)) {
    current.testRan = true
    current.verificationRan = true
    current.verificationFailed = true
    completePhase(current, 'verify', 'failed test command')
  }
  if (tool === 'Bash' && isRemoteCommand(command)) {
    current.remoteOpsRan = true
    current.remoteOpsType = isGitPushCommand(command) ? 'git_push' : 'remote'
    current.remoteOpsFailed = true
  }
  ensureRuntimePlan(current)
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
    `phase machine: ${enabledText(process.env.CLAUDE_CODE_PHASE_MACHINE)}`,
    `quality gate: ${process.env.CLAUDE_CODE_QUALITY_GATE || 'hard'}`,
    `delegation policy: ${process.env.CLAUDE_CODE_DELEGATION_POLICY || 'proactive'}`,
    `project memory scope: ${process.env.CLAUDE_CODE_PROJECT_MEMORY_SCOPE || 'project'}`,
    `tool registry: ${enabledText(process.env.CLAUDE_CODE_TOOL_REGISTRY)}`,
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
  ensureRuntimePlan(current)
  const memorySummary = readProjectMemorySummary(input.cwd || process.cwd())
  const lines = [
    'Enterprise Runtime Context:',
    `- Version: ${VERSION}`,
    '- Mode: CEO scheduler with software intent router, phase machine, proactive lanes, and hard quality gates.',
    '- Local root-auto actions are allowed; do not ask for yes/no confirmation for local reads, edits, installs, tests, or dev servers.',
    '- Remote side effects are explicit-only: git push, publish, release, cloud/prod changes, secret operations.',
    '- Intent routing: chat/local_status/discussion stay lightweight; creative_work delivers finished content; research_work gathers evidence; engineering_work executes with verification; remote_ops require explicit user intent.',
    '- For chat or local_status, answer directly from local runtime context. Do not browse, run tools, or create TodoWrite unless the user explicitly asks for WebSearch/external research or real work.',
    '- For creative_work, deliver the complete polished artifact now, self-review it for structure, voice, specificity, and AI-sounding filler, and never answer with "I can write" when the user already requested content.',
    '- For research_work or current/latest/external/version/API/docs facts, use web/root-auto-browser evidence and cite sources.',
    '- For engineering_work, move through plan/delegate/execute/verify/review: TodoWrite for broad work, Task lanes for architect/reviewer/QA when expected, diff inspection, and the closest test/check/build after edits.',
    '- Tool registry: rg for code search, git diff/status/show for review, node --check for JS, bash -n for shell, root-auto-browser for JS-heavy or unavailable web tools.',
    `- Current turn intent: ${current.intent || 'unknown'}, workClass: ${current.workClass || 'none'}, mode: ${current.mode || 'mixed'}, complex: ${Boolean(current.complex)}, needsWeb: ${Boolean(current.needsWeb ?? current.requiresWeb)}.`,
    `- Phase: ${current.phase || 'classify'}; required phases: ${(current.requiredPhases || []).join(', ') || 'none'}; completed phases: ${(current.completedPhases || []).join(', ') || 'none'}.`,
    `- Expected lanes: ${(current.expectedLanes || []).join(', ') || 'none'}; completed lanes: ${(current.completedLanes || []).join(', ') || 'none'}; quality threshold: ${qualityThreshold(current) || 'none'}.`,
    current.reasons?.length ? `- Classifier reasons: ${current.reasons.join(', ')}.` : '- Classifier reasons: none.',
    '- Never print or store raw secrets. Ledger and memory are project-local under .claude/enterprise.',
  ]
  if (memorySummary) {
    lines.push('Project memory summary:')
    lines.push(memorySummary)
  }
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
  const lookupText = webLookupText(tool, input.tool_input, command)

  if (
    current.intent === 'local_status' &&
    !isTruthy(process.env.CLAUDE_CODE_LOCAL_STATUS_WEB ?? '0') &&
    isWebLookupTool(tool, command)
  ) {
    if (hasExplicitWebRequest(current.prompt) || !isProbablyLocalStatusLookup(lookupText)) {
      promoteLocalStatusToResearch(current, lookupText)
      saveState(input, state)
    } else {
      appendLedger(input, {
        event: 'pre_tool',
        turn: current.turn,
        data: { tool, intent: current.intent, workClass: current.workClass, input: summarizeToolInput(tool, input.tool_input), blocked: 'local_status_web' },
      })
      return {
        decision: 'block',
        reason: 'Local runtime/status questions must be answered from the local enterprise context; web lookup is disabled for local-status lookups. If the user explicitly asks for WebSearch, start a new research turn or include that instruction in the prompt.',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Local status does not need web evidence.',
        },
      }
    }
  }

  appendLedger(input, {
    event: 'pre_tool',
    turn: current.turn,
    data: { tool, intent: current.intent, workClass: current.workClass, input: summarizeToolInput(tool, input.tool_input) },
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
  const assistantText = compactAssistantText(lastAssistantText(input))
  const statusOnlyUpdate = isStatusOnlyUpdate(assistantText)
  if (assistantText && current.workClass !== 'none' && current.intent !== 'remote_ops' && !statusOnlyUpdate) completePhase(current, 'execute', 'assistant output')
  ensureRuntimePlan(current)
  const waitingLanes = activeLanes(current)
  const progressUpdate = isProgressUpdate(assistantText)
  const changedCount = current.changedFiles.length
  const gatesActive = []
  const gatesSkipped = []
  const needsWeb = Boolean(current.needsWeb ?? current.requiresWeb)
  const hardQualityGate = envMode('CLAUDE_CODE_QUALITY_GATE', 'hard') === 'hard'
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

  if (current.intent === 'remote_ops' && current.simpleRemote) {
    if (!current.remoteOpsRan) {
      violations.push('Run the explicitly requested git push before reporting it as done.')
    } else if (current.remoteOpsFailed) {
      violations.push('The git push failed. Fix the remote operation or report the concrete blocker.')
    }
  }

  const missingLanes = current.expectedLanes.filter(lane => !current.completedLanes.includes(lane))
  if (!chatLike && missingLanes.length > 0) {
    violations.push(`Complete the expected specialist lane(s) before finalizing: ${missingLanes.join(', ')}.`)
  }

  const missingPhases = current.requiredPhases.filter(phase => phase !== 'finalize' && !current.completedPhases.includes(phase))
  if (!chatLike && missingPhases.length > 0) {
    violations.push(`Advance the runtime phase machine before finalizing; missing phase(s): ${missingPhases.join(', ')}.`)
  }

  if (researchGate && !current.webUsed && !current.browserUsed) {
    violations.push('Use web evidence for current/latest/external/version/API/docs facts before finalizing.')
  }

  if (creativeGate) {
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

  const quality = scoreQuality(current, input)
  if (hardQualityGate && quality.threshold > 0 && quality.finalScore < quality.threshold) {
    violations.push(`Quality score ${quality.finalScore}/${quality.threshold} is below the hard gate. Improve the missing dimensions before finalizing.`)
  }

  const awaitingSubagents = waitingLanes.length > 0 && progressUpdate
  if (awaitingSubagents || statusOnlyUpdate) {
    const softViolations = [...violations]
    appendLedger(input, {
      event: statusOnlyUpdate ? 'stop_gate_status_update' : 'stop_gate_progress',
      turn: current.turn,
      data: {
        intent: current.intent,
        workClass: current.workClass,
        phase: current.phase,
        activeLanes: waitingLanes,
        statusOnlyUpdate,
        quality,
        softViolations,
      },
    })
    saveState(input, state)
    return null
  }

  appendLedger(input, {
    event: 'stop_gate',
    turn: current.turn,
    data: {
      intent: current.intent,
      workClass: current.workClass,
      phase: current.phase,
      requiredPhases: current.requiredPhases,
      completedPhases: current.completedPhases,
      expectedLanes: current.expectedLanes,
      completedLanes: current.completedLanes,
      quality,
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

  if (violations.length === 0) {
    completePhase(current, 'finalize', 'stop gate passed')
    saveState(input, state)
    return null
  }

  const maxRetries = Math.max(0, Number.parseInt(process.env.CLAUDE_CODE_GATE_MAX_RETRIES || '3', 10) || 0)
  if (current.gateAttempts >= maxRetries) {
    return {
      suppressOutput: true,
      systemMessage: `Enterprise gate reached max retries. Continue working if possible; final answer must disclose unresolved checks only if you are genuinely blocked: ${violations.join(' | ')}`,
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
      const startText = `${input.agent_type || ''} ${input.agent_id || ''} ${input.description || ''} ${input.prompt || ''} ${input.name || ''}`
      const lane = laneFromText(startText)
      const agentId = String(input.agent_id || `${lane}-${Date.now()}`)
      ensureRuntimePlan(state.current)
      completePhase(state.current, 'delegate', `subagent_start:${lane}`)
      state.current.activeAgents[agentId] = { lane, status: 'started', startedAt: new Date().toISOString(), agent_type: input.agent_type || '' }
      state.current.laneEvents.push({ lane, status: 'started', ts: new Date().toISOString(), reason: 'subagent_start' })
      saveState(input, state)
      appendLedger(input, { event: 'subagent_start', turn: state.current.turn, data: { agent_type: input.agent_type, agent_id: input.agent_id, lane, activeAgents: Object.keys(state.current.activeAgents).length } })
      jsonOut({
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'SubagentStart',
          additionalContext: `Enterprise subagent lane: ${lane}. Return structured summary, evidence, changed files, commands/tests, risks, quality concerns, and next action.`,
        },
      })
      return
    }
    case 'SubagentStop': {
      const state = currentState(input)
      const agentId = String(input.agent_id || '')
      const storedLane = agentId ? state.current.activeAgents?.[agentId]?.lane : null
      const lane = storedLane || laneFromText(`${input.agent_type || ''} ${input.agent_id || ''} ${input.last_assistant_message || ''}`)
      if (agentId && state.current.activeAgents?.[agentId]) {
        state.current.activeAgents[agentId] = { ...state.current.activeAgents[agentId], status: 'completed', completedAt: new Date().toISOString() }
        delete state.current.activeAgents[agentId]
      }
      completeLane(state.current, lane, 'subagent_stop')
      saveState(input, state)
      appendLedger(input, { event: 'subagent_stop', turn: state.current.turn, data: { agent_type: input.agent_type, agent_id: input.agent_id, lane, activeAgents: Object.keys(state.current.activeAgents || {}).length, last: truncate(input.last_assistant_message || '', 1200) } })
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
