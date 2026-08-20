import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/dsh-edge/tests/**/*.snapshot.mjs'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
})
