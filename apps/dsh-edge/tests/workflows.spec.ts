import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflowDirectory = new URL('../../../.github/workflows/', import.meta.url)

function workflow(name: string): string {
  return readFileSync(new URL(name, workflowDirectory), 'utf8')
}

describe('repository workflows', () => {
  it('contains only Edge CI and release automation', () => {
    expect(readdirSync(workflowDirectory).sort()).toEqual(['edge-ci.yml', 'release-edge.yml'])
  })

  it('builds the isolated dependency closure before installing repository tools', () => {
    const source = workflow('edge-ci.yml')
    expect(source.indexOf('pnpm --dir apps/dsh-edge/standalone run build'))
      .toBeLessThan(source.indexOf('pnpm install --frozen-lockfile'))
    expect(source).toContain('node apps/dsh-edge/tests/run-session-integration.mjs')
    expect(source).not.toMatch(/playwright install|build:lib|contracts-ready/u)
  })

  it('publishes through the Edge-owned standalone release command', () => {
    const source = workflow('release-edge.yml')
    expect(source).toContain('node apps/dsh-edge/scripts/publish.mjs --tarball $tarball')
    expect(source).not.toContain('scripts/release/')
  })
})
