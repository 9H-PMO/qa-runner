import { chromium } from 'playwright'
import AxeBuilder from '@axe-core/playwright'
import { USER_AGENT, bypassHeaders, hasBypass, isTarget, httpFetch } from './http.mjs'

// Collects everything the checks need in one pass per page, so each check stays a pure function of this data.
export { sitemapPages }

export async function crawl(baseUrl, config, log) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const base = new URL(baseUrl)
  const queue = [base.href]
  const seen = new Set()
  const pages = []
  const sitemapUrls = await sitemapPages(base, config.crawl.maxPages)
  for (const u of sitemapUrls) queue.push(u)

  while (queue.length && pages.length < config.crawl.maxPages) {
    const url = normalise(queue.shift())
    if (!url || seen.has(url)) continue
    seen.add(url)
    log(`  crawl ${pages.length + 1}/${config.crawl.maxPages} ${url}`)
    const data = await capturePage(browser, url, config, pages.length < 3)
    pages.push(data)
    for (const href of data.links) {
      const n = normalise(href)
      if (n && new URL(n).host === base.host && !seen.has(n) && !/\.(pdf|jpe?g|png|webp|svg|zip|docx?|xlsx?)$/i.test(n)) queue.push(n)
    }
  }
  await browser.close()
  return pages
}

async function capturePage(browser, url, config, withScreenshots) {
  const vp = config.viewports.mobile
  const context = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, userAgent: USER_AGENT })
  // Bypass header only on requests to the site under test (see http.mjs). maxRedirects: 0 hands each redirect back to
  // the browser, so the next hop is routed (and judged) afresh instead of inheriting the header.
  if (hasBypass) {
    await context.route((u) => isTarget(u.href), async (route) => {
      const response = await route.fetch({ headers: { ...route.request().headers(), ...bypassHeaders }, maxRedirects: 0 }).catch(() => null)
      // The context may close while this is in flight (journey/page done): ignore, or Node exits on the rejection.
      return (response ? route.fulfill({ response }) : route.abort()).catch(() => {})
    })
  }
  const page = await context.newPage()
  const consoleErrors = []
  const requests = []
  const failed = []
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 300)))
  page.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 300)))
  page.on('request', (r) => requests.push(r.url()))
  page.on('response', (r) => r.status() >= 400 && failed.push({ url: r.url(), status: r.status() }))
  page.on('requestfailed', (r) => r.failure()?.errorText !== 'net::ERR_ABORTED' && failed.push({ url: r.url(), status: r.failure()?.errorText || 'failed' }))

  const out = { url, status: 0, headers: {}, consoleErrors, requests, failed, links: [], screenshots: {} }
  try {
    const res = await page.goto(url, { waitUntil: 'networkidle', timeout: config.crawl.timeoutMs }).catch(async () =>
      page.goto(url, { waitUntil: 'load', timeout: config.crawl.timeoutMs }))
    out.status = res?.status() ?? 0
    out.headers = res ? await res.allHeaders() : {}
    out.challenged = !!(out.headers['x-vercel-mitigated'] || out.headers['cf-mitigated'])
    out.finalUrl = page.url()
    Object.assign(out, await page.evaluate(extractDom))
    out.cookies = (await context.cookies()).map((c) => ({ name: c.name, domain: c.domain, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite }))
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    out.axe = axe.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') }))
    if (withScreenshots) {
      for (const [name, size] of Object.entries(config.viewports)) {
        await page.setViewportSize(size)
        await page.waitForTimeout(300)
        out.screenshots[name] = (await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 })).toString('base64')
        if (name !== 'mobile') out[`overflow_${name}`] = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
      }
    }
  } catch (e) {
    out.error = String(e.message).slice(0, 300)
  }
  await context.close()
  return out
}

// Runs in the page.
function extractDom() {
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content') ?? null
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const nav = performance.getEntriesByType('navigation')[0]
  const smallText = [...document.querySelectorAll('p, li, a, span, td, label')].filter((el) => visible(el) && el.childElementCount === 0 && el.textContent.trim() && parseFloat(getComputedStyle(el).fontSize) < 12).length
  const smallTargets = [...document.querySelectorAll('a[href], button, input, select, textarea')].filter((el) => {
    if (!visible(el)) return false
    const r = el.getBoundingClientRect()
    return (r.width < 24 || r.height < 24) && getComputedStyle(el).display !== 'inline'
  }).length
  return {
    title: document.title,
    description: meta('meta[name="description"]'),
    robotsMeta: meta('meta[name="robots"]'),
    viewportMeta: meta('meta[name="viewport"]'),
    canonical: document.querySelector('link[rel="canonical"]')?.href ?? null,
    lang: document.documentElement.lang,
    ogTitle: meta('meta[property="og:title"]'),
    ogImage: meta('meta[property="og:image"]'),
    favicon: !!document.querySelector('link[rel~="icon"]'),
    h1: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim()),
    jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap((s) => {
      try { const j = JSON.parse(s.textContent); const items = Array.isArray(j) ? j : j['@graph'] ?? [j]; return items.map((i) => i['@type']).flat() } catch { return ['INVALID'] }
    }),
    links: [...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => /^https?:/.test(h)),
    emptyLinks: [...document.querySelectorAll('a[href]')].filter((a) => visible(a) && !a.textContent.trim() && !a.getAttribute('aria-label') && !a.querySelector('img[alt]:not([alt=""]), svg title')).length,
    imagesMissingAlt: [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).map((i) => i.currentSrc || i.src).slice(0, 20),
    brokenImages: [...document.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src)).map((i) => i.currentSrc || i.src).slice(0, 20),
    oversizedImages: [...document.querySelectorAll('img')].filter((i) => i.naturalWidth > 0 && i.clientWidth > 0 && i.naturalWidth > i.clientWidth * 2.5 && i.naturalWidth > 1200).map((i) => `${i.currentSrc || i.src} (${i.naturalWidth}px shown at ${i.clientWidth}px)`).slice(0, 10),
    text: document.body?.innerText?.slice(0, 50000) ?? '',
    html: document.documentElement.outerHTML.slice(0, 400000),
    overflow_mobile: document.documentElement.scrollWidth > window.innerWidth + 1,
    smallText,
    smallTargets,
    hasPrivacyLink: [...document.querySelectorAll('a')].some((a) => /privacy|cookie/i.test(a.textContent + a.href)),
    hasCookieBanner: /cookie|consent/i.test([...document.querySelectorAll('[class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i], [aria-label*="cookie" i]')].map((e) => e.textContent).join(' ')),
    forms: document.querySelectorAll('form').length,
    ttfb: nav ? Math.round(nav.responseStart - nav.requestStart) : null,
  }
}

function normalise(href) {
  try { const u = new URL(href); u.hash = ''; if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1); return u.href } catch { return null }
}

async function sitemapPages(base, max) {
  try {
    const res = await httpFetch(new URL('/sitemap.xml', base))
    if (!res.ok) return []
    let xml = await res.text()
    const child = [...xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
    if (child.length) xml = (await Promise.all(child.slice(0, 5).map((u) => httpFetch(u).then((r) => r.text()).catch(() => '')))).join('')
    // Sitemaps on previews often point at the production host; re-point them at the URL under test.
    return [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>/g)].map((m) => { const u = new URL(m[1].trim()); return new URL(u.pathname + u.search, base).href }).slice(0, max)
  } catch { return [] }
}
