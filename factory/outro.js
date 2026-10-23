// The closing card: what the run did, in numbers anyone can read, and the same prompts drawn before and after.
window.OUTRO_HTML = (S, { shownArt, escH, fitArt, E }) => {
  const runs = S.runs[S.keys.student] ?? {}
  const grader = S.keys.grader
  const dataset = S.cases.filter((c) => c.status === 'accepted')
  const firstV = S.versions[0].id
  const best = S.current
  // Corrections per drawing: the steers said about each accepted case, before the first Optimize and after it.
  const users = E.filter((e) => e.type === 'user')
  const optAt = users.findIndex((u) => u.act === 'optimize')
  const per = (from, to) => {
    const slice = users.slice(from, to)
    const accepted = slice.filter((u) => u.act === 'accept').length
    return accepted ? slice.filter((u) => u.act === 'steer').length / accepted : 0
  }
  const nextOpt = users.findIndex((u, i) => i > optAt && u.act === 'optimize')
  const before = per(0, optAt)
  const after = per(optAt, nextOpt < 0 ? users.length : nextOpt)
  const fmt = (x) => x.toFixed(1).replace(/\.0$/, '')
  const won = S.versions.filter((v) => v.by === 'optimizer' && v.status === 'won').length
  const lost = S.versions.filter((v) => v.status === 'lost').length
  const trial = S.versions.find((v) => v.id === best)?.trial
  const solid = (o) => {
    const ink = [...shownArt(o)].filter((ch) => ch.trim())
    return ink.filter((ch) => '░▒▓█=+*#%@&8$'.includes(ch)).length / Math.max(1, ink.length)
  }
  const passed = (v, c) => {
    const vd = runs[v]?.[c.id]?.verdicts?.[grader] ?? {}
    return (c.checks ?? []).filter((k) => vd[k.id]?.pass).length
  }
  // The four cases that changed most between the first version and the best one.
  const shown = dataset
    .filter((c) => runs[firstV]?.[c.id]?.output && runs[best]?.[c.id]?.output)
    .sort((a, b) => solid(runs[best][b.id].output) - solid(runs[firstV][b.id].output) - (solid(runs[best][a.id].output) - solid(runs[firstV][a.id].output)))
    .slice(0, 4)
  const box = (v, c, after) => {
    const a = shownArt(runs[v][c.id].output)
    return `<div class="box${after ? ' after' : ''}"><span class="v">v${v}${after ? ', after' : ', the start'} · ${passed(v, c)} of ${(c.checks ?? []).length} checks</span><pre style="font-size:${fitArt(a, 290, 200, 11)}px">${escH(a)}</pre></div>`
  }
  return `<span class="eyebrow">Same prompts, no steering, the skill’s first try</span>
    <h1>Corrections per drawing: <em>${fmt(before)} → ${fmt(after)}</em></h1>
    <p>${won + lost} versions tested, ${won} kept, ${lost} thrown out before they could ship. The best one, v${best}, passes ${trial ? `${trial.after.pass} of ${trial.after.total}` : 'most'} checks on its first try.</p>
    <div class="pairs">${shown.map((c) => `<div class="pair"><span class="p">${escH(c.ask.replace(/^\/ascii /, ''))}</span>${box(firstV, c)}${box(best, c, true)}</div>`).join('')}</div>
    <p style="color:var(--ink)"><b>Steering is the data. Checks are the benchmark. Testing is the guardrail.</b></p>`
}
