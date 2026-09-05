import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sidecarWorkspaceRoot, workspaceRoot } from '../agents/_workspace.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const publicDir = join(root, 'public')
const port = Number(process.env.PORT || 8088)
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
}

function loadDotEnv() {
  const env = { ...process.env }
  let text = ''
  try {
    text = readFileSync(join(root, '.env'), 'utf8')
  } catch {
    return env
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const cut = line.indexOf('=')
    if (cut <= 0) continue
    const key = line.slice(0, cut).trim()
    if (!key || Object.hasOwn(env, key)) continue
    env[key] = line.slice(cut + 1).trim()
  }
  return env
}

const conversations = new Map()

function memoryStore(conversationId) {
  let row = conversations.get(conversationId)
  if (!row) {
    row = { metadata: {} }
    conversations.set(conversationId, row)
  }
  return {
    async getConversation() {
      return row
    },
    async updateConversation(arg) {
      const metadata = arg?.metadata && typeof arg.metadata === 'object' ? arg.metadata : arg
      if (metadata && typeof metadata === 'object') Object.assign(row.metadata, metadata)
    },
    async appendMessage() {},
  }
}

function envFromFile() {
  return loadDotEnv()
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function localDiskSandbox(conversationId) {
  const diskRoot = sidecarWorkspaceRoot(conversationId)
  const logicalRoot = workspaceRoot(conversationId)
  const toDisk = (logicalPath) => {
    const normalized = String(logicalPath || '').replaceAll('\\', '/')
    const rel = normalized === logicalRoot || normalized.startsWith(`${logicalRoot}/`)
      ? normalized.slice(logicalRoot.length).replace(/^\//, '')
      : normalized.replace(/^\//, '')
    const safe = rel.split('/').filter(part => part && part !== '.' && part !== '..')
    return safe.length > 0 ? join(diskRoot, ...safe) : diskRoot
  }
  return {
    kind: 'local-disk',
    files: {
      async makeDir(path) {
        await mkdir(toDisk(path), { recursive: true })
      },
      async write(path, content) {
        const dest = toDisk(path)
        await mkdir(dirname(dest), { recursive: true })
        await writeFile(dest, content, 'utf8')
      },
      async read(path) {
        return readFile(toDisk(path), 'utf8')
      },
      async exists(path) {
        try {
          await access(toDisk(path))
          return true
        } catch {
          return false
        }
      },
    },
    commands: {
      async run(command, options = {}) {
        const cwd = options.cwd ? toDisk(options.cwd) : diskRoot
        await mkdir(cwd, { recursive: true })
        const trimmed = String(command || '').trim()
        const printf = trimmed.match(/^printf\s+'([^']*)'$/)
        if (printf) return { exitCode: 0, stdout: printf[1], stderr: '' }
        return await new Promise((resolve, reject) => {
          const child = spawn(command, { cwd, shell: true, windowsHide: true })
          let stdout = ''
          let stderr = ''
          const timer = setTimeout(() => {
            child.kill()
            reject(new Error('local sandbox command timed out'))
          }, Math.max(1, Number(options.timeout || 30)) * 1000)
          child.stdout?.setEncoding('utf8')
          child.stdout?.on('data', chunk => { stdout = `${stdout}${String(chunk)}`.slice(-20_000) })
          child.stderr?.setEncoding('utf8')
          child.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-20_000) })
          child.once('error', error => {
            clearTimeout(timer)
            reject(error)
          })
          child.once('close', code => {
            clearTimeout(timer)
            resolve({ exitCode: code ?? 1, stdout, stderr })
          })
        })
      },
    },
    getHost() {
      return undefined
    },
    envdAccessToken: '',
  }
}

function makersContext(req, body, env) {
  const url = new URL(req.url || '/', `http://127.0.0.1:${String(port)}`)
  const conversationId = String(req.headers['makers-conversation-id'] || body?.conversation_id || 'local-dev').trim()
  return {
    conversation_id: conversationId,
    env,
    store: memoryStore(conversationId),
    sandbox: localDiskSandbox(conversationId),
    tools: { all: () => [] },
    utils: { abortActiveRun: async () => ({ aborted: false }) },
    request: {
      url: url.pathname + url.search,
      method: req.method,
      headers: req.headers,
      body,
      query: Object.fromEntries(url.searchParams),
    },
  }
}

async function sendWebResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
    res.end()
  } catch (error) {
    reader.releaseLock()
    if (!res.writableEnded) res.end()
    throw error
  }
}

async function serveStatic(res, pathname) {
  const decoded = decodeURIComponent(pathname)
  const target = normalize(join(publicDir, decoded === '/' ? 'index.html' : decoded.replace(/^[/\\]+/, '')))
  if (target !== publicDir && !target.startsWith(publicDir + sep)) {
    res.writeHead(403).end()
    return
  }
  try {
    const info = await stat(target)
    if (!info.isFile()) throw new Error('not a file')
    const body = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[extname(target)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    const html = await readFile(join(publicDir, 'index.html'))
    res.writeHead(200, { 'content-type': MIME['.html'] })
    res.end(html)
  }
}

const env = envFromFile()
const { onRequest } = await import('../agents/api/_proxy.ts')
const { onRequestPost } = await import('../agents/stop.ts')

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${String(port)}`)
    if (
      url.pathname.startsWith('/api')
      || url.pathname === '/stop'
      || url.pathname === '/plugins/dsh-agent-teams/state'
    ) {
      const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req)
      const context = makersContext(req, body, env)
      const response = url.pathname === '/stop'
        ? await onRequestPost(context)
        : await onRequest(context)
      await sendWebResponse(res, response)
      return
    }
    await serveStatic(res, url.pathname)
  })().catch((error) => {
    console.warn('[local-dev] request failed:', error)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      error: 'LOCAL_DEV_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }))
  })
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, '127.0.0.1', resolve)
})
console.log(`Makers frontend: http://127.0.0.1:${String(port)}`)
