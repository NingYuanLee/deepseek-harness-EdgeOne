import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  addArchivedSessionId,
  archivedFollowItem,
  cachedArchivedSessionIds,
  injectArchivedSessionIds,
  isWorkspaceFollowEndpoint,
  loadArchivedSessionIds,
  mergeArchivedIntoMuxText,
  sessionIdFromArchiveBody,
  subscribeArchivedSessions,
} from '../agents/_session-archive.ts'

test('archive RPC bodies expose the session id from the official envelope', () => {
  assert.equal(sessionIdFromArchiveBody({
    type: 'client-request',
    payload: { args: { request: { sessionId: 'sess-1' } } },
  }), 'sess-1')
  assert.equal(sessionIdFromArchiveBody({ payload: { args: { sessionId: 'sess-2' } } }), 'sess-2')
  assert.equal(sessionIdFromArchiveBody({}), '')
})

test('archived session ids persist on disk and stay unique', async () => {
  const conversationId = `archive-${Date.now()}`
  assert.deepEqual(await addArchivedSessionId(conversationId, 'a'), ['a'])
  assert.deepEqual(await addArchivedSessionId(conversationId, 'a'), ['a'])
  assert.deepEqual(await addArchivedSessionId(conversationId, 'b'), ['a', 'b'])
  assert.deepEqual(await loadArchivedSessionIds(conversationId), ['a', 'b'])
  await rm(join(tmpdir(), 'dsh-makers-web', conversationId.replace(/[^a-zA-Z0-9_-]/g, '_')), {
    recursive: true,
    force: true,
  })
})

test('workspace follow baselines pick up persisted archived session ids', () => {
  assert.equal(isWorkspaceFollowEndpoint('workspace/follow'), true)
  const frame = {
    type: 'item',
    streamId: 's1',
    value: { type: 'baseline', value: { items: [], archivedSessionIds: ['keep'] } },
  }
  assert.equal(injectArchivedSessionIds(frame, ['keep', 'new']), true)
  assert.deepEqual(
    (frame.value.value as { archivedSessionIds: string[] }).archivedSessionIds,
    ['keep', 'new'],
  )
  const merged = mergeArchivedIntoMuxText(JSON.stringify({
    type: 'item',
    streamId: 's1',
    value: { type: 'baseline', value: { items: [] } },
  }), ['hidden'])
  assert.match(merged, /"hidden"/)
  const increment = JSON.parse(mergeArchivedIntoMuxText(JSON.stringify({
    type: 'item',
    streamId: 's1',
    value: { type: 'archived', archivedSessionIds: [] },
  }), ['hidden'])) as { value: { archivedSessionIds: string[] } }
  assert.deepEqual(increment.value.archivedSessionIds, ['hidden'])
})

test('archiving a session notifies live workspace follow streams', async () => {
  const conversationId = `archive-live-${Date.now()}`
  const seen: string[][] = []
  const stop = subscribeArchivedSessions((id, ids) => {
    if (id === conversationId) seen.push(ids)
  })
  await addArchivedSessionId(conversationId, 'sess-live')
  stop()
  assert.deepEqual(cachedArchivedSessionIds(conversationId), ['sess-live'])
  assert.deepEqual(seen, [['sess-live']])
  assert.match(archivedFollowItem('stream-1', ['sess-live']), /"archived"/)
  await rm(join(tmpdir(), 'dsh-makers-web', conversationId.replace(/[^a-zA-Z0-9_-]/g, '_')), {
    recursive: true,
    force: true,
  })
})

test('API proxy archives sessions instead of forwarding a missing sidecar method', async () => {
  const source = await readFile(new URL('../agents/api/_proxy.ts', import.meta.url), 'utf8')
  assert.match(source, /isWorkspaceArchivePath/)
  assert.match(source, /archiveWorkspaceSession/)
  assert.match(source, /mergeArchivedIntoMuxText/)
  assert.match(source, /subscribeArchivedSessions/)
  assert.match(source, /archivedFollowItem/)
})
