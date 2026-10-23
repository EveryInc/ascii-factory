// Records the page to an MP4, frame by frame: the page's clock is set for each frame, so the video
// is smooth whatever the machine's speed. Then the narration (audio/<id>.wav, from voice.mjs) is laid at the times the
// page gives for each line, over the music, which dips while the narrator speaks.
// Needs Playwright (npm i -g playwright), Chrome and ffmpeg.
//   node factory/record.mjs out.mp4 [fps] [from seconds] [for seconds]   (the last two record a slice, for checking)
import { spawn, execFileSync, execSync } from 'node:child_process'
import { existsSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const out = process.argv[2] || 'ascii-factory.mp4'
const FPS = Number(process.argv[3] || 30)
const globalRoot = execSync('npm root -g').toString().trim()
const { chromium } = await import(pathToFileURL(join(globalRoot, 'playwright/index.mjs')).href)

const HERE = dirname(fileURLToPath(import.meta.url))
const page_ = pathToFileURL(join(HERE, 'index.html')).href + '?record'
const browser = await chromium.launch({ channel: 'chrome', args: ['--window-size=1440,810'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 4 / 3 }) // a 1920x1080 video, with the dashboard at a readable size
await page.goto(page_)
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(500)
const END = await page.evaluate(() => window.END)
const FROM = Number(process.argv[4] || 0) * 1000
const frames = Math.ceil(((Number(process.argv[5] || 0) * 1000 || END - FROM) / 1000) * FPS)

const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] })
const cdp = await page.context().newCDPSession(page)
const t0 = Date.now()
for (let i = 0; i < frames; i++) {
  await page.evaluate((t) => window.renderAt(t), FROM + (i * 1000) / FPS)
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: 1440, height: 810, scale: 4 / 3 } })
  if (!ff.stdin.write(Buffer.from(data, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r))
  if (i % (FPS * 10) === 0) console.log(`${Math.round((i / FPS))}s of ${Math.round(END / 1000)}s, ${Math.round((Date.now() - t0) / 1000)}s in`)
}
ff.stdin.end()
await new Promise((r) => ff.on('close', r))
const CUES = await page.evaluate(() => window.CUES ?? [])
await browser.close()

// The sound: each line where it starts, and the music under it all, ducked by the voice and faded out at the end.
const lines = CUES.filter((c) => existsSync(join(HERE, 'audio', `${c.id}.wav`)) && c.at >= FROM && c.at < FROM + (frames * 1000) / FPS)
const music = join(HERE, 'audio', 'music.mp3')
if (lines.length) {
  const secs = frames / FPS
  const inputs = lines.flatMap((c) => ['-i', join(HERE, 'audio', `${c.id}.wav`)])
  const voice = lines.map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.at - FROM)}:all=1[v${i}]`).join(';')
  const mix = `${voice};${lines.map((_, i) => `[v${i}]`).join('')}amix=inputs=${lines.length}:normalize=0,apad,atrim=0:${secs}[voice]`
  const bed = existsSync(music)
    ? `;[${lines.length + 1}:a]aloop=loop=-1:size=2e9,atrim=0:${secs},volume=0.32,afade=t=in:d=1.5,afade=t=out:st=${secs - 3}:d=3[m];[voice]asplit[voice1][key];[m][key]sidechaincompress=threshold=0.03:ratio=8:attack=40:release=500[ducked];[voice1][ducked]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5[out]`
    : ';[voice]loudnorm=I=-16:TP=-1.5[out]'
  const tmp = out.replace(/\.mp4$/, '.silent.mp4')
  renameSync(out, tmp)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, ...inputs, ...(existsSync(music) ? ['-i', music] : []), '-filter_complex', mix + bed, '-map', '0:v', '-map', '[out]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', out])
  execFileSync('rm', [tmp])
}
console.log(`wrote ${out}: ${frames} frames, ${(END / 1000).toFixed(1)}s, ${lines.length} lines of narration`)
