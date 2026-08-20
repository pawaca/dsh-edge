import { describe, expect, it } from 'vitest'
import { runKeylessInstall } from '../examples/install-keyless.mjs'

describe.skipIf(process.platform === 'win32')('dsh-edge install transcript', () => {
  it('runs the shipped no-account Free installer through its real bin and prompts', async () => {
    await expect(await runKeylessInstall())
      .toMatchFileSnapshot('./snapshots/edge-install.expected.txt')
  }, 30_000)
})
