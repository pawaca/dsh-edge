import { describe, expect, it } from 'vitest'
import { resolveNpmInvocation } from '../scripts/verify-packed.mjs'

describe('packed installer verifier', () => {
  it('runs npm directly on POSIX hosts', () => {
    expect(resolveNpmInvocation({ platform: 'linux' })).toEqual({ command: 'npm', args: [] })
  })

  it('runs the npm JavaScript entry through Node on Windows', () => {
    const files = new Set([
      String.raw`D:\tools\npm.cmd`,
      String.raw`D:\tools\node_modules\npm\bin\npm-cli.js`,
    ])

    expect(resolveNpmInvocation({
      platform: 'win32',
      nodeExecutable: String.raw`C:\node\node.exe`,
      environment: { Path: String.raw`"C:\Program Files\Node";D:\tools` },
      pathExists: (path: string) => files.has(path),
    })).toEqual({
      command: String.raw`C:\node\node.exe`,
      args: [String.raw`D:\tools\node_modules\npm\bin\npm-cli.js`],
    })
  })

  it('fails loud when a Windows npm shim has no adjacent JavaScript entry', () => {
    expect(() => resolveNpmInvocation({
      platform: 'win32',
      environment: { PATH: String.raw`C:\node` },
      pathExists: (path: string) => path.endsWith('npm.cmd'),
    })).toThrow('npm-cli.js is not adjacent to an npm.cmd entry on PATH')
  })
})
