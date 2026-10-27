// A follow-up that asks for a different task starts a new case (#1). These run the real server, copied into a temp
// folder with its own HOME, state file and port, with test/fake-claude.mjs as the model, so the repo's own skill and
// board are never touched. Run with: npm test

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const FAKE = join(REPO, 'test/fake-claude.mjs')

// ---------- a board of its own ----------

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

async function startBoard({ state } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'toy-loop-test-'))
  const home = join(dir, 'home')
  mkdirSync(join(dir, 'loop/v2'), { recursive: true })
  for (const f of ['server.mjs', 'dashboard.html']) copyFileSync(join(REPO, 'loop/v2', f), join(dir, 'loop/v2', f))
  const port = await freePort()
  const skillDir = join(dir, '.claude/skills/ascii')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ascii\ndescription: Draw ASCII art of a subject.\nhooks: { Stop: [{ hooks: [{ type: command, command: "curl -s -m 2 -o /dev/null --json @- localhost:${port}/catch || true" }] }] }\n---\n\nDraw the requested subject as ASCII art.\n`,
  )
  const stateFile = join(dir, 'data/v2.json')
  if (state) {
    mkdirSync(dirname(stateFile), { recursive: true })
    // The board keys a skill by its real path (on macOS the temp folder is under /private), as a saved board does.
    writeFileSync(stateFile, JSON.stringify(state(realpathSync(join(skillDir, 'SKILL.md')))))
  }
  chmodSync(FAKE, 0o755)
  const log = join(dir, 'calls.jsonl')
  const child = spawn(process.execPath, [join(dir, 'loop/v2/server.mjs')], {
    env: { ...process.env, HOME: home, CLAUDE_BIN: FAKE, TOY_LOOP_V2_PORT: String(port), TOY_LOOP_V2_STATE: stateFile, FAKE_LOG: log, TOY_LOOP_PASSWORD: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (out += d))
  await until(() => out.includes('toy loop v2:'), 'the server did not start: ' + out)
  const url = `http://localhost:${port}`
  return { dir, home, port, url, skillDir, log, stop: () => (child.kill(), rmSync(dir, { recursive: true, force: true })), output: () => out }
}

async function until(ok, what, ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    const got = await ok()
    if (got) return got
    if (Date.now() > end) throw new Error(`timed out: ${typeof what === 'function' ? what() : what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

// ---------- talking to it ----------

async function tool(b, name, args = {}) {
  const res = await fetch(`${b.url}/api/tool/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
  const body = await res.json()
  if (res.status !== 200) throw new Error(body.error)
  return body.result
}

// The board as the page sees it: the first event on /events.
async function board(b) {
  const res = await fetch(`${b.url}/events`)
  const reader = res.body.getReader()
  let text = ''
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value)
  reader.cancel()
  return JSON.parse(text.match(/^data: (.*)$/m)[1])
}

const calls = (b) => (existsSync(b.log) ? readFileSync(b.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])

// ---------- sessions ----------

// A Claude Code transcript, written the way Claude Code writes one, and posted to /catch as the Stop hook does.
function session(b) {
  const id = randomUUID()
  const path = join(b.home, '.claude/projects/test', `${id}.jsonl`)
  mkdirSync(dirname(path), { recursive: true })
  const line = (m) => appendFileSync(path, JSON.stringify(m) + '\n')
  const reply = (answer) => line({ type: 'assistant', uuid: randomUUID(), message: { id: randomUUID(), role: 'assistant', model: 'fake', content: [{ type: 'text', text: answer }] } })
  let last = ''
  return {
    id,
    use(args, answer) {
      line({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: `<command-name>/ascii</command-name>\n<command-args>${args}</command-args>` } })
      line({ type: 'user', isMeta: true, uuid: randomUUID(), message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${b.skillDir}` }] } })
      reply((last = answer))
      return this
    },
    say(text, answer) {
      line({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: text } })
      reply((last = answer))
      return this
    },
    post: () =>
      fetch(`${b.url}/catch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: id, transcript_path: path, cwd: b.dir, last_assistant_message: last }),
      }),
  }
}

