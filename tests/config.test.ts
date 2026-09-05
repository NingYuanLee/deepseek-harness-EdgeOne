import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('agent config packages the DSH Web sidecar and allows long runs', async () => {
  const config = JSON.parse(await readFile(new URL('../edgeone.json', import.meta.url), 'utf8'))
  assert.equal(config.agents.timeout, 300)
  assert.ok(config.agents.externalNodeModules.includes('@deepseek-ai/dsh'))
  assert.ok(config.agents.externalNodeModules.every((name: string) => !name.includes('linux-x64')))
  assert.equal(config.agents.includeFiles, undefined)
})

test('production preparation preserves Linux runtime natives while restoring host build and runtime natives', async () => {
  const source = await readFile(
    new URL('../scripts/restore-host-frontend-natives.mjs', import.meta.url),
    'utf8',
  )
  assert.match(source, /npm[\s\S]*pack/)
  assert.match(source, /@img\/sharp-linux-x64/)
  assert.match(source, /@img\/sharp-libvips-linux-x64/)
  assert.match(source, /@koromix\/koffi-linux-x64/)
  assert.match(source, /@koromix\/koffi-\$\{process\.platform\}-\$\{process\.arch\}/)
  assert.doesNotMatch(source, /spawnSync\(['"]npm['"], \[['"]install['"]/)
})

test('production pruning removes dependency source maps to stay below the Agent package limit', async () => {
  const source = await readFile(
    new URL('../scripts/prune-agent-dependencies.mjs', import.meta.url),
    'utf8',
  )
  assert.match(source, /removeSourceMaps/)
  assert.match(source, /endsWith\('\.map'\)/)
})

test('sidecar config binds Makers Gateway and MCP bridges', async () => {
  const source = await readFile(new URL('../agents/_dsh-web-sidecar.ts', import.meta.url), 'utf8')
  assert.match(source, /startLocalGatewayProxy/)
  assert.match(source, /startLocalMcpBridge/)
  assert.match(source, /spawn\(process\.execPath, \[\s*'--expose-internals'/)
  assert.match(source, /'--no-open'/)
  assert.match(source, /exchangeLaunchToken/)
  assert.match(source, /launchTokenFromOutput/)
  assert.match(source, /Makers 模式/)
  assert.match(source, /workspace\.create/)
})

test('sidecar defaults to official DeepSeek and reads the key from the environment', async () => {
  const source = await readFile(new URL('../agents/_dsh-web-sidecar.ts', import.meta.url), 'utf8')
  assert.match(source, /id: llm-deepseek/)
  assert.match(source, /OFFICIAL_PROVIDER = 'deepseek-official'/)
  assert.match(source, /DEFAULT_OFFICIAL_MODEL = 'deepseek-v4-flash-vision-exp'/)
  assert.match(source, /DEFAULT_OFFICIAL_BASE_URL = 'https:\/\/api\.deepseek\.com'/)
  assert.match(source, /id: agent-default-model/)
  assert.match(source, /provider: \$\{OFFICIAL_PROVIDER\}/)
  assert.match(source, /officialDeepSeekSection/)
  assert.doesNotMatch(source, /id: llm-pi-ai/)
  assert.doesNotMatch(source, /officialVisionProviderLines/)
  assert.match(source, /DEEPSEEK_API_KEY: deepseekApiKey/)
  assert.match(source, /ensureOfficialDefaultModelSettings/)
  assert.match(source, /id: agent-teams/)
  assert.match(source, /@nanmicoder\/dsh-agent-teams/)
  assert.match(source, /id: better-sidebar/)
  assert.match(source, /dsh-better-sidebar/)
  assert.match(source, /hydrateSidecarWorkspace/)
  assert.match(source, /session\.create/)
  assert.match(source, /request: \{ workspaceId \}/)
  assert.match(source, /request: \{ cwd: workspacePath \}/)
  assert.match(source, /id: permission/)
  assert.match(source, /Inspect the EdgeOne Makers sandbox/)
  assert.match(source, /makers-mcp-permission/)
  assert.match(source, /Every Makers tool stays available/)
  assert.match(source, /Commands and preview ask for confirmation/)
  assert.match(source, /workspace\.create/)
  assert.doesNotMatch(source, /displayName: EdgeOne Makers/)
  assert.doesNotMatch(source, /DEEPSEEK_BASE_URL: gateway\.baseUrl/)
  assert.doesNotMatch(source, /DEEPSEEK_API_KEY: 'makers-proxy'/)
})

test('API proxy refuses selecting the four shipped agent presets', async () => {
  const source = await readFile(new URL('../agents/api/_proxy.ts', import.meta.url), 'utf8')
  assert.match(source, /LOCKED_BUILT_IN_PRESETS/)
  assert.match(source, /standard.*code.*minimal.*cordis/)
  assert.match(source, /agent-preset-read-only/)
})

test('API proxy refuses model credential writes so keys stay in the environment', async () => {
  const source = await readFile(new URL('../agents/api/_proxy.ts', import.meta.url), 'utf8')
  assert.match(source, /LOCKED_CREDENTIAL_PATHS/)
  assert.match(source, /LOCKED_MODEL_SETTINGS/)
  assert.match(source, /model-config-read-only/)
  assert.match(source, /\/api\/credentials\.set/)
  assert.match(source, /\/api\/credentials\.unset/)
  assert.match(source, /llm-deepseek/)
  assert.match(source, /rewriteLegacyPiAiOfficialProvider/)
  assert.match(source, /deepseek-official/)
  assert.match(source, /cookie: sidecar\.cookie/)
  assert.match(source, /\/api\/sidebar\.proxy/)
  assert.match(source, /sidebarUpstreamPath/)
  assert.match(source, /headers\.delete\('content-encoding'\)/)
})

test('API proxy buffers session.export as a binary stream so Makers does not UTF-8-decode the ZIP', async () => {
  const source = await readFile(new URL('../agents/api/_proxy.ts', import.meta.url), 'utf8')
  const exportBlock = source.slice(source.indexOf("path === '/api/session.export'"))
  assert.match(exportBlock, /upstream\.arrayBuffer\(\)/)
  assert.match(exportBlock, /x-content-type-stream/)
  assert.doesNotMatch(exportBlock.slice(0, 600), /headers\.set\('content-length'/)
  assert.match(source, /requestSearch/)
})
