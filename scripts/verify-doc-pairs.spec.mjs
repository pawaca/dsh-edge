import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories = []
const script = resolve(import.meta.dirname, 'verify-doc-pairs.mjs')
const header = `# Bilingual-pair consistency record: the git blob hash of each side at the
# last confirmed-consistent state. Both languages carry equal authority.
# After editing either side, update both and re-record every pair with:
#   pnpm run doc-pairs -- --write`

function blobHash(content) {
  const length = new TextEncoder().encode(content).byteLength
  return createHash('sha1').update(`blob ${String(length)}\0${content}`).digest('hex')
}

function fixture(rows) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-edge-doc-pairs-'))
  temporaryDirectories.push(directory)
  writeFileSync(join(directory, 'Guide.md'), 'English\n')
  writeFileSync(join(directory, 'Guide.zh.md'), '中文\n')
  writeFileSync(join(directory, 'Guide.i18n.yaml'), `${header}\n${rows.join('\n')}\n`)
  return directory
}

function verify(directory) {
  return spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('bilingual document pairing manifests', () => {
  it('accepts the exact English and Chinese pair', () => {
    const directory = fixture([
      `Guide.md: ${blobHash('English\n')}`,
      `Guide.zh.md: ${blobHash('中文\n')}`,
    ])
    expect(verify(directory).status).toBe(0)
  })

  it('rejects deletion of the Chinese manifest row', () => {
    const directory = fixture([`Guide.md: ${blobHash('English\n')}`])
    const result = verify(directory)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('must contain exactly Guide.md and Guide.zh.md')
  })

  it('rejects malformed rows instead of ignoring them', () => {
    const directory = fixture([
      `Guide.md: ${blobHash('English\n')}`,
      'Guide.zh.md: not-a-blob-hash',
    ])
    const result = verify(directory)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('malformed pairing row')
  })
})
