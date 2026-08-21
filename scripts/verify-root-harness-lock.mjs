/** Verify that repository checks resolve the same exact Harness baseline as the release assembly. */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import edgePackage from '../apps/dsh-edge/package.json' with { type: 'json' }

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targetVersion = edgePackage.dshEdge.upstreamVersion
const lock = await readFile(resolve(repoRoot, 'pnpm-lock.yaml'), 'utf8')
const harnessVersions = new Set(
  [...lock.matchAll(/@deepseek-ai\/dsh-[^@:'"\s()]+@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)]
    .map(match => match[1]),
)

if (harnessVersions.size !== 1 || !harnessVersions.has(targetVersion)) {
  throw new Error(
    `Root lock mixes Harness versions: ${[...harnessVersions].join(', ') || 'none'}; expected ${targetVersion}.`,
  )
}

console.log(`Verified root test closure uses Harness ${targetVersion} only.`)
