import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/dsh-edge/tests/**/*.snapshot.mjs'],
    environment: 'node',
    pool: 'forks',
    // Each snapshot owns a Wrangler dev runtime (and one owns Chromium).
    // Serial execution avoids local port/process contention between runtimes.
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
})
