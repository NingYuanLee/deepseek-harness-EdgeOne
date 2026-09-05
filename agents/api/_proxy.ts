import { mkdir } from 'node:fs/promises'
import WebSocket from 'ws'
import { getDshWebSidecar, snapshotDshSettingsYaml, type DshWebSidecar } from '../_dsh-web-sidecar.ts'
import { deleteSandboxBrowserPath, listSandboxBrowserFiles, matchSandboxFileReferences, readSandboxBrowserFile, sidecarWorkspaceRoot, uploadSandboxBrowserFile } from '../_workspace.ts'

function requestPath(context: any): string {
  const value = typeof context.request?.url === 'string' ? context.request.url : '/api'
  try { return new URL(value, 'http://local').pathname } catch { return '/api' }
}

function officialSidecarPath(path: string): string {
  const match = path.match(/^\/api\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)$/)
  if (!match) return path
  const [, ns, method] = match
  if (ns === 'remote' || ns === 'events' || ns === 'sidebar') return path
  return `/api/${ns}/${method}`
}

function pathAliases(...paths: string[]): Set<string> {
  const aliases = new Set<string>()
  for (const path of paths) {
    aliases.add(path)
    aliases.add(officialSidecarPath(path))
  }
  return aliases
}

function queryValue(context: any, incomingUrl: URL, key: string): string {
  const fromUrl = incomingUrl.searchParams.get(key)
  if (fromUrl) return fromUrl
  const query = context.request?.query
  if (!query || typeof query !== 'object' || Array.isArray(query)) return ''
  const value = (query as Record<string, unknown>)[key]
  if (Array.isArray(value)) return String(value[0] ?? '')
  return value === undefined || value === null ? '' : String(value)
}

function requestSearch(context: any, incomingUrl: URL): string {
  if (incomingUrl.search) return incomingUrl.search
  const query = context.request?.query
  if (!query || typeof query !== 'object' || Array.isArray(query)) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item))
    } else {
      params.set(key, String(value))
    }
  }
  const encoded = params.toString()
  return encoded ? `?${encoded}` : ''
}

function asStreamBody(context: any): Record<string, unknown> | undefined {
  return asRecord(context.request?.body)
}

function sseHeaders(): HeadersInit {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  }
}

function startSseKeepalive(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): () => void {
  try {
    controller.enqueue(encoder.encode(': connected\n\n'))
  } catch {
    // The browser already disconnected.
  }
  const timer = setInterval(() => {
    try {
      controller.enqueue(encoder.encode(': keepalive\n\n'))
    } catch {
      // The browser already disconnected.
    }
  }, 2_000)
  return () => clearInterval(timer)
}

function remoteMuxStream(context: any): Response {
  const encoder = new TextEncoder()
  let socket: WebSocket | undefined
  const signal = context.request?.signal as AbortSignal | undefined
  const body = asStreamBody(context) ?? {}
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : ''
  const payload = body.payload
  if (!endpoint) {
    return new Response(JSON.stringify({ error: 'remote.mux requires endpoint' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const stopKeepalive = startSseKeepalive(controller, encoder)
      const streamError = (error: unknown): void => {
        stopKeepalive()
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'error',
            streamId: 'makers',
            error: {
              code: 'internal',
              message: error instanceof Error ? error.message : String(error),
              details: {},
            },
          })}\n\n`))
        } catch {
          // The browser already disconnected.
        }
        try { controller.close() } catch { /* already cancelled */ }
      }
      try {
        const sidecar = await getDshWebSidecar(context)
        const streamId = crypto.randomUUID()
        socket = new WebSocket(`ws://127.0.0.1:${String(sidecar.port)}/api/remote.mux`, {
          headers: {
            origin: `http://127.0.0.1:${String(sidecar.port)}`,
            cookie: sidecar.cookie,
          },
        })
        const close = (): void => {
          if (socket?.readyState === WebSocket.OPEN) {
            try { socket.send(JSON.stringify({ type: 'cancel', streamId })) } catch { /* closing */ }
          }
          if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) socket.close()
        }
        signal?.addEventListener('abort', close, { once: true })
        socket.once('open', () => {
          try {
            socket?.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }))
          } catch {
            close()
          }
        })
        socket.on('message', data => {
          try {
            const text = data.toString()
            const frame = JSON.parse(text) as { streamId?: string; type?: string }
            if (frame.streamId !== undefined && frame.streamId !== streamId) return
            controller.enqueue(encoder.encode(`data: ${text}\n\n`))
            if (frame.type === 'end' || frame.type === 'error') close()
          } catch {
            close()
          }
        })
        socket.once('error', streamError)
        socket.once('close', () => {
          stopKeepalive()
          signal?.removeEventListener('abort', close)
          try { controller.close() } catch { /* already cancelled */ }
        })
      } catch (error) {
        streamError(error)
      }
    },
    cancel() {
      if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) socket.close()
    },
  })
  return new Response(stream, { headers: sseHeaders() })
}

