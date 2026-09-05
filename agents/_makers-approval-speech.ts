const ALLOW = /^(允许一次|允许|同意|好的|好|可以|确认|ok|okay|yes|y|allow|approve)$/i
const REJECT = /^(拒绝|不允许|取消|否|不|no|n|reject|deny|cancel)$/i

export function makersApprovalSpeech(text: unknown): 'allowed-once' | 'rejected' | null {
  const value = String(text ?? '').trim().replace(/[。！？.!?,，]/g, '')
  if (!value) return null
  if (ALLOW.test(value)) return 'allowed-once'
  if (REJECT.test(value)) return 'rejected'
  return null
}
