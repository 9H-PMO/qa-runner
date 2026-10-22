import tls from 'node:tls'
import dns from 'node:dns/promises'
import lighthouse from 'lighthouse'
import * as chromeLauncher from 'chrome-launcher'
import { USER_AGENT, extraHeaders, httpFetch } from './http.mjs'

const PLATFORM_HOSTS = /(\.vercel\.app|\.netlify\.app|\.replit\.app|\.repl\.co|\.pages\.dev|localhost|127\.0\.0\.1)$/

// Site-level facts (not per page): robots, sitemap, TLS, DNS, probes, Lighthouse.
export async function siteFacts(baseUrl, pages, config, log, lighthouseResults) {
  const base = new URL(baseUrl)
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(base.hostname)
  const ownDomain = !PLATFORM_HOSTS.test(base.hostname)
  const live = (process.env.QA_STAGE ?? (ownDomain && !isLocal ? 'live' : 'staging')) === 'live'
  const apex = base.hostname.replace(/^www\./, '')
  const get = (path, opts = {}) => httpFetch(new URL(path, base), { redirect: 'manual', ...opts }).catch(() => null)

  const [robots, sitemap, llms, notFound] = await Promise.all([get('/robots.txt'), get('/sitemap.xml'), get('/llms.txt'), get('/qa-check-this-page-should-not-exist-404')])
  const facts = {
    isLocal, ownDomain, apex, live,
    robotsTxt: robots?.ok ? await robots.text() : null,
    sitemapOk: !!sitemap?.ok,
    llmsTxt: !!llms?.ok,
    notFoundStatus: notFound?.status ?? null,
  }

  log('  probing exposed files')
  const exposed = []
  for (const p of ['/.env', '/.env.local', '/.git/config', '/.DS_Store', '/wp-config.php.bak', '/backup.zip', '/server-status', '/phpinfo.php']) {
    const r = await get(p)
    if (r?.status === 200 && !/text\/html/.test(r.headers.get('content-type') ?? '')) exposed.push(p)
  }
  facts.exposed = exposed

  if (!isLocal && base.protocol === 'https:') {
    const http = await httpFetch(`http://${base.host}/`, { redirect: 'manual' }).catch(() => null)
    facts.httpRedirectsToHttps = !!http && http.status >= 300 && http.status < 400 && /^https:/.test(http.headers.get('location') ?? '')
    facts.certDaysLeft = await certDays(base.hostname)
  }

  if (ownDomain && !isLocal) {
    log('  checking DNS / email auth')
    const txt = await dns.resolveTxt(apex).catch(() => [])
    const dmarc = await dns.resolveTxt(`_dmarc.${apex}`).catch(() => [])
    facts.mx = (await dns.resolveMx(apex).catch(() => [])).length > 0
    facts.spf = txt.map((t) => t.join('')).find((t) => t.startsWith('v=spf1')) ?? null
    facts.dmarc = dmarc.map((t) => t.join('')).find((t) => t.startsWith('v=DMARC1')) ?? null
    const caa = await dns.resolveCaa(apex).catch(() => [])
    facts.caa = caa.length > 0
  }

  // Raw HTML (no JS) vs rendered text tells us whether crawlers and AI bots see the content.
  const home = pages[0]
  const raw = await httpFetch(base).then((r) => r.text()).catch(() => '')
  const rawText = raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  facts.ssrRatio = home?.text ? Math.min(1, rawText.length / Math.max(1, home.text.replace(/\s+/g, ' ').length)) : null

  facts.lighthouse = lighthouseResults
  return facts
}

async function certDays(host) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 8000 }, () => {
      const c = s.getPeerCertificate()
      s.end()
      resolve(c?.valid_to ? Math.floor((new Date(c.valid_to) - Date.now()) / 86400000) : null)
    })
    s.on('error', () => resolve(null))
    s.on('timeout', () => { s.destroy(); resolve(null) })
  })
}

export async function runLighthouse(urls, log) {
  const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-sandbox'] })
  const results = []
  try {
    for (const url of urls) {
      log(`  lighthouse ${url}`)
      const r = await lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance', 'accessibility', 'seo', 'best-practices'], formFactor: 'mobile', extraHeaders, emulatedUserAgent: USER_AGENT, screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false } }).catch((e) => ({ error: e.message }))
      if (!r?.lhr || r.lhr.runtimeError) { results.push({ url, error: r?.lhr?.runtimeError?.message ?? r?.error ?? 'failed' }); continue }
      const { categories: c, audits: a } = r.lhr
      const score = (k) => (c[k]?.score == null ? null : Math.round(c[k].score * 100))
      results.push({
        url,
        performance: score('performance'), accessibility: score('accessibility'), seo: score('seo'), bestPractices: score('best-practices'),
        lcp: a['largest-contentful-paint']?.numericValue, cls: a['cumulative-layout-shift']?.numericValue, tbt: a['total-blocking-time']?.numericValue,
        opportunities: Object.values(a).filter((x) => x.details?.type === 'opportunity' && (x.details.overallSavingsMs ?? 0) > 150).sort((x, y) => y.details.overallSavingsMs - x.details.overallSavingsMs).slice(0, 4).map((x) => `${x.title} (~${Math.round(x.details.overallSavingsMs)}ms)`),
      })
    }
  } finally {
    await chrome.kill()
  }
  return results
}
