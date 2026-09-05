import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { makersApprovalSpeech } from '../agents/_makers-approval-speech.ts'

test('approval speech maps short allow and reject phrases', () => {
  assert.equal(makersApprovalSpeech('允许'), 'allowed-once')
  assert.equal(makersApprovalSpeech('允许一次。'), 'allowed-once')
  assert.equal(makersApprovalSpeech('yes'), 'allowed-once')
  assert.equal(makersApprovalSpeech('拒绝'), 'rejected')
  assert.equal(makersApprovalSpeech('no'), 'rejected')
  assert.equal(makersApprovalSpeech('帮我继续改简历'), null)
})

test('prepared approval panel settles language approval', async () => {
  const source = await readFile(
    new URL('../public/plugins/@deepseek-ai/dsh-client-ui-approval/client.js', import.meta.url),
    'utf8',
  )
  assert.match(source, /parseApprovalSpeech/)
  assert.match(source, /speech\.placeholder/)
  assert.match(source, /也可以输入：允许 \/ 拒绝/)
  assert.match(source, /composerDraft/)
})
