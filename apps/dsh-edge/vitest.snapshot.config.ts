import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/dsh-edge/tests/**/*.snapshot.mjs'],
    environment: 'node',
    pool: 'forks',
    // Each snapshot owns a Wrangler dev runtime (and one owns Chromium).
    // Serial execution avoids local port/process contention between runtimes.
    // Isolate restarts the fork between files so a long-running test
    // (remote-idle waits 150 s for DO eviction) cannot exhaust the worker
    // and crash subsequent files on memory-constrained Windows runners.
    maxWorkers: 1,
    poolOptions: { forks: { isolate: true } },
    testTimeout: 300_000,
    hookTimeout: 30_000,
    // A poll without its own timeout waits as long as the browser snapshots'
    // other waits: Windows release runners sometimes take tens of seconds to
    // boot the Web client, and vitest's 1 s default failed a release run.
    expect: { poll: { timeout: 30_000 } },
  },
})
