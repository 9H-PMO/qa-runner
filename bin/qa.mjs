#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crawl, sitemapPages } from '../src/crawl.mjs'
import { siteFacts, runLighthouse } from '../src/site.mjs'
import { runChecks } from '../src/checks.mjs'
import { renderHtml } from '../src/report.mjs'

const STANDARD_VERSION = '1.0'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt }
const url = args.find((a) => /^https?:\/\//.test(a))
if (!url) {
  console.error('Usage: qa <url> [--project name] [--pages 20] [--out dir] [--stage staging|live] [--config qa.project.json] [--strict] [--quiet]')
  process.exit(2)
}

const config = JSON.parse(fs.readFileSync(path.join(root, 'qa.config.json'), 'utf8'))
const overridePath = flag('config', fs.existsSync('qa.project.json') ? 'qa.project.json' : null)
if (overridePath) deepMerge(config, JSON.parse(fs.readFileSync(overridePath, 'utf8')))
if (flag('pages')) config.crawl.maxPages = Number(flag('pages'))

const quiet = args.includes('--quiet')
const log = (m) => !quiet && console.error(m)
const host = new URL(url).host
const startedAt = new Date()
const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outBase = path.resolve(flag('out', path.join(root, 'reports')))
const outDir = path.join(outBase, host.replace(/[:]/g, '_'), stamp)
fs.mkdirSync(outDir, { recursive: true })

if (flag('stage')) process.env.QA_STAGE = flag('stage')
log(`QA ${url}`)
// Lighthouse first: crawling first can trip hosting firewalls and leave Lighthouse with a challenge page.
log('1/4 Lighthouse')
const lhUrls = [...new Set([new URL(url).href, ...(await sitemapPages(new URL(url), 10))])].slice(0, config.crawl.lighthousePages)
const lighthouseResults = await runLighthouse(lhUrls, log)
log('2/4 crawling pages')
const pages = await crawl(url, config, log)
log('3/4 site checks')
const site = await siteFacts(url, pages, config, log, lighthouseResults)
log('4/4 scoring')
const categories = await runChecks(pages, site, config)

const totalWeight = Object.keys(categories).reduce((s, k) => s + (config.weights[k] ?? 0), 0)
const overall = Math.round(Object.values(categories).reduce((s, c) => s + (c.score ?? 0) * (config.weights[c.key] ?? 0), 0) / totalWeight)
const failedGates = Object.values(categories).filter((c) => c.status === 'fail').map((c) => c.label)
// If the host's firewall blocked us, the scores describe a challenge page, not the site.
const incomplete = pages[0]?.challenged || pages.filter((p) => p.challenged).length > pages.length * 0.3 || site.lighthouse.every((r) => r.error)

// Screenshots go to files too, so the /qa skill can review them visually.
const screenshots = pages.filter((p) => Object.keys(p.screenshots).length).map((p, i) => {
  for (const [v, b64] of Object.entries(p.screenshots)) fs.writeFileSync(path.join(outDir, `shot-${i}-${v}.jpg`), Buffer.from(b64, 'base64'))
  return { url: p.url, ...p.screenshots }
})

const report = {
  standardVersion: STANDARD_VERSION, project: flag('project', config.project ?? host), url, host,
  startedAt: startedAt.toISOString(), durationSec: Math.round((Date.now() - startedAt) / 1000),
  pagesCrawled: pages.length, stage: site.live ? 'live' : 'staging', overall, verdict: incomplete ? 'INCOMPLETE' : failedGates.length ? 'FAIL' : 'PASS', failedGates,
  projectOverrides: !!overridePath, categories, lighthouse: site.lighthouse,
}
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2))
fs.writeFileSync(path.join(outDir, 'report.html'), renderHtml({ ...report, screenshots }))
fs.appendFileSync(path.join(outBase, 'history.jsonl'), JSON.stringify({ project: report.project, url, at: report.startedAt, overall, verdict: report.verdict, scores: Object.fromEntries(Object.values(categories).map((c) => [c.key, c.score])) }) + '\n')

console.log(`\n${report.verdict}  overall ${overall}/100  (${pages.length} pages)`)
if (incomplete) console.log('  Blocked by the host firewall. Set QA_VERCEL_BYPASS or allow-list the runner, then re-run.')
for (const c of Object.values(categories)) console.log(`  ${c.status.toUpperCase().padEnd(5)} ${String(c.score ?? '-').padStart(3)}  ${c.label}  (${c.findings.length})`)
console.log(`\nReport: ${path.join(outDir, 'report.html')}`)
process.exit(args.includes('--strict') && report.verdict !== 'PASS' ? 1 : 0)

function deepMerge(t, s) {
  for (const [k, v] of Object.entries(s)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) deepMerge((t[k] ??= {}), v)
    else t[k] = v
  }
}
