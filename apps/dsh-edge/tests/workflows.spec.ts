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
    expect(source).toContain('pnpm --dir apps/dsh-edge pack --pack-destination')
    expect(source).not.toMatch(/playwright install|build:lib|contracts-ready/u)
  })

  it('publishes through the Edge-owned standalone release command', () => {
    const source = workflow('release-edge.yml')
    expect(source).toContain('contents: write')
    expect(source).toContain('fetch-depth: 0')
    expect(source).toContain('master:refs/remotes/origin/master')
    expect(source).toContain('if ($tagCommit -ne $masterCommit)')
    expect(source).toContain('pnpm run check')
    expect(source).toContain('pnpm --dir apps/dsh-edge pack --pack-destination')
    expect(source).toContain('node apps/dsh-edge/tests/run-session-integration.mjs')
    expect(source).toContain('pnpm --filter dsh-edge run test:snapshot')
    expect(source).toContain('node apps/dsh-edge/scripts/publish.mjs --tarball $tarball')
    expect(source).toContain("'release', 'create', $tag, $tarball")
    expect(source).toContain("'release', 'edit', $tag")
    expect(source).toContain("'--draft=false'")
    expect(source).toContain('"--prerelease=$prereleaseValue"')
    expect(source).toContain("$arguments += '--latest=false'")
    expect(source).toContain('if ($release.isImmutable)')
    expect(source.indexOf('gh release upload $tag $tarball'))
      .toBeLessThan(source.indexOf("'release', 'edit', $tag"))
    expect(source).toContain("$arguments += @('--prerelease', '--latest=false')")
    expect(source.indexOf('node apps/dsh-edge/scripts/publish.mjs --tarball $tarball'))
      .toBeLessThan(source.indexOf("'release', 'create', $tag, $tarball"))
    expect(source).not.toContain('scripts/release/')
  })
})