function eventStream(context: any, kind: 'mux' | 'host'): Response {
  const encoder = new TextEncoder()
  let socket: WebSocket | undefined
  const signal = context.request?.signal as AbortSignal | undefined
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const stopKeepalive = startSseKeepalive(controller, encoder)
      const finishError = (error: unknown): void => {
        stopKeepalive()
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'server-request',
            rpcId: crypto.randomUUID(),
            method: 'stream/error',
            payload: {
              type: 'stream/error',
              error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
            },
          })}\n\n`))
        } catch {
          // The browser already disconnected.
        }
        try { controller.close() } catch { /* already cancelled */ }
      }
      const aborted = (): boolean => Boolean(signal?.aborted)
      const closeSocket = (): void => {
        if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) socket.close()
      }
      signal?.addEventListener('abort', closeSocket, { once: true })
      let lastError: unknown
      for (let attempt = 0; attempt < 8 && !aborted(); attempt += 1) {
        lastError = undefined
        try {
          const sidecar = await getDshWebSidecar(context)
          const path = kind === 'mux' ? '/api/events.mux' : '/api/events.host'
          const connected = await new Promise<boolean>((resolve) => {
            let settled = false
            const done = (ok: boolean, error?: unknown): void => {
              if (settled) return
              settled = true
              if (error) lastError = error
              resolve(ok)
            }
            socket = new WebSocket(`ws://127.0.0.1:${String(sidecar.port)}${path}`, {
              headers: {
                origin: `http://127.0.0.1:${String(sidecar.port)}`,
                cookie: sidecar.cookie,
              },
            })
            socket.once('open', () => done(true))
            socket.on('message', data => {
              try { controller.enqueue(encoder.encode(`data: ${data.toString()}\n\n`)) } catch { closeSocket() }
            })
            socket.once('error', error => done(false, error))
            socket.once('close', () => done(false, lastError || new Error('sidecar event stream closed')))
          })
          if (connected && socket) {
            await new Promise<void>((resolve) => {
              socket?.once('close', () => resolve())
              if (aborted() || socket?.readyState === WebSocket.CLOSED) resolve()
            })
            if (aborted()) break
            await new Promise(resolve => setTimeout(resolve, 250))
            continue
          }
        } catch (error) {
          lastError = error
        }
        if (aborted()) break
        await new Promise(resolve => setTimeout(resolve, Math.min(2_000, 250 * (attempt + 1))))
      }
      signal?.removeEventListener('abort', closeSocket)
      if (!aborted()) finishError(lastError || new Error('sidecar event stream closed'))
      else {
        stopKeepalive()
        try { controller.close() } catch { /* already cancelled */ }
      }
    },
    cancel() {
      if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) socket.close()
    },
  })
  return new Response(stream, { headers: sseHeaders() })
}

