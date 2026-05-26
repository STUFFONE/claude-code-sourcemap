#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..')
const VERSION = '2.1.88-root-auto-enterprise-deepseek.1'

function usage() {
  console.log(`root-auto-browser ${VERSION}

Usage:
  root-auto-browser smoke
  root-auto-browser search "query"
  root-auto-browser fetch "url"
  root-auto-browser open "url"
  root-auto-browser snapshot [url]
  root-auto-browser screenshot [url]
  root-auto-browser click "selector" [url]
  root-auto-browser fill "selector" "text" [url]
  root-auto-browser extract "instruction" [url]
`)
}

function projectDir() {
  return join(process.cwd(), '.claude', 'enterprise', 'browser-runs')
}

function ensureDir() {
  const dir = projectDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function writeArtifact(kind, data, ext = 'json') {
  const dir = ensureDir()
  const file = join(dir, `${stamp()}-${kind}.${ext}`)
  writeFileSync(file, ext === 'json' ? `${JSON.stringify(data, null, 2)}\n` : data)
  return file
}

function stateFile() {
  return join(ensureDir(), 'state.json')
}

function readState() {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'))
  } catch {
    return {}
  }
}

function saveState(state) {
  writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function out(data) {
  console.log(JSON.stringify(data, null, 2))
}

async function ensurePlaywright() {
  try {
    return await import('playwright')
  } catch (error) {
    if (!/^(1|true|yes|on)$/i.test(process.env.CLAUDE_CODE_BROWSER_AUTO_INSTALL || '1')) {
      throw error
    }
    const install = spawnSync('npm', ['install', '--prefix', SCRIPT_DIR, '--no-audit', '--no-fund'], { stdio: 'inherit' })
    if (install.status !== 0) throw new Error('npm install for Playwright failed')
    return await import('playwright')
  }
}

async function launchBrowser() {
  const { chromium } = await ensurePlaywright()
  const headless = !/^(1|true|yes|on)$/i.test(process.env.CLAUDE_CODE_BROWSER_HEADED || '')
  try {
    return await chromium.launch({ headless, args: ['--no-sandbox'] })
  } catch (error) {
    if (/Executable doesn't exist|browserType.launch/i.test(String(error?.message || error))) {
      const cli = join(SCRIPT_DIR, 'node_modules', 'playwright', 'cli.js')
      if (existsSync(cli) && /^(1|true|yes|on)$/i.test(process.env.CLAUDE_CODE_BROWSER_AUTO_INSTALL || '1')) {
        const install = spawnSync(process.execPath, [cli, 'install', 'chromium'], { cwd: SCRIPT_DIR, stdio: 'inherit' })
        if (install.status === 0) return await chromium.launch({ headless, args: ['--no-sandbox'] })
      }
    }
    throw error
  }
}

async function newPage(url) {
  const browser = await launchBrowser()
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    userAgent: 'Mozilla/5.0 root-auto-browser AI research tool',
  })
  const page = await context.newPage()
  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForTimeout(1000)
  }
  return { browser, context, page }
}

