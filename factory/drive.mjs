// Runs the v2 board for real with a scripted person, and records everything the board pushes as a trace for the replay.
// The person uses /ascii in real Claude Code sessions (claude -p) in a project whose skill has the board's line, steers
// in the same session, and decides each case on the Desk with the board's own tools. Every steer pushes the same
// way: toward solid, shaded drawings that stand on a shadow.
//
//   TOY_LOOP_V2_PORT=4489 TOY_LOOP_V2_STATE=/tmp/v2.json node loop/v2/server.mjs
//   node factory/drive.mjs <project with .claude/skills/ascii, connected to 4489> trace.jsonl
import { spawn } from 'node:child_process'
import { appendFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:4489'
const [PROJECT, OUT] = process.argv.slice(2)
writeFileSync(OUT, '')
const T0 = Date.now()
const emit = (e) => appendFileSync(OUT, JSON.stringify({ t: Date.now() - T0, ...e }) + '\n')

// ---------- recording: each push of the board, as a patch on the one before ----------

function diff(a, b) {
  if (a === b) return undefined
  const obj = (x) => x && typeof x === 'object'
  if (!obj(a) || !obj(b) || Array.isArray(a) !== Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b) ? undefined : { $v: b }
  const out = {}
  let any = false
  for (const k of Object.keys(b)) {
    const d = diff(a[k], b[k])
    if (d !== undefined) (out[k] = d), (any = true)
  }
  for (const k of Object.keys(a)) if (!(k in b)) (out[k] = { $del: 1 }), (any = true)
  if (Array.isArray(b) && a.length !== b.length) (out.$len = b.length), (any = true)
  return any ? { $p: out } : undefined
}

let S = null
const last = { state: {}, stream: {} }
const pending = { state: null, stream: null }
// At most four records a second of each kind: enough for the replay, small enough to ship.
setInterval(() => {
  for (const kind of ['state', 'stream']) {
    if (!pending[kind]) continue
    const d = diff(last[kind], pending[kind])
    if (d) emit({ type: kind, d })
    last[kind] = pending[kind]
    pending[kind] = null
  }
}, 250)

async function listen() {
  const res = await fetch(`${BASE}/events`)
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true })
    for (let i; (i = buf.indexOf('\n\n')) >= 0; ) {
      const msg = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const kind = msg.match(/^event: (\w+)/m)?.[1]
      const data = msg.split('\n').find((l) => l.startsWith('data: '))
      if (!data || !kind) continue
      const v = JSON.parse(data.slice(6))
      if (kind === 'state') S = v
      if (kind in pending) pending[kind] = v
    }
  }
}

// ---------- the person ----------

const tool = (name, args = {}) =>
  fetch(`${BASE}/api/tool/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-from': 'board' }, body: JSON.stringify(args) }).then((r) => r.json())
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, what, max = 30 * 60_000) {
  const end = Date.now() + max
  while (Date.now() < end) {
    const v = S && fn(S)
    if (v) return v
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// One turn of a real Claude Code session in the project. A resumed turn is a new process, which does not
// register the skill's hook again, so post what the hook would have posted.
function claude(prompt, resume) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--model', 'haiku', '--output-format', 'json']
    if (resume) args.push('--resume', resume)
    const child = spawn('claude', args, { cwd: PROJECT, stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('close', async () => {
      try {
        const r = JSON.parse(out)
        if (resume) {
          const dir = readdirSync(join(homedir(), '.claude/projects')).find((d) => {
            try {
              return readdirSync(join(homedir(), '.claude/projects', d)).includes(`${r.session_id}.jsonl`)
            } catch {
              return false
            }
          })
          await fetch(`${BASE}/catch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hook_event_name: 'Stop', session_id: r.session_id, cwd: PROJECT, transcript_path: join(homedir(), '.claude/projects', dir, `${r.session_id}.jsonl`), last_assistant_message: r.result }),
          })
        }
        resolve(r)
      } catch (e) {
        reject(new Error(`claude -p failed: ${out.slice(0, 300)}`))
      }
    })
  })
}

