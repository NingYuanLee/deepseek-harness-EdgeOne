import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomeFor } from './_dsh-web-sidecar.ts'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function uniqueIds(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return [...new Set(values.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]
}

export function archiveStorePath(conversationId: string): string {
  return join(dshHomeFor(conversationId), 'archived-sessions.json')
}

export function sessionIdFromArchiveBody(body: unknown): string {
  const envelope = asRecord(body)
  const payload = asRecord(envelope?.payload)
  const args = asRecord(payload?.args)
  const request = asRecord(args?.request)
  const id = request?.sessionId ?? args?.sessionId ?? payload?.sessionId ?? envelope?.sessionId
  return typeof id === 'string' ? id.trim() : ''
}

const archiveCache = new Map<string, string[]>()
const archiveListeners = new Set<(conversationId: string, ids: string[]) => void>()

export function cachedArchivedSessionIds(conversationId: string): string[] {
  return archiveCache.get(conversationId) ?? []
}

export function subscribeArchivedSessions(
  listener: (conversationId: string, ids: string[]) => void,
): () => void {
  archiveListeners.add(listener)
  return () => {
    archiveListeners.delete(listener)
  }
}

export function archivedFollowItem(streamId: string, archivedSessionIds: string[]): string {
  return JSON.stringify({
    type: 'item',
    streamId,
    value: { type: 'archived', archivedSessionIds },
  })
}

function rememberArchivedSessionIds(conversationId: string, ids: string[], notify: boolean): string[] {
  archiveCache.set(conversationId, ids)
  if (notify) {
    for (const listener of archiveListeners) listener(conversationId, ids)
  }
  return ids
}

export async function loadArchivedSessionIds(conversationId: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(archiveStorePath(conversationId), 'utf8')) as unknown
    const record = asRecord(raw)
    return rememberArchivedSessionIds(conversationId, uniqueIds(record?.ids ?? raw), false)
  } catch {
    return rememberArchivedSessionIds(conversationId, [], false)
  }
}

export async function addArchivedSessionId(conversationId: string, sessionId: string): Promise<string[]> {
  const id = sessionId.trim()
  if (!id) throw new Error('sessionId is required.')
  const ids = await loadArchivedSessionIds(conversationId)
  if (!ids.includes(id)) ids.push(id)
  await mkdir(dshHomeFor(conversationId), { recursive: true })
  await writeFile(archiveStorePath(conversationId), `${JSON.stringify({ ids }, null, 2)}\n`, 'utf8')
  return rememberArchivedSessionIds(conversationId, ids, true)
}

export function injectArchivedSessionIds(node: unknown, archivedSessionIds: string[]): boolean {
  if (archivedSessionIds.length === 0 || !node || typeof node !== 'object') return false
  const record = node as Record<string, unknown>
  if (record.type === 'archived') {
    record.archivedSessionIds = [...new Set([...uniqueIds(record.archivedSessionIds), ...archivedSessionIds])]
    return true
  }
  if (record.type === 'baseline' && record.value && typeof record.value === 'object') {
    const value = record.value as Record<string, unknown>
    const existing = uniqueIds(value.archivedSessionIds)
    value.archivedSessionIds = [...new Set([...existing, ...archivedSessionIds])]
    return true
  }
  let changed = false
  for (const child of Object.values(record)) {
    if (injectArchivedSessionIds(child, archivedSessionIds)) changed = true
  }
  return changed
}

export function mergeArchivedIntoMuxText(text: string, archivedSessionIds: string[]): string {
  if (!text || archivedSessionIds.length === 0) return text
  try {
    const frame = JSON.parse(text) as unknown
    if (injectArchivedSessionIds(frame, archivedSessionIds)) return JSON.stringify(frame)
  } catch {
    // Keep the original sidecar frame if it is not JSON.
  }
  return text
}

export function isWorkspaceFollowEndpoint(endpoint: string): boolean {
  return endpoint === 'workspace/follow' || endpoint === 'workspace.follow' || endpoint.endsWith('/workspace/follow')
}