const CAT = '```\n /\\_/\\\n( o.o )\n > ^ <\n```'
const BIG_CAT = '```\n  /\\_____/\\\n /  o   o  \\\n( ==  ^  == )\n )         (\n(  )     (  )\n```'
const DOG = '```\n  / \\__\n (    @\\___\n /         O\n```'

const desk = (b) => tool(b, 'list_desk')
const settled = (c) => c.checks.length && !c.writing_checks && c.checks.every((k) => k.pass !== null)
// The desk once every case on it has its checks written and graded, and there are n of them.
const deskOf = (b, n) => until(async () => {
  const d = await desk(b)
  return d.length === n && d.every(settled) && d
}, `a desk of ${n}`)

// ---------- the tests ----------

let b
before(async () => (b = await startBoard()))
after(() => b?.stop())
beforeEach(async () => {
  await fetch(`${b.url}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  await tool(b, 'set_settings', { prompts: { checks: '' } })
})

test('1. a refinement stays on the case', async () => {
  const s = session(b).use('a cat', CAT)
  await s.post()
  s.say('make it more detailed', BIG_CAT)
  await s.post()
  const [c] = await until(async () => {
    const d = await deskOf(b, 1)
    return d[0].said_in_session.length === 1 && d
  }, 'the steer on the desk')
  assert.equal(c.request, '/ascii a cat')
  assert.deepEqual(c.said_in_session, ['make it more detailed'])
})

test('2. a new task starts a new case with its own request', async () => {
  const s = session(b).use('a cat', CAT)
  await s.post()
  s.say('make it smaller, simpler and make it a dog', DOG)
  await s.post()
  const d = await deskOf(b, 2)
  const dog = d.find((c) => c.request === '/ascii a dog')
  const cat = d.find((c) => c.request === '/ascii a cat')
  assert.ok(dog && cat, 'a cat case and a dog case')
  assert.deepEqual(dog.said_in_session, ['make it smaller, simpler and make it a dog'], 'the whole message steers the new case')
  assert.equal(dog.answer, DOG)
  assert.equal(dog.split_from, cat.id)
  assert.equal(cat.split_into, dog.id)
  const state = await board(b)
  const saved = state.cases.find((c) => c.id === dog.id)
  assert.equal(saved.prompt, 'a dog', 'the lab asks for the request without the skill name')
  assert.equal(saved.turns[0].answer, CAT, 'the answer the message reacted to comes along as the first answer')

  // The check writer can give the request without the skill's name too.
  const h = session(b).use('a cat', CAT)
  await h.post()
  h.say('now draw a house', '```\n /\\\n/__\\\n|  |\n```')
  await h.post()
  const house = (await deskOf(b, 4)).find((c) => c.request === '/ascii a house')
  assert.ok(house, 'a house case')
  assert.equal((await board(b)).cases.find((c) => c.id === house.id).prompt, 'a house')
})

test('3. the original case keeps its checks from before the split', async () => {
  const s = session(b).use('a cat', CAT)
  await s.post()
  s.say('make it more detailed', BIG_CAT)
  await s.post()
  const [before] = await until(async () => {
    const d = await deskOf(b, 1)
    return d[0].checks.length === 2 && d
  }, 'the steer written into a check')
  s.say('make it smaller, simpler and make it a dog', DOG)
  await s.post()
  const cat = (await deskOf(b, 2)).find((c) => c.request === '/ascii a cat')
  assert.deepEqual(cat.checks.map((k) => k.question), before.checks.map((k) => k.question))
  assert.deepEqual(cat.said_in_session, ['make it more detailed'])
  assert.equal(cat.answer, BIG_CAT, 'graded on its own last answer, not the dog')
})

test('4. the judge is shown the new request', async () => {
  const s = session(b).use('a cat', CAT)
  await s.post()
  s.say('make it a dog', DOG)
  await s.post()
  await deskOf(b, 2)
  const judged = calls(b).filter((c) => c.role === 'judge' && c.prompt.includes(DOG))
  assert.ok(judged.length, 'the dog was judged')
  for (const c of judged) assert.match(c.prompt, /^REQUEST: \/ascii a dog$/m)
})

test('5. the same transcript posted again makes no duplicates', async () => {
  const s = session(b).use('a cat', CAT)
  await s.post()
  s.say('make it a dog', DOG)
  await s.post()
  await deskOf(b, 2)
  await s.post()
  await s.post()
  s.say('thanks', 'Glad you like it.')
  await s.post()
  await new Promise((r) => setTimeout(r, 300))
  assert.equal((await deskOf(b, 2)).length, 2)
})

test('6. later turns follow the new case', async () => {
  const s = session(b).use('a cat', CAT)
  await s.post()
  s.say('make it a dog', DOG)
  await s.post()
  await deskOf(b, 2)
  s.say('make the tail longer', DOG + '\n~~')
  await s.post()
  const d = await until(async () => {
    const d = await deskOf(b, 2)
    return d.find((c) => c.request === '/ascii a dog').said_in_session.length === 2 && d
  }, 'the dog steered')
  assert.deepEqual(d.find((c) => c.request === '/ascii a dog').said_in_session, ['make it a dog', 'make the tail longer'])
  assert.deepEqual(d.find((c) => c.request === '/ascii a cat').said_in_session, [])
})

test('7. a dismissed new case stays dismissed', async () => {
  const s = session(b).use('a cat', CAT)
  await s.post()
  s.say('make it a dog', DOG)
  await s.post()
  const dog = (await deskOf(b, 2)).find((c) => c.request === '/ascii a dog')
  await tool(b, 'review_case', { case_id: dog.id, decision: 'dismiss' })
  await s.post()
  s.say('make the tail longer', DOG + '\n~~')
  await s.post()
  await new Promise((r) => setTimeout(r, 300))
  const d = await deskOf(b, 1)
  assert.equal(d[0].request, '/ascii a cat')
  assert.deepEqual(d[0].said_in_session, [])
})

test('8. undo puts the split back together, and it does not split again', async () => {
  const s = session(b).use('a cat', CAT)
  await s.post()
  s.say('make it a dog', DOG)
  await s.post()
  const dog = (await deskOf(b, 2)).find((c) => c.request === '/ascii a dog')
  await tool(b, 'rejoin_case', { case_id: dog.id })
  s.say('make the tail longer', DOG + '\n~~')
  await s.post()
  await s.post()
  const [c] = await until(async () => {
    const d = await deskOf(b, 1)
    return d[0].said_in_session.length === 2 && d
  }, 'one case with both steers')
  assert.equal(c.request, '/ascii a cat')
  assert.deepEqual(c.said_in_session, ['make it a dog', 'make the tail longer'])
  assert.equal(c.split_into, undefined)
  assert.ok(c.checks.some((k) => k.question === 'Reflects: make it a dog?'), 'the message steers the case again')
})

test('9. no undo once a case is accepted', async () => {
  const s = session(b).use('a cat', CAT)
  await s.post()
  s.say('make it a dog', DOG)
  await s.post()
  const dog = (await deskOf(b, 2)).find((c) => c.request === '/ascii a dog')
  await tool(b, 'review_case', { case_id: dog.id, decision: 'accept' })
  await assert.rejects(tool(b, 'rejoin_case', { case_id: dog.id }), /accepted|dataset/)
})

test('10. the lab asks for the new request', async () => {
  const s = session(b).use('a cat', CAT)
  await s.post()
  s.say('make it a dog', DOG)
  await s.post()
  const dog = (await deskOf(b, 2)).find((c) => c.request === '/ascii a dog')
  await tool(b, 'review_case', { case_id: dog.id, decision: 'accept' })
  const [v] = (await tool(b, 'list_versions')).filter((x) => x.status === 'current')
  await tool(b, 'test_version', { version: v.id })
  await until(async () => (await tool(b, 'list_cases')).some((c) => c.id === dog.id && c.run), 'the dog case run in the lab')
  const asked = calls(b).filter((c) => c.role === 'student').map((c) => c.prompt.match(/ARGUMENTS: (.*)$/m)?.[1])
  assert.ok(asked.includes('a dog'), `the student was asked for: ${asked.join(', ')}`)
  assert.ok(!asked.includes('a cat'), 'and never for the cat, which was not accepted')
})

test('11. a board saved before this change loads and works', async () => {
  const old = await startBoard({
    state: (file) => ({
      schema: 2,
      active: file,
      settings: {},
      boards: [{ skill: { name: 'ascii', file }, cases: [], dismissed: [], versions: [], runs: {}, log: [], current: null, seq: { c: 0, k: 0, s: 0, v: 0 } }],
    }),
  })
  try {
    const s = session(old).use('a cat', CAT)
    await s.post()
    s.say('make it more detailed', BIG_CAT)
    await s.post()
    const [c] = await until(async () => {
      const d = await deskOf(old, 1)
      return d[0].said_in_session.length === 1 && d
    }, 'the old board steered')
    assert.equal(c.request, '/ascii a cat')
  } finally {
    old.stop()
  }
})

test('12. a custom checks prompt keeps the old behavior', async () => {
  await tool(b, 'set_settings', { prompts: { checks: 'Write yes/no checks. Reply with JSON only: {"checks": [], "comments": [], "unrelated": []}' } })
  const s = session(b).use('a cat', CAT)
  await s.post()
  s.say('make it a dog', DOG)
  await s.post()
  const [c] = await until(async () => {
    const d = await deskOf(b, 1)
    return d[0].said_in_session.length === 1 && d
  }, 'one case, steered')
  assert.equal(c.request, '/ascii a cat')
  assert.deepEqual(c.said_in_session, ['make it a dog'])
})

test('13. undo waits for a later split to be undone first', async () => {
  const s = session(b).use('a cat', CAT)
  await s.post()
  s.say('make it a dog', DOG)
  await s.post()
  await deskOf(b, 2)
  s.say('now draw a house', '```\n /\\\n/__\\\n|  |\n```')
  await s.post()
  const d = await deskOf(b, 3)
  const dog = d.find((c) => c.request === '/ascii a dog')
  const house = d.find((c) => c.request === '/ascii a house')
  assert.equal(house.split_from, dog.id)
  await assert.rejects(tool(b, 'rejoin_case', { case_id: dog.id }), /later split|house/)
  await tool(b, 'rejoin_case', { case_id: house.id })
  await tool(b, 'rejoin_case', { case_id: dog.id })
  assert.equal((await deskOf(b, 1))[0].request, '/ascii a cat')
})

// Found in review: a hook delivery can carry several turns at once (the board was not running, or a session resumed).

test('14. a session caught all at once: the original still gets its checks', async () => {
  const s = session(b).use('a cat', CAT).say('make it more detailed', BIG_CAT).say('make it a dog', DOG)
  await s.post()
  const d = await deskOf(b, 2)
  const cat = d.find((c) => c.request === '/ascii a cat')
  assert.deepEqual(cat.said_in_session, ['make it more detailed'])
  assert.ok(cat.checks.some((k) => k.question === 'Reflects: make it more detailed?'), 'the steer before the split is in the checks')
})

test('15. undo keeps a case stopped where the session moved on', async () => {
  const s = session(b).use('a cat', CAT).say('make it a dog', DOG).say('unrelated: write a SQL query', 'SELECT 1')
  await s.post()
  const dog = (await deskOf(b, 2)).find((c) => c.request === '/ascii a dog')
  await tool(b, 'rejoin_case', { case_id: dog.id })
  s.say('add a WHERE clause', 'SELECT 1 WHERE 1')
  await s.post()
  await new Promise((r) => setTimeout(r, 300))
  const [c] = await deskOf(b, 1)
  assert.deepEqual(c.said_in_session, ['make it a dog'], 'nothing after the unrelated message')
  assert.equal(c.answer, DOG)
})

test('16. a comment just before the new task is not taken for an answer', async () => {
  const s = session(b).use('a cat', CAT)
  await s.post()
  s.say('thanks', 'You are welcome.').say('make it a dog', DOG)
  await s.post()
  const d = await deskOf(b, 2)
  const cat = d.find((c) => c.request === '/ascii a cat')
  const dog = d.find((c) => c.request === '/ascii a dog')
  assert.equal(cat.answer, CAT, 'the cat is graded on the cat')
  assert.equal((await board(b)).cases.find((c) => c.id === dog.id).turns[0].answer, CAT, 'the dog starts from the cat')
})

test('17. undo keeps the notes written on the split-off case', async () => {
  const s = session(b).use('a cat', CAT)
  await s.post()
  s.say('make it a dog', DOG)
  await s.post()
  const dog = (await deskOf(b, 2)).find((c) => c.request === '/ascii a dog')
  await tool(b, 'write_notes', { case_id: dog.id, text: 'floppy ears please' })
  await tool(b, 'rejoin_case', { case_id: dog.id })
  const [c] = await deskOf(b, 1)
  assert.match(c.notes, /floppy ears please/)
})

test('18. a case that had stopped stays stopped when it is split later', async () => {
  // A case from before this change: the dog was steering, and the session then moved on.
  await tool(b, 'set_settings', { prompts: { checks: 'Write yes/no checks. Reply with JSON only: {"checks": [], "comments": [], "unrelated": []}' } })
  const s = session(b).use('a cat', CAT).say('make it a dog', DOG).say('unrelated: write a SQL query', 'SELECT 1')
  await s.post()
  const [cat] = await until(async () => {
    const d = await deskOf(b, 1)
    return d[0].said_in_session.length === 1 && d
  }, 'the old-style case')
  // Back to the built-in prompt, and a note that has the checks written again: now the dog splits off.
  await tool(b, 'set_settings', { prompts: { checks: '' } })
  const mark = calls(b).length // the call log is shared with the tests before this one
  await tool(b, 'write_notes', { case_id: cat.id, text: 'keep it simple' })
  await deskOf(b, 2)
  s.say('add a WHERE clause', 'SELECT 1 WHERE 1')
  await s.post()
  await new Promise((r) => setTimeout(r, 300))
  const dog = (await deskOf(b, 2)).find((c) => c.request === '/ascii a dog')
  assert.deepEqual(dog.said_in_session, ['make it a dog'], 'nothing from after the session moved on')
  assert.equal(dog.answer, DOG)
  // Not even for a moment: no check writer was ever shown the SQL as part of the dog case.
  const seen = calls(b).slice(mark).filter((c) => c.role === 'checks' && /^REQUEST: \/ascii a dog$/m.test(c.prompt) && c.prompt.includes('write a SQL query'))
  assert.equal(seen.length, 0, 'the unrelated message came back into the new case')
})

test('19. accepting the original while its checks are written does not stop the new case following', async () => {
  const s = session(b).use('a cat', CAT)
  await s.post()
  const [cat] = await deskOf(b, 1)
  s.say('make it a dog (slow)', DOG)
  await s.post()
  await tool(b, 'review_case', { case_id: cat.id, decision: 'accept' }) // while the check writer is still at it
  await until(async () => (await desk(b)).some((c) => c.request === '/ascii a dog'), 'the dog split off', 8000)
  s.say('make the tail longer', DOG + '\n~~')
  await s.post()
  const [dog] = await until(async () => {
    const d = await deskOf(b, 1)
    return d[0].said_in_session.length === 2 && d
  }, 'the dog steered after the split')
  assert.deepEqual(dog.said_in_session, ['make it a dog (slow)', 'make the tail longer'])
})
