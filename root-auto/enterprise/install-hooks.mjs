#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '../..')
const HOOK_SCRIPT = join(REPO_ROOT, 'root-auto', 'enterprise', 'enterprise-hook.mjs')
const SETTINGS_PATH = join(os.homedir(), '.claude', 'settings.json')
const SKILLS_SRC = join(REPO_ROOT, 'root-auto', 'skills')
const SKILLS_DST = join(os.homedir(), '.claude', 'skills')

function shellQuote(value) {
  return `"${String(value).replace(/(["\\$`])/g, '\\$1')}"`
}

function loadSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
  } catch (error) {
    if (existsSync(SETTINGS_PATH)) {
      writeFileSync(`${SETTINGS_PATH}.enterprise-bak`, readFileSync(SETTINGS_PATH, 'utf8'), 'utf8')
    }
    return {}
  }
}

function sameHook(hook, command) {
  return hook && hook.type === 'command' && typeof hook.command === 'string' && hook.command.includes(command)
}

function addHook(settings, event, matcher, command, timeout = 60) {
  settings.hooks ||= {}
  settings.hooks[event] ||= []
  const matchers = settings.hooks[event]
  let entry = matchers.find(item => (item.matcher || '') === (matcher || ''))
  if (!entry) {
    entry = matcher ? { matcher, hooks: [] } : { hooks: [] }
    matchers.push(entry)
  }
  entry.hooks = (entry.hooks || []).filter(hook => !sameHook(hook, 'enterprise-hook.mjs'))
  entry.hooks.push({
    type: 'command',
    command,
    timeout,
    statusMessage: 'Enterprise runtime gate',
  })
}

function syncSkills() {
  if (!existsSync(SKILLS_SRC)) return
  mkdirSync(SKILLS_DST, { recursive: true })
  for (const name of ['super', 'normal', 'company', 'board', 'root-auto-status']) {
    const src = join(SKILLS_SRC, name)
    if (existsSync(src)) cpSync(src, join(SKILLS_DST, name), { recursive: true, force: true })
  }
}

function main() {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true })
  const settings = loadSettings()
  settings.skipDangerousModePermissionPrompt = true
  settings.permissions ||= {}
  settings.permissions.defaultMode = 'bypassPermissions'
  settings.autoMemoryEnabled = true
  settings.autoMemoryConsolidationEnabled = true

  const command = `node ${shellQuote(HOOK_SCRIPT)}`
  addHook(settings, 'SessionStart', '', command, 20)
  addHook(settings, 'UserPromptSubmit', '', command, 20)
  addHook(settings, 'PreToolUse', 'Bash|Write|Edit|MultiEdit|NotebookEdit|TodoWrite|Task|Agent|WebFetch|WebSearch', command, 20)
  addHook(settings, 'PermissionRequest', 'Bash|Write|Edit|MultiEdit|NotebookEdit|TodoWrite|Task|Agent', command, 20)
  addHook(settings, 'PostToolUse', 'Bash|Write|Edit|MultiEdit|NotebookEdit|TodoWrite|Task|Agent|WebFetch|WebSearch', command, 20)
  addHook(settings, 'PostToolUseFailure', 'Bash|Write|Edit|MultiEdit|NotebookEdit|TodoWrite|Task|Agent|WebFetch|WebSearch', command, 20)
  addHook(settings, 'SubagentStart', '', command, 20)
  addHook(settings, 'SubagentStop', '', command, 20)
  addHook(settings, 'Stop', '', command, 20)
  addHook(settings, 'PreCompact', '', command, 20)
  addHook(settings, 'PostCompact', '', command, 20)
  addHook(settings, 'SessionEnd', '', command, 20)

  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  syncSkills()

  if (!process.argv.includes('--quiet')) {
    console.log(`Enterprise hooks installed into ${SETTINGS_PATH}`)
  }
}

main()
