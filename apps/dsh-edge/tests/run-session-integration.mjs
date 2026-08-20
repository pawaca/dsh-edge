/** Run the durable compatibility matrix against both released Worker artifacts. */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const integration = fileURLToPath(new URL('./session.integration.mjs', import.meta.url))
const appRoot = fileURLToPath(new URL('..', import.meta.url))

for (const mode of ['direct', 'isolated']) {
  process.stdout.write(`Running ${mode} release-artifact integration…\n`)
  execFileSync(process.execPath, [integration], {
    cwd: appRoot,
    stdio: 'inherit',
    env: { ...process.env, DSH_EDGE_TEST_RUNTIME_MODE: mode },
  })
}
