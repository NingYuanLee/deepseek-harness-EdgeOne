import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildDocx, buildPptx, buildXlsx } from '../agents/_office-files.ts'
import { listSandboxBrowserFiles, matchSandboxFileReferences, normalizeWorkspacePath, readSandboxBrowserFile, sidecarWorkspaceRoot, workspaceRoot, writeWorkspaceBytes, writeWorkspaceFile } from '../agents/_workspace.ts'

test('sandbox file references match one directory level like the composer @ menu', () => {
  const items = [
    { path: '小说.docx', name: '小说.docx', type: 'file' as const, depth: 0 },
    { path: 'notes', name: 'notes', type: 'directory' as const, depth: 0 },
    { path: 'notes/hello.txt', name: 'hello.txt', type: 'file' as const, depth: 1 },
  ]
  assert.deepEqual(matchSandboxFileReferences(items, ''), [
    { path: '小说.docx', kind: 'file' },
    { path: 'notes', kind: 'directory' },
  ])
  assert.deepEqual(matchSandboxFileReferences(items, '小'), [
    { path: '小说.docx', kind: 'file' },
  ])
  assert.deepEqual(matchSandboxFileReferences(items, 'notes/'), [
    { path: 'notes/hello.txt', kind: 'file' },
  ])
})

test('workspace paths stay relative and traversal-free', () => {
  assert.equal(normalizeWorkspacePath('src/App.tsx'), 'src/App.tsx')
  assert.equal(normalizeWorkspacePath('./src/main.ts'), 'src/main.ts')
  assert.equal(normalizeWorkspacePath('../secret'), null)
  assert.equal(normalizeWorkspacePath('/tmp/file'), null)
  assert.equal(normalizeWorkspacePath('src//file.ts'), null)
})

test('workspace root sanitizes the conversation id', () => {
  assert.equal(
    workspaceRoot('abc/../unsafe'),
    'projects/abc____unsafe/workspace',
  )
})

function missingConversation(action: string) {
  return Object.assign(new Error(`Conversation not found by ${action}.`), {
    code: 'MemoryNotFoundError',
  })
}

function createSandbox(written = new Map<string, string>()) {
  return {
    files: {
      makeDir: async () => {},
      write: async (path: string, content: string) => { written.set(path, content) },
    },
    commands: {
      run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    },
  }
}

test('writeWorkspaceFile bootstraps a missing conversation before snapshotting', async () => {
  const written = new Map<string, string>()
  const conversations = new Map<string, { metadata: Record<string, unknown> }>()
  const store = {
    async getConversation({ conversationId }: { conversationId: string }) {
      const row = conversations.get(conversationId)
      if (!row) throw missingConversation('getConversation')
      return row
    },
    async appendMessage({ conversationId }: { conversationId: string }) {
      if (!conversations.has(conversationId)) {
        conversations.set(conversationId, { metadata: {} })
      }
    },
    async updateConversation({
      conversationId,
      metadata,
    }: {
      conversationId: string
      metadata: Record<string, unknown>
    }) {
      const row = conversations.get(conversationId)
      if (!row) throw missingConversation('updateConversation')
      row.metadata = { ...row.metadata, ...metadata }
      return row
    },
  }

  const result = await writeWorkspaceFile(
    { store, sandbox: createSandbox(written) },
    'conv-1',
    'index.html',
    '<html></html>',
  )

  assert.equal(result.path, 'index.html')
  assert.ok([...written.keys()].some(path => path.endsWith('/index.html')))
  const snapshot = conversations.get('conv-1')?.metadata?.workspaceSnapshot as Record<string, { content: string }>
  assert.equal(snapshot['index.html']?.content, '<html></html>')
})

test('writeWorkspaceFile still succeeds when snapshot persistence fails', async () => {
  const written = new Map<string, string>()
  const store = {
    async getConversation() {
      throw missingConversation('getConversation')
    },
    async appendMessage() {
      throw new Error('store unavailable')
    },
    async updateConversation() {
      throw missingConversation('updateConversation')
    },
  }

  const result = await writeWorkspaceFile(
    { store, sandbox: createSandbox(written) },
    'conv-1',
    'index.html',
    '<html></html>',
  )

  assert.equal(result.path, 'index.html')
  assert.ok([...written.keys()].some(path => path.endsWith('/index.html')))
})

