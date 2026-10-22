// Shared HTTP identity for every request the runner makes (fetch, Playwright, Lighthouse).
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 9H-QA/1.0'

// Vercel "Protection Bypass for Automation" lets CI scan previews and firewall-protected sites without being challenged.
export const extraHeaders = Object.fromEntries([
  process.env.QA_VERCEL_BYPASS && ['x-vercel-protection-bypass', process.env.QA_VERCEL_BYPASS],
  process.env.QA_VERCEL_BYPASS && ['x-vercel-set-bypass-cookie', 'true'],
].filter(Boolean))

export const httpFetch = (url, opts = {}) =>
  fetch(url, { signal: AbortSignal.timeout(10000), ...opts, headers: { 'user-agent': USER_AGENT, ...extraHeaders, ...opts.headers } })

// A firewall/bot challenge is not a broken page; it means we could not verify it.
export const isChallenge = (res) => !!res && (res.headers.get('x-vercel-mitigated') || res.headers.get('cf-mitigated') || (res.status === 429))
