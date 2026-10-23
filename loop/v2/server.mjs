// Toy loop v2: the same two loops on a skill, with no chat on the board. The skill is used in Claude Code, as usual.
//
//   connect:   one line in a skill's SKILL.md frontmatter, a hook that posts each turn of a session here
//   desk:      each use of the skill, caught by that hook, with checks suggested straight away. Your notes on a case
//              (spoken or typed) rewrite its checks; accept puts it in the dataset, dismiss removes it
//   lab:       test a version of the skill on the dataset's cases, and grade its first tries on their checks
//   library:   every version of the skill. Optimize writes new ones from what the current one fails, and a new one
//              becomes the skill when it passes more checks than the current one on the cases both were run on
//
// Each connected skill has a board of its own. Agent native: every action is a tool, served over MCP at /mcp
// and registered with WebMCP by the page. It only listens on localhost, because it rewrites a file that Claude Code
// reads as instructions. All model work goes through `claude -p`, so there is no API key and nothing to install.
//
// Hosted (TOY_LOOP_PASSWORD set): the board sits behind a login, listens beyond localhost, and calls the API with
// ANTHROPIC_API_KEY through the Anthropic SDK, because a host has no `claude` login to borrow. Hooks do not reach it,
// so its first start loads seed.json, a board to try things on.

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const PASSWORD = process.env.TOY_LOOP_PASSWORD || '' // set it to host the board: see the login section
const HOSTED = Boolean(PASSWORD)
const PORT = Number(process.env.TOY_LOOP_V2_PORT || (HOSTED && process.env.PORT) || 4488)
const API_KEY = (HOSTED && process.env.ANTHROPIC_API_KEY) || ''
const STATE_FILE = process.env.TOY_LOOP_V2_STATE || join(ROOT, 'data/v2.json')
const SEED_FILE = join(HERE, 'seed.json') // the board a host starts from
const TRANSCRIPTS = join(homedir(), '.claude/projects') // where Claude Code keeps each session's transcript
// Where to look for connected skills before they have been used: this project's skills, and your own.
const SKILL_DIRS = [join(ROOT, '.claude/skills'), join(homedir(), '.claude/skills')]
// The one line. Claude Code registers the hook when the skill is used, and from then on posts each turn of
// that session here as it ends. Quick and silent when the board is not running.
const LINE = `hooks: { Stop: [{ hooks: [{ type: command, command: "curl -s -m 2 -o /dev/null --json @- localhost:${PORT}/catch || true" }] }] }`
const CONNECTED = new RegExp(`localhost:${PORT}/catch\\b`)
const SCHEMA = 2 // bump when the shape of the state file changes
// Who does what, and how hard they think, set on the board:
//   teacher: writes the versions of the skill   student: does the skill's task on each case
//   grader:  writes a case's checks, and answers them
// The student's first tries are kept for each student, the grader's answers for each grader, and the teacher's
// versions for each teacher, so changing one shows what that one has done, and Test fills in the rest.
const DEFAULTS = {
  teacher: { model: 'opus', effort: '' },
  // Low effort: the student starts drawing in a second or two, where it would otherwise plan for minutes.
  student: { model: 'haiku', effort: 'low' },
  grader: { model: 'sonnet', effort: 'low' },
  prompts: { teacher: '', checks: '' }, // edited prompts: empty means the built-in one
  // Optimize writes at least min new versions and at most max, and stops once patience of them in a row have lost.
  optimize: { min: 3, max: 10, patience: 3 },
}
let settings = structuredClone(DEFAULTS)
const roleKey = (role) => settings[role].model + (settings[role].effort ? ` · ${settings[role].effort}` : '')
const as = (role) => ({ model: settings[role].model, effort: settings[role].effort || undefined })
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max']
const localClaude = join(homedir(), '.local/bin/claude')
const CLAUDE = process.env.CLAUDE_BIN || (existsSync(localClaude) ? localClaude : 'claude')

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const tilde = (p) => (p.startsWith(homedir() + sep) ? `~${p.slice(homedir().length)}` : p)
// The answer the session has got to: the reply to the last message that asked for one.
const latest = (c) => c.turns.findLast((t) => !t.comment)

// ---------- the skill file ----------

function readSkill(file) {
  const text = readFileSync(file, 'utf8')
  const front = text.match(/^---\n[\s\S]*?\n---\n?/)?.[0] ?? ''
  return { front, body: text.slice(front.length).trim() }
}

const frontField = (front, key) =>
  front
    .match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))?.[1]
    ?.trim()
    .replace(/^(["'])(.*)\1$/, '$2') ?? ''

const connectedFile = (file) => {
  try {
    return CONNECTED.test(readSkill(file).front)
  } catch {
    return false
  }
}

// ---------- model calls ----------

function limiter(n) {
  let running = 0
  const queue = []
  const next = () => {
    if (running >= n || !queue.length) return
    running++
    const { fn, resolve, reject } = queue.shift()
    fn()
      .then(resolve, reject)
      .finally(() => {
        running--
        next()
      })
  }
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject })
      next()
    })
}
const limit = limiter(10) // ten cases at a time: a test of a dozen comes back in about the time of one

// --safe-mode and a temp cwd keep these calls clear of skills and hooks,
// so trying the skill here never shows up as a new use of the skill.
// The reply streams: onText hears the text so far, each time more of it arrives.
const askCli = ({ model, system, prompt, effort, onText }) =>
  new Promise((resolve, reject) => {
    const args = ['-p', '--safe-mode', '--model', model, '--tools', '', '--no-session-persistence', '--system-prompt', system]
    args.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages')
    if (effort) args.push('--effort', effort)
    const child = spawn(CLAUDE, args, { cwd: tmpdir(), env: { ...process.env, TOY_LOOP_INTERNAL: '1' } })
    let buf = ''
    let text = ''
    let result = null
    let err = ''
    let late = false
    const timer = setTimeout(() => {
      late = true
      child.kill()
    }, 300_000)
    child.stdout.on('data', (d) => {
      buf += d
      for (let i; (i = buf.indexOf('\n')) >= 0; ) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        const delta = m.type === 'stream_event' && m.event?.type === 'content_block_delta' ? m.event.delta : null
        if (delta?.type === 'text_delta') {
          text += delta.text
          onText?.(text)
        } else if (m.type === 'result') result = m
      }
    })
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (result && !result.is_error) return resolve(String(result.result ?? text))
      const why = late ? 'no reply within 5 minutes' : result?.is_error ? result.result : err || `it exited with code ${code} and no output`
      reject(new Error(`claude -p failed: ${clip(String(why), 300)}`))
    })
    child.stdin.end(prompt)
  })

// Hosted, the same call goes to the API through the SDK, streamed the same way. The short names are the ones
// `claude --model` takes. Opus and Sonnet can decline a request on safety grounds; fallbacks: 'default' has the API
// run a declined request again on the model it recommends, rather than return the refusal.
const API_MODELS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }
let anthropic = null
async function askApi({ model, system, prompt, effort, onText }) {
  anthropic ??= new (await import('@anthropic-ai/sdk')).default({ apiKey: API_KEY })
  const id = API_MODELS[model] ?? model
  const params = { model: id, max_tokens: 32000, system, messages: [{ role: 'user', content: prompt }], ...(effort ? { output_config: { effort } } : {}) }
  const stream = /^claude-(opus|sonnet)-/.test(id)
    ? anthropic.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : anthropic.messages.stream(params)
  let text = ''
  for await (const event of stream)
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text
      onText?.(text)
    }
  const message = await stream.finalMessage()
  if (message.stop_reason === 'refusal') throw new Error('the model declined this request')
  return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
}

const ask = (call) => (API_KEY ? askApi(call) : askCli(call))

// Now and then a headless call comes back empty, so each one gets a second go.
const llm = (call) => limit(() => ask(call).catch(() => ask(call)))

// The first complete JSON object in a reply: a model now and then adds a line, or a second object, after it.
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
  throw new Error(`expected JSON, got: ${clip(text, 120)}`)
}

const RUN_SYSTEM = 'You are Claude Code. The user invoked a skill; its instructions and arguments are in their message. Keep any planning brief and start the answer quickly.'

// A skill reaches the model as its instructions with the arguments it was called with, the way Claude Code passes them.
const runSkill = (body, prompt, onText) =>
  llm({
    ...as('student'),
    system: RUN_SYSTEM,
    prompt: body.includes('$ARGUMENTS') ? body.replaceAll('$ARGUMENTS', prompt) : `${body}\n\nARGUMENTS: ${prompt}`,
    onText,
  })

// Models count characters badly, so measure what can be measured and hand it over.
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

const JUDGE_SYSTEM = `You grade one answer from a Claude Code skill.
Answer each yes/no check about the answer. Be strict and literal: pass only when the answer is clearly yes.
Reply with JSON only.`

