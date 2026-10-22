// Shared HTTP identity for every request the runner makes (fetch, Playwright, Lighthouse).
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 9H-QA/1.0'

// Vercel "Protection Bypass for Automation" lets CI scan previews and firewall-protected sites without being challenged.
// It must only ever be sent to the site under test: never to third-party links, CDNs or blob storage, which would
// leak the secret and (as a non-safelisted header) break their CORS requests. No set-bypass-cookie: it adds a redirect.
const BYPASS = process.env.QA_VERCEL_BYPASS
let targetOrigin = null
// Exact origin (protocol + host): the plain-HTTP redirect probe must not carry the secret in cleartext.
export const setTarget = (url) => { targetOrigin = new URL(url).origin }
export const isTarget = (url) => { try { return new URL(url).origin === targetOrigin } catch { return false } }
export const bypassHeaders = BYPASS ? { 'x-vercel-protection-bypass': BYPASS } : {}
export const hasBypass = !!BYPASS

// Follows redirects itself: fetch keeps custom headers across origins, so each hop decides afresh whether to send the bypass.
export async function httpFetch(url, opts = {}) {
  const follow = (opts.redirect ?? 'follow') === 'follow'
  let current = String(url)
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(current, { signal: AbortSignal.timeout(10000), ...opts, redirect: 'manual', headers: { 'user-agent': USER_AGENT, ...(isTarget(current) ? bypassHeaders : {}), ...opts.headers } })
    const location = res.headers.get('location')
    if (!follow || res.status < 300 || res.status >= 400 || !location) return res
    current = new URL(location, current).href
  }
  throw new TypeError('Too many redirects')
}

// A firewall/bot challenge is not a broken page; it means we could not verify it.
export const isChallenge = (res) => !!res && (res.headers.get('x-vercel-mitigated') || res.headers.get('cf-mitigated') || (res.status === 429))
