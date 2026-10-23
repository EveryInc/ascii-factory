// The narration and the music, with Gemini: each line of narration.json becomes audio/<id>.wav, and audio/music.mp3
// is a bed under it. Lines that already have audio are kept, so changing one line costs one call.
//   GEMINI_API_KEY=... node factory/voice.mjs [ids to redo...]
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'audio')
const KEY = process.env.GEMINI_API_KEY
if (!KEY) throw new Error('set GEMINI_API_KEY')
const API = 'https://generativelanguage.googleapis.com/v1beta'
const TTS = 'gemini-3.8-flash-tts'
const MUSIC = 'lyria-3-pro-preview'
const { voice, style, music, lines } = JSON.parse(readFileSync(join(HERE, 'narration.json'), 'utf8'))
mkdirSync(OUT, { recursive: true })

async function post(model, body) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${API}/models/${model}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify(body) })
    if (res.ok) return res.json()
    if (res.status !== 429 && res.status < 500) throw new Error(`${model}: ${res.status} ${(await res.text()).slice(0, 300)}`)
    await new Promise((r) => setTimeout(r, 15_000 * (attempt + 1)))
  }
  throw new Error(`${model}: gave up`)
}
const audioOf = (r) => r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData.data
// Now and then a reply comes back with no audio in it: ask again, a few times.
async function audio(model, body, what) {
  for (let i = 0; i < 4; i++) {
    const r = await post(model, body)
    const data = audioOf(r)
    if (data) return Buffer.from(data, 'base64')
    console.log(`${what}: no audio (${r.candidates?.[0]?.finishReason ?? JSON.stringify(r).slice(0, 160)}), asking again`)
  }
  throw new Error(`${what}: no audio after 4 tries`)
}
const duration = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString())

async function say({ id, text }) {
  // Style notes go in a section the model is told not to read, or it reads them out.
  const prompt = `### DIRECTOR'S NOTES (do not read aloud)\n${style}\n\n### TRANSCRIPT (read only this)\n${text}`
  const raw = await audio(TTS, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } }, id)
  const pcm = join(OUT, `${id}.pcm`)
  writeFileSync(pcm, raw) // 24 kHz, 16-bit, mono
  const secs = readFileSync(pcm).length / 2 / 24000
  // TTS leaves a short burst of noise at the end: cut it, trim the silence at both ends, fade in and out.
  const af = `atrim=0:${secs - 0.16},silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.04,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08,areverse,afade=t=in:d=0.015,areverse,afade=t=in:d=0.03,areverse`
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm, '-af', af, '-ar', '48000', join(OUT, `${id}.wav`)])
  rmSync(pcm)
}

const redo = new Set(process.argv.slice(2))
const todo = lines.filter((l) => redo.has(l.id) || !existsSync(join(OUT, `${l.id}.wav`)))
// A take that runs far slower or faster than speech has silence or something extra in it: take it again.
const pace = (l) => l.text.split(/\s+/).length / (duration(join(OUT, `${l.id}.wav`)) / 60)
await Promise.all(
  todo.map(async (l) => {
    for (let take = 1; take <= 6; take++) {
      await say(l)
      const wpm = pace(l)
      if (wpm > 135 && wpm < 215) return
      console.log(`${l.id}: take ${take} runs at ${Math.round(wpm)} words a minute, taking it again`)
    }
  }),
)
if (!existsSync(join(OUT, 'music.mp3')) || redo.has('music')) {
  writeFileSync(join(OUT, 'music.mp3'), await audio(MUSIC, { contents: [{ parts: [{ text: music }] }], generationConfig: { responseModalities: ['AUDIO'] } }, 'music'))
}
// How long each line runs, for the replay to give it room.
const lengths = Object.fromEntries(lines.map((l) => [l.id, Math.round(duration(join(OUT, `${l.id}.wav`)) * 1000)]))
writeFileSync(join(HERE, 'narration.js'), `window.NARRATION = ${JSON.stringify({ lines: lines.map((l) => ({ ...l, ms: lengths[l.id] })) })}\n`)
console.log(`${todo.length} lines voiced; music ${Math.round(duration(join(OUT, 'music.mp3')))}s; total narration ${Math.round(Object.values(lengths).reduce((a, b) => a + b, 0) / 1000)}s`)
