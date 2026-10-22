// Self-contained HTML scorecard in the 9H brand (Core Black / Signal Grey, Hubot Sans + Overpass Mono).
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const STATUS = { pass: 'Pass', warn: 'Warn', fail: 'Fail', review: 'Review' }

export function renderHtml(report) {
  const cats = Object.values(report.categories)
  const shots = report.screenshots
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA ${esc(report.host)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Hubot+Sans:wght@300..700&family=Overpass+Mono:wght@400..600&display=swap" rel="stylesheet">
<style>
:root{--ink:#242128;--grey:#E7E7EB;--grey-d:#D9D9DD;--grey-l:#F1F1F4;--white:#fff;--pass:#2AB893;--warn:#EAAE60;--fail:#FD5C70;--muted:#5f5b66}
*{box-sizing:border-box}body{margin:0;background:var(--grey);color:var(--ink);font:400 15px/1.55 'Hubot Sans',system-ui,sans-serif}
.mono{font-family:'Overpass Mono',monospace;text-transform:uppercase;letter-spacing:.06em;font-size:11px}
header{background:var(--ink);color:var(--white);padding:40px 16px 48px;background-image:radial-gradient(ellipse 55% 60% at 85% 20%,rgba(42,184,147,.45),transparent 60%),radial-gradient(ellipse 50% 60% at 10% 90%,rgba(72,150,209,.35),transparent 60%)}
.wrap{max-width:1120px;margin:0 auto;padding:0 16px}header .wrap{padding:0}
h1{font-weight:300;font-size:clamp(28px,5vw,48px);margin:8px 0 4px;word-break:break-all}
.meta{opacity:.7}.hero{display:flex;gap:32px;align-items:flex-end;flex-wrap:wrap;margin-top:24px}
.big{font-weight:300;font-size:88px;line-height:1}.verdict{padding:6px 14px;border-radius:9999px;border:.5px solid currentColor}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin:-28px auto 32px}
.tile{background:var(--white);border-radius:16px;padding:16px;border:.5px solid var(--grey-d);text-decoration:none;color:inherit}
.tile .score{font-size:36px;font-weight:300}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.pass{color:var(--pass)}.warn{color:#b9822f}.fail{color:var(--fail)}.review{color:var(--muted)}
.bg-pass{background:var(--pass)}.bg-warn{background:var(--warn)}.bg-fail{background:var(--fail)}.bg-review{background:var(--muted)}
section{background:var(--white);border-radius:16px;padding:24px;margin-bottom:16px;border:.5px solid var(--grey-d)}
h2{font-family:'Overpass Mono',monospace;text-transform:uppercase;font-size:14px;letter-spacing:.06em;margin:0;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.metrics{display:flex;gap:16px;flex-wrap:wrap;margin:12px 0;color:var(--muted)}
.f{border-top:.5px solid var(--grey-d);padding:12px 0}.f:first-of-type{border-top:0}
.sev{display:inline-block;min-width:72px;padding:2px 8px;border-radius:4px;border:.5px solid currentColor;text-align:center;margin-right:8px}
.critical{color:#c4283c}.high{color:var(--fail)}.medium{color:#b9822f}.low{color:var(--muted)}
.gate{background:var(--ink);color:var(--white);border-radius:4px;padding:2px 6px;margin-left:6px}
pre{white-space:pre-wrap;word-break:break-all;background:var(--grey-l);padding:10px;border-radius:4px;font-size:12px;margin:8px 0 0}
.fix{color:var(--muted);margin-top:6px}.ok{color:var(--muted)}
.shots{display:grid;grid-template-columns:1fr 2fr 3fr;gap:12px;align-items:start}.shots img{width:100%;border-radius:4px;border:.5px solid var(--grey-d);max-height:900px;object-fit:cover;object-position:top}
@media(max-width:700px){.shots{grid-template-columns:1fr}.big{font-size:64px}}
footer{padding:24px 0 48px;color:var(--muted)}
</style></head><body>
<header><div class="wrap">
<div class="mono">9H Website QA · ${esc(report.project ?? '')} · ${esc(new Date(report.startedAt).toLocaleString('en-GB'))}</div>
<h1>${esc(report.url)}</h1>
<div class="meta mono">${esc(report.stage)} · ${report.pagesCrawled} pages crawled · ${report.durationSec}s · standard v${esc(report.standardVersion)}</div>
<div class="hero"><div><div class="mono meta">Overall</div><div class="big">${report.overall}</div></div>
<div class="verdict mono ${report.verdict === 'PASS' ? 'pass' : 'fail'}" style="color:${report.verdict === 'PASS' ? 'var(--pass)' : 'var(--fail)'}">${report.verdict === 'PASS' ? 'Launch gates passed' : report.verdict === 'INCOMPLETE' ? 'Incomplete: blocked by host firewall' : `${report.failedGates.length} gate(s) failing: ${esc(report.failedGates.join(', '))}`}</div></div>
</div></header>
<div class="wrap">
<div class="grid">${cats.map((c) => `<a class="tile" href="#${c.key}"><div class="mono"><span class="dot bg-${c.status}"></span>${esc(c.label)}</div><div class="score">${c.score ?? '—'}</div><div class="mono ${c.status}">${STATUS[c.status]} · ${c.findings.length} finding${c.findings.length === 1 ? '' : 's'}</div></a>`).join('')}</div>
${cats.map((c) => `<section id="${c.key}"><h2><span>${esc(c.label)}</span><span class="${c.status}">${c.score ?? '—'} · ${STATUS[c.status]}</span></h2>
<div class="metrics mono">${Object.entries(c.metrics).map(([k, v]) => `<span>${esc(k)}: ${esc(v ?? '—')}</span>`).join('')}</div>
${c.findings.length ? c.findings.map((f) => `<div class="f"><span class="sev mono ${f.severity}">${f.severity}</span><strong>${esc(f.title)}</strong>${f.gate ? '<span class="gate mono">gate</span>' : ''}${f.url ? `<div class="ok">${esc(f.url)}</div>` : ''}${f.detail ? `<pre>${esc(f.detail)}</pre>` : ''}${f.fix ? `<div class="fix">Fix: ${esc(f.fix)}</div>` : ''}</div>`).join('') : '<div class="ok">No issues found.</div>'}
</section>`).join('')}
${shots.length ? `<section><h2>Screenshots</h2>${shots.map((s) => `<div class="mono" style="margin:16px 0 8px">${esc(s.url)}</div><div class="shots">${['mobile', 'tablet', 'desktop'].filter((v) => s[v]).map((v) => `<figure style="margin:0"><figcaption class="mono ok">${v}</figcaption><img loading="lazy" alt="${v} screenshot of ${esc(s.url)}" src="data:image/jpeg;base64,${s[v]}"></figure>`).join('')}</div>`).join('')}</section>` : ''}
<footer class="mono">Generated by 9H qa-runner. Thresholds: qa.config.json${report.projectOverrides ? ' + qa.project.json' : ''}.</footer>
</div></body></html>`
}
