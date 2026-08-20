import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unstable_dev } from 'wrangler'
import edgePackage from '../package.json' with { type: 'json' }
import {
  workerArtifactPath,
  writePrebuiltModeWranglerConfig,
} from './wrangler-config.mjs'

const ACCESS_KEY = 'packed-installer-owner-key-32-bytes'
const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-installed-smoke-'))
let worker

try {
  for (const mode of ['direct', 'isolated']) {
    const artifact = workerArtifactPath(mode)
    assert.equal((await stat(artifact)).isFile(), true, `missing ${mode} Worker artifact`)
  }

  for (const mode of ['direct', 'isolated']) {
    const configFile = join(directory, `wrangler-${mode}.json`)
    await writePrebuiltModeWranglerConfig(mode, configFile)
    worker = await unstable_dev(workerArtifactPath(mode), {
      config: configFile,
      env: mode === 'direct' ? '' : 'isolated',
      vars: {
        DEEPSEEK_API_KEY: 'packed-installer-test-key',
        DSH_EDGE_ACCESS_KEY: ACCESS_KEY,
      },
      logLevel: 'error',
      experimental: {
        disableExperimentalWarning: true,
        showInteractiveDevSession: false,
        watch: false,
      },
    })
    const response = await worker.fetch('http://dsh-edge.test/api/health')
    assert.equal(response.status, 200)
    const health = await response.json()
    assert.equal(health.service, 'dsh-edge')
    assert.equal(health.shell, mode === 'direct' ? 'just-bash-direct' : 'just-bash-isolated')
    assert.equal(health.deploymentId, `dsh-edge@${edgePackage.version}/${mode}`)
    await worker.stop()
    worker = undefined
    process.stdout.write(`Installed ${mode} Worker artifact started successfully.\n`)
  }
} finally {
  await worker?.stop()
  await rm(directory, { recursive: true, force: true })
}
