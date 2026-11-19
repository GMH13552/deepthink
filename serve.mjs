import { createServer } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { exec } from 'node:child_process'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// 本地静态服务器：把 dist/ 以 127.0.0.1 的形式提供出来，供浏览器访问
// 用法：node serve.mjs [--port 8090] [--host 127.0.0.1] [--seed-key <credentials.yaml>] [--open]

const ROOT = resolve(fileURLToPath(new URL('./dist', import.meta.url)))

const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name) => argv.includes(name)

const PORT = Number(argOf('--port') ?? process.env.PORT ?? 8090)
const HOST = argOf('--host') ?? process.env.HOST ?? '127.0.0.1'
const SEED_FILE = argOf('--seed-key') ?? process.env.SEED_KEY_FILE ?? ''
const OPEN = has('--open')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

/** 从 DSH 凭据文件里取 DEEPSEEK_API_KEY，仅注入到内存里的 index.html，不落盘 */
const readSeedKey = () => {
  if (!SEED_FILE) return null
  try {
    const text = readFileSync(SEED_FILE, 'utf8')
    const line = text.split(/\r?\n/).find((l) => /^\s*DEEPSEEK_API_KEY:/.test(l))
    const key = line?.replace(/^\s*DEEPSEEK_API_KEY:\s*/, '').trim()
    return key && key.startsWith('sk-') ? key : null
  } catch {
    return null
  }
}

const seedKey = readSeedKey()
const seedScript = seedKey
  ? `<script>try{if(!localStorage.getItem("chat-demo:api-key"))localStorage.setItem("chat-demo:api-key",${JSON.stringify(
      seedKey
    )})}catch(e){}</script>`
  : ''

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost'))
    let pathname = decodeURIComponent(url.pathname)
    if (pathname.endsWith('/')) pathname += 'index.html'

    const candidate = normalize(join(ROOT, pathname))
    const safe = candidate === ROOT || candidate.startsWith(ROOT + sep)

    let file = safe && existsSync(candidate) && statSync(candidate).isFile() ? candidate : null
    if (!file && safe && existsSync(candidate + '.html')) file = candidate + '.html'
    if (!file) file = join(ROOT, 'index.html')

    const ext = extname(file).toLowerCase()
    const isHtml = ext === '.html'

    if (isHtml && seedScript) {
      const html = readFileSync(file, 'utf8').replace('</head>', seedScript + '</head>')
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      })
      return res.end(html)
    }

    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    if (req.method === 'HEAD') return res.end()
    createReadStream(file).pipe(res)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('server error: ' + String(error))
  }
})

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`
  console.log(`chat-demo 运行中：${url}`)
  console.log(`静态文件目录：${ROOT}`)
  if (seedKey) console.log('已启用 API Key 自动注入（仅内存，首次访问时写入浏览器 localStorage）')
  if (OPEN) exec(`start "" "${url}"`)
})
