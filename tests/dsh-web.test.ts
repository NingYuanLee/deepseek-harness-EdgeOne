import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('build preparation installs the official DSH Web plugin graph', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  assert.match(html, /__DSH_BOOT__/)
  assert.match(html, /window\.__ModuleLoader__/)
  assert.match(html, /@deepseek-ai\/dsh-client-ui-conversation/)
  assert.match(html, /@deepseek-ai\/dsh-client-ui-trajectory/)
  assert.match(html, /@deepseek-ai\/dsh-client-ui-workspace/)
  assert.match(html, /@nanmicoder\/dsh-agent-teams/)
  assert.match(html, /dsh-better-sidebar/)
  assert.doesNotMatch(html, /@deepseek-ai\/dsh-client-ui-cordis/)
})

test('Agent Teams and the file sidebar are prepared into the Web roster', async () => {
  const teams = await readFile(
    new URL('../public/plugins/@nanmicoder/dsh-agent-teams/client.js', import.meta.url),
    'utf8',
  )
  const sidebar = await readFile(
    new URL('../public/plugins/dsh-better-sidebar/client.js', import.meta.url),
    'utf8',
  )
  assert.match(teams, /id: "agent-teams-activity"/)
  assert.match(teams, /ctx\.slots\.inject\("shell\.overlay"/)
  assert.match(sidebar, /\/api\/sidebar\.proxy\?p=/)
  assert.match(sidebar, /\/plugins\/dsh-better-sidebar\/client-\$\{name\}\.js/)
  assert.doesNotMatch(sidebar, /fetch\(`\/sidebar\/api\/\$\{method\}`/)
})

test('Makers connection bundle uses SSE and injects conversation routing', async () => {
  const gateway = await readFile(
    new URL('../public/plugins/@deepseek-ai/dsh-api-gateway/client.js', import.meta.url),
    'utf8',
  )
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  assert.match(gateway, /Remote stream SSE failed to open/)
  assert.match(gateway, /accept: "text\/event-stream"/)
  assert.doesNotMatch(gateway, /url\.protocol = url\.protocol === "https:" \? "wss:" : "ws:"/)
  assert.match(html, /makers-conversation-id/)
  assert.match(html, /window\.__ModuleLoader__/)
  assert.match(html, /__DSH_BOOT_READY__/)
})

test('built-in agent presets are locked in the prepared Web UI', async () => {
  const source = await readFile(
    new URL('../public/plugins/@deepseek-ai/dsh-client-ui-agent-preset/client.js', import.meta.url),
    'utf8',
  )
  assert.match(source, /function isLockedBuiltInPreset\(id\)/)
  assert.match(source, /dsh-makers-tip dsh-makers-locked/)
  assert.match(source, /data-locked": isLockedBuiltInPreset\(row\.id\)/)
  assert.match(source, /data-tip": isLockedBuiltInPreset\(row\.id\)/)
  assert.match(source, /presetMakersName: "Makers mode"/)
  assert.match(source, /presetMakersName: "Makers 模式"/)
  assert.match(source, /presetMakersDescription: "A DSH Agent that uses EdgeOne Makers MCP tools, Sandbox, and AI Gateway."/)
  assert.match(source, /preset\.id === "makers"/)
  assert.doesNotMatch(source, /slots\.inject\("settings\.section"/)
  assert.doesNotMatch(source, /slots\.inject\("settings\.general\.item"/)
  assert.doesNotMatch(source, /conversation\.hero\.agentPreset/)
  assert.doesNotMatch(source, /conversation\.session\.header\.actions/)
})

test('permission modes keep the composer picker and use Makers sandbox copy', async () => {
  const conversation = await readFile(
    new URL('../public/plugins/@deepseek-ai/dsh-client-ui-conversation/client.js', import.meta.url),
    'utf8',
  )
  const permission = await readFile(
    new URL('../public/plugins/@deepseek-ai/dsh-client-ui-permission-presets/client.js', import.meta.url),
    'utf8',
  )
  assert.match(conversation, /function PermissionSelect\(\{ value, locked, command, t \}\)/)
  assert.match(conversation, /command\(`\/permission \$\{id\}`\)/)
  assert.match(conversation, /"access.read-only.detail": "Inspect the EdgeOne Makers sandbox: list and read files. Writes, commands, and preview will ask you to confirm/)
  assert.match(conversation, /"access.read-only.detail": "只能查看 EdgeOne Makers 沙箱：列出和读取文件。写入、运行命令或发布预览时会询问你确认/)
  assert.match(conversation, /"access.workspace-write.detail": "Read and write files in the EdgeOne Makers sandbox. Commands and preview will ask you to confirm/)
  assert.match(conversation, /access\.\$\{currentValue\}\.detail/)
  assert.match(permission, /slots\.inject\("settings\.general\.item"/)
  assert.match(permission, /available: \(session\) => selectOf\(sessionFor\(session\)\) !== void 0/)
  assert.match(permission, /EdgeOne Makers 沙箱/)
})

test('workspace UI shows a single cloud workspace without switching', async () => {
  const conversation = await readFile(
    new URL('../public/plugins/@deepseek-ai/dsh-client-ui-conversation/client.js', import.meta.url),
    'utf8',
  )
  const workspace = await readFile(
    new URL('../public/plugins/@deepseek-ai/dsh-client-ui-workspace/client.js', import.meta.url),
    'utf8',
  )
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  assert.match(conversation, /"hero.cloudWorkspace": "EdgeOne 沙箱"/)
  assert.match(conversation, /"hero.cloudWorkspace": "EdgeOne Sandbox"/)
  assert.match(conversation, /const inert = sessionId === void 0 && workspaces\.items\.length === 0;/)
  assert.match(conversation, /selectWorkspace\(only\.workspaceId\)/)
  assert.doesNotMatch(conversation, /hero.workspaceLocked/)
  assert.doesNotMatch(conversation, /"hero.cloudWorkspace": "云端工作区"/)
  assert.match(workspace, /"section.workspaces": "EdgeOne 沙箱"/)
  assert.match(workspace, /"section.workspaces": "EdgeOne Sandbox"/)
  assert.match(workspace, /wide && \(0, react_jsx_runtime.jsxs\)\("div", \{\s*className: WorkspaceBrowser_module_css_default.sectionHeader/)
  assert.doesNotMatch(workspace, /workspace.locked/)
  assert.doesNotMatch(workspace, /jsx\)\(ProjectRowItem/)
  assert.match(html, /dsh-makers-hover-tip/)
  assert.match(html, /hostOf/)
})

test('charset is declared in the first 1024 bytes before overlay copy', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  const charset = html.match(/<meta\s+charset=["']utf-8["']\s*\/?>/i)
  assert.ok(charset?.index != null, 'missing utf-8 charset meta')
  assert.ok(
    Buffer.byteLength(html.slice(0, charset.index), 'utf8') < 1024,
    'charset must be inside the HTML5 encoding-sniff window',
  )
  assert.ok(charset.index < html.indexOf('__DSH_BOOT__'))
  assert.ok(charset.index < html.indexOf('GitHub 源码'))
})

test('locale defaults from hostname instead of the browser language', async () => {
  const source = await readFile(
    new URL('../public/plugins/@deepseek-ai/dsh-client-locale/client.js', import.meta.url),
    'utf8',
  )
  assert.match(
    source,
    /function resolveInitialLocale\(locales\) \{\n\t\t\tif \(typeof window !== "undefined" && location\.hostname\.endsWith\("\.edgeone\.dev"\)\) return "en";\n\t\t\treturn locales\.some\(\(locale\) => locale\.id === "zh"\) \? "zh" : "en";/,
  )
  assert.match(source, /detectBrowserLocale/)
})

test('page chrome keeps only a GitHub link to this repository', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  assert.match(html, /dsh-makers-actions/)
  assert.match(html, /dsh-makers-chrome/)
  assert.match(html, /GitHub 源码/)
  assert.match(html, /github.com\/NingYuanLee\/deepseek-harness-EdgeOne/)
  assert.match(html, /headerUtilities/)
  assert.match(html, /utilities.insertBefore\(nav, utilities.firstChild\)/)
  assert.match(html, /#dsh-makers-chrome\{position:absolute;top:0;left:16px/)
  assert.match(html, /const host = centerCol\(\);\s*if \(!host\) return;/)
  assert.doesNotMatch(html, /dsh-makers-powered/)
  assert.doesNotMatch(html, /dsh-makers-contact/)
  assert.doesNotMatch(html, /模版部署/)
  assert.doesNotMatch(html, /EdgeOne Makers Agents/)
  assert.doesNotMatch(html, /github.com\/TencentEdgeOne\/deepseek-harness/)
  assert.doesNotMatch(html, /edgeone.ai\/makers\/new/)
  assert.doesNotMatch(html, /console.cloud.tencent.com\/edgeone\/makers\/new/)
  assert.doesNotMatch(html, /pages.edgeone.ai\/contact/)
  assert.doesNotMatch(html, /cloud.tencent.com\/online-service/)
  assert.doesNotMatch(html, /\|\| document\.body/)
})

test('session log export downloads through fetch so conversation routing is preserved', async () => {
  const source = await readFile(
    new URL('../public/plugins/@deepseek-ai/dsh-session-log-export/client.js', import.meta.url),
    'utf8',
  )
  assert.match(source, /method: "GET"/)
  assert.match(source, /URL\.createObjectURL\(blob\)/)
  assert.doesNotMatch(source, /method: "HEAD"/)
})

test('settings and model welcome preferences persist through Host even off loopback', async () => {
  const settings = await readFile(
    new URL('../public/plugins/@deepseek-ai/dsh-client-ui-settings/client.js', import.meta.url),
    'utf8',
  )
  const models = await readFile(
    new URL('../public/plugins/@deepseek-ai/dsh-client-ui-settings-models/client.js', import.meta.url),
    'utf8',
  )
  const selection = await readFile(
    new URL('../public/plugins/@deepseek-ai/dsh-client-ui-model-selection/client.js', import.meta.url),
    'utf8',
  )
  assert.match(settings, /const persistence = "host";/)
  assert.doesNotMatch(settings, /isLoopback \? "host" : "memory"/)
  assert.doesNotMatch(models, /isLoopback \? "host" : "memory"/)
  assert.doesNotMatch(models, /id: "welcome-notice"/)
  assert.doesNotMatch(models, /id: "deepseek-official"/)
  assert.match(models, /officialProvided: "Models come from the official DeepSeek API\. Image input is enabled for DeepSeek-V4-Flash-Vision\. The key is read only from DEEPSEEK_API_KEY\."/)
  assert.match(models, /officialProvided: "模型由 DeepSeek 原厂提供，已开启图片输入（DeepSeek-V4-Flash-Vision）。API Key 仅从环境变量 DEEPSEEK_API_KEY 读取。"/)
  assert.match(models, /https:\/\/api-docs\.deepseek\.com\//)
  assert.match(selection, /officialVisionGroups/)
  assert.match(selection, /group.id === "deepseek-official"/)
  assert.match(selection, /deepseek-v4-flash-vision-exp/)
  assert.match(selection, /groups: officialGroups/)
  assert.doesNotMatch(selection, /group\.id === "edgeone-makers"/)
  assert.match(selection, /inflightSelect/)
  assert.match(selection, /const optimistic =/)
  assert.match(selection, /if \(accepted\) return/)
  assert.doesNotMatch(selection, /if \(accepted\) \{\n\t\t\t\t\tif \(rootRef\.current !== null\) close\(true\)/)
})

test('generated API routes expose static files the Makers scanner accepts', async () => {
  const route = await readFile(new URL('../agents/api/session.prompt.ts', import.meta.url), 'utf8')
  const remoteRoute = await readFile(new URL('../agents/api/commands/list.ts', import.meta.url), 'utf8')
  const pickerRoute = await readFile(new URL('../agents/api/directoryPicker/pick.ts', import.meta.url), 'utf8')
  const generator = await readFile(new URL('../scripts/generate-dsh-api-routes.mjs', import.meta.url), 'utf8')
  assert.match(route, /export async function onRequest/)
  assert.match(remoteRoute, /export async function onRequest/)
  assert.match(remoteRoute, /\.\.\/_proxy\.ts/)
  assert.match(pickerRoute, /export async function onRequest/)
  assert.match(generator, /directoryPicker\/pick/)
})
