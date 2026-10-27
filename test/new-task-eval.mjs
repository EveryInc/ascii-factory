// An eval for the new_task label in CHECK_SYSTEM: does the check writer tell a follow-up that asks for a different task
// from one that refines this one, and does the change leave ordinary steering alone?
//
//   node test/new-task-eval.mjs                 run both gates, the prompt in loop/v2/server.mjs against the one on main
//   node test/new-task-eval.mjs --runs 5        more runs of each
//   node test/new-task-eval.mjs --baseline <ref>  compare against another git ref
//   node test/new-task-eval.mjs --candidate <ref> judge the prompt at a git ref instead of this tree (--candidate main: the red run)
//   node test/new-task-eval.mjs --tag <name>    add a name to the results file
//   node test/new-task-eval.mjs --fixtures      write the answers the eval reads (once; they are checked in)
//   node test/new-task-eval.mjs --rescore <results.json>  score saved results again, with no model calls
//   node test/new-task-eval.mjs --add-replies   write fixture replies for follow-ups that have none
//
// It calls real models through `claude -p`, the way the board does, so it is not part of `npm test`.
// Gate 1: single follow-ups on a fixed case, each with an expected label. Gate 2: a case steered step by step, where
// nothing should be a new task and the checks should come out as they do with the old prompt.
// The input to the check writer is built as askForChecks builds it (loop/v2/server.mjs), so keep the two in step.

import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'test/fixtures/new-task-eval.json')
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? fallback : process.argv[i + 1]
}
const RUNS = Number(arg('runs', 3))
const BASELINE = arg('baseline', 'main')
const CANDIDATE = arg('candidate', null) // null: the prompt in this tree
const TAG = arg('tag', '')
const MODEL = arg('model', 'sonnet') // the board's grader, which writes the checks
const EFFORT = arg('effort', 'low')
const localClaude = join(homedir(), '.local/bin/claude')
const CLAUDE = process.env.CLAUDE_BIN || (existsSync(localClaude) ? localClaude : 'claude')

// ---------- the prompts ----------

const constIn = (src, name) => src.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`'))[1]
const serverAt = (ref) => (ref ? execFileSync('git', ['show', `${ref}:loop/v2/server.mjs`], { cwd: ROOT, encoding: 'utf8' }) : readFileSync(join(ROOT, 'loop/v2/server.mjs'), 'utf8'))
// "new" is the prompt being judged; "old" is what it is compared with.
const PROMPTS = { new: constIn(serverAt(CANDIDATE), 'CHECK_SYSTEM'), old: constIn(serverAt(BASELINE), 'CHECK_SYSTEM') }
const RUN_SYSTEM = readFileSync(join(ROOT, 'loop/v2/server.mjs'), 'utf8').match(/const RUN_SYSTEM = '([^']*)'/)[1]

// ---------- model calls, as the board makes them ----------

const ask = ({ system, prompt, model = MODEL, effort = EFFORT }) =>
  new Promise((resolve, reject) => {
    const args = ['-p', '--safe-mode', '--model', model, '--tools', '', '--no-session-persistence', '--system-prompt', system, '--output-format', 'json']
    if (effort) args.push('--effort', effort)
    const child = spawn(CLAUDE, args, { cwd: tmpdir() })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', () => {
      try {
        const r = JSON.parse(out)
        if (!r.is_error) return resolve(String(r.result))
      } catch {}
      reject(new Error(`claude -p failed: ${(err || out).slice(0, 300)}`))
    })
    child.stdin.end(prompt)
  })
const retry = (call) => ask(call).catch(() => ask(call))

function limiter(n) {
  let running = 0
  const queue = []
  const next = () => {
    if (running >= n || !queue.length) return
    running++
    const { fn, resolve, reject } = queue.shift()
    fn().then(resolve, reject).finally(() => (running--, next()))
  }
  return (fn) => new Promise((resolve, reject) => (queue.push({ fn, resolve, reject }), next()))
}
const limit = limiter(8)

// The first complete JSON object in a reply, as the board reads it.
function parseJson(text) {
  for (let a = text.indexOf('{'); a >= 0; a = text.indexOf('{', a + 1)) {
    let depth = 0
    let quoted = false
    let escaped = false
    for (let i = a; i < text.length; i++) {
      const ch = text[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') quoted = false
      } else if (ch === '"') quoted = true
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        try {
          return JSON.parse(text.slice(a, i + 1))
        } catch {
          break
        }
      }
    }
  }
  throw new Error(`expected JSON, got: ${text.slice(0, 120)}`)
}

// ---------- the check writer's input, as askForChecks builds it ----------

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

function facts(output) {
  const blocks = [...output.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1])
  if (!blocks.length) return `- no code block. The answer is ${plural(output.split('\n').length, 'line')}`
  const block = blocks.sort((a, b) => b.length - a.length)[0].replace(/^\s*\n/, '').trimEnd()
  const lines = block.split('\n')
  const widest = Math.max(...lines.map((l) => [...l].length))
  const nonAscii = [...new Set([...block].filter((ch) => ch.codePointAt(0) > 126))]
  const outside = output.replace(/```[\s\S]*?```/g, '').trim()
  return [
    `- code blocks: ${blocks.length}. The biggest is ${plural(lines.length, 'line')} tall and its widest line is ${widest} characters`,
    `- non-ASCII characters in it: ${nonAscii.length ? nonAscii.join(' ') : 'none'}`,
    `- text outside the code blocks: ${outside ? JSON.stringify(clip(outside, 300)) : 'none'}`,
  ].join('\n')
}

// c: { ask, turns: [{ id, answer }], steering: [{ id, text, turn, read }], checks: [{ id, question }] | null }
function checksPrompt(skill, c) {
  const last = c.turns.at(-1)
  const said = c.steering.map((s) => {
    const head = `${s.id}${s.read ? '' : ' (new)'}: ${s.text}`
    const turn = s.turn !== last.id ? c.turns.find((t) => t.id === s.turn) : null
    return turn ? `${head}\nTHE REPLY IT GOT:\n<<<\n${clip(turn.answer, 1500)}\n>>>` : head
  })
  const first = c.turns.length > 1 ? `THE FIRST ANSWER:\n<<<\n${clip(c.turns[0].answer, 1500)}\n>>>\n\n` : ''
  return `SKILL: /${skill.name}: ${skill.description}

