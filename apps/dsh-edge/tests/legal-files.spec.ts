import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectLicenseDocuments, renderBundledTerms } from '../scripts/legal-files.mjs'

const directories: string[] = []

function packageDirectory(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-edge-legal-'))
  directories.push(root)
  const path = join(root, 'package')
  mkdirSync(path)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(path, name), content)
  return path
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

describe('bundled license documents', () => {
  it('reproduces and deduplicates package license and notice files', () => {
    const shared = 'BSD terms and copyright notice'
    const documents = collectLicenseDocuments([
      { license: 'BSD-3-Clause', name: 'left', path: packageDirectory({ LICENSE: `${shared}  \r\n` }), version: '1.0.0' },
      { license: 'BSD-3-Clause', name: 'right', path: packageDirectory({ LICENSE: shared, NOTICE: 'Right notice' }), version: '2.0.0' },
    ])

    expect(documents).toHaveLength(2)
    expect(documents.find(document => document.text === shared)?.uses).toEqual([
      { file: 'LICENSE', name: 'left', version: '1.0.0' },
      { file: 'LICENSE', name: 'right', version: '2.0.0' },
    ])
    expect(renderBundledTerms([
      { license: 'BSD-3-Clause', name: 'diff', path: packageDirectory({ LICENSE: shared }), version: '9.0.0' },
    ])).toContain('BSD terms and copyright notice')
  })

  it('fails loud when a package omits terms for an unsupported license', () => {
    expect(() => collectLicenseDocuments([
      { license: 'Unknown-1.0', name: 'missing', path: packageDirectory({}), version: '1.0.0' },
    ])).toThrow('has no distributable license text')
  })

  it('records metadata attribution when a published MIT package omits its license file', () => {
    const [document] = collectLicenseDocuments([{
      author: { name: 'Example Author' },
      license: 'MIT',
      name: 'missing-mit',
      path: packageDirectory({}),
      repository: { url: 'https://example.com/repo' },
      version: '1.2.3',
    }])
    if (document === undefined) throw new Error('expected generated MIT terms')

    expect(document.text).toContain('did not include a license or notice file')
    expect(document.text).toContain('Published package author: Example Author')
    expect(document.text).toContain('https://example.com/repo')
    expect(document.uses).toEqual([
      { file: 'package metadata fallback', name: 'missing-mit', version: '1.2.3' },
    ])
  })
})
