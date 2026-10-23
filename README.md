# 9H QA runner

One QA standard for every website we build. It checks a URL against 11 categories and produces a scorecard: an HTML report, a JSON file and a pass/fail verdict.

```bash
npm install
node bin/qa.mjs https://example.com --project "Client"
```

## What it checks

| Category | Automated checks | Launch gates (fail the run) |
|---|---|---|
| Performance | Lighthouse mobile, LCP, CLS, TBT, oversized images | score ≥ 85, LCP ≤ 2.5s, CLS ≤ 0.1 |
| Accessibility | axe-core WCAG 2.2 AA on every page, Lighthouse a11y, tap targets | 0 critical/serious, Lighthouse ≥ 95 |
| SEO | titles, descriptions, H1, canonical, lang, OG, share image (loads, 1200×630, not a template default), duplicates, robots.txt, sitemap, noindex | description present, sitemap, no noindex when live |
| Security | HSTS, CSP, XCTO, Referrer-Policy, clickjacking, HTTPS redirect, TLS expiry, mixed content, exposed files (.env, .git), cookie flags | required headers, no exposed files, cert > 21 days |
| UX & functional | page errors, broken links, console errors, failed assets, real 404s, viewport meta | no 4xx/5xx pages, 0 broken links, 0 console errors |
| Design & layout | horizontal scroll at mobile/tablet/desktop, tiny text, broken images, screenshots | no overflow, no broken images |
| Privacy & GDPR | trackers and marketing cookies before consent, consent banner, privacy link | 0 trackers/cookies before consent |
| Content quality | placeholder text (lorem, TODO, TBC…), missing alt, empty links, thin pages | no placeholders, no missing alt |
| Analytics | GA4 / GTM / Meta / Plausible / Vercel / HubSpot detection, coverage, duplicates | analytics present when live |
| Reliability & ops | TTFB, compression, SPF, DMARC, CAA | SPF + DMARC on own domains |
| AEO | JSON-LD, Organization schema, AI-crawler blocking, llms.txt, server-rendered content | structured data present, ≥ 50% of text in the server HTML |

Things tools can't judge (visual design, copy and Figma fidelity) are covered by the `/qa` Claude skill. It runs this tool, then reviews the screenshots.

**Share images:** Slack and WhatsApp show only a square cut from the middle of the 1200×630 image, so put the logo and
headline inside the central 630×630 and keep photos and decoration at the sides. Check the square crop by eye before launch.

## Stages

`--stage staging` (the default for `*.vercel.app` and localhost) turns noindex, robots blocking and missing analytics into reminders. `--stage live` (the default for own domains) makes them gates.

## Per-project overrides

Put a `qa.project.json` in the site repo and change only what differs, e.g.:

```json
{ "project": "BMIT", "gates": { "performance": { "lighthouseMobile": 80 } } }
```

Every override should have a reason recorded in the project.

## Three ways it runs

1. **On demand**: `/qa <url>` in Claude Code.
2. **In CI**: copy `ci/qa.yml` into the site repo (manual, weekly, and on Vercel deploys when the Vercel project is linked to GitHub). It pins a release tag. To roll out a new standard, tag a release and bump `ref:` in each repo.
3. **Monthly on live sites**: a scheduled run over every client domain, appending to `reports/history.jsonl`.

## Firewalls

Vercel and Cloudflare may challenge the scanner. Challenged URLs are reported as "unverified", not broken. If the home page itself is blocked, the verdict is `INCOMPLETE`. Set `QA_VERCEL_BYPASS` to the project's Protection Bypass for Automation secret.