REQUEST: ${c.ask}

${first}THE LATEST ANSWER IN THE SESSION:
<<<
${clip(last.answer, 3000)}
>>>

THE LATEST ANSWER, MEASURED BY CODE:
${facts(last.answer)}

WHAT THE PERSON SAID AFTER IT IN THE SESSION, IN ORDER:
${said.join('\n\n') || '(nothing)'}

THEIR NOTES ON THE CASE:
(none)

CHECKS IT HAS NOW:
${c.checks?.map((k) => `${k.id}: ${k.question}`).join('\n') || '(none yet)'}`
}

// What the check writer decided about one message.
function labelOf(got, id) {
  if (got.new_task?.id === id) return 'new_task'
  if ((got.unrelated ?? []).includes(id)) return 'unrelated'
  if ((got.comments ?? []).includes(id)) return 'comment'
  return 'steering'
}
// The board stores the request with or without the skill's name in front ("/ascii a dog" or "a dog"), so compare without it.
const bare = (s) => String(s ?? '').trim().replace(/^\/\S+\s+/, '').toLowerCase().replace(/[."]/g, '')
const sameRequest = (a, b) => bare(a) === bare(b)

// ---------- the cases ----------

// Gate 1: one follow-up at a time, on a fixed case. group decides how a label is scored.
const FOLLOW_UPS = [
  { id: 'dog', context: 'cat', text: 'make it a dog', group: 'new_task', request: 'a dog' },
  { id: 'dog-steer', context: 'cat', text: 'make it smaller, simpler and make it a dog', group: 'new_task', request: 'a dog' },
  { id: 'house', context: 'cat', text: 'now draw a house', group: 'new_task', request: 'a house' },
  { id: 'tiger', context: 'cat', text: 'can you do a tiger instead', group: 'new_task', request: 'a tiger' },
  { id: 'lighthouse', context: 'house', text: 'do a lighthouse instead', group: 'new_task', request: 'a lighthouse' },
  { id: 'hat', context: 'cat', text: 'add a hat', group: 'refinement' },
  { id: 'bigger', context: 'cat', text: 'make it bigger', group: 'refinement' },
  { id: 'fence', context: 'cat', text: 'draw it sitting on a fence', group: 'refinement' },
  { id: 'chimney', context: 'house', text: 'add a chimney with smoke', group: 'refinement' },
  { id: 'kitten', context: 'cat', text: 'make it a kitten', group: 'borderline' },
  { id: 'owner', context: 'cat', text: 'add its owner next to it', group: 'borderline' },
  { id: 'thanks', context: 'cat', text: 'thanks, looks good', group: 'comment' },
  { id: 'why', context: 'cat', text: 'why did you use @ for the eye?', group: 'comment' },
  { id: 'mcp', context: 'cat', text: 'claude mcp add --transport http toy-loop http://localhost:4488/mcp', group: 'unrelated' },
  { id: 'auth', context: 'cat', text: 'can you fix the failing test in auth.ts', group: 'unrelated' },
  // Held out: added after the prompt was reworded on the two above, and not to be tuned on. Once a result on these
  // has led to a change, they are no longer held out; add fresh ones.
  { id: 'email', context: 'cat', text: 'summarize this email thread for me', group: 'unrelated', heldOut: true },
  { id: 'sql', context: 'cat', text: 'write a SQL query that counts active users', group: 'unrelated', heldOut: true },
  { id: 'calendar', context: 'house', text: "what's on my calendar tomorrow?", group: 'unrelated', heldOut: true },
  { id: 'both', context: 'cat', text: 'draw a cat and a dog together', group: 'report' },
  { id: 'lion', context: 'cat', text: 'make it a lion', group: 'report' },
]
const EXPECT = { new_task: 'new_task', refinement: 'steering', borderline: 'steering', comment: 'comment', unrelated: 'unrelated' }

// Gate 2: one case steered step by step. Every step is steering except the last, a comment; the gates in report() say so.
const SEQUENCE = {
  ask: '/ascii a coffee mug',
  steps: [
    { text: 'make it bigger' },
    { text: 'add steam coming out of the top' },
    { text: 'it should be at least 12 lines tall' },
    { text: 'less cluttered, fewer characters inside the mug' },
    { text: 'thanks, looks good' },
  ],
}

// ---------- fixtures: the answers the session would have given, made once ----------

const SESSION_MODEL = 'sonnet'
const skillBody = (skill) => skill.body
const firstAnswer = (skill, request) => retry({ system: RUN_SYSTEM, prompt: `${skillBody(skill)}\n\nARGUMENTS: ${request}`, model: SESSION_MODEL, effort: 'low' })
const reply = (skill, request, before, text) =>
  retry({
    system: RUN_SYSTEM,
    prompt: `${skillBody(skill)}\n\nARGUMENTS: ${request}\n\nYOUR ANSWER SO FAR:\n<<<\n${before}\n>>>\n\nTHE PERSON NOW SAYS: ${text}\n\nReply to them as you would in the session.`,
    model: SESSION_MODEL,
    effort: 'low',
  })

async function makeFixtures(board) {
  // The cat is the case from a real session: its two answers, its first steer and the checks the board wrote then.
  const saved = JSON.parse(readFileSync(board, 'utf8')).boards[0]
  const cat = saved.cases.find((c) => c.ask === '/ascii a cat')
  const skill = { name: 'ascii', description: saved.skill.description, body: 'Draw the requested subject as ASCII art.' }
  const contexts = {
    cat: {
      ask: cat.ask,
      turns: cat.turns.slice(0, 2).map(({ answer }, i) => ({ id: `t${i + 1}`, answer })),
      steering: [{ id: 's1', text: cat.steering[0].text, turn: 't2', read: true }],
      checks: arg('cat-checks') ? JSON.parse(readFileSync(arg('cat-checks'), 'utf8')) : null,
    },
  }
  if (!contexts.cat.checks) throw new Error('--cat-checks <file>: the checks the board wrote after the first steer')
  // The house has no steering yet: its checks are what the current prompt writes from the request.
  const house = { ask: '/ascii a house', turns: [{ id: 't1', answer: await firstAnswer(skill, 'a house') }], steering: [], checks: null }
  house.checks = parseJson(await retry({ system: PROMPTS.old, prompt: checksPrompt(skill, house) })).checks.map((k, i) => ({ id: `k${i + 1}`, question: k.question }))
  contexts.house = house
  const followUps = await Promise.all(
    FOLLOW_UPS.map((f) => limit(async () => ({ id: f.id, reply: await reply(skill, contexts[f.context].ask.replace(/^\/\S+ /, ''), contexts[f.context].turns.at(-1).answer, f.text) }))),
  )
  const answers = [await firstAnswer(skill, 'a coffee mug')]
  for (const s of SEQUENCE.steps) answers.push(await reply(skill, 'a coffee mug', answers.at(-1), s.text))
  mkdirSync(dirname(FIXTURES), { recursive: true })
  writeFileSync(FIXTURES, JSON.stringify({ skill, contexts, replies: Object.fromEntries(followUps.map((f) => [f.id, f.reply])), sequence: answers }, null, 1))
  console.log(`wrote ${FIXTURES}`)
}

// ---------- gate 1: single follow-ups ----------

async function gate1(fx) {
  const jobs = []
  for (const f of FOLLOW_UPS)
    for (const which of ['new', 'old'])
      for (let run = 0; run < RUNS; run++)
        jobs.push(
          limit(async () => {
            const ctx = structuredClone(fx.contexts[f.context])
            const id = `s${ctx.steering.length + 1}`
            ctx.turns.push({ id: 'tf', answer: fx.replies[f.id] })
            ctx.steering.push({ id, text: f.text, turn: 'tf', read: false })
            const got = parseJson(await retry({ system: PROMPTS[which], prompt: checksPrompt(fx.skill, ctx) }))
            return { item: f.id, which, run, label: labelOf(got, id), request: got.new_task?.id === id ? got.new_task.request : null, checks: got.checks }
          }),
        )
  return Promise.all(jobs)
}

// ---------- gate 2: one case steered step by step ----------

// A check that keeps its wording keeps its id, as setChecks does.
function setChecks(before, list, seq) {
  return list.map((x) => before.find((k) => k.id === x.id && k.question === x.question) ?? { id: `k${++seq.k}`, question: String(x.question ?? '') })
}

async function gate2Run(fx, which, run) {
  const seq = { k: 0 }
  const c = { ask: SEQUENCE.ask, turns: [{ id: 'm0', answer: fx.sequence[0] }], steering: [], checks: null }
  const steps = []
  let got = parseJson(await retry({ system: PROMPTS[which], prompt: checksPrompt(fx.skill, c) }))
  c.checks = setChecks([], got.checks ?? [], seq)
  steps.push({ step: 0, label: null, checks: c.checks, kept: null })
  for (const [i, s] of SEQUENCE.steps.entries()) {
    for (const x of c.steering) x.read = true
    const id = `s${i + 1}`
    c.turns.push({ id: `m${i + 1}`, answer: fx.sequence[i + 1] })
    c.steering.push({ id, text: s.text, turn: `m${i + 1}`, read: false })
    got = parseJson(await retry({ system: PROMPTS[which], prompt: checksPrompt(fx.skill, c) }))
    const label = labelOf(got, id)
    const before = c.checks
    // As refreshChecks does: the reply's checks are kept for steering and for a comment alike (a comment's reply is not a
    // new answer, so its turn goes). A split or an unrelated message would cut the case, a failure here, so the checks
    // stay as they were.
    if (label === 'comment') c.turns = c.turns.filter((t) => t.id !== `m${i + 1}`)
    if (label === 'comment' || label === 'steering') c.checks = setChecks(before, got.checks ?? [], seq)
    const kept = before.filter((k) => c.checks.includes(k)).length
    steps.push({ step: i + 1, label, checks: c.checks, kept, of: before.length })
  }
  return { which, run, steps }
}

const gate2 = (fx) => Promise.all(['new', 'old'].flatMap((which) => Array.from({ length: RUNS }, (_, run) => gate2Run(fx, which, run))))

// ---------- the report ----------

const count = (xs, f) => xs.filter(f).length
const tally = (rs) => Object.entries(rs.reduce((a, r) => ((a[r.label] = (a[r.label] ?? 0) + 1), a), {})).map(([k, n]) => `${k} ${n}`).join(', ')

// meta is how the results were made: this run's settings, or those saved with results being scored again.
function report(g1, g2, meta) {
  const { model, effort, runs, candidate, baseline } = meta
  const out = [`# new_task eval`, '', `Check writer: ${model}${effort ? ` · ${effort}` : ''}. ${runs} runs each. Judged ("new"): CHECK_SYSTEM ${candidate}. Compared with ("old"): ${baseline}.`, '', '## Gate 1: single follow-ups', '']
  out.push('| Follow-up | Expected | New prompt | Requests (new) | Old prompt |', '|---|---|---|---|---|')
  for (const f of FOLLOW_UPS) {
    const n = g1.filter((r) => r.item === f.id && r.which === 'new')
    const o = g1.filter((r) => r.item === f.id && r.which === 'old')
    const reqs = n.filter((r) => r.request).map((r) => r.request)
    out.push(`| ${f.text}${f.heldOut ? ' (held out)' : ''} | ${EXPECT[f.group] ?? 'report only'}${f.request ? ` (${f.request})` : ''} | ${tally(n)} | ${reqs.join('; ') || '–'} | ${tally(o)} |`)
  }
  const newOf = (group) => g1.filter((r) => r.which === 'new' && FOLLOW_UPS.find((f) => f.id === r.item).group === group)
  const oldOf = (group) => g1.filter((r) => r.which === 'old' && FOLLOW_UPS.find((f) => f.id === r.item).group === group)
  const splits = (rs) => count(rs, (r) => r.label === 'new_task')
  const found = newOf('new_task')
  const badRequests = found.filter((r) => r.label === 'new_task' && !sameRequest(r.request, FOLLOW_UPS.find((f) => f.id === r.item).request))
  const sameAsOld = (group) => newOf(group).every((r) => r.label === EXPECT[group]) || count(newOf(group), (r) => r.label === EXPECT[group]) >= count(oldOf(group), (r) => r.label === EXPECT[group])
  const g1checks = [
    ['Clear refinements: no splits', splits(newOf('refinement')) === 0, `${splits(newOf('refinement'))} of ${newOf('refinement').length}`],
    ['Borderline: at most 1 split in 6', splits(newOf('borderline')) <= Math.floor(newOf('borderline').length / 6), `${splits(newOf('borderline'))} of ${newOf('borderline').length}`],
    ['New tasks: caught in most runs', splits(found) > found.length / 2, `${splits(found)} of ${found.length}`],
    ['Requests: no preferences, right form', badRequests.length === 0, badRequests.map((r) => `${r.item}: "${r.request}"`).join('; ') || 'all clean'],
    ['Comments: as with the old prompt', sameAsOld('comment'), `${count(newOf('comment'), (r) => r.label === 'comment')} of ${newOf('comment').length} (old ${count(oldOf('comment'), (r) => r.label === 'comment')})`],
    ['Held-out unrelated: labeled unrelated', (() => {
      const h = g1.filter((r) => r.which === 'new' && FOLLOW_UPS.find((f) => f.id === r.item).heldOut)
      return count(h, (r) => r.label === 'unrelated') === h.length
    })(), (() => {
      const h = g1.filter((r) => r.which === 'new' && FOLLOW_UPS.find((f) => f.id === r.item).heldOut)
      return `${count(h, (r) => r.label === 'unrelated')} of ${h.length}${h.some((r) => r.label !== 'unrelated') ? ` (${tally(h.filter((r) => r.label !== 'unrelated'))})` : ''}`
    })()],
    ['Unrelated: as with the old prompt', sameAsOld('unrelated'), `${count(newOf('unrelated'), (r) => r.label === 'unrelated')} of ${newOf('unrelated').length} (old ${count(oldOf('unrelated'), (r) => r.label === 'unrelated')})`],
  ]

  out.push('', '## Gate 2: steering only', '', '| Step | Follow-up | Labels (new) | Labels (old) | Checks kept, new | Checks kept, old | Checks, new | Checks, old |', '|---|---|---|---|---|---|---|---|')
  const at = (which, step) => g2.filter((r) => r.which === which).map((r) => r.steps[step])
  const kept = (xs) => (xs[0].kept == null ? '–' : `${xs.reduce((a, x) => a + x.kept, 0)} of ${xs.reduce((a, x) => a + x.of, 0)}`)
  const sizes = (xs) => xs.map((x) => x.checks.length).join(', ')
  for (let step = 0; step <= SEQUENCE.steps.length; step++) {
    const n = at('new', step)
    const o = at('old', step)
    out.push(`| ${step} | ${step ? SEQUENCE.steps[step - 1].text : SEQUENCE.ask} | ${step ? tally(n) : '–'} | ${step ? tally(o) : '–'} | ${kept(n)} | ${kept(o)} | ${sizes(n)} | ${sizes(o)} |`)
  }
  const all = (which) => g2.filter((r) => r.which === which).flatMap((r) => r.steps.slice(1))
  const twelve = (which) => at(which, 3).map((x) => x.checks.some((k) => /\b12\b/.test(k.question) && /at least|or more|minimum/i.test(k.question)))
  const keptRate = (which) => {
    const xs = all(which).filter((x) => x.label === 'steering')
    return xs.reduce((a, x) => a + x.kept, 0) / Math.max(1, xs.reduce((a, x) => a + x.of, 0))
  }
  const g2checks = [
    ['No split or unrelated, ever', count(all('new'), (x) => x.label === 'new_task' || x.label === 'unrelated') === 0, `${count(all('new'), (x) => x.label === 'new_task' || x.label === 'unrelated')} of ${all('new').length}`],
    ['"thanks, looks good" is a comment', at('new', 5).every((x) => x.label === 'comment'), at('new', 5).map((x) => x.label).join(', ')],
    ['"at least 12 lines" kept exactly', twelve('new').every(Boolean), `new ${count(twelve('new'), Boolean)} of ${runs}, old ${count(twelve('old'), Boolean)} of ${runs}`],
    ['Untouched checks kept, as often as before', keptRate('new') >= keptRate('old') - 0.1, `new ${(100 * keptRate('new')).toFixed(0)}%, old ${(100 * keptRate('old')).toFixed(0)}%`],
  ]
  out.push('', '## Gates', '', '| Check | Pass | Result |', '|---|---|---|')
  for (const [name, ok, detail] of [...g1checks, ...g2checks]) out.push(`| ${name} | ${ok ? 'yes' : '**no**'} | ${detail} |`)
  out.push('', 'Steer coverage in gate 2 (does each steer show up in a check?) is read by hand from the side-by-side checks in the JSON results.')
  return out.join('\n')
}