const CHECK_SYSTEM = `You write the eval for one case of a Claude Code skill: yes/no checks that will grade any future answer to the same request.
You are given the skill, the request, the answer it got in the session, what the person said after it in the session, and their notes on the case: what they like and don't like, spoken or typed on the board where they review cases.

- Until the person says anything, write 2 to 4 checks for what the request asks for: its subject, anything it names, and what the skill is plainly for. Nothing it does not imply.
- What they say in the session and in their notes is steering: it adds, changes or removes checks. A later message wins over an earlier one. The notes are spoken as often as typed, so read them for what they mean, not word for word.
- A number they give is the threshold, exactly as given: "at least 3 lines" makes a check for at least 3, never more.
- A relative ask with no number ("bigger", "longer", "less cluttered") needs one, so that the check can be answered. In the session it got a new answer, which shows how much they meant: take the number from that answer's measurements, with a little room, so that answer passes. The notes get no new answer: set the number just beyond the answer they were looking at.
- A check is answered by someone who sees only the request and one new answer, never this conversation, so each must be observable in an answer on its own.
- YES must mean the answer is the way they want it. One thing per check, at most 20 words.
- Change a check only when something the person said calls for it. Keep every other check word for word, with its id.
- A message in the session that is about the answer but asks for no change ("thanks", "looks good", a question about it) changes nothing, and the reply to it is not a new answer: put its id in "comments".
- A message in the session may not be about this answer at all: other work, or a new topic. Put its id in "unrelated", and take nothing from it or from anything after it.

Reply with JSON only:
{"checks": [{"id": "<the id of a check it has now, or null>", "question": "..."}], "comments": ["<id of a message>"], "unrelated": ["<id of a message>"]}`

const GENERATE_SYSTEM = `You write a Claude Code skill: the instructions in its SKILL.md, from cases of how one person wants it to work.
Each case is a request the skill was used for, with yes/no checks written from what the person said about the answers they got, and their notes.

Write instructions that make the first answer to any such request pass those checks.
- Read the checks and the notes as this person's taste, and generalize it: what would they want from any request to this skill? Do not fit the instructions to the requests you are shown.
- Never mention the subjects of those requests, and never copy an answer or any part of one.
- Keep it short: plain instructions, no preamble. Stay within what the skill is for.

Reply in exactly this form:
<name>what this version tries, as a short name of at most 8 words</name>
<skill>
the complete instructions
</skill>`

const REWRITE_SYSTEM = `You improve a Claude Code skill: the instructions in its SKILL.md.
The instructions are given to a model together with a request. The person who uses the skill judges each answer with yes/no checks, written from what they said about earlier answers.

Rewrite the instructions so that the first answer passes more checks, before the person has said anything.
- Read the checks and the person's notes as their taste, and generalize it: what would they want from any request to this skill? Do not fit the instructions to the requests you are shown.
- Never mention the subjects of those requests, and never copy an answer or any part of one.
- Keep what already works, and keep it short: plain instructions, no preamble.
- Stay within what the skill is for.

Reply in exactly this form:
<name>what this version tries, as a short name of at most 8 words, such as "Frame every drawing in a titled border"</name>
<skill>
the complete new instructions
</skill>`

// ---------- boards: one for each connected skill ----------

const boards = new Map() // the skill's file -> its board
let activeKey = null // the board on show
const clients = new Set()
let flushTimer = null
let saveTimer = null

const active = () => boards.get(activeKey) ?? null
const skills = () => [...boards.values()].map((b) => ({ key: b.key, name: b.state.skill.name, file: tilde(b.key) }))

const view = () => ({
  ...(active()?.state ?? { skill: null, cases: [], versions: [], baseline: null, runs: {}, current: null, loop: { running: false }, stopped: null }),
  skills: skills(),
  active: activeKey,
  line: HOSTED ? LINE.replace(`localhost:${PORT}`, 'localhost:4488') : LINE, // hosted, the line is for a board on your own machine
  port: HOSTED ? 4488 : PORT,
  home: homedir(),
  settings,
  hosted: HOSTED,
  keys: { teacher: roleKey('teacher'), student: roleKey('student'), grader: roleKey('grader') },
  builtIn: { teacher: REWRITE_SYSTEM, checks: CHECK_SYSTEM },
})

// Every change goes through touch(): push the board on show to the page, and save every board.
function touch() {
  flushTimer ??= setTimeout(() => {
    flushTimer = null
    const msg = `event: state\ndata: ${JSON.stringify(view())}\n\n`
    for (const res of clients) res.write(msg)
  }, 40)
  saveTimer ??= setTimeout(() => {
    saveTimer = null
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify({ schema: SCHEMA, active: activeKey, settings, boards: [...boards.values()].map((b) => b.state) }, null, 1))
  }, 400)
}

// Replies being written go to the page on their own, a few times a second, rather than with the whole board.
let streamTimer = null
function flushStreams() {
  streamTimer ??= setTimeout(() => {
    streamTimer = null
    const msg = `event: stream\ndata: ${JSON.stringify({ active: activeKey, streams: active()?.streams ?? {} })}\n\n`
    for (const res of clients) res.write(msg)
  }, 80)
}

const freshBoard = (name, file) => ({
  // { name, file, front, description, connected, missing }  front is the frontmatter as the file has it now
  skill: { name, file },
  // A case is one use of the skill in a session, and whatever was said about it after:
  //   { id, key, session, ask, prompt, status, at, turns, following, dropped, steering, notes, notesRead, checks, writing, verdicts }
  //   key:       the session, and the message that used the skill, so a later turn of the session finds the same case
  //   ask:       what was typed. prompt is what the skill was given, and what each version is tried on
  //   status:    'queue' while it is on the desk, then 'accepted' once it is in the dataset
  //   turns:     [{ id, ask, answer, comment }]  the use, then each follow-up in the session while it is about this answer.
  //              comment: it asked for no change ("thanks"), so its reply is not a new answer
  //   following: later turns of the session are still taken as steering. Off once the session moves on, or it is accepted
  //   steering:  [{ id, text, turn, read }]  what was said in the session after the use, read once worked into the checks
  //   notes:     what the person thinks of it, spoken or typed on the desk. notesRead: the notes the checks were last written from
  //   checks:    [{ id, question }], or null until the first ones are written
  //   verdicts:  { [grader]: { [checkId]: { pass, why } } }  for the latest answer in the session
  //   model:     the model the session used
  cases: [],
  dismissed: [], // keys of dismissed cases, so a later turn in their session does not bring them back
  // The library, every version of the skill's body: { id, text, note, by, status, parent, trial, at }
  //   by:      'start' | 'hand' (SKILL.md edited by hand) | 'board' | 'agent' | 'optimizer' | 'generate'
  //   teacher: the teacher that wrote it, or null for yours (the start, edits by hand, an agent's)
  //   status:  'won' (it has been the skill), 'lost' (it did not beat the skill), 'new' (not judged yet), 'running',
  //            'writing' (Optimize is writing it: no text yet)
  //   trial:   { against, before, after, cases }  the scores it was judged on, on the cases both were run on
  versions: [],
  // The baseline: no skill, only what the skill is for (its description). The bar every version has to clear.
  baseline: { id: 0, text: '', note: 'no skill', by: 'baseline', status: 'baseline', parent: null, teacher: null, trial: null },
  current: null, // the version that is the skill: what SKILL.md holds
  runs: {}, // runs[student][versionId][caseId] = { output, verdicts: { [grader]: { [checkId]: { pass, why } } } }
  log: [],
  loop: { running: false, kind: null, status: 'idle' }, // the one job at a time: a test, or optimizing
  stopped: null, // why the last job stopped short, if it did
  seq: { c: 0, k: 0, s: 0, v: 0 },
})

// A saved board, brought up to date: older ones split the dataset, had a loop that ran on its own, and kept
// what was said on the board as separate steers rather than notes.
function revive(s) {
  s.loop = freshBoard().loop
  s.stopped ??= null
  s.baseline ??= freshBoard().baseline
  // First tries and verdicts were kept for one student and one grader, both Haiku at low effort.
  const old = 'haiku · low'
  if (Object.values(s.runs).some((byCase) => Object.values(byCase).some((r) => r && 'output' in r))) {
    const runs = {}
    for (const [vid, byCase] of Object.entries(s.runs))
      for (const [cid, r] of Object.entries(byCase)) ((runs[vid] ??= {})[cid] = { output: r.output, verdicts: { [old]: r.verdicts ?? {} } })
    s.runs = { [old]: runs }
  }
  for (const c of s.cases) {
    if (Object.values(c.verdicts ?? {}).some((x) => typeof x?.pass === 'boolean')) c.verdicts = { [old]: c.verdicts }
    c.writing = false
    if (c.status !== 'queue') c.status = 'accepted'
    const board = c.steering.filter((x) => x.from === 'board')
    c.notes ??= board.map((x) => x.text).join('\n')
    c.notesRead ??= board.every((x) => x.read) ? c.notes : ''
    c.steering = c.steering.filter((x) => x.from !== 'board')
  }
  const was = { kept: 'won', rejected: 'lost', testing: 'new', running: 'new' }
  s.versions = s.versions.filter((v) => v.status !== 'writing') // being written when the server stopped
  for (const v of s.versions) {
    v.status = was[v.status] ?? v.status
    v.by ??= v.note === 'starting point' ? 'start' : v.note === 'edited by hand' ? 'hand' : 'optimizer'
    v.teacher ??= v.by === 'optimizer' ? 'sonnet' : null // the optimizer used to write with Sonnet
    if (v.trial && !('against' in v.trial)) v.trial = null
    delete v.score
  }
  s.current ??= s.versions.findLast((v) => v.status === 'won')?.id ?? null
  return s
}

