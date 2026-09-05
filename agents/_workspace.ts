import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { isOfficeDocumentPath } from './_office-files.ts'

const IGNORED_DIRECTORIES = new Set([
  '.git', '.next', '.cache', '.turbo', '.vite',
  'node_modules', 'dist', 'build', 'coverage', '__pycache__',
])

const IGNORED_FILES = new Set(['.DS_Store', 'preview'])

const TEXT_PREVIEW_LIMIT = 512 * 1024
const SNAPSHOT_FILE_LIMIT = 80
const SNAPSHOT_BYTE_LIMIT = 2 * 1024 * 1024
const DOWNLOAD_BYTE_LIMIT = 20 * 1024 * 1024

const CONTENT_TYPES: Record<string, string> = {
  css: 'text/css; charset=utf-8',
  gif: 'image/gif',
  htm: 'text/html; charset=utf-8',
  html: 'text/html; charset=utf-8',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  webp: 'image/webp',
  xml: 'application/xml; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

interface WorkspaceSnapshotFile {
  content: string
  updatedAt: number
}

type WorkspaceSnapshot = Record<string, WorkspaceSnapshotFile>

export interface WorkspaceItem {
  path: string
  name: string
  type: 'file' | 'directory'
  depth: number
  size?: number
  mtime?: number
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'workspace'
}

export function workspaceRoot(conversationId: string): string {
  return `projects/${safeSegment(conversationId)}/workspace`
}

export function sidecarWorkspaceRoot(conversationId: string): string {
  return join(tmpdir(), 'dsh-makers-web', safeSegment(conversationId), 'workspace')
}

async function mirrorFileToSidecar(conversationId: string, path: string, content: string): Promise<void> {
  const dest = join(sidecarWorkspaceRoot(conversationId), path)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, content, 'utf8')
}

function usesDiskWorkspace(context: any): boolean {
  return !context?.sandbox?.files || context.sandbox.kind === 'local-disk'
}

function diskFilePath(conversationId: string, relativePath = ''): string {
  return relativePath
    ? join(sidecarWorkspaceRoot(conversationId), ...relativePath.split('/'))
    : sidecarWorkspaceRoot(conversationId)
}

async function listWorkspaceFromDisk(conversationId: string): Promise<WorkspaceItem[]> {
  const root = sidecarWorkspaceRoot(conversationId)
  await mkdir(root, { recursive: true })
  const items: WorkspaceItem[] = []
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 6 || items.length >= 400) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (items.length >= 400) return
      if (IGNORED_DIRECTORIES.has(entry.name) || IGNORED_FILES.has(entry.name)) continue
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const childPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        items.push({
          path: childRel,
          name: entry.name,
          type: 'directory',
          depth: childRel.split('/').length - 1,
        })
        await walk(childPath, childRel, depth + 1)
      } else if (entry.isFile()) {
        let size: number | undefined
        let mtime: number | undefined
        try {
          const info = await stat(childPath)
          size = info.size
          mtime = Math.round(info.mtimeMs)
        } catch {
          // The file can disappear between readdir and stat.
        }
        items.push({
          path: childRel,
          name: entry.name,
          type: 'file',
          depth: childRel.split('/').length - 1,
          ...(size !== undefined ? { size } : {}),
          ...(mtime !== undefined ? { mtime } : {}),
        })
      }
    }
  }
  await walk(root, '', 0)
  return items
}