const LOCKED_BUILT_IN_PRESETS = new Set(['standard', 'code', 'minimal', 'cordis'])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function requestedLockedPreset(body: unknown): string | undefined {
  const envelope = asRecord(body)
  const method = typeof envelope?.method === 'string' ? envelope.method : ''
  const payload = asRecord(envelope?.payload) ?? {}
  if (method === 'agentPreset.select') {
    const id = String(payload.agentPreset || '')
    return LOCKED_BUILT_IN_PRESETS.has(id) ? id : undefined
  }
  if (payload.ns !== 'agent-presets') return undefined
  if (method === 'settings.update') {
    const id = String(asRecord(payload.patch)?.default || '')
    return LOCKED_BUILT_IN_PRESETS.has(id) ? id : undefined
  }
  if (method === 'settings.replace') {
    const id = String(asRecord(payload.section)?.default || '')
    return LOCKED_BUILT_IN_PRESETS.has(id) ? id : undefined
  }
  if (method === 'settings.mutate' && Array.isArray(payload.ops)) {
    for (const op of payload.ops) {
      const edit = asRecord(op)
      const path = Array.isArray(edit?.path) ? edit.path : []
      if (edit?.op === 'set' && path.length === 1 && path[0] === 'default') {
        const id = String(edit.value || '')
        if (LOCKED_BUILT_IN_PRESETS.has(id)) return id
      }
    }
  }
  return undefined
}

function rejectLockedPreset(rpcId: unknown, agentPreset: string): Response {
  return Response.json({
    type: 'server-response',
    rpcId: typeof rpcId === 'string' && rpcId.length > 0 ? rpcId : crypto.randomUUID(),
    result: {
      ok: false,
      error: {
        code: 'agent-preset-read-only',
        message: `Built-in agent preset "${agentPreset}" is not selectable on EdgeOne Makers.`,
        details: {
          agentPreset,
          reason: 'locked on EdgeOne Makers',
        },
      },
    },
  })
}

const LOCKED_MODEL_SETTINGS = new Set(['llm-deepseek', 'llm-pi-ai'])
const LOCKED_CREDENTIAL_PATHS = pathAliases(
  '/api/credentials.set',
  '/api/credentials.unset',
)

function rejectLockedModelConfig(rpcId: unknown, reason: string): Response {
  return Response.json({
    type: 'server-response',
    rpcId: typeof rpcId === 'string' && rpcId.length > 0 ? rpcId : crypto.randomUUID(),
    result: {
      ok: false,
      error: {
        code: 'model-config-read-only',
        message: 'Model providers and API keys are locked. Use DEEPSEEK_API_KEY from the environment.',
        details: { reason },
      },
    },
  })
}

