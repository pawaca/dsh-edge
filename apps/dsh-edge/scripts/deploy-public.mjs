/** Deploy the locally built, pinned Direct Worker bundle.
 * Uses Wrangler's existing authenticated session or CLOUDFLARE_API_TOKEN.
 * Does not read, print or transmit DeepSeek secrets from local files.
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { writePrebuiltModeWranglerConfig } from './wrangler-config.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const workerName = process.argv[2] || 'dsh-edge'
if (!/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/u.test(workerName)) {
  throw new Error('Worker name phải hợp lệ, ví dụ: dsh-edge.')
}
const filename = join(root, `.wrangler.public.deploy.${randomUUID()}.json`)
const require = createRequire(import.meta.url)
try {
  await writePrebuiltModeWranglerConfig('direct', filename, { workerName })
  const args = [require.resolve('wrangler'), 'deploy', '--env', '', '--name', workerName, '--config', filename]
  const result = await execa(process.execPath, args, { cwd: root, stdio: 'inherit', reject: false })
  if (result.exitCode !== 0) {
    throw new Error(`Cloudflare không chấp nhận deploy (exit ${String(result.exitCode ?? 'unknown')}).`)
  }
  process.stdout.write('\nĐã gửi bản build tới Cloudflare. Kiểm tra /api/public/config (ready: true) và /owner.\n')
} finally {
  await rm(filename, { force: true })
}