async function runDiskCommand(
  command: string,
  cwd: string,
  timeout: number,
): Promise<{ command: string; stdout: string; stderr: string; exitCode: number }> {
  await mkdir(cwd, { recursive: true })
  const trimmed = command.trim()
  const printf = trimmed.match(/^printf\s+'([^']*)'$/)
  if (printf) return { command, stdout: printf[1], stderr: '', exitCode: 0 }
  return await new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Command timed out after ${String(timeout)}s.`))
    }, timeout * 1000)
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
      resolve({ command, stdout, stderr, exitCode: code ?? 1 })
    })
  })
}

export async function hydrateSidecarWorkspace(
  context: any,
  conversationId: string,
  sidecarWorkspacePath = sidecarWorkspaceRoot(conversationId),
): Promise<void> {
  if (!context?.sandbox) return
  try {
    const items = await listWorkspace(context, conversationId)
    for (const item of items) {
      if (item.type !== 'file' || isOfficeDocumentPath(item.path)) continue
      const file = await readWorkspaceFile(context, conversationId, item.path)
      const dest = join(sidecarWorkspacePath, file.path)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, file.content, 'utf8')
    }
  } catch (error) {
    console.warn('[workspace] sidecar hydrate failed:', error)
  }
}

export function normalizeWorkspacePath(value: string): string | null {
  const path = value.trim().replaceAll('\\', '/').replace(/^\.\//, '')
  if (!path || path.startsWith('/') || path.includes('\0')) return null
  const parts = path.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return null
  return parts.join('/')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function isMissingConversation(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : ''
  const message = error instanceof Error ? error.message : String(error)
  return code === 'MemoryNotFoundError' || /Conversation not found/i.test(message)
}

async function getConversation(context: any, conversationId: string): Promise<any> {
  try {
    return await context.store.getConversation({ conversationId })
  } catch (firstError) {
    try { return await context.store.getConversation(conversationId) } catch { throw firstError }
  }
}

async function appendBootstrapMessage(context: any, conversationId: string): Promise<void> {
  const payload = {
    conversationId,
    role: 'system' as const,
    content: 'workspace',
    metadata: { kind: 'workspace-bootstrap' },
  }
  try {
    await context.store.appendMessage(payload)
  } catch (firstError) {
    try {
      await context.store.appendMessage(conversationId, payload)
    } catch {
      throw firstError
    }
  }
}

async function ensureConversation(context: any, conversationId: string): Promise<void> {
  if (!context?.store) return
  try {
    await getConversation(context, conversationId)
  } catch (error) {
    if (!isMissingConversation(error)) throw error
    await appendBootstrapMessage(context, conversationId)
  }
}

async function updateConversationMetadata(
  context: any,
  conversationId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (!context?.store) return
  await ensureConversation(context, conversationId)
  try {
    await context.store.updateConversation({ conversationId, metadata })
    return
  } catch (firstError) {
    if (isMissingConversation(firstError)) {
      await appendBootstrapMessage(context, conversationId)
      await context.store.updateConversation({ conversationId, metadata })
      return
    }
    try {
      await context.store.updateConversation(conversationId, { metadata })
    } catch {
      throw firstError
    }
  }
}

async function loadWorkspaceSnapshot(context: any, conversationId: string): Promise<WorkspaceSnapshot> {
  try {
    const conversation = await getConversation(context, conversationId)
    const snapshot = conversation?.metadata?.workspaceSnapshot
    return snapshot && typeof snapshot === 'object' ? snapshot as WorkspaceSnapshot : {}
  } catch {
    return {}
  }
}

async function workspaceHasFiles(context: any, root: string): Promise<boolean> {
  const result = await context.sandbox.commands.run(
    "find . -mindepth 1 -maxdepth 1 ! -name preview -print -quit",
    { cwd: root, timeout: 10 },
  )
  return result.exitCode === 0 && Boolean(String(result.stdout || '').trim())
}

async function restoreWorkspaceSnapshot(context: any, conversationId: string, root: string): Promise<void> {
  if (await workspaceHasFiles(context, root)) return
  const snapshot = await loadWorkspaceSnapshot(context, conversationId)
  for (const [path, file] of Object.entries(snapshot).slice(0, SNAPSHOT_FILE_LIMIT)) {
    const normalized = normalizeWorkspacePath(path)
    if (!normalized || typeof file?.content !== 'string') continue
    const parent = normalized.split('/').slice(0, -1).join('/')
    if (parent) await context.sandbox.files.makeDir(`${root}/${parent}`)
    await context.sandbox.files.write(`${root}/${normalized}`, file.content)
  }
}

async function saveWorkspaceSnapshotFile(
  context: any,
  conversationId: string,
  path: string,
  content: string,
): Promise<void> {
  const snapshot = await loadWorkspaceSnapshot(context, conversationId)
  snapshot[path] = { content, updatedAt: Date.now() }
  const ordered = Object.entries(snapshot)
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
  const bounded: WorkspaceSnapshot = {}
  let bytes = 0
  for (const [candidatePath, file] of ordered) {
    const size = new TextEncoder().encode(file.content).byteLength
    if (Object.keys(bounded).length >= SNAPSHOT_FILE_LIMIT || bytes + size > SNAPSHOT_BYTE_LIMIT) continue
    bounded[candidatePath] = file
    bytes += size
  }
  try {
    await updateConversationMetadata(context, conversationId, { workspaceSnapshot: bounded })
  } catch (error) {
    console.warn('[workspace] snapshot persistence failed:', error)
  }
}

export async function ensureWorkspace(context: any, conversationId: string): Promise<string> {
  if (usesDiskWorkspace(context)) {
    const diskRoot = sidecarWorkspaceRoot(conversationId)
    await mkdir(diskRoot, { recursive: true })
    const snapshot = await loadWorkspaceSnapshot(context, conversationId)
    if (Object.keys(snapshot).length > 0) {
      const existing = await listWorkspaceFromDisk(conversationId)
      if (!existing.some(item => item.type === 'file')) {
        for (const [path, file] of Object.entries(snapshot).slice(0, SNAPSHOT_FILE_LIMIT)) {
          const normalized = normalizeWorkspacePath(path)
          if (!normalized || typeof file?.content !== 'string') continue
          await mirrorFileToSidecar(conversationId, normalized, file.content)
        }
      }
    }
    return workspaceRoot(conversationId)
  }
  const root = workspaceRoot(conversationId)
  await context.sandbox.files.makeDir(root)
  await restoreWorkspaceSnapshot(context, conversationId, root)
  return root
}

export async function listWorkspace(context: any, conversationId: string): Promise<WorkspaceItem[]> {
  if (usesDiskWorkspace(context)) {
    await ensureWorkspace(context, conversationId)
    return listWorkspaceFromDisk(conversationId)
  }
  const root = await ensureWorkspace(context, conversationId)
  const ignored = [...IGNORED_DIRECTORIES]
    .map(directory => `-path './${directory}'`)
    .join(' -o ')
  const expression = `find . \\( ${ignored} \\) -prune -o -maxdepth 6`
  const result = await context.sandbox.commands.run([
    `{ ${expression} -printf '%y\\t%T@\\t%s\\t%p\\n' 2>/dev/null; }`,
    '||',
    `{ ${expression} -print | while IFS= read -r path; do`,
    `if [ -d "$path" ]; then printf 'd\\t0\\t0\\t%s\\n' "$path";`,
    `else printf 'f\\t0\\t0\\t%s\\n' "$path"; fi; done; }`,
  ].join(' '), { cwd: root, timeout: 30 })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Failed to list workspace files.')
  }

  return String(result.stdout || '')
    .split('\n')
    .map((line: string) => line.trimEnd())
    .filter(Boolean)
    .map((line: string) => {
      const [kind = '', mtimeRaw = '', sizeRaw = '', ...pathParts] = line.split('\t')
      return { kind, mtimeRaw, sizeRaw, rawPath: pathParts.join('\t').replace(/^\.\//, '') }
    })
    .filter(item => item.rawPath && item.rawPath !== '.' && ['d', 'f', 'l'].includes(item.kind))
    .filter(item => !item.rawPath.split('/').some(segment => IGNORED_DIRECTORIES.has(segment)))
    .filter(item => !IGNORED_FILES.has(item.rawPath.split('/').pop() || ''))
    .slice(0, 400)
    .map(item => {
      const name = item.rawPath.split('/').pop() || item.rawPath
      const mtime = Number.parseFloat(item.mtimeRaw)
      const size = Number.parseInt(item.sizeRaw, 10)
      return {
        path: item.rawPath,
        name,
        type: item.kind === 'd' ? 'directory' as const : 'file' as const,
        depth: item.rawPath.split('/').length - 1,
        ...(Number.isFinite(size) && size >= 0 ? { size } : {}),
        ...(Number.isFinite(mtime) && mtime > 0 ? { mtime: Math.round(mtime * 1000) } : {}),
      }
    })
}

export async function readWorkspaceFile(
  context: any,
  conversationId: string,
  requestedPath: string,
): Promise<{ path: string; content: string; size: number; truncated: boolean }> {
  const path = normalizeWorkspacePath(requestedPath)
  if (!path) throw new Error('Invalid workspace file path.')
  if (usesDiskWorkspace(context)) {
    await ensureWorkspace(context, conversationId)
    const content = await readFile(diskFilePath(conversationId, path), 'utf8')
    const encoded = new TextEncoder().encode(content)
    const truncated = encoded.byteLength > TEXT_PREVIEW_LIMIT
    const visible = truncated
      ? new TextDecoder().decode(encoded.slice(0, TEXT_PREVIEW_LIMIT))
      : content
    return { path, content: visible, size: encoded.byteLength, truncated }
  }
  const root = await ensureWorkspace(context, conversationId)
  const result = await context.sandbox.files.read(`${root}/${path}`)
  const content = typeof result === 'string'
    ? result
    : result instanceof Uint8Array
      ? new TextDecoder().decode(result)
      : result instanceof ArrayBuffer
        ? new TextDecoder().decode(new Uint8Array(result))
        : typeof result?.content === 'string'
          ? result.content
          : ''
  const encoded = new TextEncoder().encode(content)
  const truncated = encoded.byteLength > TEXT_PREVIEW_LIMIT
  const visible = truncated
    ? new TextDecoder().decode(encoded.slice(0, TEXT_PREVIEW_LIMIT))
    : content
  return { path, content: visible, size: encoded.byteLength, truncated }
}

function contentTypeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return CONTENT_TYPES[ext] || 'application/octet-stream'
}

function bytesFromUnknown(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value && typeof value === 'object' && 'content' in value) {
    return bytesFromUnknown((value as { content?: unknown }).content)
  }
  return new Uint8Array()
}

const BROWSER_HIDDEN = new Set(['.agent-teams', '.dsh'])

export function matchSandboxFileReferences(
  items: WorkspaceItem[],
  query: string,
): Array<{ path: string; kind: 'file' | 'directory' }> {
  const needle = query.replaceAll('\\', '/')
  const slash = needle.lastIndexOf('/')
  const dir = slash >= 0 ? needle.slice(0, slash) : ''
  const prefix = (slash >= 0 ? needle.slice(slash + 1) : needle).toLowerCase()
  return items
    .filter(item => {
      const parent = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : ''
      const name = item.path.slice(item.path.lastIndexOf('/') + 1)
      return parent === dir && name.toLowerCase().startsWith(prefix)
    })
    .map(item => ({
      path: item.path,
      kind: item.type === 'directory' ? 'directory' as const : 'file' as const,
    }))
}

export async function listSandboxBrowserFiles(
  context: any,
  conversationId: string,
): Promise<WorkspaceItem[]> {
  await mkdir(sidecarWorkspaceRoot(conversationId), { recursive: true })
  await hydrateSidecarWorkspace(context, conversationId)
  return (await listWorkspaceFromDisk(conversationId))
    .filter(item => !item.path.split('/').some(part => BROWSER_HIDDEN.has(part)))
}

export async function readSandboxBrowserFile(
  context: any,
  conversationId: string,
  requestedPath: string,
): Promise<{ path: string; bytes: Uint8Array; contentType: string }> {
  const path = normalizeWorkspacePath(requestedPath)
  if (!path) throw new Error('Invalid workspace file path.')
  await mkdir(sidecarWorkspaceRoot(conversationId), { recursive: true })
  await hydrateSidecarWorkspace(context, conversationId)
  try {
    const buffer = await readFile(diskFilePath(conversationId, path))
    if (buffer.byteLength > DOWNLOAD_BYTE_LIMIT) {
      throw new Error('File is larger than 20MB.')
    }
    return { path, bytes: new Uint8Array(buffer), contentType: contentTypeFor(path) }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : ''
    if (code !== 'ENOENT' || usesDiskWorkspace(context) || !context?.sandbox?.files?.read) {
      throw error instanceof Error ? error : new Error('Failed to read sandbox file.')
    }
  }
  const root = await ensureWorkspace(context, conversationId)
  const result = await context.sandbox.files.read(`${root}/${path}`)
  const bytes = bytesFromUnknown(result)
  if (bytes.byteLength > DOWNLOAD_BYTE_LIMIT) throw new Error('File is larger than 20MB.')
  return { path, bytes, contentType: contentTypeFor(path) }
}

export async function writeWorkspaceFile(
  context: any,
  conversationId: string,
  requestedPath: string,
  content: string,
): Promise<{ path: string; bytes: number }> {
  const path = normalizeWorkspacePath(requestedPath)
  if (!path) throw new Error('Invalid workspace file path.')
  if (isOfficeDocumentPath(path)) {
    throw new Error('DOCX/XLSX/PPTX are binary Office files. Use workspace_write_docx, workspace_write_xlsx, or workspace_write_pptx instead of workspace_write_file.')
  }
  if (usesDiskWorkspace(context)) {
    await ensureWorkspace(context, conversationId)
    await mirrorFileToSidecar(conversationId, path, content)
    await saveWorkspaceSnapshotFile(context, conversationId, path, content)
    return { path, bytes: new TextEncoder().encode(content).byteLength }
  }
  const root = await ensureWorkspace(context, conversationId)
  const parent = path.split('/').slice(0, -1).join('/')
  if (parent) await context.sandbox.files.makeDir(`${root}/${parent}`)
  await context.sandbox.files.write(`${root}/${path}`, content)
  await saveWorkspaceSnapshotFile(context, conversationId, path, content)
  try {
    await mirrorFileToSidecar(conversationId, path, content)
  } catch (error) {
    console.warn('[workspace] sidecar mirror failed:', error)
  }
  return { path, bytes: new TextEncoder().encode(content).byteLength }
}

export async function writeWorkspaceBytes(
  context: any,
  conversationId: string,
  requestedPath: string,
  bytes: Uint8Array,
): Promise<{ path: string; bytes: number }> {
  const path = normalizeWorkspacePath(requestedPath)
  if (!path) throw new Error('Invalid workspace file path.')
  await ensureWorkspace(context, conversationId)
  const dest = diskFilePath(conversationId, path)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, Buffer.from(bytes))
  return { path, bytes: bytes.byteLength }
}

export async function runWorkspaceCommand(
  context: any,
  conversationId: string,
  command: string,
  timeout = 120,
): Promise<{ command: string; stdout: string; stderr: string; exitCode: number }> {
  if (!command.trim()) throw new Error('Command must not be empty.')
  if (usesDiskWorkspace(context)) {
    await ensureWorkspace(context, conversationId)
    return runDiskCommand(
      command,
      sidecarWorkspaceRoot(conversationId),
      Math.min(Math.max(Math.round(timeout), 1), 300),
    )
  }
  const root = await ensureWorkspace(context, conversationId)
  const result = await context.sandbox.commands.run(command, {
    cwd: root,
    timeout: Math.min(Math.max(Math.round(timeout), 1), 300),
  })
  return {
    command,
    stdout: String(result.stdout || '').slice(-20_000),
    stderr: String(result.stderr || '').slice(-20_000),
    exitCode: Number(result.exitCode),
  }
}

function normalizePublicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const trimmed = value.trim()
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function appendAccessToken(url: string, token: string): string {
  const parsed = new URL(url)
  parsed.pathname = '/preview/'
  parsed.search = ''
  parsed.searchParams.set('access_token', token)
  return parsed.toString()
}

export async function publishWorkspacePreview(
  context: any,
  conversationId: string,
): Promise<{ previewUrl: string; framework: string }> {
  if (usesDiskWorkspace(context)) {
    await ensureWorkspace(context, conversationId)
    const items = await listWorkspace(context, conversationId)
    const files = items.filter(item => item.type === 'file' && /\.html?$/i.test(item.path))
    const preferred = files.find(item => /(?:^|\/)(?:index|resume|preview)\.html?$/i.test(item.path)) ?? files[0]
    if (!preferred) {
      throw new Error('Local preview needs an HTML file in the sandbox. Write one first, or download it from 沙箱文件.')
    }
    return {
      previewUrl: `/api/sandbox/file?path=${encodeURIComponent(preferred.path)}`,
      framework: 'static',
    }
  }
  const root = await ensureWorkspace(context, conversationId)
  const packageJsonExists = await context.sandbox.files.exists(`${root}/package.json`)
  const release = [
    'if command -v fuser >/dev/null 2>&1; then fuser -k 3000/tcp 2>/dev/null || true;',
    'elif command -v lsof >/dev/null 2>&1; then lsof -ti tcp:3000 | xargs -r kill -9 2>/dev/null || true; fi;',
    'sleep 1',
  ].join(' ')
  await context.sandbox.commands.run(release, { timeout: 10 })

  let framework = 'static'
  let command = "ln -sfn . preview; : > /tmp/dsh-preview.log; nohup python3 -m http.server 3000 --bind 0.0.0.0 >> /tmp/dsh-preview.log 2>&1 &"
  if (packageJsonExists) {
    const scripts = await context.sandbox.commands.run(
      "node -e \"const p=require('./package.json'); console.log(JSON.stringify(p.scripts||{}))\"",
      { cwd: root, timeout: 10 },
    )
    let parsed: Record<string, string> = {}
    try { parsed = JSON.parse(String(scripts.stdout || '{}')) } catch { parsed = {} }
    if (parsed.dev) {
      framework = 'node-dev'
      const host = normalizePublicUrl(context.sandbox.getHost(9000))
      const allowedHost = host ? new URL(host).hostname : ''
      command = [
        ': > /tmp/dsh-preview.log;',
        `nohup env PORT=3000 EDGEONE_PREVIEW_BASE_PATH=/preview __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${shellQuote(allowedHost)}`,
        'npm run dev -- --host 0.0.0.0 --port 3000 >> /tmp/dsh-preview.log 2>&1 &',
      ].join(' ')
    } else if (parsed.start) {
      framework = 'node-start'
      command = ': > /tmp/dsh-preview.log; nohup env PORT=3000 npm run start >> /tmp/dsh-preview.log 2>&1 &'
    }
  }

  const started = await context.sandbox.commands.run(command, { cwd: root, timeout: 15 })
  if (started.exitCode !== 0) {
    throw new Error(started.stderr || started.stdout || 'Failed to start preview server.')
  }
  const ready = await context.sandbox.commands.run(
    "for i in $(seq 1 30); do curl -fsS http://127.0.0.1:3000/preview/ >/dev/null 2>&1 && exit 0; curl -fsS http://127.0.0.1:3000/ >/dev/null 2>&1 && exit 0; sleep 1; done; tail -80 /tmp/dsh-preview.log; exit 1",
    { timeout: 40 },
  )
  if (ready.exitCode !== 0) {
    throw new Error(ready.stdout || ready.stderr || 'Preview server did not become ready.')
  }

  const host = normalizePublicUrl(context.sandbox.getHost(9000))
  const token = String(context.sandbox.envdAccessToken || '')
  if (!host || !token) throw new Error('Sandbox preview credentials are unavailable.')
  const previewUrl = appendAccessToken(host, token)
  try {
    await updateConversationMetadata(context, conversationId, {
      preview: { published: true, framework, updatedAt: Date.now() },
    })
  } catch (error) {
    console.warn('[workspace] preview metadata persistence failed:', error)
  }
  return { previewUrl, framework }
}

export async function currentPreview(
  context: any,
  conversationId: string,
): Promise<{ previewUrl?: string; published: boolean }> {
  try {
    const conversation = await getConversation(context, conversationId)
    const published = conversation?.metadata?.preview?.published === true
    if (!published) return { published: false }
    try {
      const host = normalizePublicUrl(context.sandbox.getHost(9000))
      const token = String(context.sandbox.envdAccessToken || '')
      return { published: true, ...(host && token ? { previewUrl: appendAccessToken(host, token) } : {}) }
    } catch {
      return { published: true }
    }
  } catch {
    return { published: false }
  }
}
