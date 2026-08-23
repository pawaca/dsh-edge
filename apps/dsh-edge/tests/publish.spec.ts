import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertReleaseIdentity,
  publishTag,
  readPackedIdentity,
  resolveNpmInvocation,
  targetTag,
} from '../scripts/publish.mjs'
import { resolvePnpmInvocation } from '../scripts/pnpm-invocation.mjs'

const temporaryDirectories: string[] = []
// These contract tests intentionally launch the real npm CLI. A cold hosted
// runner can spend several seconds loading npm before inspecting the tarball.
const NPM_CLI_TEST_TIMEOUT_MS = 30_000

function tarEntry(manifest: unknown) {
  const encoder = new TextEncoder()
  const set = (target: Uint8Array, value: string, offset: number) => {
    target.set(encoder.encode(value), offset)
  }
  const content = encoder.encode(JSON.stringify(manifest))
  const header = new Uint8Array(512)
  set(header, 'package/package.json', 0)
  set(header, '0000644\0', 100)
  set(header, '0000000\0', 108)
  set(header, '0000000\0', 116)
  set(header, `${content.length.toString(8).padStart(11, '0')}\0`, 124)
  set(header, '00000000000\0', 136)
  header.fill(' '.charCodeAt(0), 148, 156)
  header[156] = '0'.charCodeAt(0)
  set(header, 'ustar\0', 257)
  set(header, '00', 263)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  set(header, `${checksum.toString(8).padStart(6, '0')}\0 `, 148)
  const entry = new Uint8Array(512 + Math.ceil(content.length / 512) * 512)
  entry.set(header)
  entry.set(content, 512)
  return entry
}

function tarballWithManifests(...manifests: unknown[]) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-edge-publish-'))
  temporaryDirectories.push(directory)
  const entries = manifests.map(tarEntry)
  const archive = new Uint8Array(entries.reduce((size, entry) => size + entry.length, 1024))
  let offset = 0
  for (const entry of entries) {
    archive.set(entry, offset)
    offset += entry.length
  }
  const tarball = join(directory, 'package.tgz')
  writeFileSync(tarball, gzipSync(archive))
  return tarball
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('standalone npm publication', { timeout: NPM_CLI_TEST_TIMEOUT_MS }, () => {
  it('keeps stable and prerelease channels separate without moving them backwards', () => {
    expect(targetTag('0.2.0')).toBe('latest')
    expect(targetTag('0.2.0-alpha.3')).toBe('next')
    expect(publishTag('0.2.0', '0.1.3')).toBe('latest')
    expect(publishTag('0.1.3', '0.2.0')).toBe('historical')
  })

  it('runs npm through its JavaScript entry on Windows', () => {
    const files = new Set([
      String.raw`D:\tools\npm.cmd`,
      String.raw`D:\tools\node_modules\npm\bin\npm-cli.js`,
    ])
    expect(resolveNpmInvocation(['publish', 'dsh-edge.tgz'], {
      PATH: String.raw`D:\tools`,
    }, {
      platform: 'win32',
      nodeExecutable: String.raw`C:\node\node.exe`,
      pathExists: path => files.has(path),
    })).toEqual({
      command: String.raw`C:\node\node.exe`,
      args: [String.raw`D:\tools\node_modules\npm\bin\npm-cli.js`, 'publish', 'dsh-edge.tgz'],
    })
  })

  it('derives the publication identity from the packed manifest', () => {
    expect(readPackedIdentity(tarballWithManifests({
      name: 'dsh-edge',
      version: '0.2.0',
    }))).toEqual({ name: 'dsh-edge', version: '0.2.0' })
  })

  it('rejects a stale tarball version before consulting the registry', () => {
    const identity = readPackedIdentity(tarballWithManifests({
      name: 'dsh-edge',
      version: '0.1.3',
    }))
    expect(() => assertReleaseIdentity(identity))
      .toThrow('checkout expects dsh-edge@0.4.0')
  })

  it('rejects a tarball for a different package', () => {
    expect(() => readPackedIdentity(tarballWithManifests({
      name: '@example/not-dsh-edge',
      version: '0.1.3',
    }))).toThrow('instead of dsh-edge')
  })

  it('uses npm semantics when a tarball contains duplicate manifests', () => {
    expect(() => readPackedIdentity(tarballWithManifests(
      { name: 'dsh-edge', version: '0.1.3' },
      { name: '@example/not-dsh-edge', version: '9.9.9' },
    ))).toThrow('instead of dsh-edge')
  })
})

describe('standalone pnpm tooling', () => {
  it('runs a JavaScript pnpm entry through Node', () => {
    expect(resolvePnpmInvocation('/tools/pnpm.cjs', ['run', 'build:web'], {
      nodeExecutable: '/tools/node',
    })).toEqual({
      command: '/tools/node',
      args: ['/tools/pnpm.cjs', 'run', 'build:web'],
    })
  })

  it('runs the pnpm standalone executable directly', () => {
    expect(resolvePnpmInvocation('pnpm', ['run', 'build:web'], {
      nodeExecutable: '/tools/node',
    })).toEqual({
      command: 'pnpm',
      args: ['run', 'build:web'],
    })
  })
})