async function proxyAgentTeams(context: any, path: string): Promise<Response> {
  const suffix = path.slice('/api/agent-teams/'.length)
  if (!['state', 'plan', 'halt'].includes(suffix)) {
    return Response.json({ error: 'unknown agent-teams route' }, { status: 404 })
  }
  const sidecar = await getDshWebSidecar(context)
  const incomingUrl = new URL(typeof context.request?.url === 'string' ? context.request.url : path, 'http://local')
  const query = incomingUrl.search || requestSearch(context, incomingUrl)
  const method = String(context.request?.method || 'GET').toUpperCase()
  const body = method === 'GET' || method === 'HEAD'
    ? undefined
    : JSON.stringify(context.request?.body ?? {})
  const upstream = await fetch(`http://127.0.0.1:${String(sidecar.port)}/plugins/dsh-agent-teams/${suffix}${query}`, {
    method,
    headers: {
      accept: context.request?.headers?.accept || '*/*',
      origin: `http://127.0.0.1:${String(sidecar.port)}`,
      cookie: sidecar.cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
    signal: context.request?.signal,
  })
  const headers = new Headers(upstream.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  headers.delete('transfer-encoding')
  return new Response(upstream.body, { status: upstream.status, headers })
}

async function pickSandboxDirectory(context: any): Promise<Response> {
  const conversationId = String(context.conversation_id || '').trim()
  if (!conversationId) {
    return Response.json({ error: 'makers-conversation-id is required for the sandbox workspace.' }, { status: 400 })
  }
  const path = sidecarWorkspaceRoot(conversationId)
  await mkdir(path, { recursive: true })
  const rpcId = asRecord(context.request?.body)?.rpcId
  return Response.json({
    type: 'server-response',
    rpcId: typeof rpcId === 'string' && rpcId.length > 0 ? rpcId : crypto.randomUUID(),
    result: {
      ok: true,
      value: path,
    },
  })
}

async function listSandboxFiles(context: any): Promise<Response> {
  const conversationId = String(context.conversation_id || '').trim()
  if (!conversationId) {
    return Response.json({ error: 'makers-conversation-id is required for the sandbox workspace.' }, { status: 400 })
  }
  const items = await listSandboxBrowserFiles(context, conversationId)
  return Response.json({
    root: 'EdgeOne 沙箱',
    items,
  })
}

function rpcQuery(body: unknown): string {
  const envelope = asRecord(body)
  const payload = asRecord(envelope?.payload)
  const args = asRecord(payload?.args)
  if (typeof args?.query === 'string') return args.query
  if (typeof payload?.query === 'string') return payload.query
  return ''
}

async function listSandboxFileReferences(context: any): Promise<Response> {
  const conversationId = String(context.conversation_id || '').trim()
  const rpcId = asRecord(context.request?.body)?.rpcId
  if (!conversationId) {
    return Response.json({
      type: 'server-response',
      rpcId: typeof rpcId === 'string' && rpcId.length > 0 ? rpcId : crypto.randomUUID(),
      result: { ok: true, value: [] },
    })
  }
  const items = await listSandboxBrowserFiles(context, conversationId)
  return Response.json({
    type: 'server-response',
    rpcId: typeof rpcId === 'string' && rpcId.length > 0 ? rpcId : crypto.randomUUID(),
    result: {
      ok: true,
      value: matchSandboxFileReferences(items, rpcQuery(context.request?.body)),
    },
  })
}

function sandboxFileError(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  const status = /Invalid workspace file path|File is empty|File is larger than|File not found|system sandbox folder/.test(message)
    ? 400
    : 500
  return Response.json({ error: message }, { status })
}

function bytesFromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'))
}

function uploadBytesFromBody(body: unknown): { path: string; bytes: Uint8Array } | undefined {
  if (body instanceof Uint8Array) return { path: '', bytes: body }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) return { path: '', bytes: new Uint8Array(body) }
  const record = asRecord(body)
  if (!record) return undefined
  const path = String(record.path || record.name || '')
  if (typeof record.contentBase64 === 'string') {
    return { path, bytes: bytesFromBase64(record.contentBase64) }
  }
  if (typeof record.content === 'string') {
    return { path, bytes: new TextEncoder().encode(record.content) }
  }
  return undefined
}