function decodeDuckUrl(href) {
  try {
    if (href.startsWith('//')) href = `https:${href}`
    const url = new URL(href)
    const uddg = url.searchParams.get('uddg')
    return uddg ? decodeURIComponent(uddg) : href
  } catch {
    return href
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

async function collectSnapshot(page) {
  return await page.evaluate(() => {
    function visible(el) {
      const style = window.getComputedStyle(el)
      const box = el.getBoundingClientRect()
      return style && style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0
    }
    function txt(el) {
      return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    }
    const links = Array.from(document.querySelectorAll('a[href]'))
      .filter(visible)
      .slice(0, 80)
      .map(a => ({ text: txt(a).slice(0, 200), href: a.href }))
      .filter(x => x.text || x.href)
    const buttons = Array.from(document.querySelectorAll('button,input[type=button],input[type=submit]'))
      .filter(visible)
      .slice(0, 50)
      .map((b, i) => ({ index: i, text: txt(b).slice(0, 160), selector: b.id ? `#${b.id}` : b.name ? `[name="${b.name}"]` : null }))
    const inputs = Array.from(document.querySelectorAll('input,textarea,select'))
      .filter(visible)
      .slice(0, 50)
      .map((el, i) => ({ index: i, tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), name: el.getAttribute('name'), placeholder: el.getAttribute('placeholder'), selector: el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : null }))
    const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
      .filter(visible)
      .slice(0, 50)
      .map(h => ({ level: h.tagName.toLowerCase(), text: txt(h).slice(0, 240) }))
    return {
      title: document.title,
      url: location.href,
      headings,
      links,
      buttons,
      inputs,
      text: txt(document.body).slice(0, 12000),
    }
  })
}

async function screenshotPage(page, kind) {
  const file = join(ensureDir(), `${stamp()}-${kind}.png`)
  await page.screenshot({ path: file, fullPage: true })
  return file
}

async function commandSearch(query) {
  const fetchResults = await fetchDuckDuckGo(query).catch(() => [])
  if (fetchResults.length > 0) {
    const artifact = writeArtifact('search', { query, results: fetchResults, source: 'https://html.duckduckgo.com/html/' })
    saveState({ lastUrl: fetchResults[0]?.url, lastSearch: query })
    out({ ok: true, command: 'search', query, results: fetchResults, artifact, backend: 'duckduckgo-html' })
    return
  }

  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const { browser, page } = await newPage(url)
  try {
    const snapshot = await collectSnapshot(page)
    const results = snapshot.links
      .map(link => ({ title: link.text, url: decodeDuckUrl(link.href) }))
      .filter(link => link.title && /^https?:\/\//.test(link.url))
      .filter((link, idx, arr) => arr.findIndex(x => x.url === link.url) === idx)
      .slice(0, 10)
    const artifact = writeArtifact('search', { query, results, source: page.url() })
    saveState({ lastUrl: results[0]?.url || page.url(), lastSearch: query })
    out({ ok: true, command: 'search', query, results, artifact })
  } finally {
    await browser.close()
  }
}

async function fetchDuckDuckGo(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 root-auto-browser AI research tool',
      accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  })
  const html = await response.text()
  const results = []
  const pattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi
  let match
  while ((match = pattern.exec(html)) && results.length < 10) {
    const title = stripHtml(decodeHtml(match[2])).trim()
    const link = decodeDuckUrl(decodeHtml(match[1]))
    const snippet = stripHtml(decodeHtml(match[3] || '')).trim()
    if (title && /^https?:\/\//.test(link) && !results.some(item => item.url === link)) {
      results.push({ title, url: link, snippet })
    }
  }
  return results
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

async function commandFetch(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 root-auto-browser AI research tool' },
    redirect: 'follow',
  })
  const contentType = response.headers.get('content-type') || ''
  const body = await response.text()
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.replace(/\s+/g, ' ').trim() || ''
  const text = contentType.includes('html') ? stripHtml(body).slice(0, 16000) : body.slice(0, 16000)
  const artifact = writeArtifact('fetch', { url: response.url, status: response.status, contentType, title, text })
  saveState({ ...readState(), lastUrl: response.url })
  out({ ok: true, command: 'fetch', url: response.url, status: response.status, contentType, title, text, artifact })
}

async function commandOpen(url, kind = 'open') {
  const { browser, page } = await newPage(url)
  try {
    const snapshot = await collectSnapshot(page)
    const screenshot = await screenshotPage(page, kind)
    const artifact = writeArtifact(kind, snapshot)
    saveState({ ...readState(), lastUrl: page.url(), lastScreenshot: screenshot, lastSnapshot: artifact })
    out({ ok: true, command: kind, url: page.url(), title: snapshot.title, snapshot, screenshot, artifact })
  } finally {
    await browser.close()
  }
}

async function commandSnapshot(url) {
  const target = url || readState().lastUrl
  if (!target) throw new Error('No URL supplied and no previous URL exists')
  await commandOpen(target, 'snapshot')
}

