/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const standaloneRequire = createRequire(new URL('../standalone/package.json', import.meta.url))
const sourceDir = new URL('../src/', import.meta.url)

/** Every upstream package the Edge runtime imports, statically or dynamically. */
function importedUpstreamPackages(): string[] {
  const names = new Set<string>()
  for (const file of readdirSync(sourceDir)) {
    if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue
    const source = readFileSync(new URL(file, sourceDir), 'utf8')
    for (const match of source.matchAll(/(?:from\s+|import\(\s*)['"](@deepseek-ai\/[a-z0-9-]+)/gu)) names.add(match[1]!)
  }
  return [...names].sort()
}

function exportsTypert(name: string): boolean {
  const manifest = JSON.parse(readFileSync(standaloneRequire.resolve(`${name}/package.json`), 'utf8')) as {
    exports?: Record<string, unknown>
  }
  return manifest.exports?.['./typert'] !== undefined
}

describe('upstream Typert reflections', () => {
  // The gateway only serves a Remote namespace whose reflection is registered;
  // a mounted package left out answers its Web client's calls as unserved.
  it('registers the reflection of every imported upstream package that exports one', () => {
    const registrations = readFileSync(new URL('session-store.ts', sourceDir), 'utf8')
    const withReflection = importedUpstreamPackages().filter(exportsTypert)
    expect(withReflection.length).toBeGreaterThan(0)
    const missing = withReflection.filter(name => !registrations.includes(`'${name}/typert'`))
    expect(missing).toEqual([])
  })
})