async function downloadSandboxFile(context: any): Promise<Response> {
  const conversationId = String(context.conversation_id || '').trim()
  if (!conversationId) {
    return Response.json({ error: 'makers-conversation-id is required for the sandbox workspace.' }, { status: 400 })
  }
  const incomingUrl = new URL(typeof context.request?.url === 'string' ? context.request.url : '/api/sandbox/file', 'http://local')
  const requested = queryValue(context, incomingUrl, 'path')
  try {
    const file = await readSandboxBrowserFile(context, conversationId, requested)
    const headers = new Headers({
      'content-type': file.contentType,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.path.split('/').pop() || file.path)}`,
      'cache-control': 'no-store',
      'x-content-type-stream': 'true',
    })
    return new Response(file.bytes, { status: 200, headers })
  } catch (error) {
    return sandboxFileError(error)
  }
}

async function uploadSandboxFile(context: any): Promise<Response> {
  const conversationId = String(context.conversation_id || '').trim()
  if (!conversationId) {
    return Response.json({ error: 'makers-conversation-id is required for the sandbox workspace.' }, { status: 400 })
  }
  const incomingUrl = new URL(typeof context.request?.url === 'string' ? context.request.url : '/api/sandbox/file', 'http://local')
  const parsed = uploadBytesFromBody(context.request?.body)
  const requested = queryValue(context, incomingUrl, 'path') || parsed?.path || ''
  if (!parsed) {
    return Response.json({ error: 'Upload requires JSON content or contentBase64.' }, { status: 400 })
  }
  try {
    const file = await uploadSandboxBrowserFile(context, conversationId, requested, parsed.bytes)
    return Response.json({ ok: true, path: file.path, bytes: file.bytes })
  } catch (error) {
    return sandboxFileError(error)
  }
}

async function deleteSandboxFile(context: any): Promise<Response> {
  const conversationId = String(context.conversation_id || '').trim()
  if (!conversationId) {
    return Response.json({ error: 'makers-conversation-id is required for the sandbox workspace.' }, { status: 400 })
  }
  const incomingUrl = new URL(typeof context.request?.url === 'string' ? context.request.url : '/api/sandbox/file', 'http://local')
  const requested = queryValue(context, incomingUrl, 'path') || String(asRecord(context.request?.body)?.path || '')
  try {
    const result = await deleteSandboxBrowserPath(context, conversationId, requested)
    return Response.json({ ok: true, path: result.path })
  } catch (error) {
    return sandboxFileError(error)
  }
}

async function handleSandboxFile(context: any): Promise<Response> {
  const method = String(context.request?.method || 'GET').toUpperCase()
  if (method === 'DELETE') return deleteSandboxFile(context)
  if (method === 'POST' || method === 'PUT') return uploadSandboxFile(context)
  return downloadSandboxFile(context)
}

function isWorkspaceCreatePath(path: string): boolean {
  return path === '/api/workspace/create' || path === '/api/workspace.create'
}

function rewriteWorkspaceCreatePath(body: unknown, workspacePath: string): unknown {
  const envelope = asRecord(body)
  if (!envelope) return { type: 'client-request', rpcId: crypto.randomUUID(), method: 'workspace/create', payload: { args: { request: { path: workspacePath } } } }
  const payload = asRecord(envelope.payload) ?? {}
  const args = asRecord(payload.args) ?? {}
  const request = asRecord(args.request) ?? {}
  return {
    ...envelope,
    method: typeof envelope.method === 'string' ? String(envelope.method).replaceAll('.', '/') : 'workspace/create',
    payload: {
      ...payload,
      args: {
        ...args,
        request: { ...request, path: workspacePath },
      },
    },
  }
}

function adoptedWorkspaceResponse(sidecar: DshWebSidecar, rpcId: unknown): Response | undefined {
  const workspace = sidecar.workspace
  if (!workspace) return undefined
  const now = new Date().toISOString()
  return Response.json({
    type: 'server-response',
    rpcId: typeof rpcId === 'string' && rpcId.length > 0 ? rpcId : crypto.randomUUID(),
    result: {
      ok: true,
      value: {
        workspace: {
          workspaceId: workspace.workspaceId,
          path: workspace.path,
          title: workspace.title,
          sessionIds: [],
          createdAt: now,
          updatedAt: now,
        },
        created: false,
      },
    },
  })
}

function rewriteLegacyPiAiOfficialProvider(body: unknown): unknown {
  const envelope = asRecord(body)
  const payload = asRecord(envelope?.payload)
  if (!envelope || !payload || payload.provider !== 'deepseek') return body
  return { ...envelope, payload: { ...payload, provider: 'deepseek-official' } }
}

function requestedLockedModelConfig(path: string, body: unknown): string | undefined {
  if (LOCKED_CREDENTIAL_PATHS.has(path)) return path
  const envelope = asRecord(body)
  const method = typeof envelope?.method === 'string' ? envelope.method : ''
  const payload = asRecord(envelope?.payload) ?? {}
  if (
    (method === 'settings.update' || method === 'settings.replace' || method === 'settings.mutate')
    && typeof payload.ns === 'string'
    && LOCKED_MODEL_SETTINGS.has(payload.ns)
  ) {
    return payload.ns
  }
  if (method === 'credentials.set' || method === 'credentials.unset') return method
  return undefined
}

const SETTINGS_WRITE_PATHS = pathAliases(
  '/api/settings.update',
  '/api/settings.replace',
  '/api/settings.mutate',
)

function settingsWriteSucceeded(bytes: Uint8Array): boolean {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { result?: { ok?: boolean } }
    return parsed.result?.ok === true
  } catch {
    return false
  }
}

async function snapshotSettingsAfterWrite(
  context: any,
  sidecar: DshWebSidecar,
  path: string,
  upstream: Response,
  headers: Headers,
): Promise<Response | undefined> {
  if (!SETTINGS_WRITE_PATHS.has(path)) return undefined
  const bytes = new Uint8Array(await upstream.arrayBuffer())
  headers.set('content-length', String(bytes.byteLength))
  if (upstream.ok && settingsWriteSucceeded(bytes)) {
    try {
      await snapshotDshSettingsYaml(context, sidecar.conversationId, sidecar.home)
    } catch (error) {
      console.warn('[dsh-web] settings snapshot failed:', error)
    }
  }
  return new Response(bytes, { status: upstream.status, headers })
}

function sidebarUpstreamPath(context: any): string | undefined {
  const incomingUrl = new URL(typeof context.request?.url === 'string' ? context.request.url : '/api/sidebar.proxy', 'http://local')
  const target = incomingUrl.searchParams.get('p')
  if (!target || (!target.startsWith('/sidebar/') && target !== '/sidebar')) return undefined
  if (target.includes('\\') || target.includes('\0') || target.includes('://')) return undefined
  const forwarded = new URLSearchParams(incomingUrl.search)
  forwarded.delete('p')
  const query = forwarded.toString()
  return query ? `${target}?${query}` : target
}

async function proxySidebar(context: any): Promise<Response> {
  const target = sidebarUpstreamPath(context)
  if (!target) {
    return Response.json({ error: 'sidebar.proxy requires a /sidebar path' }, { status: 400 })
  }
  const sidecar = await getDshWebSidecar(context)
  const method = String(context.request?.method || 'GET').toUpperCase()
  const incomingType = String(context.request?.headers?.['content-type'] || context.request?.headers?.['Content-Type'] || '')
  const incomingBody = context.request?.body
  let body: BodyInit | undefined
  const headers: Record<string, string> = {
    accept: context.request?.headers?.accept || '*/*',
    origin: `http://127.0.0.1:${String(sidecar.port)}`,
    cookie: sidecar.cookie,
  }
  if (method !== 'GET' && method !== 'HEAD') {
    if (incomingType.includes('octet-stream') && incomingBody != null) {
      headers['content-type'] = 'application/octet-stream'
      body = incomingBody instanceof Uint8Array
        ? incomingBody
        : typeof incomingBody === 'string'
          ? incomingBody
          : JSON.stringify(incomingBody)
    } else {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(incomingBody ?? {})
    }
  }
  const upstream = await fetch(`http://127.0.0.1:${String(sidecar.port)}${target}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: context.request?.signal,
  })
  const responseHeaders = new Headers(upstream.headers)
  responseHeaders.delete('content-encoding')
  responseHeaders.delete('content-length')
  responseHeaders.delete('transfer-encoding')
  const type = responseHeaders.get('content-type') || ''
  if (!type.includes('json') && !type.startsWith('text/')) {
    const bytes = new Uint8Array(await upstream.arrayBuffer())
    responseHeaders.set('x-content-type-stream', 'true')
    return new Response(bytes, { status: upstream.status, headers: responseHeaders })
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
}

async function proxy(context: any): Promise<Response> {
  const path = requestPath(context)
  if (path === '/api/sidebar.proxy') return proxySidebar(context)
  if (path === '/api/remote.mux') return remoteMuxStream(context)
  if (path === '/api/events.mux') return eventStream(context, 'mux')
  if (path === '/api/events.host') return eventStream(context, 'host')
  if (path === '/api/directoryPicker/pick') return pickSandboxDirectory(context)
  if (path === '/api/sandbox/files') return listSandboxFiles(context)
  if (path === '/api/sandbox/file') return handleSandboxFile(context)
  if (path === '/api/fileReferences/list' || path === '/api/fileReferences.list') {
    return listSandboxFileReferences(context)
  }
  if (
    path === '/api/agent-teams/state'
    || path === '/api/agent-teams/plan'
    || path === '/api/agent-teams/halt'
  ) {
    return proxyAgentTeams(context, path)
  }

  const incomingBody = context.request?.body
  const lockedPreset = requestedLockedPreset(incomingBody)
  if (lockedPreset) return rejectLockedPreset(asRecord(incomingBody)?.rpcId, lockedPreset)
  const lockedModelConfig = requestedLockedModelConfig(path, incomingBody)
  if (lockedModelConfig) return rejectLockedModelConfig(asRecord(incomingBody)?.rpcId, lockedModelConfig)

  const sidecar = await getDshWebSidecar(context)
  if (isWorkspaceCreatePath(path)) {
    const conversationId = String(context.conversation_id || sidecar.conversationId || '').trim()
    const workspacePath = sidecarWorkspaceRoot(conversationId)
    await mkdir(workspacePath, { recursive: true })
    const adopted = adoptedWorkspaceResponse(sidecar, asRecord(incomingBody)?.rpcId)
    if (adopted) return adopted
    context.request.body = rewriteWorkspaceCreatePath(incomingBody, workspacePath)
  }
  const incomingUrl = new URL(typeof context.request?.url === 'string' ? context.request.url : path, 'http://local')
  const upstreamPath = officialSidecarPath(incomingUrl.pathname)
  const upstreamUrl = new URL(`${upstreamPath}${requestSearch(context, incomingUrl)}`, `http://127.0.0.1:${String(sidecar.port)}`)
  const method = String(context.request?.method || 'POST').toUpperCase()
  const body = method === 'GET' || method === 'HEAD'
    ? undefined
    : JSON.stringify(rewriteLegacyPiAiOfficialProvider(context.request?.body ?? {}))
  const upstream = await fetch(upstreamUrl, {
    method,
    headers: {
      accept: context.request?.headers?.accept || '*/*',
      origin: `http://127.0.0.1:${String(sidecar.port)}`,
      cookie: sidecar.cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
    signal: context.request?.signal,
  })
  const headers = new Headers(upstream.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  headers.delete('transfer-encoding')
  if ((path === '/api/session.export' || path === '/api/session/export') && method === 'GET') {
    const bytes = new Uint8Array(await upstream.arrayBuffer())
    if (!headers.has('content-type')) headers.set('content-type', 'application/zip')
    // Makers' strict stream detector only treats SSE / chunked / this flag as binary.
    // Without it the runtime UTF-8-decodes the ZIP and the local proxy then writes
    // leftover bytes into an already-ended response (ERR_STREAM_WRITE_AFTER_END).
    headers.set('x-content-type-stream', 'true')
    headers.set('cache-control', 'no-store')
    return new Response(bytes, { status: upstream.status, headers })
  }
  const settingsResponse = await snapshotSettingsAfterWrite(context, sidecar, path, upstream, headers)
  if (settingsResponse) return settingsResponse
  return new Response(upstream.body, { status: upstream.status, headers })
}

export async function onRequest(context: any): Promise<Response> {
  try {
    return await proxy(context)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[dsh-web] proxy failed:', error)
    return Response.json({
      error: 'DSH_WEB_PROXY_FAILED',
      message,
    }, { status: 502 })
  }
}