async function commandScreenshot(url) {
  const target = url || readState().lastUrl
  if (!target) throw new Error('No URL supplied and no previous URL exists')
  const { browser, page } = await newPage(target)
  try {
    const screenshot = await screenshotPage(page, 'screenshot')
    saveState({ ...readState(), lastUrl: page.url(), lastScreenshot: screenshot })
    out({ ok: true, command: 'screenshot', url: page.url(), screenshot })
  } finally {
    await browser.close()
  }
}

async function commandClick(selector, url) {
  const target = url || readState().lastUrl
  if (!target) throw new Error('No URL supplied and no previous URL exists')
  const { browser, page } = await newPage(target)
  try {
    await page.locator(selector).first().click({ timeout: 15_000 })
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(1000)
    const snapshot = await collectSnapshot(page)
    const screenshot = await screenshotPage(page, 'click')
    const artifact = writeArtifact('click', { selector, snapshot })
    saveState({ ...readState(), lastUrl: page.url(), lastScreenshot: screenshot, lastSnapshot: artifact })
    out({ ok: true, command: 'click', selector, url: page.url(), snapshot, screenshot, artifact })
  } finally {
    await browser.close()
  }
}

async function commandFill(selector, text, url) {
  const target = url || readState().lastUrl
  if (!target) throw new Error('No URL supplied and no previous URL exists')
  const { browser, page } = await newPage(target)
  try {
    await page.locator(selector).first().fill(text, { timeout: 15_000 })
    const snapshot = await collectSnapshot(page)
    const screenshot = await screenshotPage(page, 'fill')
    const artifact = writeArtifact('fill', { selector, snapshot })
    saveState({ ...readState(), lastUrl: page.url(), lastScreenshot: screenshot, lastSnapshot: artifact })
    out({ ok: true, command: 'fill', selector, url: page.url(), snapshot, screenshot, artifact })
  } finally {
    await browser.close()
  }
}

async function commandExtract(instruction, url) {
  const target = url || readState().lastUrl
  if (!target) throw new Error('No URL supplied and no previous URL exists')
  const { browser, page } = await newPage(target)
  try {
    const snapshot = await collectSnapshot(page)
    const lower = instruction.toLowerCase()
    const extracted = {
      instruction,
      title: snapshot.title,
      url: snapshot.url,
      headings: snapshot.headings,
      links: lower.includes('link') || lower.includes('source') ? snapshot.links.slice(0, 40) : snapshot.links.slice(0, 12),
      text: snapshot.text,
    }
    const artifact = writeArtifact('extract', extracted)
    saveState({ ...readState(), lastUrl: page.url(), lastSnapshot: artifact })
    out({ ok: true, command: 'extract', ...extracted, artifact })
  } finally {
    await browser.close()
  }
}

async function smoke() {
  const { browser, page } = await newPage('data:text/html,<title>root-auto-browser-smoke</title><h1>ok</h1>')
  try {
    const snapshot = await collectSnapshot(page)
    const screenshot = await screenshotPage(page, 'smoke')
    const artifact = writeArtifact('smoke', snapshot)
    out({ ok: true, command: 'smoke', title: snapshot.title, screenshot, artifact })
  } finally {
    await browser.close()
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage()
    return
  }
  if (cmd === '--version' || cmd === 'version') {
    console.log(VERSION)
    return
  }
  if (cmd === 'smoke') return await smoke()
  if (cmd === 'search') return await commandSearch(args.join(' '))
  if (cmd === 'fetch') return await commandFetch(args[0])
  if (cmd === 'open') return await commandOpen(args[0])
  if (cmd === 'snapshot') return await commandSnapshot(args[0])
  if (cmd === 'screenshot') return await commandScreenshot(args[0])
  if (cmd === 'click') return await commandClick(args[0], args[1])
  if (cmd === 'fill') return await commandFill(args[0], args[1] || '', args[2])
  if (cmd === 'extract') return await commandExtract(args[0] || 'extract main facts', args[1])
  throw new Error(`Unknown command: ${cmd}`)
}

main().catch(error => {
  out({ ok: false, error: String(error?.message || error) })
  process.exitCode = 1
})
