import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'edge-runtime',
          include: [
            'apps/dsh-edge/tests/**/*.spec.ts',
            'scripts/**/*.spec.{ts,mjs}',
          ],
          environment: 'node',
          pool: 'forks',
        },
      },
      {
        test: {
          name: 'edge-client',
          include: ['packages/client/ui-edge/tests/**/*.spec.{ts,tsx}'],
          environment: 'jsdom',
          pool: 'forks',
          setupFiles: ['packages/client/ui-edge/tests/setup.ts'],
          deps: {
            web: {
              transformAssets: true,
              transformCss: true,
            },
          },
        },
      },
    ],
  },
})
