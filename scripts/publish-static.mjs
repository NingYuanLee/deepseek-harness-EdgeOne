import { access, cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const publicDir = join(root, 'public')
const distDir = join(root, 'dist')

try {
  await access(join(publicDir, 'index.html'))
} catch {
  throw new Error('public/index.html is missing. Run npm run prepare:dsh-web first.')
}

await rm(distDir, { recursive: true, force: true })
await mkdir(distDir, { recursive: true })
await cp(publicDir, distDir, { recursive: true })
console.log('Published prepared DSH Web from public/ to dist/.')
