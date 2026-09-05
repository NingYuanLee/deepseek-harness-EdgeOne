import { spawn, type ChildProcess } from 'node:child_process'
import { open, cp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startLocalGatewayProxy, type LocalGatewayProxy } from './_gateway-proxy.ts'
import { makersMcpPermissionSource } from './_makers-mcp-permission.mjs'
import { startLocalMcpBridge, type LocalMcpBridge } from './_mcp-bridge.ts'
import { hydrateSidecarWorkspace } from './_workspace.ts'

const require = createRequire(import.meta.url)

export interface DshWebSidecar {
  conversationId: string
  home: string
  port: number
  cookie: string
  child: ChildProcess
  gateway: LocalGatewayProxy
  mcp: LocalMcpBridge
  lastUsedAt: number
  context: any
  owner: boolean
  workspace?: SidecarWorkspace
  close(): Promise<void>
}

interface SidecarWorkspace {
  workspaceId: string
  path: string
  title: string
}

interface SidecarRuntime {
  port: number
  cookie: string
  pid: number
  workspaceId?: string
  workspacePath: string
  workspaceTitle: string
}

const sidecars = new Map<string, Promise<DshWebSidecar>>()
const SIDECAR_IDLE_MS = 25 * 60_000
const SIDECAR_RUNTIME_FILE = 'sidecar-runtime.json'
const SIDECAR_LOCK_FILE = 'sidecar.lock'
const DSH_SETTINGS_FILE = 'settings.yaml'
const DSH_SETTINGS_METADATA_KEY = 'dshSettingsYaml'
const DSH_SETTINGS_MAX_BYTES = 256 * 1024

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'default'
}

export function dshHomeFor(conversationId: string): string {
  return join(tmpdir(), 'dsh-makers-web', safeSegment(conversationId))
}

function requestHost(context: any): string {
  const headers = context?.request?.headers
  if (!headers || typeof headers !== 'object') return ''
  return String(headers.host || headers.Host || '')
}

