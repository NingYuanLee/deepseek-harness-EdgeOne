import { lstat, mkdir, readdir, rm, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const projectRoot = new URL('../', import.meta.url)
const nodeModulesRoot = fileURLToPath(new URL('node_modules/', projectRoot))
const nodePtyRoot = join(nodeModulesRoot, 'node-pty')
const subprocessRuntimePath = fileURLToPath(new URL(
  'node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js',
  projectRoot,
))

const unusedPackages = [
  'mermaid',
  'react-icons',
  '@mermaid-js/parser',
  'cytoscape',
  'cytoscape-fcose',
  'katex',
  'lexical',
  'shiki',
  'vite',
  'typescript',
  '@deepseek-ai/dsh-web-frontend',
  '@deepseek-ai/dsh-client-web',
  'dsh-better-sidebar',
  'openai',
  '@google/genai',
  '@anthropic-ai/sdk',
  'react',
  'react-dom',
  'rollup',
  'esbuild',
]

const unusedScopes = [
  '@codemirror',
  '@shikijs',
  '@lezer',
  '@rollup',
  '@esbuild',
  '@types',
]

const nodePtyJunk = [
  'prebuilds/darwin-arm64',
  'prebuilds/darwin-x64',
  'prebuilds/linux-arm64',
  'prebuilds/win32-arm64',
  'prebuilds/win32-x64',
  'third_party/conpty',
  'deps/winpty',
  'src',
  'build',
]

async function sizeOf(path) {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
  if (!stats.isDirectory()) return stats.size
  const entries = await readdir(path)
  const sizes = await Promise.all(entries.map(entry => sizeOf(join(path, entry))))
  return sizes.reduce((total, size) => total + size, 0)
}

async function removePath(path) {
  const bytes = await sizeOf(path)
  if (bytes === 0) return 0
  await rm(path, { recursive: true, force: true })
  return bytes
}

function packagePath(name) {
  return join(nodeModulesRoot, ...name.split('/'))
}

async function removeSourceMaps(path) {
  let removedBytes = 0
  let removedFiles = 0
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { bytes: 0, files: 0 }
    throw error
  }
  for (const entry of entries) {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) {
      const removed = await removeSourceMaps(entryPath)
      removedBytes += removed.bytes
      removedFiles += removed.files
    } else if (entry.isFile() && entry.name.endsWith('.map')) {
      removedBytes += await sizeOf(entryPath)
      await rm(entryPath, { force: true })
      removedFiles += 1
    }
  }
  return { bytes: removedBytes, files: removedFiles }
}

async function makeNodePtyLazy() {
  let source
  try {
    source = await readFile(subprocessRuntimePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  const eagerImport = 'import * as nodePty from "node-pty";\n'
  const terminalMethod = 'async spawnTerminal(spec) {\n\t\tconst file = spec.argv[0];'
  const lazyTerminalMethod = 'async spawnTerminal(spec) {\n\t\tconst nodePty = await import("node-pty");\n\t\tconst file = spec.argv[0];'

  if (source.includes(lazyTerminalMethod)) return false
  if (!source.includes(eagerImport) || !source.includes(terminalMethod)) {
    throw new Error('Unsupported @deepseek-ai/dsh-subprocess-local build; cannot make node-pty lazy.')
  }
  await writeFile(
    subprocessRuntimePath,
    source.replace(eagerImport, '').replace(terminalMethod, lazyTerminalMethod),
  )
  return true
}

async function writeSidecarFrontendStub() {
  const dest = packagePath('@deepseek-ai/dsh-web-frontend')
  await mkdir(join(dest, 'dist'), { recursive: true })
  await writeFile(join(dest, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-web-frontend',
    version: '0.1.2-rc.1',
    type: 'module',
  }, null, 2)}\n`)
  await writeFile(join(dest, 'dist', 'index.html'), '<!DOCTYPE html><title>dsh</title>\n')
}

const patchedNodePty = await makeNodePtyLazy()
console.log(`${patchedNodePty ? 'Patched' : 'Kept'} node-pty as a lazy Makers-only terminal dependency.`)

let removedBytes = 0
for (const name of unusedPackages) {
  removedBytes += await removePath(packagePath(name))
}
for (const scope of unusedScopes) {
  removedBytes += await removePath(join(nodeModulesRoot, scope))
}
for (const relativePath of nodePtyJunk) {
  removedBytes += await removePath(join(nodePtyRoot, relativePath))
}
await writeSidecarFrontendStub()

if (process.platform === 'linux') {
  removedBytes += await removePath(fileURLToPath(new URL('../public/', projectRoot)))
}

console.log(`Pruned ${(removedBytes / 1024 / 1024).toFixed(1)} MiB of frontend-only and unused native files from the Makers agent package.`)

const sourceMaps = await removeSourceMaps(nodeModulesRoot)
console.log(`Pruned ${sourceMaps.files} dependency source maps (${(sourceMaps.bytes / 1024 / 1024).toFixed(1)} MiB) from the Makers agent package.`)

const remaining = await sizeOf(nodeModulesRoot)
console.log(`Agent node_modules is now ${(remaining / 1024 / 1024).toFixed(1)} MiB.`)
if (process.platform === 'linux' && remaining > 245 * 1024 * 1024) {
  throw new Error(`Agent node_modules is still ${(remaining / 1024 / 1024).toFixed(1)} MiB; EdgeOne limit is 250 MiB.`)
}
