import WebSocket from 'ws'
import { getDshWebSidecar, snapshotDshSettingsYaml, type DshWebSidecar } from '../_dsh-web-sidecar.ts'
import { sidecarWorkspaceRoot } from '../_workspace.ts'

function requestPath(context: any): string {
  const value = typeof context.request?.url === 'string' ? context.request.url : '/api'
  try { return new URL(value, 'http://local').pathname } catch { return '/api' }
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
      const streamError = (error: unknown): void => {
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
            controller.enqueue(encoder.encode(': connected\n\n'))
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
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

function eventStream(context: any, kind: 'mux' | 'host'): Response {
  const encoder = new TextEncoder()
  let socket: WebSocket | undefined
  const signal = context.request?.signal as AbortSignal | undefined
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const streamError = (error: unknown): void => {
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
      try {
        const sidecar = await getDshWebSidecar(context)
        const path = kind === 'mux' ? '/api/events.mux' : '/api/events.host'
        socket = new WebSocket(`ws://127.0.0.1:${String(sidecar.port)}${path}`, {
          headers: {
            origin: `http://127.0.0.1:${String(sidecar.port)}`,
            cookie: sidecar.cookie,
          },
        })
        const close = (): void => {
          if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) socket.close()
        }
        signal?.addEventListener('abort', close, { once: true })
        socket.once('open', () => {
          try { controller.enqueue(encoder.encode(': connected\n\n')) } catch { close() }
        })
        socket.on('message', data => {
          try { controller.enqueue(encoder.encode(`data: ${data.toString()}\n\n`)) } catch { close() }
        })
        socket.once('error', streamError)
        socket.once('close', () => {
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
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
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
const LOCKED_CREDENTIAL_PATHS = new Set([
  '/api/credentials.set',
  '/api/credentials.unset',
])

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

async function pickSandboxDirectory(context: any): Promise<Response> {
  const sidecar = await getDshWebSidecar(context)
  const rpcId = asRecord(context.request?.body)?.rpcId
  return Response.json({
    type: 'server-response',
    rpcId: typeof rpcId === 'string' && rpcId.length > 0 ? rpcId : crypto.randomUUID(),
    result: {
      ok: true,
      value: sidecarWorkspaceRoot(sidecar.conversationId),
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

const SETTINGS_WRITE_PATHS = new Set([
  '/api/settings.update',
  '/api/settings.replace',
  '/api/settings.mutate',
])

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

  const incomingBody = context.request?.body
  const lockedPreset = requestedLockedPreset(incomingBody)
  if (lockedPreset) return rejectLockedPreset(asRecord(incomingBody)?.rpcId, lockedPreset)
  const lockedModelConfig = requestedLockedModelConfig(path, incomingBody)
  if (lockedModelConfig) return rejectLockedModelConfig(asRecord(incomingBody)?.rpcId, lockedModelConfig)

  const sidecar = await getDshWebSidecar(context)
  const incomingUrl = new URL(typeof context.request?.url === 'string' ? context.request.url : path, 'http://local')
  const upstreamUrl = new URL(`${incomingUrl.pathname}${requestSearch(context, incomingUrl)}`, `http://127.0.0.1:${String(sidecar.port)}`)
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
  if (path === '/api/session.export' && method === 'GET') {
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
