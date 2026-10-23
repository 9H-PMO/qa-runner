import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { expect } from '@playwright/test'
import YAML from 'yaml'

import { USER_AGENT, bypassHeaders, hasBypass, isTarget } from './http.mjs'

// User journeys: qa.stories.yml (the plain-language stories, reviewed by a PM) + qa.journeys.mjs (one Playwright
// function per story id, exported as default { [id]: async (ctx) => {} }). Both live in the site's repo.
// A story with no function is reported as "not automated" rather than silently skipped.

const SEVERITY = { critical: 'critical', high: 'high', normal: 'medium' }

export function loadStories(dir) {
  const file = path.join(dir, 'qa.stories.yml')
  if (!fs.existsSync(file)) return null
  return { file, ...YAML.parse(fs.readFileSync(file, 'utf8')) }
}

export async function runJourneys(baseUrl, config, dir, log) {
  const stories = loadStories(dir)
  if (!stories) return null
  const jsFile = path.join(dir, 'qa.journeys.mjs')
  const impl = fs.existsSync(jsFile) ? (await import(pathToFileURL(jsFile).href)).default : {}
  const formSecret = process.env.QA_FORM_SECRET
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const results = []

  for (const story of stories.stories) {
    const viewports = story.viewports ?? ['mobile', 'desktop']
    for (const vp of viewports) {
      const fn = impl[story.id]
      if (!fn) { results.push({ story, vp, status: 'missing' }); continue }
      if (story.submits && !formSecret) { results.push({ story, vp, status: 'skipped', reason: 'QA_FORM_SECRET not set (would send real emails)' }); continue }
      log(`  journey ${story.id} (${vp})`)
      const context = await browser.newContext({ viewport: config.viewports[vp], userAgent: USER_AGENT, deviceScaleFactor: 1, hasTouch: vp === 'mobile', isMobile: vp === 'mobile' })
      // Same rule as the crawler: secrets only ever go to the site under test. Redirects are handed back to the browser.
      if (hasBypass || formSecret) {
        await context.route((u) => isTarget(u.href), async (route) => {
          const req = route.request()
          const headers = { ...req.headers(), ...bypassHeaders }
          if (formSecret && req.method() === 'POST' && /\/api\/forms\/[^/]+\/submit/.test(req.url())) headers['x-qa-test'] = formSecret
          const response = await route.fetch({ headers, maxRedirects: 0 }).catch(() => null)
          // The context may close while this is in flight (journey done): ignore, or Node exits on the rejection.
          return (response ? route.fulfill({ response }) : route.abort()).catch(() => {})
        })
      }
      const page = await context.newPage()
      page.setDefaultTimeout(15000)
      let current = 'start'
      const step = (name) => { current = name }
      const started = Date.now()
      try {
        await fn({ page, base: baseUrl.replace(/\/$/, ''), url: (p) => new URL(p, baseUrl).href, expect, step, viewport: vp, isMobile: vp === 'mobile', qa: '[QA TEST]' })
        results.push({ story, vp, status: 'pass', ms: Date.now() - started })
      } catch (e) {
        const shot = await page.screenshot({ type: 'jpeg', quality: 55 }).catch(() => null)
        results.push({ story, vp, status: 'fail', step: current, error: String(e.message).split('\n').slice(0, 6).join('\n').slice(0, 700), at: page.url(), screenshot: shot?.toString('base64') })
      }
      await context.close()
    }
  }
  await browser.close()
  return { file: stories.file, results }
}

// Turns journey results into a scorecard category (same shape as checks.mjs categories).
export function journeysCategory(run) {
  const PENALTY = { critical: 40, high: 20, medium: 8, low: 3 }
  const f = []
  const byStory = new Map()
  for (const r of run.results) (byStory.get(r.story.id) ?? byStory.set(r.story.id, []).get(r.story.id)).push(r)
  for (const [id, rs] of byStory) {
    const story = rs[0].story
    const failed = rs.filter((r) => r.status === 'fail')
    if (failed.length) {
      const sev = SEVERITY[story.priority] ?? 'medium'
      f.push({
        severity: sev, gate: sev !== 'medium',
        title: `Story failed: ${story.as}, ${story.i_want} (${id}, ${failed.map((r) => r.vp).join(' + ')})`,
        detail: failed.map((r) => `[${r.vp}] step "${r.step}" at ${r.at}\n${r.error}`).join('\n\n'),
        image: failed[0].screenshot,
      })
    }
    if (rs.some((r) => r.status === 'missing')) f.push({ severity: 'low', title: `Story not automated yet: ${id}`, fix: 'Add a function for it to qa.journeys.mjs.' })
    for (const r of rs.filter((r) => r.status === 'skipped')) f.push({ severity: 'low', title: `Story skipped: ${id} (${r.vp})`, detail: r.reason })
  }
  const total = run.results.filter((r) => r.status === 'pass' || r.status === 'fail').length
  const passed = run.results.filter((r) => r.status === 'pass').length
  const score = Math.max(0, 100 - f.reduce((s, x) => s + PENALTY[x.severity], 0))
  return {
    key: 'journeys', label: 'User journeys', score,
    status: f.some((x) => x.gate) ? 'fail' : f.length ? 'warn' : 'pass',
    findings: f.sort((a, b) => PENALTY[b.severity] - PENALTY[a.severity]),
    metrics: { stories: byStory.size, runs: `${passed}/${total} passed` },
  }
}
