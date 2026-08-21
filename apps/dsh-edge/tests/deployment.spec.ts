import { describe, expect, it } from 'vitest'
import edgePackage from '../package.json' with { type: 'json' }
import assemblyPackage from '../standalone/package.json' with { type: 'json' }
import {
  edgeDeploymentApiKeyConfigured,
  resolveEdgeDeploymentConfig,
  resolveEdgeDeploymentHealth,
  resolveEdgeDeploymentProfile,
  type EdgeDeploymentConfigSource,
} from '../src/deployment.ts'

const VALID_SOURCE: EdgeDeploymentConfigSource = {
  DEEPSEEK_API_KEY: 'sk-edge-deployment-test',
}

describe('dsh-edge deployment configuration', () => {
  it('records the exact upstream version represented by its dependencies', () => {
    const harnessVersions = Object.entries(assemblyPackage.dependencies)
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
      .map(([, version]) => version)
    expect(new Set(harnessVersions)).toEqual(new Set([edgePackage.dshEdge.upstreamVersion]))
  })
  it('resolves the complete default turn configuration before reporting ready', () => {
    expect(resolveEdgeDeploymentConfig(VALID_SOURCE)).toEqual({
      baseURL: 'https://api.deepseek.com',
      maxTokens: 8_192,
      model: 'deepseek-v4-flash',
      reasoningEffort: 'off',
      searchBaseURL: 'https://api.deepseek.com/anthropic/v1',
      streamIdleTimeoutMs: 120_000,
      commandTimeoutPolicy: {
        defaultTimeoutMs: 120_000,
        maxTimeoutMs: 120_000,
      },
    })
    expect(resolveEdgeDeploymentHealth(VALID_SOURCE)).toMatchObject({
      ok: true,
      service: 'dsh-edge',
      shell: 'just-bash-direct',
      deploymentId: 'local-development',
      status: 'ready',
    })
    expect(resolveEdgeDeploymentHealth({ ...VALID_SOURCE, LOADER: {} })).toMatchObject({
      shell: 'just-bash-isolated',
    })
  })

  it('projects validated deployment choices without returning the API key', () => {
    const profile = resolveEdgeDeploymentProfile({
      ...VALID_SOURCE,
      LOADER: {},
      DEEPSEEK_BASE_URL: 'https://gateway.example/v1',
      DEEPSEEK_MODEL: 'deepseek-custom',
      DEEPSEEK_REASONING_EFFORT: 'max',
      DEEPSEEK_SEARCH_BASE_URL: 'https://search-gateway.example/anthropic/v1/',
      DEEPSEEK_MAX_OUTPUT_TOKENS: '4096',
      DEEPSEEK_STREAM_IDLE_TIMEOUT_MS: '30000',
      DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS: '10000',
      DSH_EDGE_MAX_COMMAND_TIMEOUT_MS: '20000',
    })

    expect(profile).toEqual({
      shell: 'just-bash-isolated',
      storage: 'durable-object-sqlite-vfs',
      attachmentStorage: 'unavailable',
      deploymentId: 'local-development',
      apiKeyConfigured: true,
      baseURL: 'https://gateway.example/v1',
      maxTokens: 4_096,
      model: 'deepseek-custom',
      reasoningEffort: 'max',
      searchBaseURL: 'https://search-gateway.example/anthropic/v1',
      streamIdleTimeoutMs: 30_000,
      commandTimeoutPolicy: {
        defaultTimeoutMs: 10_000,
        maxTimeoutMs: 20_000,
      },
    })
    expect(JSON.stringify(profile)).not.toContain(VALID_SOURCE.DEEPSEEK_API_KEY)
    expect(edgeDeploymentApiKeyConfigured({})).toBe(false)
    expect(edgeDeploymentApiKeyConfigured({ DEEPSEEK_API_KEY: '   ' })).toBe(false)
  })

  it('projects the private R2 attachment backend without exposing its binding', () => {
    const profile = resolveEdgeDeploymentProfile({
      ...VALID_SOURCE,
      DSH_EDGE_ATTACHMENTS: { private: 'binding' },
    })

    expect(profile.attachmentStorage).toBe('private-r2')
    expect(resolveEdgeDeploymentHealth({
      ...VALID_SOURCE,
      DSH_EDGE_ATTACHMENTS: {},
    })).toMatchObject({ attachmentStorage: 'private-r2' })
    expect(JSON.stringify(profile)).not.toContain('binding')
  })

  it('omits credential-bearing URL components only from the browser projection', () => {
    const baseURL = 'https://gateway.example/v1?token=query-secret#fragment-secret'
    const source = { ...VALID_SOURCE, DEEPSEEK_BASE_URL: baseURL }

    expect(resolveEdgeDeploymentConfig(source).baseURL).toBe(baseURL)
    expect(resolveEdgeDeploymentProfile(source).baseURL).toBe('https://gateway.example/v1')
    expect(JSON.stringify(resolveEdgeDeploymentProfile(source))).not.toMatch(/query-secret|fragment-secret/u)
    expect(() => resolveEdgeDeploymentProfile({
      ...VALID_SOURCE,
      DEEPSEEK_BASE_URL: 'https://user:password@gateway.example/v1',
    })).toThrow(/without credentials/u)
  })

  it.each([
    [{}, /Configure the DEEPSEEK_API_KEY Worker secret/u],
    [{ ...VALID_SOURCE, DEEPSEEK_BASE_URL: 'file:///tmp/model' }, /valid HTTP\(S\) URL/u],
    [{ ...VALID_SOURCE, DEEPSEEK_MAX_OUTPUT_TOKENS: '0' }, /positive integer/u],
    [{ ...VALID_SOURCE, DEEPSEEK_MODEL: 'bad model' }, /valid model id/u],
    [{ ...VALID_SOURCE, DEEPSEEK_REASONING_EFFORT: 'medium' }, /off, low, high, or max/u],
    [{ ...VALID_SOURCE, DEEPSEEK_SEARCH_BASE_URL: 'file:///tmp/search' }, /valid HTTP\(S\) URL/u],
    [{ ...VALID_SOURCE, DEEPSEEK_SEARCH_BASE_URL: 'https://user:password@search.example/v1' }, /without credentials/u],
    [{ ...VALID_SOURCE, DEEPSEEK_SEARCH_BASE_URL: 'https://search.example/v1?key=secret' }, /query or fragment/u],
    [{ ...VALID_SOURCE, DEEPSEEK_STREAM_IDLE_TIMEOUT_MS: '0' }, /positive integer/u],
    [{
      ...VALID_SOURCE,
      DSH_EDGE_DEFAULT_COMMAND_TIMEOUT_MS: '120001',
      DSH_EDGE_MAX_COMMAND_TIMEOUT_MS: '120000',
    }, /must be no greater/u],
  ] satisfies Array<[EdgeDeploymentConfigSource, RegExp]>) (
    'refuses ready status when deployment choice %# is invalid',
    (source, expected) => {
      expect(() => resolveEdgeDeploymentHealth(source)).toThrow(expected)
    },
  )

  it('accepts the upstream DeepSeek low reasoning effort', () => {
    expect(resolveEdgeDeploymentConfig({
      ...VALID_SOURCE,
      DEEPSEEK_REASONING_EFFORT: 'low',
    }).reasoningEffort).toBe('low')
  })

})
