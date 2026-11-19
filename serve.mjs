import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { exec } from 'node:child_process'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// 本地静态服务器：把 dist/ 以 127.0.0.1 的形式提供出来
// 用法：node serve.mjs [--port 8090] [--host 127.0.0.1] [--open]

const ROOT = resolve(fileURLToPath(new URL('./dist', import.meta.url)))
const argv = process.argv.slice(2)
const argOf = (name) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
const PORT = Number(argOf('--port') ?? process.env.PORT ?? 8090)
const HOST = argOf('--host') ?? process.env.HOST ?? '127.0.0.1'
const OPEN = argv.includes('--open')

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

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost'))
    let pathname = decodeURIComponent(url.pathname)
    if (pathname.endsWith('/')) {
      pathname += 'index.html'
    }
    const candidate = normalize(join(ROOT, pathname))
    const safe = candidate === ROOT || candidate.startsWith(ROOT + sep)
    let file = safe && existsSync(candidate) && statSync(candidate).isFile() ? candidate : null
    if (!file && safe && existsSync(candidate + '.html')) {
      file = candidate + '.html'
    }
    if (!file) {
      file = join(ROOT, 'index.html')
    }
    const ext = extname(file).toLowerCase()
    const isHtml = ext === '.html'
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(file).pipe(res)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('server error: ' + String(error))
  }
})

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`
  console.log(`Deepthink 运行中：${url}`)
  console.log(`静态文件目录：${ROOT}`)
  if (OPEN) {
    exec(`start "" "${url}"`)
  }
})
