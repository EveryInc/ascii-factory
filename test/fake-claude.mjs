#!/usr/bin/env node
// A stand-in for `claude -p` in the server tests: the board runs it through CLAUDE_BIN. It works out its role from the
// system prompt and answers by fixed rules, so the tests check what the board does with an answer, not the model.
//
//   check writer: "make it a dog" is a new task ("/ascii a dog"); "now draw a house" is one too, given without the
//                 skill's name ("a house"), so both forms reach the board; "thanks" is a comment; a message starting
//                 "unrelated:" is unrelated; anything else is steering and becomes a check. Only a prompt that offers
//                 "new_task" gets one, so a custom checks prompt behaves as it did before.
//   judge:        every check passes.
//   student:      repeats the request it was given, in a code block.
//
// A message containing "(slow)" makes the check writer take a second and a half, so a test can act while it waits.
// Each call is appended to FAKE_LOG as a line of JSON: { role, prompt }.

import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
const system = args[args.indexOf('--system-prompt') + 1] ?? ''
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk

const section = (title) => prompt.split(`${title}`)[1]?.split(/\n\n[A-Z][A-Z ,'()]+:\n/)[0] ?? ''

function checkWriter() {
  const offersNewTask = system.includes('"new_task"')
  const request = prompt.match(/^REQUEST: (.*)$/m)[1]
  const before = [...section('CHECKS IT HAS NOW:').matchAll(/^(k\d+): (.*)$/gm)].map((m) => ({ id: m[1], question: m[2] }))
  const said = [...section('WHAT THE PERSON SAID AFTER IT IN THE SESSION, IN ORDER:').matchAll(/^(s\d+)((?: \([^)]*\))*): (.*)$/gm)].map((m) => ({
    id: m[1],
    marks: m[2],
    text: m[3],
  }))
  const checks = before.length ? [...before] : [{ id: null, question: `Does it depict ${request.replace(/^\/\S+ /, '')}?` }]
  const out = { checks, comments: [], unrelated: [], new_task: null }
  for (const s of said) {
    const kept = s.marks.includes('not a new task') // the person undid a split on this message
    if (/^unrelated:/.test(s.text)) {
      out.unrelated.push(s.id)
      break
    }
    if (offersNewTask && !kept && /make it a dog/.test(s.text)) {
      out.new_task = { id: s.id, request: '/ascii a dog' }
      break
    }
    if (offersNewTask && !kept && /now draw a house/.test(s.text)) {
      out.new_task = { id: s.id, request: 'a house' }
      break
    }
    if (/^thanks/.test(s.text)) {
      out.comments.push(s.id)
      continue
    }
    const q = `Reflects: ${s.text}?`
    if (!checks.some((k) => k.question === q)) checks.push({ id: null, question: q })
  }
  return JSON.stringify(out)
}

function judge() {
  const ids = [...section('CHECKS:').matchAll(/^(k\d+): /gm)].map((m) => m[1])
  return JSON.stringify(Object.fromEntries(ids.map((id) => [id, { pass: true, why: 'fake judge' }])))
}

const student = () => '```\n' + (prompt.match(/ARGUMENTS: (.*)$/m)?.[1] ?? prompt.trim()) + '\n```'

const role = system.startsWith('You grade one answer') ? 'judge' : system.startsWith('You are Claude Code.') ? 'student' : 'checks'
if (role === 'checks' && prompt.includes('(slow)')) await new Promise((r) => setTimeout(r, 1500))
const result = role === 'judge' ? judge() : role === 'student' ? student() : checkWriter()
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ role, prompt }) + '\n')
// The board reads stream-json and takes the result line.
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result }) + '\n')