// How shaded a drawing is: the share of its ink that is fill, how much of that is dark, and whether it stands on a shadow.
function shade(output) {
  const blocks = [...output.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1])
  const art = (blocks.sort((a, b) => b.length - a.length)[0] ?? output).replace(/^\s*\n/, '').trimEnd()
  const ink = [...art].filter((ch) => ch.trim())
  const fill = ink.filter((ch) => '=+*#%@░▒▓█&8$'.includes(ch)).length / Math.max(1, ink.length)
  const dark = ink.filter((ch) => '#%@▓█&8$'.includes(ch)).length / Math.max(1, ink.length)
  const tail = art.split('\n').slice(-2).join('')
  const ground = [...tail].filter((ch) => '.:-~=░▒'.includes(ch)).length >= 8
  return { fill, dark, ground }
}

const STEERS = {
  fill: [
    "it's all outline and it looks hollow. fill the body in with shading so it reads as a solid object",
    'too see-through. shade it in: use denser characters like + * # @ for the body instead of leaving it empty',
    'fill it in. I want it to look solid and heavy, shaded with a light-to-dark ramp of characters',
  ],
  dark: [
    'more contrast please: the shadow side should be really dark, # and @, and the lit side light',
    'it reads a bit flat. push the darks darker on the side away from the light',
  ],
  ground: [
    'light comes from the top left. put a soft shadow on the ground under it, falling to the right',
    'it is floating. give it a shadow on the ground beneath it',
    'add a cast shadow on the ground, lower right of it, so it sits on something',
  ],
}
const used = { fill: 0, dark: 0, ground: 0 }
const pick = (kind) => STEERS[kind][used[kind]++ % STEERS[kind].length]

const deskCase = (sid) => S.cases.find((c) => c.session === sid)
async function use(subject, { dismiss = false } = {}) {
  emit({ type: 'user', act: 'use', text: `/ascii ${subject}` })
  let r = await claude(`/ascii ${subject}`)
  const sid = r.session_id
  const c = await until(() => deskCase(sid), `the desk to catch ${subject}`)
  await until(() => !deskCase(sid).writing, `checks for ${subject}`)
  await sleep(1500)
  if (dismiss) {
    emit({ type: 'user', act: 'dismiss', c: c.id })
    await tool('review_case', { case_id: c.id, decision: 'dismiss' })
    return
  }
  for (let n = 0; n < 3; n++) {
    const m = shade(r.result)
    const kind = m.fill < 0.35 ? 'fill' : m.dark < 0.1 ? 'dark' : !m.ground ? 'ground' : null
    if (!kind) break
    const text = pick(kind)
    emit({ type: 'user', act: 'steer', c: c.id, text, kind })
    const said = deskCase(sid).steering.length
    r = await claude(text, sid)
    await until(() => deskCase(sid).steering.length > said, `the steer on ${subject}`)
    await until(() => !deskCase(sid).writing, `checks for ${subject}`)
    await sleep(1000)
  }
  emit({ type: 'user', act: 'accept', c: c.id })
  await tool('review_case', { case_id: c.id, decision: 'accept' })
}

async function optimize() {
  await until((s) => !s.loop.running, 'the board to be idle')
  emit({ type: 'user', act: 'optimize' })
  const r = await tool('optimize')
  if (r.error) throw new Error(r.error)
  await until((s) => s.loop.running, 'optimize to start', 60_000).catch(() => {})
  await until((s) => !s.loop.running, 'optimize to finish', 120 * 60_000)
}

const PHASES = [
  [['a cat'], ['a lighthouse'], ['a coffee mug'], ['a bicycle', { dismiss: true }], ['a rocket'], ['an owl']],
  [['a teapot'], ['a mushroom'], ['a sailboat'], ['a skateboard', { dismiss: true }], ['a hot air balloon'], ['a cactus in a pot']],
  [['a whale'], ['an apple'], ['a robot'], ['a mountain cabin']],
]

listen().catch((e) => {
  console.error('stream ended', e)
  process.exit(1)
})
await until((s) => s, 'first state', 10_000)
for (const [i, phase] of PHASES.entries()) {
  emit({ type: 'phase', n: i + 1 })
  for (const [subject, opts] of phase) {
    console.log(new Date().toISOString(), 'using /ascii', subject)
    await use(subject, opts)
  }
  console.log(new Date().toISOString(), 'optimizing, phase', i + 1)
  await optimize()
}
await sleep(2000)
emit({ type: 'end' })
console.log('done')
process.exit(0)
