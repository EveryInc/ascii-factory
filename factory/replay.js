// Replays a recorded run of the v2 board through the board itself, sped up, with a narrator and subtitles.
// renderAt(ms) draws the replay at a moment; the recorder calls it frame by frame, a browser from requestAnimationFrame.

// Wrapped, so its names never clash with the board's own top-level ones.
;(() => {
  const N = window.NARRATION?.lines ?? []

  // ---------- the recording: patches on the board's pushes, rebuilt into whole states ----------

  function patch(a, d) {
    if ('$v' in d) return d.$v
    const out = Array.isArray(a) ? a.slice() : { ...a }
    for (const [k, v] of Object.entries(d.$p)) {
      if (k === '$len') continue
      if (v.$del) delete out[k]
      else out[k] = patch(out[k], v)
    }
    if ('$len' in d.$p) out.length = d.$p.$len
    return out
  }
  const E = []
  {
    let state = {}
    let stream = {}
    for (const e of TRACE) {
      if (e.type === 'state') E.push({ ...e, state: (state = patch(state, e.d)) })
      else if (e.type === 'stream') E.push({ ...e, stream: (stream = patch(stream, e.d)) })
      else E.push(e)
    }
    // the board as it stood at each event
    let s = null
    for (const e of E) e.at = s = e.state ?? s
  }
  const REAL = E.at(-1).t

  // ---------- moments the narrator talks about ----------

  const first = (test) => E.findIndex(test)
  const acts = (a) => E.flatMap((e, i) => (e.type === 'user' && e.act === a ? [i] : []))
  const phases = E.flatMap((e, i) => (e.type === 'phase' ? [i] : []))
  const versions = (e) => e.at?.versions ?? []
  const MOMENTS = {
    firstCase: first((e) => e.at?.cases?.length),
    firstSteer: first((e) => e.at?.cases?.some((c) => c.steering?.length)),
    steerRead: first((e) => e.at?.cases?.some((c) => c.steering?.some((s) => s.read))),
    firstAccept: acts('accept')[0],
    firstDismiss: acts('dismiss')[0],
    optimize1: acts('optimize')[0],
    writing1: first((e) => versions(e).some((v) => v.status === 'writing')),
    testing1: E.findIndex((e, i) => i > acts('optimize')[0] && versions(e).some((v) => v.by === 'optimizer' && v.status === 'running')),
    won1: first((e) => versions(e).some((v) => v.by === 'optimizer' && v.status === 'won')),
    lost1: first((e) => versions(e).some((v) => v.status === 'lost')),
    phase2: phases[1],
    optimize2: acts('optimize')[1],
    phase3: phases[2],
    optimize3: acts('optimize')[2],
    lastWon: (() => {
      let at = -1
      let n = 0
      E.forEach((e, i) => {
        const w = versions(e).filter((v) => v.by === 'optimizer' && v.status === 'won').length
        if (w > n) (n = w), (at = i)
      })
      return at
    })(),
  }
  const lines = N.filter((l) => MOMENTS[l.at] >= 0)
    .map((l) => ({ ...l, i: MOMENTS[l.at] }))
    .sort((a, b) => a.i - b.i)
  const intro = N.find((l) => l.at === 'intro')
  const outro = N.find((l) => l.at === 'outro')
  const INTRO = Math.max(6000, (intro?.ms ?? 0) + 900)
  const OUTRO = Math.max(12000, (outro?.ms ?? 0) + 3000)

  // ---------- timeline: squeeze the waits, give every line of narration room to be heard ----------

  const squeeze = (g) => Math.min(g, 800) + Math.pow(Math.max(0, g - 800), 0.55)
  function minGap(prev, e) {
    if (e.type === 'user' && ['accept', 'dismiss', 'optimize'].includes(e.act)) return 900
    if (prev.type === 'user') return 500
    return 0
  }
  function layout(k) {
    let t = INTRO
    E[0].pb = t
    let li = 0
    for (let i = 1; i < E.length; i++) {
      t += Math.max(k * squeeze(E[i].t - E[i - 1].t), minGap(E[i - 1], E[i]))
      while (li < lines.length && lines[li].i < i) li++
      // a line of narration holds the next one back until it has been said
      if (li < lines.length && lines[li].i === i) {
        if (li > 0) t = Math.max(t, lines[li - 1].pb + lines[li - 1].ms + 450)
        lines[li].pb = t
      }
      E[i].pb = t
    }
    if (lines[0]?.i === 0) lines[0].pb = E[0].pb
    const last = lines.at(-1)
    return Math.max(t, last ? last.pb + last.ms + 600 : 0)
  }
  const q = new URLSearchParams(location.search)
  const TARGET = (Number(q.get('len')) || 112) * 1000
  let body
  {
    let lo = 0
    let hi = 1
    while (layout(hi) < TARGET - OUTRO && hi < 1e5) hi *= 2
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (layout(mid) < TARGET - OUTRO) lo = mid
      else hi = mid
    }
    body = layout(lo)
  }
  const OUTRO_AT = body
  const END = body + OUTRO

  function realAt(t) {
    if (t <= E[0].pb) return 0
    for (let i = 1; i < E.length; i++)
      if (E[i].pb >= t) {
        const a = E[i - 1]
        const b = E[i]
        return a.t + ((b.t - a.t) * (t - a.pb)) / Math.max(1, b.pb - a.pb)
      }
    return REAL
  }

  // ---------- drawings, for the outro ----------

  function shownArt(output) {
    const blocks = [...String(output).matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1])
    return (blocks.sort((a, b) => b.length - a.length)[0] ?? output).replace(/^\s*\n/, '').trimEnd()
  }
  const escH = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  function fitArt(text, w, h, max) {
    const ls = text.split('\n')
    const cols = Math.max(1, ...ls.map((l) => [...l].length))
    return Math.max(2, Math.min(max, w / (cols * 0.602), h / (ls.length * 1.1)))
  }

  // ---------- the frame around the board ----------

  document.querySelector('header').insertAdjacentHTML('afterbegin', '<span class="brand"><img src="every-logo-white.svg" alt="Every"><span class="rule"></span><span>The <em>ASCII</em> Factory</span></span>')
  document.querySelector('#conn').insertAdjacentHTML('afterend', '<span id="replayclock"></span>')
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div id="subtitle"><span class="t"></span></div>
    <div class="card" id="intro">
      <img src="every-logo-white.svg" alt="Every">
      <h1>The <em>ASCII</em> Factory</h1>
      <p>${escH(intro?.text ?? '')}</p>
      <p class="small">A real run of Every’s toy loop: every drawing, check and version here was made by the models, sped up about ${Math.round(REAL / (END - INTRO - OUTRO))}×.</p>
    </div>
    <div class="card" id="outro"></div>`,
  )
  const sub = document.getElementById('subtitle')
  const cols = [...document.querySelectorAll('main > .col')]

  // Elements keyed by what they show, so an arrival animates however often the board redraws.
  const born = new Map()
  function keyed() {
    const out = []
    for (const el of document.querySelectorAll('.cases > li')) out.push([el, `case:${el.closest('ol').id}:${el.querySelector('.row .prompt')?.textContent ?? el.textContent.slice(0, 40)}`, 'slide'])
    for (const el of document.querySelectorAll('.said li')) out.push([el, 'said:' + el.textContent, 'rise'])
    for (const el of document.querySelectorAll('.check')) out.push([el, 'check:' + el.textContent.slice(0, 80), 'rise'])
    for (const el of document.querySelectorAll('.mark')) out.push([el, 'mark:' + el.closest('.check')?.textContent.slice(0, 80) + el.className, 'pop'])
    for (const el of document.querySelectorAll('#versions > li')) out.push([el, 'ver:' + el.textContent.slice(0, 30), 'slide'])
    for (const el of document.querySelectorAll('pre.art')) out.push([el, 'art:' + el.textContent.slice(0, 120), 'print'])
    return out
  }
  const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3)
  function motion(t) {
    for (const [el, key, kind] of keyed()) {
      if (!born.has(key)) born.set(key, t)
      const p = ease((t - born.get(key)) / (kind === 'print' ? 650 : 380))
      if (kind === 'print') el.style.clipPath = p < 1 ? `inset(0 0 ${(1 - p) * 100}% 0)` : ''
      else if (kind === 'slide') el.style.cssText = p < 1 ? `opacity:${p};transform:translateX(${(p - 1) * 18}px)` : ''
      else if (kind === 'pop') el.style.transform = p < 1 ? `scale(${1 + (1 - p) * 0.35})` : ''
      else el.style.cssText = p < 1 ? `opacity:${p};transform:translateY(${(1 - p) * 8}px)` : ''
    }
  }

  // CSS animations and transitions run on the replay's clock, not the wall clock.
  const animStart = new WeakMap()
  function syncAnimations(t) {
    for (const a of document.getAnimations()) {
      if (!animStart.has(a)) {
        animStart.set(a, t)
        a.pause()
      }
      const end = a.effect?.getComputedTiming().endTime ?? Infinity
      a.currentTime = Math.min(t - animStart.get(a), end === Infinity ? 1e9 : end)
    }
  }

  // The person's hands on the board: pressing Accept, Dismiss and Optimize.
  let next = 0
  const pressable = (e) => e?.type === 'user' && ['accept', 'dismiss', 'optimize'].includes(e.act)
  function hands(t) {
    for (const b of document.querySelectorAll('button.pressed')) b.classList.remove('pressed')
    const u = E.slice(next).find((e) => e.type === 'user')
    if (pressable(u) && u.pb - t < 380) (u.act === 'optimize' ? document.getElementById('optimize') : document.querySelector(`#acts [data-act="${u.act}"]`))?.classList.add('pressed')
  }

  // ---------- intro, outro, subtitles, column in focus, clock ----------

  const FOCUS = { firstCase: 0, firstSteer: 0, steerRead: 0, firstAccept: 1, firstDismiss: 0, optimize1: 2, writing1: 2, testing1: 1, won1: 1, lost1: 2, phase2: 0, optimize2: 2, phase3: 0, optimize3: 2, lastWon: 2 }
  function cards(t) {
    document.getElementById('intro').style.opacity = t < INTRO - 600 ? 1 : Math.max(0, 1 - (t - (INTRO - 600)) / 600)
    const o = document.getElementById('outro')
    if (t < OUTRO_AT) return (o.style.opacity = 0)
    if (!o.innerHTML) o.innerHTML = window.OUTRO_HTML?.(E.at(-1).at, { shownArt, escH, fitArt, E, outro }) ?? ''
    o.style.opacity = ease((t - OUTRO_AT) / 800)
  }
  let lastCap = null
  function subtitles(t) {
    const cap = t >= OUTRO_AT || t < INTRO ? null : lines.filter((l) => l.pb <= t).at(-1)
    const span = sub.querySelector('.t')
    if (cap !== lastCap) {
      span.textContent = cap?.text ?? ''
      lastCap = cap
    }
    span.style.opacity = cap ? ease((t - cap.pb) / 300) : 0
    const f = cap ? FOCUS[cap.at] : undefined
    cols.forEach((c, i) => (c.style.opacity = f === undefined || f === i ? 1 : 0.4))
    const mm = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`
    document.getElementById('replayclock').innerHTML = `real run <b>${mm(realAt(t))}</b> of ${mm(REAL)}`
  }

  // ---------- the clock ----------

  function renderAt(t) {
    // Every push reaches the board in order, as it would live: the board reacts to some on their way past
    // (a version being written opens itself), so none can be skipped, however many fall in one frame.
    let stream = null
    while (next < E.length && E[next].pb <= t) {
      const e = E[next++]
      if (e.type === 'state' && e.state.skill) window.__stream.listeners.state({ data: JSON.stringify(e.state) }) // the recording starts before the board has a skill
      if (e.type === 'stream') stream = e.stream
    }
    if (stream) window.__stream.listeners.stream({ data: JSON.stringify(stream) })
    hands(t)
    motion(t)
    syncAnimations(t)
    subtitles(t)
    cards(t)
  }
  window.renderAt = renderAt
  window.END = END
  // When each line of narration starts in the video, for the sound track.
  window.CUES = [...(intro ? [{ id: intro.id, at: 500 }] : []), ...lines.map((l) => ({ id: l.id, at: l.pb })), ...(outro ? [{ id: outro.id, at: OUTRO_AT + 900 }] : [])]

  if (!q.has('record')) {
    const from = (+q.get('t') || 0) * 1000
    document.fonts.ready.then(() => {
      const t0 = performance.now() - from
      const tick = () => {
        renderAt(Math.min(END, performance.now() - t0))
        requestAnimationFrame(tick)
      }
      tick()
    })
  }
})()