function Board(saved) {
  const state = saved
  const key = state.skill.file
  let epoch = 0 // bumped by reset(), and by Stop: work started before it never touches what comes after
  // Replies still being written, so the page can show them as they come: 'r:<version>:<case>' for a first try,
  // 'v:<version>' for a new version's instructions.
  const streams = {}
  const stream = (k, text) => {
    streams[k] = text
    flushStreams()
  }
  const unstream = (k) => {
    delete streams[k]
    flushStreams()
  }

  function log(msg, kind = 'inner') {
    state.log.push({ t: Date.now(), msg, kind })
    if (state.log.length > 120) state.log.shift()
    console.log(`[${state.skill.name}] ${msg}`)
    touch()
  }
  const setStatus = (status, version) => {
    state.loop.status = status
    if (version !== undefined) state.loop.version = version // the version being tested, for the progress bar
    touch()
  }
  const current = () => state.versions.find((v) => v.id === state.current)
  // The dataset is the accepted cases. Only those grade the skill, and only the ones with checks can.
  const dataset = () => state.cases.filter((c) => c.status !== 'queue')
  const gradable = () => dataset().filter((c) => c.checks?.length)
  const skillLine = () => `SKILL: /${state.skill.name}${state.skill.description ? `: ${state.skill.description}` : ''}`

  // ---------- the skill file ----------

  // Only the body is rewritten. The frontmatter, the line in it included, stays as it is.
  const writeSkill = (body) => writeFileSync(key, `${readSkill(key).front}\n${body.trim()}\n`)

  function addVersion(text, note, status, parent = null, by = 'board', teacher = null) {
    const v = { id: ++state.seq.v, text: text.trim(), note, by, status, parent, teacher, trial: null, at: Date.now() }
    state.versions.push(v)
    touch()
    return v
  }

  // The file on disk is the truth: pick up the starting point, any edit made by hand, and whether the line is still in it.
  function syncSkill() {
    const sk = state.skill
    let read
    try {
      read = readSkill(key)
    } catch {
      if (!sk.missing) log(`${tilde(key)} cannot be read`, 'error')
      sk.missing = true
      return touch()
    }
    Object.assign(sk, { missing: false, front: read.front, description: frontField(read.front, 'description'), connected: CONNECTED.test(read.front) })
    // The baseline is the skill's description and nothing more: when the description changes, so does the baseline.
    const base = sk.description || `Do what the /${sk.name} skill is for.`
    if (state.baseline.text !== base) {
      state.baseline.text = base
      for (const byVersion of Object.values(state.runs)) delete byVersion[0]
    }
    const cur = current()
    if (!cur) state.current = addVersion(read.body, 'starting point', 'won', null, 'start').id
    else if (cur.text !== read.body) {
      const v = addVersion(read.body, 'edited by hand', 'won', cur.id, 'hand')
      state.current = v.id
      log(`SKILL.md was edited by hand, now v${v.id}`, 'outer')
    }
    touch()
  }

  function watch() {
    syncSkill()
    unwatchFile(key)
    watchFile(key, { interval: 1000 }, () => syncSkill())
  }

  // ---------- model calls about this skill ----------

  async function judge(request, output, checks) {
    const text = await llm({
      ...as('grader'),
      system: JUDGE_SYSTEM,
      prompt: `${skillLine()}

REQUEST: ${request}

ANSWER (everything between the markers):
<<<
${output}
>>>

MEASURED BY CODE (trust these over your own counting):
${facts(output)}

CHECKS:
${checks.map((k) => `${k.id}: ${k.question}`).join('\n')}

Reply with JSON only, one entry per check id:
{"<id>": {"pass": true or false, "why": "<at most 10 words>"}}`,
    })
    const json = parseJson(text)
    const verdicts = {}
    for (const k of checks) {
      const v = json[k.id]
      verdicts[k.id] = typeof v?.pass === 'boolean' ? { pass: v.pass, why: String(v.why ?? '') } : { pass: false, why: 'no answer from the judge' }
    }
    return verdicts
  }

  // Write a case's checks from what it asked, what was said after it in the session, and the notes. Returns the whole new list.
  async function askForChecks(c, unread, notes) {
    const last = latest(c)
    const said = c.steering.map((s) => {
      const head = `${s.id}${unread.includes(s) ? ' (new)' : ''}: ${s.text}`
      const turn = s.turn !== last.id ? c.turns.find((t) => t.id === s.turn) : null
      return turn ? `${head}\nTHE REPLY IT GOT:\n<<<\n${clip(turn.answer, 1500)}\n>>>` : head
    })
    const first = c.turns.length > 1 ? `THE FIRST ANSWER:\n<<<\n${clip(c.turns[0].answer, 1500)}\n>>>\n\n` : ''
    const text = await llm({
      ...as('grader'),
      system: settings.prompts.checks || CHECK_SYSTEM,
      prompt: `${skillLine()}

REQUEST: ${c.ask}

${first}THE LATEST ANSWER IN THE SESSION:
<<<
${clip(last.answer, 3000)}
>>>

THE LATEST ANSWER, MEASURED BY CODE:
${facts(last.answer)}

WHAT THE PERSON SAID AFTER IT IN THE SESSION, IN ORDER:
${said.join('\n\n') || '(nothing)'}

THEIR NOTES ON THE CASE${notes !== c.notesRead ? ' (changed since the checks were last written)' : ''}:
${notes.trim() || '(none)'}

CHECKS IT HAS NOW:
${c.checks?.map((k) => `${k.id}: ${k.question}`).join('\n') || '(none yet)'}`,
    })
    const json = parseJson(text)
    const checks = (Array.isArray(json.checks) ? json.checks : [])
      .map((x) => ({ id: typeof x?.id === 'string' ? x.id : null, question: String(x?.question ?? (typeof x === 'string' ? x : '')).trim() }))
      .filter((x) => x.question)
      .slice(0, 8)
    const ids = (x) => (Array.isArray(x) ? x.map(String) : [])
    return { checks, comments: ids(json.comments), unrelated: ids(json.unrelated) }
  }

  // A new version, written from what the current one fails, and from the checks it has not been tried on yet.
  async function propose(cur, onText) {
    const failing = []
    const passing = []
    const untried = []
    for (const c of gradable()) {
      const r = runOf(cur, c)
      const vs = verdictsOf(r)
      if (!covered(cur, c)) {
        untried.push(...c.checks.map((k) => `- [${c.ask}] ${k.question}`))
        continue
      }
      for (const k of c.checks) if (vs[k.id].pass) passing.push(`- [${c.ask}] ${k.question}`)
      const failed = c.checks.filter((k) => !vs[k.id].pass)
      if (!failed.length) continue
      failing.push(`REQUEST: ${c.ask}
FIRST TRY WITH THE CURRENT INSTRUCTIONS:
<<<
${clip(r.output, 1500)}
>>>
CHECKS IT FAILED:
${failed.map((k) => `- ${k.question} (${vs[k.id].why})`).join('\n')}
WHAT THE PERSON SAID ABOUT THIS CASE:
${[...c.steering.map((s) => `- ${s.text}`), ...(c.notes.trim() ? [`- notes: ${c.notes.trim()}`] : [])].join('\n') || '(nothing: its checks came from the request)'}`)
    }
    const rejected = state.versions.filter((v) => v.status === 'lost' && v.parent === cur.id && v.teacher === roleKey('teacher'))
    const text = await llm({
      ...as('teacher'),
      system: settings.prompts.teacher || REWRITE_SYSTEM,
      onText,
      prompt: `${skillLine()}

CURRENT INSTRUCTIONS:
<<<
${cur.text}
>>>

REQUESTS WHERE THE FIRST TRY FAILS A CHECK:

${failing.slice(0, 8).join('\n\n') || '(none seen yet)'}

CHECKS THE FIRST TRY ALREADY PASSES (keep them passing):
${passing.join('\n') || '(none)'}

CHECKS NOT TRIED WITH THE CURRENT INSTRUCTIONS YET (aim to pass them too):
${untried.join('\n') || '(none)'}

REWRITES ALREADY TRIED THAT DID NOT SCORE HIGHER (try something different):
${rejected.map((v) => `- ${v.note}`).join('\n') || '(none)'}`,
    })
    const body = text.match(/<skill>([\s\S]*?)<\/skill>/)?.[1]?.trim()
    if (!body) throw new Error('the rewrite came back without a <skill> block')
    const name = text.match(/<(?:name|note)>([\s\S]*?)<\/(?:name|note)>/)?.[1]?.trim().replace(/^["']|["'.]$/g, '')
    return { body, note: clip(name || 'a rewrite', 80) }
  }

  // The teacher's first version, from the cases alone: what was asked, the checks, and what the person said.
  async function fromCases(onText) {
    const cases = gradable().map((c) => `REQUEST: ${c.ask}
CHECKS:
${c.checks.map((k) => `- ${k.question}`).join('\n')}${c.notes.trim() || c.steering.length ? `\nWHAT THE PERSON SAID:\n${[...c.steering.map((x) => `- ${x.text}`), ...(c.notes.trim() ? [`- ${c.notes.trim()}`] : [])].join('\n')}` : ''}`)
    const text = await llm({
      ...as('teacher'),
      system: GENERATE_SYSTEM,
      onText,
      prompt: `${skillLine()}

CASES:

${cases.join('\n\n')}`,
    })
    const body = text.match(/<skill>([\s\S]*?)<\/skill>/)?.[1]?.trim()
    if (!body) throw new Error('the new version came back without a <skill> block')
    const named = text.match(/<(?:name|note)>([\s\S]*?)<\/(?:name|note)>/)?.[1]?.trim().replace(/^["']|["'.]$/g, '')
    return { body, note: clip(named || 'written from the cases', 80) }
  }

  // ---------- the lab: testing versions on the dataset ----------

  // A version's first try at a case, by the student on show, and the grader on show's answers to its checks.
  const runOf = (v, c) => state.runs[roleKey('student')]?.[v.id]?.[c.id]
  const verdictsOf = (r) => r?.verdicts[roleKey('grader')]
  // A version has been run on a case once it has a first try and an answer for each of the case's checks.
  const covered = (v, c) => {
    const r = runOf(v, c)
    const vs = verdictsOf(r)
    return r?.output != null && Boolean(vs) && c.checks.every((k) => vs[k.id])
  }
  const missing = (v) => gradable().filter((c) => !covered(v, c))

  // A version's score on some cases: of their checks, how many its first tries pass.
  function scoreOn(v, cases) {
    const s = { pass: 0, total: 0, cases: cases.length }
    for (const c of cases)
      for (const k of c.checks) {
        s.total++
        if (verdictsOf(runOf(v, c))[k.id].pass) s.pass++
      }
    return s
  }
  const score = (v) => ({ ...scoreOn(v, gradable().filter((c) => covered(v, c))), of: gradable().length })

  // Answer every check of a case that the grader on show has not answered yet for one first try.
  async function grade(c, r) {
    const g = roleKey('grader')
    const vs = (r.verdicts[g] ??= {})
    const todo = c.checks.filter((k) => !vs[k.id])
    if (!todo.length) return
    const got = await judge(c.ask, r.output, todo)
    for (const k of todo) if (got[k.id] && c.checks.includes(k)) vs[k.id] = got[k.id]
    touch()
  }

  // Run versions on every case in the dataset they have not been run on, until none is missing: a case can be
  // accepted while they run. A first try kept for this student is only graded again. A case that fails is left for
  // the next test, once the others are done.
  async function settle(versions, stale) {
    const student = roleKey('student')
    const failed = new Set() // 'version:case' that failed this time: tried again on the next test, not now
    const todo = (v) => missing(v).filter((c) => !failed.has(`${v.id}:${c.id}`))
    do {
      await Promise.all(
        versions.flatMap((v) =>
          todo(v).map(async (c) => {
            const r = (((state.runs[student] ??= {})[v.id] ??= {})[c.id] ??= { output: null, verdicts: {} })
            try {
              delete r.error
              if (r.output === null) {
                touch() // the case shows as being run straight away, and its first try streams in as it is written
                const k = `r:${v.id}:${c.id}`
                stream(k, '') // started: nothing written yet, while the model thinks
                try {
                  r.output = await runSkill(v.text, c.prompt, (t) => stream(k, t))
                } finally {
                  unstream(k)
                }
                touch()
              }
              if (!stale()) await grade(c, r)
            } catch (e) {
              // The error stays with the case, where it shows; the rest of the run carries on without it.
              failed.add(`${v.id}:${c.id}`)
              if (!stale()) {
                r.error = clip(e.message, 300)
                log(`${name(v)} could not be run on "${clip(c.ask, 40)}": ${e.message}`, 'error')
              }
            }
          }),
        ),
      )
    } while (!stale() && versions.some((v) => todo(v).length))
  }

  // Grade, with the grader on show, every first try already kept for the student on show that it has not graded:
  // after the grader changes, the whole history comes back with no new runs.
  async function regradeAll(stale) {
    const todo = [...state.versions, state.baseline].flatMap((v) => gradable().filter((c) => runOf(v, c)?.output != null && !covered(v, c)).map((c) => [v, c]))
    if (!todo.length) return
    setStatus(`grading ${todo.length} first ${todo.length === 1 ? 'try' : 'tries'} kept from before, with ${roleKey('grader')}`)
    await Promise.all(todo.map(([v, c]) => (stale() ? null : grade(c, runOf(v, c)).catch(() => {}))))
  }

  // A version that never got written.
  function drop(v) {
    state.versions = state.versions.filter((x) => x !== v)
    for (const byVersion of Object.values(state.runs)) delete byVersion[v.id]
    touch()
  }

  // Make a version the skill: it is written to SKILL.md, so the next use in Claude Code follows it.
  function promote(v) {
    v.status = 'won' // before the file changes, so the watcher sees no hand edit
    state.current = v.id
    writeSkill(v.text)
    touch()
  }

  const name = (v) => (v.id === 0 ? 'the baseline' : `v${v.id}`)
  const versionById = (id) => (id === 0 ? state.baseline : state.versions.find((v) => v.id === id))

  // A new version is judged against the one it was made from, on the cases both have been run on. If it wins, and
  // it also beats the skill in SKILL.md (the best so far), it takes its place there.
  function decide(v, from) {
    const both = gradable().filter((c) => covered(v, c) && covered(from, c))
    if (!both.length) {
      v.status = 'new'
      return log(`v${v.id} cannot be judged: ${name(from)} has not been run on any of the same cases. Test ${name(from)} first`, 'error')
    }
    const a = scoreOn(v, both)
    const b = scoreOn(from, both)
    v.trial = { against: from.id, before: b, after: a, cases: both.length, student: roleKey('student'), grader: roleKey('grader') }
    if (a.pass <= b.pass) {
      v.status = 'lost'
      log(`v${v.id} lost to ${name(from)}: ${a.pass} of ${a.total} checks against ${b.pass}`)
      touch()
      return false
    }
    v.status = 'won'
    const cur = current()
    const common = cur && cur.id !== from.id ? gradable().filter((c) => covered(v, c) && covered(cur, c)) : both
    const best = !cur || cur.id === from.id || (common.length && scoreOn(v, common).pass > scoreOn(cur, common).pass)
    if (best) promote(v)
    log(`v${v.id} beats ${name(from)}: ${a.pass} of ${a.total} checks against ${b.pass}${best ? '. SKILL.md updated' : ''}`)
    touch()
    return true
  }

  // Test: run a version (and the baseline) on the cases it has not been run on. A new version is then judged
  // against the one it was made from.
  async function test(v, stale) {
    const isNew = v.status === 'new'
    if (isNew) v.status = 'running'
    setStatus(`testing ${name(v)} on ${plural(missing(v).length, 'case')}`, v.id)
    const from = isNew ? (versionById(v.parent) ?? current()) : null
    await settle([v, state.baseline, ...(from && !gradable().some((c) => covered(from, c)) ? [from] : [])], stale)
    if (!stale() && from && from.id !== v.id) decide(v, from)
    // The older versions' first tries, graded by this grader too, so the chart shows the whole history.
    if (!stale()) await regradeAll(stale)
  }

  // A version the teacher writes: in the library the moment it is begun, its name and instructions streaming in.
  async function write(v, stale, ask) {
    let wrote
    try {
      wrote = await ask((t) => {
        const named = t.match(/<(?:name|note)>([\s\S]*?)<\/(?:name|note)>/)?.[1]?.trim()
        if (named && v.note === 'writing') {
          v.note = clip(named.replace(/^["']|["'.]$/g, ''), 80)
          touch()
        }
        const body = t.match(/<skill>\s*([\s\S]*?)(?:<\/skill>|$)/)?.[1]
        if (body != null) stream(`v:${v.id}`, body)
      })
    } finally {
      unstream(`v:${v.id}`)
      if (!wrote || stale()) drop(v)
    }
    if (stale()) return false
    Object.assign(v, { text: wrote.body, note: wrote.note, status: 'running' })
    return true
  }

  // Optimize: straight to a new version, written by the teacher from what the selected one fails, then tested on
  // every case. Each one that wins becomes the one the next is written from, until 3 in a row lose.
  async function optimize(stale, from) {
    let cur = from
    const { min, max, patience } = settings.optimize
    // With nothing to go on, the one to improve is tried first.
    if (!gradable().some((c) => covered(cur, c))) {
      setStatus(`testing ${name(cur)} first, so there is something to beat`, cur.id)
      await settle([cur, state.baseline], stale)
    }
    let misses = 0
    let rounds = 0
    // At least min rounds, at most max, and no more once patience of them in a row have lost.
    while (!stale() && rounds < max && (rounds < min || misses < patience)) {
      const s = score(cur)
      if (s.cases === s.of && s.pass === s.total) {
        log(`${name(cur)} passes every check: nothing left to fix`)
        break
      }
      rounds++
      const v = addVersion('', 'writing', 'writing', cur.id, 'optimizer', roleKey('teacher'))
      setStatus(`round ${rounds} of up to ${max}: writing v${v.id} from what ${name(cur)} fails`, v.id)
      if (!(await write(v, stale, (onText) => propose(cur, onText)))) return
      setStatus(`round ${rounds} of up to ${max}: testing v${v.id} on ${plural(gradable().length, 'case')}`, v.id)
      await settle([v, state.baseline], stale)
      if (stale()) return
      if (decide(v, cur)) {
        cur = v
        misses = 0
      } else misses++
    }
    if (!stale() && misses >= patience && rounds >= min) log(`${patience} versions in a row lost to ${name(cur)}: stopped after ${plural(rounds, 'round')}`)
    else if (!stale() && rounds >= max) log(`stopped after ${plural(rounds, 'round')}, the most there can be`)
  }

  // Generate: the teacher's first version, written from the cases alone, then tested and judged against the baseline.
  async function generate(stale) {
    const v = addVersion('', 'writing', 'writing', 0, 'generate', roleKey('teacher'))
    setStatus(`writing v${v.id} from the cases`, v.id)
    if (!(await write(v, stale, (onText) => fromCases(onText)))) return
    setStatus(`testing v${v.id} on ${plural(gradable().length, 'case')}`, v.id)
    await settle([v, state.baseline], stale)
    if (!stale()) decide(v, state.baseline)
  }

  // One job at a time: a test, optimizing or generating. Its status shows on the board while it works, and Stop ends it.
  function start(kind, job, status) {
    if (state.loop.running || !current()) return false
    const mine = epoch
    const stale = () => mine !== epoch
    state.loop = { running: true, kind, status }
    state.stopped = null
    touch()
    job(stale)
      .catch((e) => {
        if (stale()) return
        state.stopped = e.message // shown on the board until the next job
        log(e.message, 'error')
      })
      .finally(() => {
        if (mine !== epoch && state.loop.running === false) return // a reset
        for (const v of state.versions) if (v.status === 'running') v.status = 'new' // it can be tested again
        state.versions = state.versions.filter((v) => v.status !== 'writing')
        state.loop = freshBoard().loop
        touch()
      })
    return true
  }

  function stop() {
    if (!state.loop.running) return
    epoch++ // the job's model calls finish, and what they return is kept, but nothing else follows from them
    log('stopped', 'outer')
    for (const v of state.versions) if (v.status === 'running') v.status = 'new'
    state.versions = state.versions.filter((v) => v.status !== 'writing')
    state.loop = freshBoard().loop
    touch()
  }

  // Add a version: from an agent. It is yours, not a teacher's, and only tested when asked.
  function newVersion(text, by, parent = current()) {
    const v = addVersion(clip(String(text), 20_000), by === 'agent' ? 'added by an agent' : 'added on the board', 'new', parent?.id ?? null, by)
    log(`v${v.id} added${by === 'agent' ? ' by an agent' : ''}: test it to judge it`, 'outer')
    return v
  }

  // Use a version: make it the skill, whatever its score.
  function useVersion(v) {
    if (v.id === state.current || v.id === 0) return
    promote(v)
    log(`v${v.id} is the skill now. SKILL.md updated`, 'outer')
  }

  // ---------- the desk ----------

  // Turn what a case asked, what was said after it in the session, and the notes into its checks: straight away for a
  // new case, and again whenever any of that changes. Nothing waits for this.
  async function refreshChecks(c) {
    if (c.writing) return (c.again = true)
    const mine = epoch
    const stale = () => mine !== epoch || !state.cases.includes(c)
    c.writing = true
    touch()
    do {
      c.again = false
      const unread = c.steering.filter((s) => !s.read)
      const notes = c.notes
      if (c.checks && !unread.length && notes === c.notesRead) break
      let got = null
      // A failed model call should not leave the case without its checks: go again, a couple of times at most.
      for (let tries = 0; !got && tries < 3; tries++) {
        try {
          got = await askForChecks(c, unread, notes)
        } catch (e) {
          if (stale()) return
          log(e.message, 'error')
        }
      }
      if (stale()) return
      if (!got) break
      for (const s of unread) s.read = true
      c.notesRead = notes
      leaveOut(c, got.unrelated)
      for (const s of unread) {
        const t = got.comments.includes(s.id) && c.turns.find((x) => x.id === s.turn)
        if (t && !t.comment) {
          t.comment = true
          c.verdicts = {} // the answer to grade is an earlier one again
        }
      }
      setChecks(c, got.checks)
    } while (c.again && !stale())
    c.writing = false
    touch()
    if (c.status === 'queue') gradeCase(c)
  }

  // The session moved on to something else: that turn and the ones after it are not about this answer.
  function leaveOut(c, ids) {
    const first = c.steering.find((s) => ids.includes(s.id))
    if (!first) return
    const cut = c.turns.findIndex((t) => t.id === first.turn)
    if (cut < 1) return
    const gone = c.turns.slice(cut).map((t) => t.id)
    c.turns = c.turns.slice(0, cut)
    c.dropped.push(...gone)
    c.steering = c.steering.filter((s) => !gone.includes(s.turn))
    c.following = false
    c.verdicts = {}
    log(`the session moved on from "${clip(c.ask, 40)}": left out "${clip(first.text, 60)}"`, 'usage')
  }

  // A check that keeps its wording keeps its id, and with it the verdicts it already has.
  function setChecks(c, list) {
    const before = c.checks ?? []
    const next = list.map((x) => before.find((k) => k.id === x.id && k.question === x.question) ?? { id: `k${++state.seq.k}`, question: x.question })
    for (const k of before) if (!next.includes(k)) log(`check dropped from "${clip(c.ask, 40)}": ${k.question}`, 'outer')
    for (const k of next) if (!before.includes(k)) log(`new check for "${clip(c.ask, 40)}": ${k.question}`, 'outer')
    c.checks = next
    touch()
  }

  // A case on the desk is graded on the answer the session got to, so its marks say whether that answer is what the checks want.
  async function gradeCase(c) {
    const answer = latest(c).answer
    const g = roleKey('grader')
    const vs = (c.verdicts[g] ??= {})
    const todo = (c.checks ?? []).filter((k) => !vs[k.id])
    if (!todo.length) return
    const asked = todo.map((k) => [k, k.question])
    let got
    try {
      got = await judge(c.ask, answer, todo)
    } catch (e) {
      if (state.cases.includes(c)) log(e.message, 'error')
      return
    }
    if (latest(c)?.answer !== answer || c.verdicts[g] !== vs) return // a newer answer came in meanwhile, and is being graded instead
    for (const [k, question] of asked) if (got[k.id] && k.question === question && c.checks.includes(k)) vs[k.id] = got[k.id]
    touch()
  }

  // Accept: the case joins the dataset as it is now. Later turns in its session no longer change it.
  // No version has been run on it yet: that waits for a test, or for Optimize.
  function accept(c) {
    if (c.status !== 'queue') return
    c.status = 'accepted'
    c.following = false
    log(`accepted "${clip(c.ask, 40)}" into the dataset`, 'outer')
  }

  // Dismiss: the case is gone, and stays gone however long its session goes on.
  function dismiss(c) {
    const was = c.status !== 'queue'
    state.cases = state.cases.filter((x) => x !== c)
    state.dismissed.push(c.key)
    for (const byVersion of Object.values(state.runs)) for (const byCase of Object.values(byVersion)) delete byCase[c.id]
    log(`dismissed "${clip(c.ask, 40)}"${was ? ': out of the dataset' : ''}`, 'outer')
  }

  // Notes: what the person thinks of the case, the whole of it. The checks are rewritten from them; the answer stays as it is.
  function setNotes(c, text) {
    c.notes = clip(text, 4000)
    log(`notes on "${clip(c.ask, 40)}": ${clip(c.notes, 120)}`, 'outer')
    refreshChecks(c)
  }

  // A check on the desk, reworded by hand: it is graded again on the session's answer.
  function editCheck(c, k, question) {
    k.question = clip(question, 300)
    for (const vs of Object.values(c.verdicts)) delete vs[k.id]
    log(`check reworded on "${clip(c.ask, 40)}": ${k.question}`, 'outer')
    gradeCase(c)
  }

  function deleteCheck(c, k) {
    c.checks = c.checks.filter((x) => x !== k)
    log(`check removed from "${clip(c.ask, 40)}": ${k.question}`, 'outer')
  }

  // A new case from a session, or more of one still on the desk. An accepted case is left as it was accepted.
  function upsert(sid, t, use, after) {
    const caseKey = `${sid}:${t.id}`
    if (state.dismissed.includes(caseKey) || !t.answer) return
    let c = state.cases.find((x) => x.key === caseKey)
    let changed = false
    if (!c) {
      c = { id: `c${++state.seq.c}`, key: caseKey, session: sid, ask: clip(t.ask, 500), prompt: use.args || clip(t.ask, 500), status: 'queue', at: Date.now(), model: t.model ?? null }
      Object.assign(c, { turns: [{ id: t.id, ask: c.ask, answer: t.answer }], following: true, dropped: [], steering: [], notes: '', notesRead: '', checks: null, writing: false, verdicts: {} })
      state.cases.push(c)
      log(`/${state.skill.name} used in a session: ${clip(c.ask, 80)}`, 'usage')
      changed = true
    } else if (c.status !== 'queue') return
    for (const x of [t, ...after]) {
      const mine = c.turns.find((y) => y.id === x.id)
      if (mine) {
        if (x.answer && mine.answer !== x.answer) {
          mine.answer = x.answer
          changed = true
        }
        continue
      }
      if (!c.following || c.dropped.includes(x.id) || !x.answer) continue
      c.turns.push({ id: x.id, ask: clip(x.ask, 1000), answer: x.answer })
      c.steering.push({ id: `s${++state.seq.s}`, text: clip(x.ask, 1000), turn: x.id, read: false })
      log(`steering "${clip(c.ask, 40)}" in the session: ${clip(x.ask, 100)}`, 'outer')
      changed = true
    }
    if (!changed) return
    c.verdicts = {}
    touch()
    if (!c.checks || c.steering.some((s) => !s.read)) refreshChecks(c)
    else gradeCase(c)
  }

  // Wipe this board. The skill file is left as it is, and becomes the new starting point.
  function reset() {
    epoch++
    Object.assign(state, freshBoard(state.skill.name, key))
    watch()
    log('reset: cases and versions cleared. SKILL.md is left as it is', 'outer')
  }

  // Pick up where the server left off: checks that were being written, and desk cases not graded yet.
  function wake() {
    watch()
    for (const c of state.cases) {
      if (!c.checks || c.steering.some((s) => !s.read) || c.notes !== c.notesRead) refreshChecks(c)
      else if (c.status === 'queue') gradeCase(c)
    }
  }

  // ---------- for the tools ----------

  const caseOut = (c, v = current()) => {
    const desk = c.status === 'queue'
    const verdicts = (desk ? c.verdicts[roleKey('grader')] : v && verdictsOf(runOf(v, c))) ?? {}
    return {
      id: c.id,
      request: c.ask,
      said_in_session: c.steering.map((s) => s.text),
      notes: c.notes,
      checks: (c.checks ?? []).map((k) => ({ id: k.id, question: k.question, pass: verdicts[k.id]?.pass ?? null, why: verdicts[k.id]?.why ?? null })),
      ...(desk
        ? { answer: latest(c).answer, writing_checks: c.writing }
        : { version: v?.id ?? null, run: v ? covered(v, c) : false, first_try: (v && runOf(v, c)?.output) ?? null }),
    }
  }
  const versionOut = (v) => ({ id: v.id, status: v.id === state.current ? 'current' : v.status, by: v.by, teacher: v.teacher, made_from: v.parent, note: v.note, score: score(v), trial: v.trial })

  return {
    key,
    state,
    streams,
    log,
    current,
    dataset,
    gradable,
    covered,
    missing,
    score,
    caseOut,
    versionOut,
    accept,
    dismiss,
    setNotes,
    editCheck,
    deleteCheck,
    newVersion,
    useVersion,
    upsert,
    reset,
    wake,
    stop,
    versionById,
    regradeDesk: () => state.cases.filter((c) => c.status === 'queue').forEach(gradeCase),
    test: (v) => start('test', (stale) => test(v, stale), `testing ${name(v)}`),
    optimize: (from) => start('optimize', (stale) => optimize(stale, from), 'optimizing'),
    generate: () => start('generate', generate, 'generating'),
  }
}

// A board for a skill, made the first time the skill is found with the line in it.
function boardFor(file, name) {
  if (boards.has(file)) return boards.get(file)
  const b = Board(freshBoard(name, file))
  boards.set(file, b)
  activeKey ??= file
  b.wake()
  b.log(`following /${name}: the line is in ${tilde(file)}`, 'outer')
  return b
}

function load() {
  let s
  try {
    s = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    // Nothing saved yet: a host starts from the seed board.
    try {
      if (HOSTED) s = JSON.parse(readFileSync(SEED_FILE, 'utf8'))
    } catch {}
    if (!s) return
  }
  // Before there were boards, the file held the one skill's board.
  if (s.schema === 1 && s.skill?.file) s = { schema: SCHEMA, active: s.skill.file, boards: [s] }
  if (s.schema !== SCHEMA) {
    const aside = STATE_FILE.replace(/\.json$/, `.schema-${s.schema ?? 0}.json`)
    renameSync(STATE_FILE, aside)
    console.log(`${STATE_FILE} is from an older version of this toy: moved to ${aside}, starting fresh`)
    return
  }
  settings = { ...structuredClone(DEFAULTS), ...(s.settings ?? {}) }
  settings.prompts = { ...DEFAULTS.prompts, ...(s.settings?.prompts ?? {}) }
  settings.optimize = { ...DEFAULTS.optimize, ...(s.settings?.optimize ?? {}) }
  for (const saved of s.boards) {
    if (!saved.skill?.file) continue
    // A board saved on another machine: its skill is the one of that name in this project, if there is one.
    const was = saved.skill.file
    const here = join(ROOT, '.claude/skills', saved.skill.name, 'SKILL.md')
    if (!existsSync(was) && existsSync(here)) saved.skill.file = realpathSync(here)
    if (s.active === was) s.active = saved.skill.file
    boards.set(saved.skill.file, Board(revive({ ...freshBoard(saved.skill.name, saved.skill.file), ...saved })))
  }
  activeKey = boards.has(s.active) ? s.active : (boards.keys().next().value ?? null)
}

// Look for skills that already have the line: this project's, and your own.
function scan() {
  for (const dir of SKILL_DIRS) {
    let names = []
    try {
      names = readdirSync(dir).sort()
    } catch {
      continue
    }
    for (const d of names) {
      const file = join(dir, d, 'SKILL.md')
      if (!connectedFile(file)) continue
      const real = realpathSync(file)
      if (!boards.has(real)) boardFor(real, frontField(readSkill(real).front, 'name') || d)
    }
  }
}

// ---------- catching the skill in a session ----------

// A session's turns, read from its transcript: what the person said, which skills Claude used, and the answer it ended on.
function readTurns(path) {
  const turns = []
  let turn = null
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      continue
    }
    if (m.isSidechain || (m.type !== 'user' && m.type !== 'assistant')) continue
    const content = m.message?.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n\n')
      .trim()
    if (m.type === 'assistant') {
      if (!turn) continue
      for (const b of blocks)
        if (b.type === 'tool_use' && b.name === 'Skill' && b.input?.skill)
          turn.uses.push({ skill: String(b.input.skill), args: String(b.input.args ?? '').trim(), typed: false, dir: null })
      // Claude Code writes one line per block of a message: the answer is the text of the turn's last message.
      if (text) {
        turn.answer = turn.msg === m.message.id ? `${turn.answer}\n\n${text}` : text
        turn.msg = m.message.id
      }
      turn.model ??= m.message?.model ?? null
      continue
    }
    // Claude Code tells the model where a skill it just loaded lives.
    if (m.isMeta) {
      const dir = text.match(/^Base directory for this skill: (.+)$/m)?.[1]?.trim()
      const use = turn?.uses.findLast((u) => !u.dir)
      if (dir && use) use.dir = dir
      continue
    }
    if (!text || blocks.some((b) => b.type === 'tool_result')) continue
    const command = text.match(/<command-name>\/?([^<]+)<\/command-name>/)?.[1]?.trim()
    if (!command && (text.startsWith('<') || text.startsWith('[Request interrupted'))) continue
    turn = { id: m.uuid, ask: text, answer: '', msg: null, uses: [], command }
    if (command) {
      const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? ''
      turn.ask = `/${command}${args ? ` ${args}` : ''}`
      turn.uses.push({ skill: command, args, typed: true, dir: null })
    }
    turns.push(turn)
  }
  // A typed command is a skill only when Claude Code loaded one for it. The others (/model, /clear) are not turns at all.
  for (const t of turns) t.uses = t.uses.filter((u) => !u.typed || u.dir)
  return turns.filter((t) => !t.command || t.uses.length)
}

// Which SKILL.md a use loaded: the folder Claude Code named, or else the skill of that name nearest the session.
function skillFileOf(use, cwd) {
  const found = []
  if (use.dir) found.push(join(use.dir, 'SKILL.md'))
  if (isAbsolute(cwd)) for (let d = cwd; d !== dirname(d); d = dirname(d)) found.push(join(d, '.claude/skills', use.skill, 'SKILL.md'))
  found.push(join(homedir(), '.claude/skills', use.skill, 'SKILL.md'))
  const file = found.find((f) => existsSync(f))
  return file ? realpathSync(file) : null
}

// The hook posts here at the end of every turn of a session that has used a connected skill. Read the whole session
// each time: every use of a connected skill is a case on that skill's board, and the turns after it, until another
// skill is used, steer it.
function onCatch(h) {
  const sid = String(h.session_id ?? '')
  const path = resolve(String(h.transcript_path ?? ''))
  const cwd = String(h.cwd ?? '')
  if (!sid || !path.startsWith(TRANSCRIPTS + sep) || !path.endsWith('.jsonl')) return
  let turns
  try {
    turns = readTurns(path)
  } catch {
    return
  }
  // The hook carries the turn's final answer exactly as Claude ended on it.
  const reply = String(h.last_assistant_message ?? '').trim()
  if (reply && turns.length) turns.at(-1).answer = reply

  turns.forEach((t, i) => {
    for (const use of t.uses) {
      const file = skillFileOf(use, cwd)
      if (!file || !connectedFile(file)) continue
      const rest = turns.slice(i + 1)
      const end = rest.findIndex((x) => x.uses.length)
      boardFor(file, use.skill).upsert(sid, t, use, end < 0 ? rest : rest.slice(0, end))
    }
  })
}

// ---------- tools: everything the board does, for an agent too ----------

const need = (x, what) => {
  if (!x) throw new Error(`no such ${what}`)
  return x
}
const B = () => need(active(), 'skill: none is connected yet')
const deskCase = (id) => {
  const c = need(B().state.cases.find((x) => x.id === id), 'case')
  if (c.status !== 'queue') throw new Error(`${id} is in the dataset, and cases there are not edited`)
  return c
}
const deskCheck = (id) => {
  const c = need(B().state.cases.find((x) => x.checks?.some((k) => k.id === id)), 'check')
  return [deskCase(c.id), c.checks.find((k) => k.id === id)]
}
const versionOf = (id) => need(B().versionById(Number(id)), 'version') // 0 is the baseline
const text = (s) => {
  const t = String(s ?? '').trim()
  if (!t) throw new Error('text is empty')
  return t
}
const busy = () => {
  if (B().state.loop.running) throw new Error('busy: stop the job that is running, or wait for it')
}
const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })

// Settings: a role's model and effort, and the two prompts that can be edited.
function setSettings(given) {
  for (const role of ['teacher', 'student', 'grader']) {
    const g = given?.[role]
    if (!g) continue
    if (g.model !== undefined && !String(g.model).trim()) throw new Error(`${role}: model is empty`)
    if (g.effort !== undefined && !EFFORTS.includes(g.effort)) throw new Error(`${role}: effort is one of ${EFFORTS.filter(Boolean).join(', ')}, or empty`)
    settings[role] = { model: String(g.model ?? settings[role].model).trim(), effort: g.effort ?? settings[role].effort }
  }
  for (const k of ['teacher', 'checks']) if (typeof given?.prompts?.[k] === 'string') settings.prompts[k] = given.prompts[k].trim()
  if (given?.optimize) {
    const o = { ...settings.optimize }
    for (const k of ['min', 'max', 'patience']) {
      if (given.optimize[k] === undefined) continue
      const n = Number(given.optimize[k])
      if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error(`optimize.${k} is a whole number from 1 to 50`)
      o[k] = n
    }
    if (o.min > o.max) throw new Error('optimize.min is more than optimize.max')
    settings.optimize = o
  }
  // A grader new to the desk grades its cases straight away.
  for (const b of boards.values()) b.regradeDesk()
  return settings
}

const TOOLS = [
  {
    name: 'get_settings',
    read: true,
    description: "Who does what: the teacher (writes versions of the skill), the student (does the skill's task on each case) and the grader (writes and answers the checks), each a model and an effort; and the teacher's and the checks' prompts, if edited (empty means built in).",
    run: () => settings,
  },
  {
    name: 'set_settings',
    description: "Change the teacher, student or grader (a model such as opus, sonnet or haiku, and an effort: low, medium, high, xhigh, max, or empty for the model's own), the teacher's or the checks' prompt (empty puts the built-in one back), or how long optimize goes on: { min, max, patience } rounds. First tries are kept for each student and verdicts for each grader, so after a change test_version fills in what is missing.",
    input: {
      teacher: { type: 'object', description: '{ model, effort } (optional)' },
      student: { type: 'object', description: '{ model, effort } (optional)' },
      grader: { type: 'object', description: '{ model, effort } (optional)' },
      prompts: { type: 'object', description: '{ teacher, checks } (optional)' },
      optimize: { type: 'object', description: '{ min, max, patience }: rounds of optimize, at least min, at most max, stopping after patience losses in a row (optional)' },
    },
    run: (given) => setSettings(given),
  },
  {
    name: 'list_skills',
    read: true,
    description: 'The skills connected to the board, and which one the other tools work on.',
    run: () => skills().map((s) => ({ ...s, on_show: s.key === activeKey })),
  },
  {
    name: 'switch_skill',
    description: 'Make the other tools work on another connected skill (it is also the one the board shows).',
    input: { skill: str('the skill, by name or by key from list_skills') },
    run: ({ skill }) => {
      const b = need([...boards.values()].find((x) => x.key === skill || x.state.skill.name === String(skill).replace(/^\//, '')), 'skill')
      activeKey = b.key
      return { ok: true, skill: b.state.skill.name }
    },
  },
  {
    name: 'list_desk',
    read: true,
    description: 'The desk: new uses of the skill, caught from Claude Code sessions, newest first, each with its suggested checks marked for the answer the session ended on.',
    run: () => (active()?.state.cases ?? []).filter((c) => c.status === 'queue').reverse().map((c) => B().caseOut(c)),
  },
  {
    name: 'review_case',
    description: 'Decide a case on the desk. accept puts it in the dataset (no version is run on it until a test or Optimize); dismiss removes it for good.',
    input: { case_id: str('a case on the desk'), decision: { type: 'string', enum: ['accept', 'dismiss'] } },
    run: ({ case_id, decision }) => {
      const c = deskCase(case_id)
      if (decision === 'accept') B().accept(c)
      else if (decision === 'dismiss') B().dismiss(c)
      else throw new Error('decision is accept or dismiss')
      return { ok: true }
    },
  },
  {
    name: 'write_notes',
    description: "Write a desk case's notes: what you like and don't like about it and its checks, the whole text (it replaces the notes). Its checks are rewritten from the notes in the background; its answer stays as it is.",
    input: { case_id: str('a case on the desk'), text: str('the notes') },
    run: ({ case_id, text: t }) => (B().setNotes(deskCase(case_id), String(t ?? '')), { ok: true }),
  },
  {
    name: 'edit_check',
    description: 'Reword one check of a case on the desk. It is graded again on the answer.',
    input: { check_id: str('a check of a case on the desk'), question: str('the new yes/no question') },
    run: ({ check_id, question }) => (B().editCheck(...deskCheck(check_id), text(question)), { ok: true }),
  },
  {
    name: 'delete_check',
    description: 'Remove one check from a case on the desk.',
    input: { check_id: str('a check of a case on the desk') },
    run: ({ check_id }) => (B().deleteCheck(...deskCheck(check_id)), { ok: true }),
  },
  {
    name: 'list_cases',
    read: true,
    description: 'The dataset: accepted cases, each with its checks, its notes, and how a version did on them on its first try (the current version unless one is given). run: false means that version has not been run on the case.',
    input: { version: num('a version id (optional)') },
    run: ({ version } = {}) => {
      const v = version !== undefined ? versionOf(version) : B().current()
      return B().dataset().map((c) => B().caseOut(c, v))
    },
  },
  {
    name: 'list_versions',
    read: true,
    description: "The library: every version of the skill, newest first, then the baseline (id 0: no skill, only its description), with its status (current, won, lost, new or running), the teacher that wrote it (null for yours), its score under the student and grader on show (checks passed of checks, on how many of the dataset's cases) and what it was judged on.",
    run: () => (active() ? [...active().state.versions.slice().reverse(), active().state.baseline] : []).map((v) => B().versionOut(v)),
  },
  {
    name: 'get_version',
    read: true,
    description: 'The instructions of one version (the body of SKILL.md, without frontmatter), and of the version it was made from.',
    input: { version: num('a version id') },
    run: ({ version }) => {
      const v = versionOf(version)
      return { ...B().versionOut(v), text: v.text, made_from_text: B().state.versions.find((p) => p.id === v.parent)?.text ?? null }
    },
  },
  {
    name: 'add_version',
    description: 'Add a version of the skill: the whole body of SKILL.md, without frontmatter. It is not run until test_version.',
    input: { text: str('the instructions'), made_from: num('the version it is a change of (optional, the current one by default)') },
    run: ({ text: t, made_from }, from) => B().versionOut(B().newVersion(text(t), from, made_from ? versionOf(made_from) : B().current())),
  },
  {
    name: 'test_version',
    description: 'Run a version on every dataset case it has not been run on, and grade its first tries. A new version is then judged against the current one, on the cases both were run on, and becomes the skill (written to SKILL.md) if it passes more checks. Runs in the background: list_versions shows when it is done.',
    input: { version: num('a version id (optional, the current one by default)') },
    run: ({ version } = {}) => {
      const v = version !== undefined ? versionOf(version) : B().current()
      if (!B().missing(v).length) return { ok: true, note: `v${v.id} has been run on every case already` }
      busy()
      B().test(v)
      return { ok: true, started: `testing v${v.id} on ${plural(B().missing(v).length, 'case')}` }
    },
  },
  {
    name: 'use_version',
    description: 'Make a version the skill, whatever its score: it is written to SKILL.md.',
    input: { version: num('a version id') },
    run: ({ version }) => {
      busy()
      B().useVersion(versionOf(version))
      return { ok: true }
    },
  },
  {
    name: 'optimize',
    description: 'The teacher writes a new version from what a version fails (the current one unless one is given), and it is tested on every case; it keeps going, from each one that wins, until 3 in a row lose. Runs in the background: list_versions shows what it tried, and stop ends it.',
    input: { from: num('the version to improve (optional, the current one by default)') },
    run: ({ from } = {}) => {
      if (!B().gradable().length) throw new Error('the dataset has no cases with checks yet')
      busy()
      B().optimize(from !== undefined ? versionOf(from) : B().current())
      return { ok: true }
    },
  },
  {
    name: 'generate',
    description: "The teacher writes a first version of its own from the cases alone (the requests, their checks and what was said about them), and it is tested on every case against the baseline. Runs in the background.",
    run: () => {
      if (!B().gradable().length) throw new Error('the dataset has no cases with checks yet')
      busy()
      B().generate()
      return { ok: true }
    },
  },
  {
    name: 'stop',
    description: 'Stop the test or the optimizing that is running. What it has run so far is kept.',
    run: () => (B().stop(), { ok: true }),
  },
]

const toolList = () =>
  TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', properties: t.input ?? {}, required: Object.keys(t.input ?? {}).filter((k) => !/optional/.test(t.input[k].description ?? '')) },
    annotations: { readOnlyHint: Boolean(t.read) },
  }))

async function callTool(name, args, from) {
  const t = need(TOOLS.find((x) => x.name === name), 'tool')
  const out = await t.run(args ?? {}, from)
  touch()
  return out
}

// MCP over plain HTTP, without sessions: `claude mcp add --transport http toy-loop http://localhost:PORT/mcp`.
const MCP_INSTRUCTIONS = `This is the toy loop board for Claude Code skills (list_skills shows them; the tools work on one at a time).
The desk holds new uses of the skill, each with suggested checks: write notes on them to rewrite their checks, then accept them into the dataset or dismiss them.
The library holds versions of the skill, and the baseline (version 0: no skill). optimize has the teacher write and test new ones from a version; generate has it write a first one from the cases; or add one with add_version and test it with test_version. Settings say which models are the teacher, the student and the grader.`

async function onMcp(msg) {
  const { id, method, params } = msg ?? {}
  if (id === undefined) return null // a notification: nothing to answer
  const reply = (result) => ({ jsonrpc: '2.0', id, result })
  if (method === 'initialize')
    return reply({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'toy-loop', version: '2.1.0' }, instructions: MCP_INSTRUCTIONS })
  if (method === 'ping') return reply({})
  if (method === 'tools/list') return reply({ tools: toolList() })
  if (method === 'tools/call') {
    try {
      const out = await callTool(params?.name, params?.arguments, 'agent')
      return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] })
    } catch (e) {
      return reply({ content: [{ type: 'text', text: e.message }], isError: true })
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${method}` } }
}

// ---------- http ----------

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (d) => data.length > 5_000_000 || (data += d)) // nothing the board, the hook or an agent sends is this long
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (e) {
        reject(e)
      }
    })
  })

// This board rewrites a file that Claude Code later reads as instructions, so only the board itself, the local hook
// and a local agent may post here: localhost, no other origin, and JSON bodies only. Hosted, that means anyone
// signed in, with the same rules for origin and body.
const LOCAL = /^(localhost|127\.0\.0\.1)(:\d+)?$/
function allowed(req) {
  if (!HOSTED && !LOCAL.test(req.headers.host ?? '')) return false
  if (req.method === 'GET') return true
  if (req.headers.origin && req.headers.origin.replace(/^https?:\/\//, '') !== req.headers.host) return false
  return (req.headers['content-type'] ?? '').includes('application/json')
}

// ---------- login (hosted only) ----------

// The cookie is a keyed hash of the password: it holds across restarts, and stops working when the password changes.
const ticket = (password) => createHmac('sha256', String(password)).update('toy-loop').digest()
const TICKET = ticket(PASSWORD)
const signedIn = (req) => {
  const given = /(?:^|;\s*)toy_loop=([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1]
  return Boolean(given) && timingSafeEqual(Buffer.from(given, 'hex'), TICKET)
}

// Wrong passwords are counted, for each caller and overall, so the password cannot be guessed at speed.
let wrong = [] // { who, at }, the last minute's worth
function tooMany(who) {
  wrong = wrong.filter((w) => w.at > Date.now() - 60_000)
  return wrong.length >= 60 || wrong.filter((w) => w.who === who).length >= 8
}

function login(req, res, password) {
  const who = req.headers['x-forwarded-for']?.split(',')[0].trim() ?? req.socket.remoteAddress
  if (tooMany(who)) return 429
  if (!timingSafeEqual(ticket(password), TICKET)) {
    wrong.push({ who, at: Date.now() })
    return 401
  }
  const secure = LOCAL.test(req.headers.host ?? '') ? '' : '; Secure'
  res.setHeader('set-cookie', `toy_loop=${TICKET.toString('hex')}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Strict${secure}`)
  return 200
}

// A proxy in front of a hosted board drops a stream that stays silent, so say something now and then.
if (HOSTED) setInterval(() => clients.forEach((res) => res.write(': still here\n\n')), 25_000).unref()

const server = createServer(async (req, res) => {
  const json = (code, body = {}) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  try {
    if (!allowed(req)) return json(403, { error: 'forbidden' })
    const { pathname } = new URL(req.url, 'http://localhost')

    if (HOSTED && !signedIn(req)) {
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(readFileSync(join(HERE, '..', 'login.html')))
      }
      if (req.method === 'POST' && pathname === '/login') return json(login(req, res, (await readBody(req)).password ?? ''))
      return json(401, { error: 'sign in first' })
    }

    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(readFileSync(join(HERE, 'dashboard.html')))
    }
    if (req.method === 'GET' && pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(`event: state\ndata: ${JSON.stringify(view())}\n\n`)
      clients.add(res)
      return req.on('close', () => clients.delete(res))
    }
    if (req.method === 'GET' && pathname === '/api/tools') return json(200, toolList())
    if (pathname === '/mcp' && req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }) // no stream to open: every answer comes back on its POST
      return res.end()
    }
    if (req.method === 'GET') return json(404)

    const body = await readBody(req)
    if (pathname === '/catch') {
      json(200, { ok: true }) // the session is not kept waiting
      return HOSTED ? null : onCatch(body) // a host has no sessions of its own to read
    }
    if (pathname === '/mcp') {
      const out = Array.isArray(body) ? (await Promise.all(body.map(onMcp))).filter(Boolean) : await onMcp(body)
      if (!out || (Array.isArray(out) && !out.length)) {
        res.writeHead(202)
        return res.end()
      }
      return json(200, out)
    }
    // The board and the page's WebMCP tools: /api/tool/<name>. The board says so, so a version it adds is the board's.
    const name = pathname.match(/^\/api\/tool\/([a-z_]+)$/)?.[1]
    if (name) {
      try {
        return json(200, { result: await callTool(name, body, req.headers['x-from'] === 'board' ? 'board' : 'agent') })
      } catch (e) {
        return json(400, { error: e.message })
      }
    }
    if (pathname === '/api/reset' && active()) {
      active().reset()
      return json(200, { ok: true })
    }
    json(404)
  } catch (e) {
    if (!res.headersSent) json(500, { error: e.message })
  }
})

// Fail closed on a host: without a password the board would listen on localhost, where nobody can reach it there.
if (!PASSWORD && (process.env.RENDER || Object.keys(process.env).some((k) => k.startsWith('RAILWAY_')))) {
  console.log('set TOY_LOOP_PASSWORD to host the board: it is only served beyond localhost behind a login')
  process.exit(1)
}
if (HOSTED && !API_KEY) console.log('no ANTHROPIC_API_KEY: model calls go through the `claude` CLI, which has to be installed and logged in')

load()
for (const b of boards.values()) b.wake()
if (!HOSTED) {
  scan()
  setInterval(scan, 3000).unref() // a skill can be connected at any time
}
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e
  console.log(`port ${PORT} is taken: the board is probably already running at http://localhost:${PORT}`)
  process.exit(1)
})
server.listen(PORT, HOSTED ? '0.0.0.0' : '127.0.0.1', () =>
  console.log(HOSTED ? `toy loop v2: port ${PORT}, behind the password` : `toy loop v2: http://localhost:${PORT}  (agents: http://localhost:${PORT}/mcp)`),
)
