/**
 * Profile the promoted Worker artifacts' startup with `wrangler check startup`
 * and reject one whose global scope takes longer than the budget.
 *
 * Cloudflare gives a Worker 1 second of startup CPU to parse and run its
 * global scope (https://developers.cloudflare.com/workers/platform/limits/).
 * The profile runs locally on a different CPU, so the budget leaves margin
 * below that limit and serves as a regression guard, not a measurement of the
 * deployed startup time.
 *
 * Usage: node scripts/check-startup.mjs [direct|isolated|all]
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { writePrebuiltModeWranglerConfig } from './wrangler-config.mjs'

export const STARTUP_BUDGET_MS = 600

/** Startup duration of a V8 CPU profile, in milliseconds. */
export function profileDurationMs(profile) {
  if (typeof profile?.startTime !== 'number' || typeof profile?.endTime !== 'number' || profile.endTime < profile.startTime) {
    throw new Error('The startup profile has no valid start and end times.')
  }
  return (profile.endTime - profile.startTime) / 1000
}

const appDirectory = fileURLToPath(new URL('..', import.meta.url))
const wranglerCli = createRequire(import.meta.url).resolve('wrangler')

async function checkStartup(mode) {
  const directory = await mkdtemp(join(tmpdir(), `dsh-edge-startup-${mode}-`))
  try {
    const config = join(directory, 'wrangler.json')
    const profile = join(directory, 'startup.cpuprofile')
    await writePrebuiltModeWranglerConfig(mode, config, { r2BucketName: 'dsh-edge-startup-check' })
    const result = await execa(process.execPath, [
      wranglerCli, 'check', 'startup',
      '--config', config,
      ...mode === 'isolated' ? ['--env', 'isolated'] : [],
      '--outfile', profile,
    ], { cwd: appDirectory, reject: false, all: true })
    if (result.exitCode !== 0) {
      throw new Error(`wrangler check startup failed for the ${mode} Worker:\n${result.all ?? ''}`)
    }
    const durationMs = profileDurationMs(JSON.parse(await readFile(profile, 'utf8')))
    process.stdout.write(`${mode} Worker startup: ${durationMs.toFixed(0)} ms (budget ${STARTUP_BUDGET_MS} ms, local CPU).\n`)
    if (durationMs > STARTUP_BUDGET_MS) {
      throw new Error(`The ${mode} Worker startup took ${durationMs.toFixed(0)} ms, above the ${STARTUP_BUDGET_MS} ms budget (Cloudflare allows 1000 ms).`)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requested = process.argv[2] ?? 'all'
  const modes = requested === 'all' ? ['direct', 'isolated'] : [requested]
  if (!modes.every(mode => mode === 'direct' || mode === 'isolated')) {
    process.stderr.write('Usage: node scripts/check-startup.mjs [direct|isolated|all]\n')
    process.exitCode = 2
  } else {
    try {
      for (const mode of modes) await checkStartup(mode)
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    }
  }
}
