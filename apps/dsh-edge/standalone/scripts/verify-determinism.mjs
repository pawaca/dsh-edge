/** Rebuild Web assets and reject byte-level drift from the preceding build. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePnpmInvocation } from '../../scripts/pnpm-invocation.mjs'

const standaloneRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const before = await releaseWebHash()
const invocation = resolvePnpmInvocation(process.env.npm_execpath, ['run', 'build:web'])
execFileSync(invocation.command, invocation.args, {
  cwd: standaloneRoot,
  stdio: 'inherit',
})
const after = await releaseWebHash()
if (before !== after) {
  throw new Error(`Standalone Web output is not deterministic: ${before} != ${after}`)
}
console.log(`Verified deterministic standalone Web output: ${after}.`)

async function releaseWebHash() {
  const hash = createHash('sha256')
  for (const path of await filesUnder(join(standaloneRoot, 'dist'))) {
    hash.update(relative(standaloneRoot, path))
    hash.update('\0')
    hash.update(await readFile(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function filesUnder(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(path))
    else if (entry.isFile()) files.push(path)
    else throw new Error(`Standalone Web output contains an unsupported entry: ${path}`)
  }
  return files.sort()
}
