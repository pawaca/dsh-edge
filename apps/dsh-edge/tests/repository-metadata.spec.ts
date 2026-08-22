import { describe, expect, it } from 'vitest'
import repositoryPackage from '../../../package.json' with { type: 'json' }
import edgeClientPackage from '../../../packages/client/ui-edge/package.json' with { type: 'json' }
import edgePackage from '../package.json' with { type: 'json' }
import assemblyPackage from '../standalone/package.json' with { type: 'json' }

describe('repository package metadata', () => {
  it('keeps the published installer as the only release-version source', () => {
    for (const manifest of [repositoryPackage, assemblyPackage, edgeClientPackage]) {
      expect(manifest.private).toBe(true)
      expect(manifest).not.toHaveProperty('version')
    }

    expect(edgePackage).not.toHaveProperty('private')
    expect(edgePackage.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
  })

  it('publishes the current product promise and branch-independent project links', () => {
    expect(edgePackage.description).toBe(
      'Your DeepSeek Harness, anywhere — deploy a persistent personal coding agent to Cloudflare Workers in one command',
    )
    expect(edgePackage.homepage).toBe('https://github.com/pawaca/dsh-edge#readme')
    expect(edgePackage.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/pawaca/dsh-edge.git',
      directory: 'apps/dsh-edge',
    })
    expect(edgePackage.keywords).toEqual(expect.arrayContaining([
      'deepseek',
      'deepseek-harness',
      'ai-agents',
      'byok',
      'cloudflare-workers',
      'durable-objects',
      'self-hosted',
    ]))
  })
})
