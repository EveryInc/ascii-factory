// Builds the replay page from the real v2 board. The board is used as it is: replay-pre.js stands in for the
// server's event stream, replay.js feeds it a recorded run, and brand.css changes only the look.
//   node factory/build.mjs [path/to/trace.jsonl]   (with a trace, it also rewrites trace.js from it)
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

if (process.argv[2]) {
  const events = readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  writeFileSync(join(here, 'trace.js'), `window.TRACE = ${JSON.stringify(events)}\n`)
  console.log(`${events.length} events, ${(events.at(-1).t / 60000).toFixed(1)} real minutes -> trace.js`)
}

let page = readFileSync(join(here, '../loop/v2/dashboard.html'), 'utf8')
const swap = (from, to) => {
  if (!page.includes(from)) throw new Error(`loop/v2/dashboard.html no longer has: ${from}`)
  page = page.replace(from, to)
}
swap('<title>Toy loop v2</title>', '<title>The ASCII Factory</title>')
swap(
  '</head>',
  `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;1,6..72,400&family=Inter:wght@400;500;600&family=Geist+Mono:wght@400;500&display=block" rel="stylesheet">
<link rel="stylesheet" href="brand.css">
</head>`,
)
swap('<script>\n', '<script src="trace.js"></script>\n<script src="narration.js"></script>\n<script src="replay-pre.js"></script>\n<script>\n')
swap('</body>', '<script src="outro.js"></script>\n<script src="replay.js"></script>\n</body>')
writeFileSync(join(here, 'index.html'), page)
console.log('index.html built from loop/v2/dashboard.html')
