import { httpFetch, isChallenge } from './http.mjs'

// Each check turns crawl + site facts into findings. A finding with gate: true fails the category.
// Severity drives the score: critical -40, high -20, medium -8, low -3 (floor 0).

const PENALTY = { critical: 40, high: 20, medium: 8, low: 3 }
const LABELS = {
  performance: 'Performance', accessibility: 'Accessibility', seo: 'SEO', security: 'Security', ux: 'UX & functional',
  design: 'Design & layout', privacy: 'Privacy & GDPR', content: 'Content quality', analytics: 'Analytics & tracking',
  reliability: 'Reliability & ops', aeo: 'AEO (AI answers)',
}

export async function runChecks(pages, site, config) {
  const ok = pages.filter((p) => p.status === 200 && !p.error)
  const g = config.gates
  const results = {}
  const cat = (key, findings, metrics = {}, scoreOverride) => {
    const penalty = findings.reduce((s, f) => s + PENALTY[f.severity], 0)
    const score = scoreOverride ?? Math.max(0, 100 - penalty)
    const status = findings.some((f) => f.gate) ? 'fail' : findings.length ? 'warn' : 'pass'
    results[key] = { key, label: LABELS[key], score, status, findings: findings.sort((a, b) => PENALTY[b.severity] - PENALTY[a.severity]), metrics }
  }
  const lh = site.lighthouse.filter((r) => !r.error)
  const avg = (k) => { const v = lh.map((r) => r[k]).filter((x) => x != null); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null }
  const where = (list) => list.slice(0, 5).map((p) => p.url ?? p).join('\n') + (list.length > 5 ? `\n…and ${list.length - 5} more` : '')

  // Performance
  {
    const f = []
    for (const r of lh) {
      if (r.performance < g.performance.lighthouseMobile) f.push({ severity: r.performance < 50 ? 'critical' : 'high', gate: true, title: `Lighthouse mobile performance ${r.performance} (< ${g.performance.lighthouseMobile})`, url: r.url, fix: r.opportunities.join('; ') || 'See Lighthouse report' })
      if (r.lcp > g.performance.lcpMs) f.push({ severity: 'high', gate: true, title: `LCP ${(r.lcp / 1000).toFixed(1)}s (> ${g.performance.lcpMs / 1000}s)`, url: r.url, fix: 'Preload the hero image, serve AVIF/WebP at the right size, avoid client-only rendering above the fold.' })
      if (r.cls > g.performance.cls) f.push({ severity: 'high', gate: true, title: `CLS ${r.cls.toFixed(3)} (> ${g.performance.cls})`, url: r.url, fix: 'Set width/height on images and embeds, reserve space for banners and fonts.' })
      if (r.tbt > g.performance.tbtMs) f.push({ severity: 'medium', title: `Total blocking time ${Math.round(r.tbt)}ms`, url: r.url, fix: 'Defer third-party scripts, split large bundles.' })
    }
    if (lh.some((r) => r.viaBypass)) f.push({ severity: 'low', title: 'Lighthouse ran through the firewall bypass on some pages', detail: lh.filter((r) => r.viaBypass).map((r) => r.url).join('\n'), fix: 'Scores may be slightly pessimistic: the bypass header also goes to third-party assets.' })
    for (const r of site.lighthouse.filter((r) => r.error)) f.push({ severity: 'low', title: 'Lighthouse could not run on this page', url: r.url, detail: r.error })
    const oversized = ok.flatMap((p) => p.oversizedImages.map((i) => `${p.url}: ${i}`))
    if (oversized.length) f.push({ severity: 'medium', title: `${oversized.length} images served far larger than displayed`, detail: where(oversized), fix: 'Use next/image or responsive srcset.' })
    cat('performance', f, { lighthouseMobile: avg('performance'), bestPractices: avg('bestPractices') }, avg('performance') ?? undefined)
  }

  // Accessibility
  {
    const f = []
    const byRule = {}
    for (const p of ok) for (const v of p.axe ?? []) (byRule[v.id] ??= { ...v, pages: [] }).pages.push(p.url)
    const sev = { critical: 'critical', serious: 'high', moderate: 'medium', minor: 'low' }
    for (const v of Object.values(byRule)) {
      const gate = (v.impact === 'critical' && g.accessibility.maxCritical === 0) || (v.impact === 'serious' && g.accessibility.maxSerious === 0)
      f.push({ severity: sev[v.impact] ?? 'low', gate, title: `${v.help} (${v.id}, ${v.impact})`, detail: `${v.pages.length} page(s), e.g. ${v.sample ?? ''}\n${where(v.pages)}`, fix: v.helpUrl })
    }
    const mobileTargets = ok.filter((p) => p.smallTargets > 0)
    if (mobileTargets.length) f.push({ severity: 'low', title: `Tap targets under 24px on ${mobileTargets.length} page(s) (WCAG 2.5.8)`, detail: where(mobileTargets) })
    const a = avg('accessibility')
    if (a != null && a < g.accessibility.lighthouse) f.push({ severity: 'medium', gate: true, title: `Lighthouse accessibility ${a} (< ${g.accessibility.lighthouse})` })
    cat('accessibility', f, { lighthouseA11y: a, axeRules: Object.keys(byRule).length })
  }

  // SEO
  {
    const f = []
    const sg = g.seo
    const noTitle = ok.filter((p) => !p.title || p.title.length < sg.titleMin || p.title.length > sg.titleMax)
    if (noTitle.length) f.push({ severity: 'medium', title: `Title missing or outside ${sg.titleMin}–${sg.titleMax} chars on ${noTitle.length} page(s)`, detail: where(noTitle.map((p) => `${p.url} — "${p.title}"`)) })
    const noDesc = ok.filter((p) => !p.description || p.description.length < sg.descMin || p.description.length > sg.descMax)
    if (noDesc.length) f.push({ severity: noDesc.some((p) => !p.description) ? 'high' : 'low', gate: noDesc.some((p) => !p.description), title: `Meta description missing or outside ${sg.descMin}–${sg.descMax} chars on ${noDesc.length} page(s)`, detail: where(noDesc) })
    const dupTitles = Object.entries(groupBy(ok, (p) => p.title)).filter(([t, ps]) => t && ps.length > 1)
    if (dupTitles.length) f.push({ severity: 'medium', title: `${dupTitles.length} duplicate page title(s)`, detail: dupTitles.map(([t, ps]) => `"${t}" × ${ps.length}`).join('\n') })
    const h1 = ok.filter((p) => p.h1.length !== 1)
    if (h1.length) f.push({ severity: 'medium', title: `Pages without exactly one H1: ${h1.length}`, detail: where(h1.map((p) => `${p.url} (${p.h1.length})`)) })
    const noCanon = ok.filter((p) => !p.canonical)
    if (noCanon.length) f.push({ severity: 'medium', title: `Missing canonical on ${noCanon.length} page(s)`, detail: where(noCanon) })
    const noLang = ok.filter((p) => !p.lang)
    if (noLang.length) f.push({ severity: 'medium', title: 'Missing <html lang>', detail: where(noLang) })
    const noOg = ok.filter((p) => !p.ogImage || !p.ogTitle)
    if (noOg.length) f.push({ severity: 'low', title: `Missing Open Graph title/image on ${noOg.length} page(s)`, detail: where(noOg) })
    const noindex = ok.filter((p) => /noindex/i.test(p.robotsMeta ?? '') || /noindex/i.test(p.headers['x-robots-tag'] ?? ''))
    if (noindex.length) f.push({ severity: site.live ? 'critical' : 'low', gate: site.live, title: `noindex on ${noindex.length} page(s)${site.live ? '' : ' (staging: remove at launch)'}`, detail: where(noindex) })
    if (!site.robotsTxt) f.push({ severity: 'medium', title: 'No robots.txt' })
    else if (/^\s*Disallow:\s*\/\s*$/im.test(site.robotsTxt)) f.push({ severity: site.live ? 'critical' : 'low', gate: site.live, title: `robots.txt blocks the whole site${site.live ? '' : ' (staging: remove at launch)'}` })
    if (!site.sitemapOk) f.push({ severity: 'high', gate: true, title: 'No sitemap.xml' })
    const s = avg('seo')
    if (s != null && s < sg.lighthouse) f.push({ severity: 'medium', title: `Lighthouse SEO ${s} (< ${sg.lighthouse})` })
    cat('seo', f, { lighthouseSeo: s, pagesCrawled: pages.length })
  }

  // Security
  {
    const f = []
    const home = ok[0] ?? pages[0]
    const h = home?.headers ?? {}
    for (const name of g.security.requiredHeaders) {
      if (site.isLocal && name === 'strict-transport-security') continue
      if (!h[name]) f.push({ severity: name === 'content-security-policy' ? 'medium' : 'high', gate: name !== 'content-security-policy', title: `Missing ${name} header` })
    }
    if (!h['x-frame-options'] && !/frame-ancestors/.test(h['content-security-policy'] ?? '')) f.push({ severity: 'medium', title: 'No clickjacking protection (X-Frame-Options or CSP frame-ancestors)' })
    if (!h['permissions-policy']) f.push({ severity: 'low', title: 'Missing Permissions-Policy header' })
    if (h['x-powered-by'] || /\d/.test(h['server'] ?? '')) f.push({ severity: 'low', title: 'Server/framework version disclosed', detail: `x-powered-by: ${h['x-powered-by'] ?? '-'}; server: ${h['server'] ?? '-'}` })
    if (site.exposed.length) f.push({ severity: 'critical', gate: true, title: 'Sensitive files publicly accessible', detail: site.exposed.join('\n') })
    if (site.httpRedirectsToHttps === false) f.push({ severity: 'high', gate: true, title: 'HTTP does not redirect to HTTPS' })
    if (site.certDaysLeft != null && site.certDaysLeft < g.security.certMinDays) f.push({ severity: 'critical', gate: true, title: `TLS certificate expires in ${site.certDaysLeft} days` })
    const mixed = ok.filter((p) => !site.isLocal && p.requests.some((r) => r.startsWith('http://')))
    if (mixed.length) f.push({ severity: 'high', gate: true, title: `Mixed content on ${mixed.length} page(s)`, detail: where(mixed) })
    const badCookies = uniq(ok.flatMap((p) => p.cookies.filter((c) => !site.isLocal && !c.secure).map((c) => c.name)))
    if (badCookies.length) f.push({ severity: 'medium', title: 'Cookies without Secure flag', detail: badCookies.join(', ') })
    const bp = avg('bestPractices')
    if (bp != null && bp < 90) f.push({ severity: 'low', title: `Lighthouse best practices ${bp}` })
    cat('security', f, { certDaysLeft: site.certDaysLeft ?? 'n/a', headersPresent: g.security.requiredHeaders.filter((n) => h[n]).length + '/' + g.security.requiredHeaders.length })
  }

  // UX & functional
  {
    const f = []
    const broken = pages.filter((p) => !p.challenged && (p.status >= 400 || p.error))
    if (broken.length) f.push({ severity: 'critical', gate: true, title: `${broken.length} internal page(s) error or 4xx/5xx`, detail: where(broken.map((p) => `${p.url} → ${p.status || p.error}`)) })
    const { broken: linkResults, unverified } = await checkLinks(uniq(ok.flatMap((p) => p.links.map(stripHash))), pages)
    if (linkResults.length > g.ux.maxBrokenLinks) f.push({ severity: 'high', gate: true, title: `${linkResults.length} broken link(s)`, detail: where(linkResults.map((l) => `${l.url} → ${l.status}`)) })
    const challenged = pages.filter((p) => p.challenged)
    if (unverified.length || challenged.length) f.push({ severity: 'low', title: `${unverified.length + challenged.length} URL(s) could not be verified (firewall/bot challenge)`, detail: where([...challenged.map((p) => p.url), ...unverified]), fix: 'Set QA_VERCEL_BYPASS (Vercel → Settings → Deployment Protection → Protection Bypass for Automation) and re-run.' })
    const errs = ok.filter((p) => p.consoleErrors.length)
    if (errs.reduce((s, p) => s + p.consoleErrors.length, 0) > g.ux.maxConsoleErrors) f.push({ severity: 'medium', gate: true, title: `JavaScript console errors on ${errs.length} page(s)`, detail: where(errs.map((p) => `${p.url}: ${p.consoleErrors[0]}`)) })
    const failedReq = uniq(ok.flatMap((p) => p.failed.filter((r) => !/favicon|analytics|gtm|doubleclick|hotjar/.test(r.url)).map((r) => `${r.url} → ${r.status}`)))
    if (failedReq.length) f.push({ severity: 'medium', title: `${failedReq.length} failed asset request(s)`, detail: where(failedReq) })
    if (site.notFoundStatus !== 404) f.push({ severity: 'medium', title: `Unknown URLs return ${site.notFoundStatus} instead of 404`, fix: 'Soft 404s hurt SEO and confuse users.' })
    if (!ok[0]?.viewportMeta) f.push({ severity: 'high', gate: true, title: 'Missing viewport meta tag' })
    if (!ok[0]?.favicon) f.push({ severity: 'low', title: 'No favicon' })
    cat('ux', f, { brokenLinks: linkResults.length, consoleErrorPages: errs.length })
  }

  // Design & layout
  {
    const f = []
    const overflow = ok.filter((p) => p.overflow_mobile || p.overflow_tablet || p.overflow_desktop)
    if (overflow.length > g.design.maxOverflowPages) f.push({ severity: 'high', gate: true, title: `Horizontal scroll on ${overflow.length} page(s)`, detail: where(overflow.map((p) => `${p.url} (${['mobile', 'tablet', 'desktop'].filter((v) => p[`overflow_${v}`]).join(', ')})`)) })
    const small = ok.filter((p) => p.smallText > 3)
    if (small.length) f.push({ severity: 'low', title: `Text under 12px on mobile on ${small.length} page(s)`, detail: where(small) })
    const broken = uniq(ok.flatMap((p) => p.brokenImages))
    if (broken.length) f.push({ severity: 'high', gate: true, title: `${broken.length} broken image(s)`, detail: where(broken) })
    // Visual fidelity vs Figma is judged by the /qa skill's AI review of the screenshots, not here.
    cat('design', f, { screenshots: ok.filter((p) => Object.keys(p.screenshots).length).length })
  }

  // Privacy & GDPR
  {
    const f = []
    const trackerHits = uniq(ok.flatMap((p) => p.requests.filter((r) => config.trackerDomains.some((d) => r.includes(d))).map((r) => new URL(r).host)))
    if (trackerHits.length > g.privacy.maxTrackersBeforeConsent) f.push({ severity: 'critical', gate: true, title: 'Trackers load before cookie consent', detail: trackerHits.join('\n'), fix: 'Block tags until consent (Google Consent Mode v2 default denied, or a CMP that gates scripts).' })
    const marketingCookies = uniq(ok.flatMap((p) => p.cookies.map((c) => c.name)).filter((n) => /^(_ga|_gid|_gcl|_fbp|_fbc|_hj|_clck|_clsk|hubspotutk|__hs|_uetsid|_uetvid|li_|_tt)/.test(n)))
    if (marketingCookies.length) f.push({ severity: 'critical', gate: true, title: 'Non-essential cookies set before consent', detail: marketingCookies.join(', ') })
    const usesTracking = ok.some((p) => /gtag\(|googletagmanager\.com|fbq\(|static\.hotjar\.com|clarity\.ms|snap\.licdn\.com/.test(p.html))
    if (usesTracking && !ok.some((p) => p.hasCookieBanner)) f.push({ severity: 'high', gate: true, title: 'Tracking present but no cookie consent banner detected' })
    if (!ok.some((p) => p.hasPrivacyLink)) f.push({ severity: 'high', gate: true, title: 'No privacy / cookie policy link found' })
    const formsNoPolicy = ok.filter((p) => p.forms > 0 && !p.hasPrivacyLink)
    if (formsNoPolicy.length) f.push({ severity: 'medium', title: 'Forms on pages without a privacy link', detail: where(formsNoPolicy) })
    cat('privacy', f, { trackersBeforeConsent: trackerHits.length, cookiesBeforeConsent: marketingCookies.length })
  }

  // Content quality
  {
    const f = []
    const re = new RegExp(config.placeholderPatterns.join('|'), 'i')
    const hits = ok.map((p) => ({ url: p.url, m: p.text.match(re) })).filter((x) => x.m)
    if (hits.length > g.content.maxPlaceholderHits) f.push({ severity: 'high', gate: true, title: `Placeholder text on ${hits.length} page(s)`, detail: where(hits.map((h) => `${h.url} — "${h.m[0]}"`)) })
    const noAlt = ok.flatMap((p) => p.imagesMissingAlt.map((i) => `${p.url}: ${i}`))
    if (noAlt.length > g.content.maxMissingAlt) f.push({ severity: 'medium', gate: true, title: `${noAlt.length} image(s) without alt attribute`, detail: where(noAlt) })
    const empty = ok.filter((p) => p.emptyLinks > 0)
    if (empty.length) f.push({ severity: 'medium', title: `Links with no text or label on ${empty.length} page(s)`, detail: where(empty) })
    const thin = ok.filter((p) => p.text.split(/\s+/).length < 120)
    if (thin.length) f.push({ severity: 'low', title: `Thin content (<120 words) on ${thin.length} page(s)`, detail: where(thin) })
    cat('content', f, { placeholderPages: hits.length })
  }

  // Analytics
  {
    const f = []
    const html = ok.map((p) => p.html).join('\n')
    const tools = Object.entries({ GA4: /G-[A-Z0-9]{6,}|gtag\(/, GTM: /GTM-[A-Z0-9]+/, 'Meta Pixel': /fbq\(/, Plausible: /plausible\.io/, 'Vercel Analytics': /_vercel\/insights|va\.vercel-scripts/, HubSpot: /hs-scripts\.com|js\.hs-analytics/ }).filter(([, r]) => r.test(html)).map(([n]) => n)
    if (!tools.length && g.analytics.requireAnalytics) f.push({ severity: site.live ? 'high' : 'low', gate: site.live, title: `No analytics detected${site.live ? '' : ' (install before launch)'}`, fix: 'Install GA4 via GTM (with Consent Mode v2) or a cookieless tool.' })
    const gtmIds = uniq(html.match(/GTM-[A-Z0-9]+/g) ?? [])
    if (gtmIds.length > 1) f.push({ severity: 'medium', title: 'Multiple GTM containers', detail: gtmIds.join(', ') })
    const anyTag = /G-[A-Z0-9]{6,}|GTM-|plausible|_vercel\/insights|va\.vercel-scripts|fbq\(|hs-scripts/
    const missing = tools.length ? ok.filter((p) => !anyTag.test(p.html)) : []
    if (missing.length) f.push({ severity: 'medium', title: `Analytics missing on ${missing.length} page(s)`, detail: where(missing) })
    cat('analytics', f, { tools: tools.join(', ') || 'none' })
  }

  // Reliability & ops
  {
    const f = []
    const slow = ok.filter((p) => p.ttfb > g.reliability.maxTtfbMs)
    if (slow.length) f.push({ severity: 'medium', title: `Slow server response (TTFB > ${g.reliability.maxTtfbMs}ms) on ${slow.length} page(s)`, detail: where(slow.map((p) => `${p.url} — ${p.ttfb}ms`)) })
    const home = ok[0]
    if (home && !home.headers['content-encoding'] && !site.isLocal) f.push({ severity: 'medium', title: 'HTML not compressed (gzip/br)' })
    if (site.ownDomain && !site.isLocal) {
      if (site.mx && !site.spf && g.reliability.requireSpf) f.push({ severity: 'high', gate: true, title: `No SPF record on ${site.apex}`, fix: 'Form notifications and replies will land in spam.' })
      if (!site.dmarc && g.reliability.requireDmarc) f.push({ severity: 'high', gate: true, title: `No DMARC record on ${site.apex}` })
      else if (/p=none/.test(site.dmarc ?? '')) f.push({ severity: 'low', title: 'DMARC policy is p=none (monitoring only)' })
      if (!site.caa) f.push({ severity: 'low', title: 'No CAA DNS record' })
    }
    cat('reliability', f, { avgTtfbMs: ok.length ? Math.round(ok.reduce((s, p) => s + (p.ttfb ?? 0), 0) / ok.length) : null, spf: site.ownDomain ? !!site.spf : 'n/a', dmarc: site.ownDomain ? !!site.dmarc : 'n/a' })
  }

  // AEO
  {
    const f = []
    const types = uniq(ok.flatMap((p) => p.jsonLd))
    if (!types.length && g.aeo.requireStructuredData) f.push({ severity: 'high', gate: true, title: 'No structured data (JSON-LD) found', fix: 'Add Organization + WebSite on home, BreadcrumbList, Article/FAQPage/Service where relevant.' })
    if (types.includes('INVALID')) f.push({ severity: 'high', title: 'Invalid JSON-LD block' })
    if (types.length && !types.some((t) => /Organization|LocalBusiness|Corporation/.test(t))) f.push({ severity: 'medium', title: 'No Organization schema' })
    const blocked = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'OAI-SearchBot'].filter((b) => new RegExp(`User-agent:\\s*${b}[\\s\\S]*?Disallow:\\s*/\\s*$`, 'im').test(site.robotsTxt ?? ''))
    if (blocked.length) f.push({ severity: 'medium', title: 'robots.txt blocks AI crawlers', detail: blocked.join(', '), fix: 'Confirm with the client whether this is intended.' })
    if (!site.llmsTxt) f.push({ severity: 'low', title: 'No /llms.txt' })
    if (site.ssrRatio != null && site.ssrRatio < 0.5) f.push({ severity: 'high', gate: true, title: `Only ${Math.round(site.ssrRatio * 100)}% of home page text is in the server HTML`, fix: 'AI crawlers mostly do not run JS; render content server-side.' })
    cat('aeo', f, { schemaTypes: types.filter((t) => t !== 'INVALID').join(', ') || 'none', ssrTextPct: site.ssrRatio != null ? Math.round(site.ssrRatio * 100) : null })
  }

  return results
}

async function checkLinks(links, pages) {
  const known = new Map(pages.map((p) => [p.url, p.status]))
  const todo = links.filter((l) => !known.has(l.replace(/\/$/, '')) && !/linkedin\.com|instagram\.com|facebook\.com|x\.com|twitter\.com|wa\.me/.test(l)).slice(0, 250)
  const broken = []
  const unverified = []
  let i = 0
  // Low concurrency: aggressive link checking is what trips hosting firewalls.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < todo.length) {
      const url = todo[i++]
      let res = await httpFetch(url, { method: 'HEAD', redirect: 'follow' }).catch((e) => e)
      if (res instanceof Response && [403, 405].includes(res.status) && !isChallenge(res)) res = await httpFetch(url, { redirect: 'follow' }).catch((e) => e)
      if (!(res instanceof Response)) broken.push({ url, status: res.name ?? 'error' })
      else if (isChallenge(res)) unverified.push(url)
      else if (res.status >= 400) broken.push({ url, status: res.status })
    }
  }))
  return { broken, unverified }
}

const stripHash = (u) => u.replace(/#.*$/, '')
const uniq = (a) => [...new Set(a)]
const groupBy = (a, fn) => a.reduce((m, x) => ((m[fn(x)] ??= []).push(x), m), {})
