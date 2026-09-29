/// <reference types="node" />
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import bootGraph from '../standalone/expected-boot-graph.json' with { type: 'json' }
import { CLIENT_SETTINGS } from '../src/edge-client-settings.ts'

const standaloneRequire = createRequire(new URL('../standalone/package.json', import.meta.url))
const webAppRoot = dirname(standaloneRequire.resolve('@deepseek-ai/dsh-web-app/package.json'))
const webAppRequire = createRequire(join(webAppRoot, 'package.json'))

function hostHalf(name: string): string | undefined {
  for (const resolver of [standaloneRequire, webAppRequire]) {
    try { return resolver.resolve(name) } catch { /* try the next resolution root */ }
  }
  return undefined
}

describe('shipped client settings namespaces', () => {
  // Upstream serves an entry as a namespace only when its Config has live (volatile) fields.
  it('registers every shipped client plugin with live settings, under its upstream entry id', async () => {
    const declared: string[] = []
    for (const { id } of bootGraph) {
      const entry = hostHalf(id)
      if (entry === undefined) continue
      const module = await import(pathToFileURL(entry).href) as { Config?: { toJSON?: () => unknown } }
      const schema = module.Config?.toJSON?.()
      if (schema !== undefined && JSON.stringify(schema).includes('"volatile":true')) declared.push(id)
    }
    expect(CLIENT_SETTINGS.map(row => row.package).sort()).toEqual(declared.sort())

    const composition = readFileSync(join(webAppRoot, 'cordis.patch.yml'), 'utf8')
    const entryIds = new Map([...composition.matchAll(/- id: ([a-z0-9-]+)\s*\n\s+name: '(@deepseek-ai\/[^']+)'/gu)].map(match => [match[2], match[1]]))
    for (const row of CLIENT_SETTINGS) expect(entryIds.get(row.package)).toBe(row.namespace)
  })
})
