import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflowDirectory = new URL('../../../.github/workflows/', import.meta.url)

function workflow(name: string): string {
  return readFileSync(new URL(name, workflowDirectory), 'utf8')
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0
}

describe('repository workflows', () => {
  it('contains only Edge CI and release automation', () => {
    expect(readdirSync(workflowDirectory).sort()).toEqual([
      'edge-ci.yml',
      'release-edge.yml',
      'request-release.yml',
    ])
  })

  it('builds the isolated dependency closure before installing repository tools', () => {
    const source = workflow('edge-ci.yml')
    expect(source).toContain('branches: [main]')
    expect(source).not.toContain('branches: [master]')
    expect(source.indexOf('pnpm --dir apps/dsh-edge/standalone run build'))
      .toBeLessThan(source.indexOf('pnpm install --frozen-lockfile'))
    expect(source).toContain('node apps/dsh-edge/tests/run-session-integration.mjs')
    expect(source).toContain('pnpm --dir apps/dsh-edge pack --pack-destination')
    expect(source).not.toMatch(/playwright install|build:lib|contracts-ready/u)
  })

  it('gates the required check on focused Windows installer verification', () => {
    const source = workflow('edge-ci.yml')
    expect(source).toContain('name: edge / windows installer')
    expect(source).toContain('runs-on: windows-2025')
    expect(source).toContain('node-version: ${{ env.WINDOWS_NODE_VERSION }}')
    expect(source).toContain('pnpm exec vitest run --project edge-runtime apps/dsh-edge/tests/installer.spec.ts')
    expect(source).toContain('needs: [linux, windows-installer]')
    expect(source).toContain('name: edge / verify')
    expect(source).toContain('test "$WINDOWS_RESULT" = success')
  })

  it('uses the reviewed Node 24 action toolchain without an implicit root install', () => {
    const edge = workflow('edge-ci.yml')
    const release = workflow('release-edge.yml')
    const explicitPnpmSetup = /uses: pnpm\/setup@v2\n\s+with:\n\s+install: false/gu

    expect(count(edge, /uses: actions\/checkout@v7/gu)).toBe(2)
    expect(count(edge, /uses: actions\/setup-node@v7/gu)).toBe(2)
    expect(count(edge, /uses: pnpm\/setup@v2/gu)).toBe(2)
    expect(count(edge, explicitPnpmSetup)).toBe(2)
    expect(count(release, /uses: actions\/checkout@v7/gu)).toBe(2)
    expect(count(release, /uses: actions\/setup-node@v7/gu)).toBe(1)
    expect(count(release, /uses: pnpm\/setup@v2/gu)).toBe(1)
    expect(count(release, explicitPnpmSetup)).toBe(1)
    expect(`${edge}\n${release}`).not.toContain('pnpm/action-setup')
  })

  it('publishes through the Edge-owned standalone release command', () => {
    const source = workflow('release-edge.yml')
    expect(source).toContain('repository_dispatch:')
    expect(source).toContain('types: [release-dsh-edge]')
    expect(source).not.toContain("tags: ['dsh-edge-v*']")
    expect(source).toContain('contents: write')
    expect(source).toContain('contents: read')
    expect(source).toContain('fetch-depth: 0')
    expect(source).toContain('git merge-base --is-ancestor "$tag_commit" "$default_commit"')
    expect(source).not.toContain('$tagCommit -ne $defaultCommit')
    expect(source).toContain('publish:\n    needs: verify-source\n    permissions:\n      contents: write\n      id-token: write')
    expect(source).toContain('ref: ${{ needs.verify-source.outputs.release_commit }}')
    expect(source).toContain('Confirm release tag is unchanged')
    expect(source).toContain('pnpm run check')
    expect(source).toContain('pnpm --dir apps/dsh-edge pack --pack-destination')
    expect(source).toContain('node apps/dsh-edge/tests/run-session-integration.mjs')
    expect(source).toContain('pnpm --filter dsh-edge run test:snapshot')
    expect(source).toContain('node apps/dsh-edge/scripts/publish.mjs --tarball $tarball')
    expect(source).toContain('name: Confirm release tag at npm publication boundary')
    expect(source).toContain('name: Confirm release tag at GitHub Release boundary')
    expect(source.indexOf('name: Confirm release tag at npm publication boundary'))
      .toBeLessThan(source.indexOf('name: Publish with npm trusted publishing'))
    expect(source.indexOf('name: Confirm release tag at GitHub Release boundary'))
      .toBeGreaterThan(source.indexOf('name: Publish with npm trusted publishing'))
    expect(source.indexOf('name: Confirm release tag at GitHub Release boundary'))
      .toBeLessThan(source.indexOf('name: Create matching GitHub release'))
    expect(source).toContain("'release', 'create', $tag, $tarball")
    expect(source).toContain("'release', 'edit', $tag")
    expect(source).toContain("'--draft=false'")
    expect(source).toContain('"--prerelease=$prereleaseValue"')
    expect(source).toContain("$arguments += '--latest=false'")
    expect(source).toContain('if ($release.isImmutable)')
    expect(source).toContain('Immutable GitHub release $tag has different metadata')
    expect(source).toContain('gh release download $tag')
    expect(source).toContain('Get-FileHash $downloaded -Algorithm SHA512')
    expect(source).toContain('already immutable with matching metadata and asset')
    expect(source).not.toContain('is immutable and cannot be recovered')
    expect(source.indexOf('gh release upload $tag $tarball'))
      .toBeLessThan(source.indexOf("'release', 'edit', $tag"))
    expect(source).toContain("$arguments += @('--prerelease', '--latest=false')")
    expect(source.indexOf('node apps/dsh-edge/scripts/publish.mjs --tarball $tarball'))
      .toBeLessThan(source.indexOf("'release', 'create', $tag, $tarball"))
    expect(source).not.toContain('scripts/release/')
  })

  it('keeps recovery possible after the default branch advances without accepting a side-branch tag', () => {
    const source = workflow('release-edge.yml')
    const ancestryGate = source.indexOf('git merge-base --is-ancestor "$tag_commit" "$default_commit"')
    const dependencySetup = source.indexOf('uses: pnpm/setup@v2')
    expect(ancestryGate).toBeGreaterThan(-1)
    expect(ancestryGate).toBeLessThan(dependencySetup)
    expect(source.indexOf('id-token: write')).toBeGreaterThan(ancestryGate)
    expect(dependencySetup).toBeLessThan(source.indexOf('pnpm run check'))
    expect(ancestryGate).toBeLessThan(source.indexOf('node apps/dsh-edge/scripts/publish.mjs --tarball $tarball'))
    expect(source).toContain('is not in reviewed default-branch history')
    expect(source).toContain('if [[ "$EVENT_NAME" != "push" && "$tag_commit" != "$default_commit" ]]')
    expect(source).toContain('npm view "dsh-edge@$version" dist.integrity --json')
  })

  it('anchors release authority to the default-branch workflow', () => {
    const request = workflow('request-release.yml')
    const release = workflow('release-edge.yml')
    expect(request).toContain('workflow_dispatch:')
    expect(request).toContain('event_type:"release-dsh-edge"')
    expect(request).not.toContain('id-token: write')
    expect(request).not.toContain('npm publish')
    expect(release).toContain('repository_dispatch:')
    expect(release).toContain("push:\n    tags: ['dsh-edge-v[0-9]*']")
    expect(release).toContain('REQUESTED_TAG: ${{ github.event.client_payload.tag }}')
    expect(release).toContain('origin/main')
  })
})