test('writeWorkspaceFile uses the sidecar disk workspace when sandbox is absent', async () => {
  const conversationId = `disk-${Date.now()}`
  const result = await writeWorkspaceFile(
    { store: { async getConversation() { return { metadata: {} } }, async updateConversation() {} } },
    conversationId,
    'src/hello.txt',
    'hello sandbox',
  )
  assert.equal(result.path, 'src/hello.txt')
  assert.equal(
    await readFile(join(sidecarWorkspaceRoot(conversationId), 'src', 'hello.txt'), 'utf8'),
    'hello sandbox',
  )
  await rm(join(tmpdir(), 'dsh-makers-web', conversationId.replace(/[^a-zA-Z0-9_-]/g, '_')), {
    recursive: true,
    force: true,
  })
})

test('sandbox browser lists and downloads files from the sidecar workspace', async () => {
  const conversationId = `browse-${Date.now()}`
  const context = { store: { async getConversation() { return { metadata: {} } }, async updateConversation() {} } }
  await writeWorkspaceFile(context, conversationId, 'notes/hello.txt', 'hello sandbox')
  const items = await listSandboxBrowserFiles(context, conversationId)
  assert.ok(items.some(item => item.path === 'notes/hello.txt' && item.type === 'file'))
  const file = await readSandboxBrowserFile(context, conversationId, 'notes/hello.txt')
  assert.equal(new TextDecoder().decode(file.bytes), 'hello sandbox')
  await assert.rejects(() => readSandboxBrowserFile(context, conversationId, '../secret'), /Invalid workspace file path/)
  await rm(join(tmpdir(), 'dsh-makers-web', conversationId.replace(/[^a-zA-Z0-9_-]/g, '_')), {
    recursive: true,
    force: true,
  })
})

test('writeWorkspaceFile rejects Office extensions so UTF-8 cannot fake them', async () => {
  const conversationId = `office-reject-${Date.now()}`
  const context = { store: { async getConversation() { return { metadata: {} } }, async updateConversation() {} } }
  await assert.rejects(() => writeWorkspaceFile(context, conversationId, 'a.docx', '<html></html>'), /workspace_write_docx/)
  await assert.rejects(() => writeWorkspaceFile(context, conversationId, 'b.xlsx', '1,2,3'), /workspace_write_xlsx/)
  await assert.rejects(() => writeWorkspaceFile(context, conversationId, 'c.pptx', '# slide'), /workspace_write_pptx/)
  await assert.rejects(() => writeWorkspaceBytes(context, conversationId, '../secret.pptx', new Uint8Array([1])), /Invalid workspace file path/)
})

test('office binaries stay on disk with the correct download MIME', async () => {
  const conversationId = `office-bin-${Date.now()}`
  const context = { store: { async getConversation() { return { metadata: {} } }, async updateConversation() {} } }
  const docx = await writeWorkspaceBytes(context, conversationId, 'docs/报告.docx', buildDocx({ title: '报告' }))
  const xlsx = await writeWorkspaceBytes(context, conversationId, 'docs/表.xlsx', buildXlsx({ sheets: [{ rows: [['中文']] }] }))
  const pptx = await writeWorkspaceBytes(context, conversationId, 'docs/稿.pptx', buildPptx({ slides: [{ title: '汇报' }] }))
  assert.ok(docx.bytes > 0 && xlsx.bytes > 0 && pptx.bytes > 0)
  const downloaded = await readSandboxBrowserFile(context, conversationId, 'docs/稿.pptx')
  assert.equal(downloaded.bytes[0], 0x50)
  assert.equal(downloaded.contentType, 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
  const listed = await listSandboxBrowserFiles(context, conversationId)
  assert.ok(listed.some(item => item.path === 'docs/报告.docx'))
  await rm(join(tmpdir(), 'dsh-makers-web', conversationId.replace(/[^a-zA-Z0-9_-]/g, '_')), {
    recursive: true,
    force: true,
  })
})