function sandboxWorkspaceTitle(context: any): string {
  return requestHost(context).endsWith('.edgeone.dev') ? 'EdgeOne Sandbox' : 'EdgeOne 沙箱'
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
    content: 'dsh-settings',
    metadata: { kind: 'dsh-settings-bootstrap' },
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

export async function restoreDshSettingsYaml(
  context: any,
  conversationId: string,
  home: string,
): Promise<boolean> {
  if (!context?.store) return false
  try {
    const conversation = await getConversation(context, conversationId)
    const yaml = conversation?.metadata?.[DSH_SETTINGS_METADATA_KEY]
    if (typeof yaml !== 'string' || !yaml.trim()) return false
    if (new TextEncoder().encode(yaml).byteLength > DSH_SETTINGS_MAX_BYTES) return false
    await mkdir(home, { recursive: true })
    await writeFile(join(home, DSH_SETTINGS_FILE), yaml)
    return true
  } catch {
    return false
  }
}

export async function snapshotDshSettingsYaml(
  context: any,
  conversationId: string,
  home: string,
): Promise<boolean> {
  if (!context?.store) return false
  try {
    const yaml = await readFile(join(home, DSH_SETTINGS_FILE), 'utf8')
    if (!yaml.trim()) return false
    if (new TextEncoder().encode(yaml).byteLength > DSH_SETTINGS_MAX_BYTES) return false
    await updateConversationMetadata(context, conversationId, { [DSH_SETTINGS_METADATA_KEY]: yaml })
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : ''
    if (code === 'ENOENT') return false
    console.warn('[dsh-web] settings snapshot failed:', error)
    return false
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = address && typeof address !== 'string' ? address.port : 0
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (!port) throw new Error('Could not allocate a DSH Web sidecar port.')
  return port
}

/** Official DeepSeek adapter. 0.1.2-rc.1 `llm-deepseek` includes vision. */
const OFFICIAL_PROVIDER = 'deepseek-official'
const MAKERS_GATEWAY_API_KEY_ENV = 'MAKERS_GATEWAY_API_KEY'
const DEFAULT_OFFICIAL_MODEL = 'deepseek-v4-flash-vision-exp'
const DEFAULT_OFFICIAL_BASE_URL = 'https://api.deepseek.com'

function envString(context: any, key: string): string {
  const value = context?.env?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

function officialDefaultModelSection(defaultModel: string): string {
  return [
    'agent-default-model:',
    `  provider: ${OFFICIAL_PROVIDER}`,
    `  model: ${JSON.stringify(defaultModel)}`,
    '',
  ].join('\n')
}

function officialDeepSeekSection(): string {
  return [
    'llm-deepseek:',
    '  apiKeyEnv: DEEPSEEK_API_KEY',
    `  baseURL: ${JSON.stringify(DEFAULT_OFFICIAL_BASE_URL)}`,
    '',
  ].join('\n')
}

function upsertYamlSection(yaml: string, name: string, section: string): string {
  const re = new RegExp(`^${name}:\\n(?:[ \\t]+.*\\n)*`, 'm')
  if (!yaml.trim()) return section
  return re.test(yaml)
    ? yaml.replace(re, section)
    : `${yaml.replace(/\s*$/, '')}\n\n${section}`
}

function hasOfficialDeepSeekAdapter(yaml: string): boolean {
  const block = yaml.match(/^llm-deepseek:\n((?:[ \t]+.*\n)*)/m)?.[1] ?? ''
  return block.includes('apiKeyEnv: DEEPSEEK_API_KEY')
}

function officialDefaultModel(context: any): string {
  const fromEnv = envString(context, 'DEEPSEEK_MODEL') || envString(context, 'AI_GATEWAY_MODEL')
  if (fromEnv && !fromEnv.startsWith('@makers/')) return fromEnv
  return DEFAULT_OFFICIAL_MODEL
}

function settingsFieldOf(yaml: string, namespace: string, key: string): string | undefined {
  const block = yaml.match(new RegExp(`^${namespace}:\\n((?:[ \\t]+.*\\n)*)`, 'm'))?.[1] ?? ''
  const value = block.match(new RegExp(`^[ \\t]+${key}:\\s*(.*)$`, 'm'))?.[1]?.trim()
  if (!value) return undefined
  const quoted = value.match(/^(['"])(.*)\1$/)
  return quoted ? quoted[2] : value
}

function settingsProviderOf(yaml: string, namespace: string): string | undefined {
  return settingsFieldOf(yaml, namespace, 'provider')
}

async function linkSidecarPackage(home: string, name: string): Promise<void> {
  const source = dirname(require.resolve(`${name}/package.json`))
  const dest = join(home, 'profiles', 'web', 'node_modules', ...name.split('/'))
  await mkdir(dirname(dest), { recursive: true })
  await rm(dest, { recursive: true, force: true })
  try {
    await symlink(source, dest, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    await cp(source, dest, { recursive: true })
  }
}

/** Seed or migrate the Host default to official DeepSeek vision (text + image). */
export async function ensureOfficialDefaultModelSettings(home: string, defaultModel: string): Promise<void> {
  const path = join(home, DSH_SETTINGS_FILE)
  let yaml = ''
  try {
    yaml = await readFile(path, 'utf8')
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : ''
    if (code !== 'ENOENT') throw error
  }
  const modelReady = settingsProviderOf(yaml, 'agent-default-model') === OFFICIAL_PROVIDER
    && settingsFieldOf(yaml, 'agent-default-model', 'model') === defaultModel
  const adapterReady = hasOfficialDeepSeekAdapter(yaml)
  if (modelReady && adapterReady) return
  let next = yaml
  if (!modelReady) next = upsertYamlSection(next, 'agent-default-model', officialDefaultModelSection(defaultModel))
  if (!adapterReady) next = upsertYamlSection(next, 'llm-deepseek', officialDeepSeekSection())
  await mkdir(home, { recursive: true })
  await writeFile(path, next)
}

async function writeProfilePatch(
  home: string,
  options: { mcpUrl: string; gatewayBaseUrl: string; defaultModel: string },
): Promise<void> {
  await mkdir(join(home, 'profiles', 'web'), { recursive: true })
  const presetRoot = join(home, '.agent-presets', 'makers')
  await mkdir(presetRoot, { recursive: true })
  await writeFile(join(presetRoot, 'preset.yml'), [
    'name: Makers 模式',
    'description: 使用 EdgeOne Makers MCP 工具、Sandbox 与 AI Gateway 的 DSH Agent。',
    'order: 1',
    '',
  ].join('\n'))
  await writeFile(
    join(presetRoot, 'makers-mcp-permission.mjs'),
    makersMcpPermissionSource(),
  )
  await writeFile(join(presetRoot, 'agent.cordis.yml'), [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    text: >-',
    '      You are a coding agent running on EdgeOne Makers. Use the mcp__edgeone__ tools for all file, command, and preview work. Never use local host filesystem or shell tools. Every Makers tool stays available. Permission modes only decide whether a call runs immediately or asks the user: Read Only auto-allows list and read; Workspace Write also auto-allows writes, Office documents, and sandbox commands; Full access auto-allows preview. If a tool needs a wider mode, call it normally — the user will be asked to approve. Inspect the workspace before editing, verify changes, and publish a preview when the project supports one. To create Word, Excel, or PowerPoint files, call workspace_write_docx, workspace_write_xlsx, or workspace_write_pptx. Never write .docx, .xlsx, or .pptx with workspace_write_file or as HTML, Markdown, or UTF-8 text — Microsoft Office cannot open those.',
    '',
    '- id: makers-mcp-permission',
    '  name: ./makers-mcp-permission.mjs',
    '',
    '- id: tool-todo',
    "  name: '@deepseek-ai/dsh-tool-todo'",
    '  config:',
    '    allowParallelInProgress: false',
    '',
  ].join('\n'))
  await writeFile(join(home, 'cordis.patch.yml'), [
    '- id: agent-presets',
    '  config:',
    '    default: makers',
    '    includeUserRoot: true',
    '',
    '- id: permission',
    '  config:',
    '    defaultPreset: workspace-write',
    '    presets:',
    '      read-only:',
    '        sandbox: read-only',
    '        approval: ask',
    '        name: read-only',
        '        description: Inspect the EdgeOne Makers sandbox. Writes, commands, and preview ask for confirmation.',
        '      workspace-write:',
        '        sandbox: workspace-write',
        '        approval: ask',
        '        name: workspace-write',
        '        description: Read, write, and run commands in the EdgeOne Makers sandbox. Preview asks for confirmation.',
    '      danger-full-access:',
    '        sandbox: danger-full-access',
    '        approval: never',
    '        name: danger-full-access',
    '        description: Full Makers sandbox access including commands and preview. The local machine is never accessible.',
    '',
    '- id: agent-default-model',
    '  config:',
    `    provider: ${OFFICIAL_PROVIDER}`,
    `    model: ${JSON.stringify(options.defaultModel)}`,
    '',
    '- id: llm-deepseek',
    '  config:',
    '    apiKeyEnv: DEEPSEEK_API_KEY',
    `    baseURL: ${JSON.stringify(DEFAULT_OFFICIAL_BASE_URL)}`,
    '',
    '- insert:',
    '    - id: agent-teams',
    "      name: '@nanmicoder/dsh-agent-teams'",
    '      config:',
    '        stateDir: .agent-teams',
    '        memberProvider: fork',
    `        memberModel: ${JSON.stringify(options.defaultModel)}`,
    '',
    '    - id: makers-mcp',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        transport: streamable-http',
    '        serverName: edgeone',
    `        url: ${JSON.stringify(options.mcpUrl)}`,
    '        headers: {}',
    '        toolCallTimeoutMs: 300000',
    '        failOnStartupError: true',
    '        reconnect:',
    '          enabled: true',
    '          initialDelayMs: 500',
    '          maxDelayMs: 5000',
    '          maxAttempts: 20',
    '',
  ].join('\n'))
}

function sidecarHeaders(port: number, cookie?: string): Record<string, string> {
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    ...(cookie ? { cookie } : {}),
  }
}

function launchTokenFromOutput(output: string): string | undefined {
  return output.match(/[?&]token=([A-Za-z0-9_-]+)/)?.[1]
}

function cookieFromSetCookie(header: string | null): string | undefined {
  if (!header) return undefined
  const pair = header.split(';', 1)[0]?.trim()
  return pair && pair.includes('=') ? pair : undefined
}

async function exchangeLaunchToken(port: number, token: string): Promise<string | undefined> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(2_000),
  })
  return cookieFromSetCookie(response.headers.get('set-cookie'))
}

async function callRpc(port: number, cookie: string, method: string, payload: Record<string, unknown>): Promise<unknown> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    let response: Response
    try {
      const endpoint = method.replaceAll('.', '/')
      response = await fetch(`http://127.0.0.1:${String(port)}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...sidecarHeaders(port, cookie) },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method: endpoint,
          payload: { args: payload },
        }),
      })
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 250))
      continue
    }
    if (response.ok) {
      const result = await response.json() as { result?: { ok?: boolean; value?: unknown; error?: { message?: string } } }
      if (result.result?.ok === true) return result.result.value
      throw new Error(result.result?.error?.message || `DSH sidecar ${method} failed`)
    }
    lastError = new Error(`DSH sidecar ${method} failed with HTTP ${String(response.status)}`)
    if (![404, 502, 503].includes(response.status)) throw lastError
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw lastError instanceof Error ? lastError : new Error(`DSH sidecar ${method} did not become ready`)
}

function extractWorkspaceId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const nested = record.workspace && typeof record.workspace === 'object'
    ? record.workspace as Record<string, unknown>
    : undefined
  const id = record.workspaceId ?? nested?.workspaceId ?? record.id ?? nested?.id
  return typeof id === 'string' && id ? id : undefined
}

function runtimePath(home: string): string {
  return join(home, SIDECAR_RUNTIME_FILE)
}

function lockPath(home: string): string {
  return join(home, SIDECAR_LOCK_FILE)
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function sidecarHealthy(port: number, cookie: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
      headers: sidecarHeaders(port, cookie),
      redirect: 'manual',
      signal: AbortSignal.timeout(2_000),
    })
    return response.status < 500
  } catch {
    return false
  }
}

async function readSidecarRuntime(home: string): Promise<SidecarRuntime | undefined> {
  try {
    const parsed = JSON.parse(await readFile(runtimePath(home), 'utf8')) as SidecarRuntime
    if (!Number.isInteger(parsed.port) || typeof parsed.cookie !== 'string' || !parsed.cookie) return undefined
    return parsed
  } catch {
    return undefined
  }
}

async function writeSidecarRuntime(home: string, runtime: SidecarRuntime): Promise<void> {
  await writeFile(runtimePath(home), `${JSON.stringify(runtime, null, 2)}\n`, 'utf8')
}

async function clearSidecarRuntime(home: string): Promise<void> {
  await rm(runtimePath(home), { force: true })
}

function workspaceFromRuntime(runtime: SidecarRuntime): SidecarWorkspace | undefined {
  if (!runtime.workspaceId) return undefined
  return {
    workspaceId: runtime.workspaceId,
    path: runtime.workspacePath,
    title: runtime.workspaceTitle,
  }
}

function attachedChild(): ChildProcess {
  return {
    exitCode: null,
    killed: false,
    kill() {},
    once() { return this },
  } as unknown as ChildProcess
}

async function sidecarMcpUrl(home: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(home, 'cordis.patch.yml'), 'utf8')
    return text.match(/url:\s*"([^"]+\/mcp)"/)?.[1]
  } catch {
    return undefined
  }
}

async function sidecarMcpHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(1_500),
    })
    return response.status > 0 && response.status < 500
  } catch {
    return false
  }
}

async function discardStaleSidecar(home: string, pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // The leftover sidecar may already have exited.
  }
  await clearSidecarRuntime(home)
}

async function attachExistingSidecar(
  context: any,
  conversationId: string,
  home: string,
): Promise<DshWebSidecar | undefined> {
  const runtime = await readSidecarRuntime(home)
  if (!runtime || !pidAlive(runtime.pid)) return undefined
  if (!await sidecarHealthy(runtime.port, runtime.cookie)) {
    await discardStaleSidecar(home, runtime.pid)
    return undefined
  }
  const mcpUrl = await sidecarMcpUrl(home)
  if (!mcpUrl || !await sidecarMcpHealthy(mcpUrl)) {
    await discardStaleSidecar(home, runtime.pid)
    return undefined
  }
  const workspace = workspaceFromRuntime(runtime)
  const sidecar: DshWebSidecar = {
    conversationId,
    home,
    port: runtime.port,
    cookie: runtime.cookie,
    child: attachedChild(),
    gateway: { close: async () => {} } as LocalGatewayProxy,
    mcp: { close: async () => {} } as LocalMcpBridge,
    lastUsedAt: Date.now(),
    context,
    owner: false,
    workspace,
    async close() {},
  }
  return sidecar
}

async function sidecarUsable(sidecar: DshWebSidecar): Promise<boolean> {
  if (sidecar.owner && sidecar.child.exitCode !== null) return false
  if (sidecar.owner) return true
  return sidecarHealthy(sidecar.port, sidecar.cookie)
}

async function adoptSandboxWorkspace(
  port: number,
  cookie: string,
  workspacePath: string,
  title: string,
): Promise<SidecarWorkspace | undefined> {
  let workspaceId: string | undefined
  for (let attempt = 0; attempt < 2 && !workspaceId; attempt += 1) {
    try {
      const created = await callRpc(port, cookie, 'workspace.create', { request: { path: workspacePath } })
      workspaceId = extractWorkspaceId(created)
    } catch (error) {
      console.warn('[dsh-web] workspace.create skipped:', error)
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  if (workspaceId) {
    try {
      await callRpc(port, cookie, 'workspace.rename', { request: { workspaceId, title } })
    } catch (error) {
      console.warn('[dsh-web] workspace.rename skipped:', error)
    }
    try {
      await callRpc(port, cookie, 'session.create', { request: { workspaceId } })
      return { workspaceId, path: workspacePath, title }
    } catch (error) {
      console.warn('[dsh-web] session.create with workspaceId skipped:', error)
    }
    return { workspaceId, path: workspacePath, title }
  }
  await callRpc(port, cookie, 'session.create', { request: { cwd: workspacePath } })
  return undefined
}

async function waitForReady(child: ChildProcess, port: number): Promise<string> {
  const deadline = Date.now() + 60_000
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', chunk => { stdout = `${stdout}${String(chunk)}`.slice(-8_000) })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-8_000) })
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`DSH Web sidecar exited with ${String(child.exitCode)}: ${stderr || stdout}`)
    }
    const token = launchTokenFromOutput(stdout)
    if (token) {
      try {
        const cookie = await exchangeLaunchToken(port, token)
        if (cookie) return cookie
      } catch {
        // The token line can print before the listener accepts connections.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  child.kill('SIGTERM')
  throw new Error(`DSH Web sidecar did not become ready: ${stderr || stdout}`)
}

async function startSidecar(context: any, conversationId: string): Promise<DshWebSidecar> {
  const [port, gateway, mcp] = await Promise.all([
    freePort(),
    startLocalGatewayProxy(context, conversationId),
    startLocalMcpBridge(context, conversationId),
  ])
  const home = dshHomeFor(conversationId)
  const defaultModel = officialDefaultModel(context)
  const deepseekApiKey = envString(context, 'DEEPSEEK_API_KEY')
  const deepseekBaseUrl = envString(context, 'DEEPSEEK_BASE_URL') || DEFAULT_OFFICIAL_BASE_URL
  await mkdir(home, { recursive: true })
  await restoreDshSettingsYaml(context, conversationId, home)
  await ensureOfficialDefaultModelSettings(home, defaultModel)
  await writeProfilePatch(home, {
    mcpUrl: mcp.url,
    gatewayBaseUrl: gateway.baseUrl,
    defaultModel,
  })
  await linkSidecarPackage(home, '@nanmicoder/dsh-agent-teams')

  const dshBin = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
  const child = spawn(process.execPath, [
    '--expose-internals',
    dshBin,
    'web',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--no-open',
  ], {
    cwd: home,
    env: {
      PATH: typeof context.env?.PATH === 'string' ? context.env.PATH : (process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'),
      HOME: home,
      DSH_HOME: home,
      DSH_CWD: home,
      NODE_PATH: [
        join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), '..', '..'),
        typeof context.env?.NODE_PATH === 'string' ? context.env.NODE_PATH : '',
        process.env.NODE_PATH || '',
      ].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      [MAKERS_GATEWAY_API_KEY_ENV]: 'makers-proxy',
      ...(deepseekApiKey ? { DEEPSEEK_API_KEY: deepseekApiKey } : {}),
      DEEPSEEK_BASE_URL: deepseekBaseUrl,
      DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let cookie = ''
  let workspace: SidecarWorkspace | undefined
  const workspacePath = join(home, 'workspace')
  const workspaceTitle = sandboxWorkspaceTitle(context)
  try {
    cookie = await waitForReady(child, port)
    await mkdir(workspacePath, { recursive: true })
    await hydrateSidecarWorkspace(context, conversationId, workspacePath)
    workspace = await adoptSandboxWorkspace(port, cookie, workspacePath, workspaceTitle)
    await writeSidecarRuntime(home, {
      port,
      cookie,
      pid: child.pid || 0,
      workspaceId: workspace?.workspaceId,
      workspacePath,
      workspaceTitle,
    })
  } catch (error) {
    child.kill('SIGTERM')
    await clearSidecarRuntime(home)
    await Promise.allSettled([gateway.close(), mcp.close()])
    throw error
  }

  const sidecar: DshWebSidecar = {
    conversationId,
    home,
    port,
    cookie,
    child,
    gateway,
    mcp,
    lastUsedAt: Date.now(),
    context,
    owner: true,
    workspace,
    async close() {
      await snapshotDshSettingsYaml(sidecar.context, conversationId, home)
      await clearSidecarRuntime(home)
      child.kill('SIGTERM')
      await Promise.race([
        new Promise<void>(resolve => child.once('exit', () => resolve())),
        new Promise<void>(resolve => setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3_000)),
      ])
      await Promise.allSettled([gateway.close(), mcp.close()])
    },
  }
  child.once('exit', () => {
    void clearSidecarRuntime(home)
    const current = sidecars.get(conversationId)
    if (current) void current.then(value => { if (value === sidecar) sidecars.delete(conversationId) })
  })
  return sidecar
}

async function clearStaleLock(home: string): Promise<void> {
  try {
    const info = await stat(lockPath(home))
    if (Date.now() - info.mtimeMs > 120_000) await rm(lockPath(home), { force: true })
  } catch {
    // No lock, or it disappeared while we inspected it.
  }
}

async function acquireSidecar(context: any, conversationId: string): Promise<DshWebSidecar> {
  const home = dshHomeFor(conversationId)
  await mkdir(home, { recursive: true })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const attached = await attachExistingSidecar(context, conversationId, home)
    if (attached) return attached
    await clearStaleLock(home)
    try {
      const handle = await open(lockPath(home), 'wx')
      try {
        const raced = await attachExistingSidecar(context, conversationId, home)
        if (raced) return raced
        return await startSidecar(context, conversationId)
      } finally {
        await handle.close().catch(() => {})
        await rm(lockPath(home), { force: true })
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : ''
      if (code !== 'EEXIST') throw error
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  throw new Error('DSH Web sidecar did not become ready: sidecar.lock timeout')
}

function sweepIdleSidecars(): void {
  const cutoff = Date.now() - SIDECAR_IDLE_MS
  for (const [conversationId, pending] of sidecars) {
    void pending.then(sidecar => {
      if (sidecar.lastUsedAt >= cutoff) return
      if (sidecars.get(conversationId) === pending) sidecars.delete(conversationId)
      void sidecar.close()
    }).catch(() => { sidecars.delete(conversationId) })
  }
}

export async function getDshWebSidecar(context: any): Promise<DshWebSidecar> {
  const conversationId = String(context.conversation_id || '').trim()
  if (!conversationId) throw new Error('makers-conversation-id is required for DSH Web.')
  sweepIdleSidecars()
  let pending = sidecars.get(conversationId)
  if (pending) {
    try {
      const sidecar = await pending
      if (await sidecarUsable(sidecar)) {
        sidecar.lastUsedAt = Date.now()
        sidecar.context = context
        return sidecar
      }
    } catch {
      // The cached start failed; fall through and acquire a new sidecar.
    }
    if (sidecars.get(conversationId) === pending) sidecars.delete(conversationId)
  }
  pending = acquireSidecar(context, conversationId)
  sidecars.set(conversationId, pending)
  void pending.catch(() => { if (sidecars.get(conversationId) === pending) sidecars.delete(conversationId) })
  const sidecar = await pending
  sidecar.lastUsedAt = Date.now()
  sidecar.context = context
  return sidecar
}

export async function stopDshWebSidecar(conversationId: string): Promise<boolean> {
  const pending = sidecars.get(conversationId)
  if (!pending) return false
  sidecars.delete(conversationId)
  const sidecar = await pending
  await sidecar.close()
  return true
}
