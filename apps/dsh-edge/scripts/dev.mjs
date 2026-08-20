/** Serve the exact prebuilt artifact used by the installer. */

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { writePrebuiltModeWranglerConfig } from './wrangler-config.mjs'

const mode = process.argv[2]
if (mode !== 'direct' && mode !== 'isolated') {
  process.stderr.write('Usage: node scripts/dev.mjs <direct|isolated> [wrangler dev options]\n')
  process.exitCode = 2
} else {
  const appDirectory = fileURLToPath(new URL('..', import.meta.url))
  const require = createRequire(import.meta.url)
  // Keep the generated config beside `.dev.vars`; Wrangler resolves local
  // secrets relative to the configuration file rather than the process cwd.
  const configFile = join(appDirectory, `.wrangler.dev.${randomUUID()}.json`)
  try {
    await writePrebuiltModeWranglerConfig(mode, configFile)
    const result = await execa(process.execPath, [
      require.resolve('wrangler'),
      'dev',
      '--config', configFile,
      '--env', mode === 'direct' ? '' : 'isolated',
      ...process.argv.slice(3),
    ], {
      cwd: appDirectory,
      stdio: 'inherit',
      reject: false,
    })
    process.exitCode = result.exitCode ?? 1
  } finally {
    await rm(configFile, { force: true })
  }
}
