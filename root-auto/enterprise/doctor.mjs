#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import os from 'os'

const VERSION = '2.1.88-root-auto-enterprise-deepseek.1'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '../..')
const SETTINGS_PATH = join(os.homedir(), '.claude', 'settings.json')

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    return error.stdout?.toString().trim() || error.stderr?.toString().trim() || 'failed'
  }
}

function settingsHasHooks() {
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    const text = JSON.stringify(settings.hooks || {})
    return text.includes('enterprise-hook.mjs')
  } catch {
    return false
  }
}

function packageInstalled() {
  const out = run('npm', ['ls', '-g', '@anthropic-ai/claude-code', '--depth=0'])
  return !/empty|failed|missing/i.test(out)
}

function main() {
  const whichClaude = run('bash', ['-lc', 'command -v claude || true'])
  const version = run('bash', ['-lc', 'claude --version || true'])
  const browserPkg = existsSync(join(REPO_ROOT, 'root-auto', 'tools', 'browser', 'node_modules', 'playwright'))
  const hook = existsSync(join(REPO_ROOT, 'root-auto', 'enterprise', 'enterprise-hook.mjs'))
  const browser = existsSync(join(REPO_ROOT, 'root-auto', 'tools', 'browser', 'root-auto-browser'))
  const git = run('git', ['-C', REPO_ROOT, 'status', '--short', '--branch'])

  console.log('Claude Code Root-Auto Enterprise Doctor')
  console.log(`version target: ${VERSION}`)
  console.log(`which claude: ${whichClaude}`)
  console.log(`claude --version: ${version}`)
  console.log(`repo: ${REPO_ROOT}`)
  console.log(`enterprise hook file: ${hook ? 'ok' : 'missing'}`)
  console.log(`settings hooks: ${settingsHasHooks() ? 'ok' : 'missing'}`)
  console.log(`browser tool: ${browser ? 'ok' : 'missing'}`)
  console.log(`playwright package: ${browserPkg ? 'ok' : 'not installed yet'}`)
  console.log(`official global npm package: ${packageInstalled() ? 'present' : 'absent'}`)
  console.log('env:')
  const defaults = {
    CLAUDE_CODE_ROOT_AUTO: '1',
    CLAUDE_CODE_ENTERPRISE: '1',
    CLAUDE_CODE_CONTEXT_WINDOW: '1000000',
    CLAUDE_CODE_WEB_POLICY: 'hybrid',
    CLAUDE_CODE_BROWSER_BACKEND: 'playwright',
    CLAUDE_CODE_REMOTE_OPS: 'explicit',
    CLAUDE_CODE_COMPANY_MAX_AGENTS: '6',
    CLAUDE_CODE_GATE_MAX_RETRIES: '3',
  }
  for (const name of [
    'CLAUDE_CODE_ROOT_AUTO',
    'CLAUDE_CODE_ENTERPRISE',
    'CLAUDE_CODE_CONTEXT_WINDOW',
    'CLAUDE_CODE_WEB_POLICY',
    'CLAUDE_CODE_BROWSER_BACKEND',
    'CLAUDE_CODE_REMOTE_OPS',
    'CLAUDE_CODE_COMPANY_MAX_AGENTS',
    'CLAUDE_CODE_GATE_MAX_RETRIES',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_AUTH_TOKEN',
  ]) {
    const value = process.env[name] ?? defaults[name]
    const suffix = process.env[name] === undefined && defaults[name] ? ' (default)' : ''
    console.log(`  ${name}: ${value ? (name.includes('TOKEN') ? '[set redacted]' : `${value}${suffix}`) : '[unset]'}`)
  }
  console.log('git:')
  console.log(git)
}

main()