// ---------- main ----------

if (process.argv.includes('--add-replies')) {
  const fx = JSON.parse(readFileSync(FIXTURES, 'utf8'))
  const missing = FOLLOW_UPS.filter((f) => !fx.replies[f.id])
  for (const f of missing) {
    const c = fx.contexts[f.context]
    fx.replies[f.id] = await reply(fx.skill, c.ask.replace(/^\/\S+ /, ''), c.turns.at(-1).answer, f.text)
  }
  writeFileSync(FIXTURES, JSON.stringify(fx, null, 1))
  console.log(`added replies for ${missing.map((f) => f.id).join(', ') || 'none'}`)
} else if (arg('rescore')) {
  // Score saved results again, with no model calls.
  const r = JSON.parse(readFileSync(arg('rescore'), 'utf8'))
  // Older results saved the candidate as a bare ref, "working tree", or not at all (the working tree).
  const c = r.candidate
  const candidate = /^(at|in) /.test(c ?? '') ? c : !c || c === 'working tree' ? 'in the working tree' : `at ${c}`
  console.log(report(r.gate1, r.gate2, { model: r.model, effort: r.effort, runs: r.runs, candidate, baseline: r.baseline }))
} else if (process.argv.includes('--fixtures')) {
  await makeFixtures(arg('from-board', join(ROOT, 'data/v2.json')))
} else {
  const fx = JSON.parse(readFileSync(FIXTURES, 'utf8'))
  const started = Date.now()
  const [g1, g2] = await Promise.all([gate1(fx), gate2(fx)])
  const meta = { model: MODEL, effort: EFFORT, runs: RUNS, candidate: CANDIDATE ? `at ${CANDIDATE}` : 'in the working tree', baseline: BASELINE }
  const md = report(g1, g2, meta)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + (TAG ? `-${TAG}` : '')
  mkdirSync(join(ROOT, 'data/new-task-eval'), { recursive: true })
  writeFileSync(join(ROOT, `data/new-task-eval/${stamp}.json`), JSON.stringify({ ...meta, gate1: g1, gate2: g2 }, null, 1))
  writeFileSync(join(ROOT, `data/new-task-eval/${stamp}.md`), md)
  console.log(md)
  console.log(`\n${((Date.now() - started) / 1000).toFixed(0)}s. Results in data/new-task-eval/${stamp}.{md,json}`)
}
