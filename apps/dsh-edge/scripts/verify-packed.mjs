import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Resolve npm without asking Windows to execute its `.cmd` shim.
 * @param {{ platform?: NodeJS.Platform, nodeExecutable?: string, environment?: NodeJS.ProcessEnv, pathExists?: (path: string) => boolean }} [options] Resolution inputs.
 * @returns {{ command: string, args: string[] }} Executable and leading arguments for npm.
 */
export function resolveNpmInvocation(options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return { command: 'npm', args: [] }

  const environment = options.environment ?? process.env
  const path = Object.entries(environment)
    .find(([name]) => name.toUpperCase() === 'PATH')?.[1]
  if (path === undefined || path === '') {
    throw new Error('Cannot run npm on Windows because PATH is unavailable')
  }

  const pathExists = options.pathExists ?? existsSync
  for (const rawDirectory of path.split(win32.delimiter)) {
    const directory = rawDirectory.startsWith('"') && rawDirectory.endsWith('"')
      ? rawDirectory.slice(1, -1)
      : rawDirectory
    if (directory === '') continue
    const shim = win32.join(directory, 'npm.cmd')
    const cli = win32.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (pathExists(shim) && pathExists(cli)) {
      return { command: options.nodeExecutable ?? process.execPath, args: [cli] }
    }
  }

  throw new Error('Cannot run npm on Windows because npm-cli.js is not adjacent to an npm.cmd entry on PATH')
}

/**
 * Install and exercise one packed dsh-edge artifact outside the workspace.
 * @param {string | undefined} input Tarball path from the command line.
 */
export function verifyPacked(input) {
  if (input === undefined) throw new Error('Usage: node scripts/verify-packed.mjs <tarball>')
  const tarball = isAbsolute(input) ? input : resolve(process.cwd(), input)
  const directory = mkdtempSync(join(tmpdir(), 'dsh-edge-packed-'))

  function run(command, args) {
    execFileSync(command, args, { cwd: directory, stdio: 'inherit' })
  }

  try {
    const npm = resolveNpmInvocation()
    run(npm.command, [...npm.args, 'install', '--ignore-scripts', '--no-audit', '--no-fund', tarball])
    const packageDirectory = join(directory, 'node_modules', 'dsh-edge')
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
    const dependencies = Object.keys(manifest.dependencies ?? {})
    const sourceRuntimeDependency = dependencies.find(name => (
      name.startsWith('@deepseek-ai/')
      || name === '@cloudflare/computer'
      || name === 'just-bash'
    ))
    if (sourceRuntimeDependency !== undefined) {
      throw new Error(`packed dsh-edge still installs bundled source dependency ${sourceRuntimeDependency}`)
    }
    const license = join(packageDirectory, 'LICENSE')
    const notices = join(packageDirectory, 'THIRD_PARTY_NOTICES.md')
    const licenseText = existsSync(license) ? readFileSync(license, 'utf8') : ''
    if (!licenseText.startsWith('MIT License') || !licenseText.includes('Copyright (c) 2026 pawaca')) {
      throw new Error('packed dsh-edge is missing its MIT license')
    }
    if (licenseText.includes('Copyright (c) 2026 DeepSeek')) {
      throw new Error('packed dsh-edge incorrectly assigns its copyright to DeepSeek')
    }
    const noticesText = existsSync(notices) ? readFileSync(notices, 'utf8') : ''
    if (
      !noticesText.includes('# Third-Party Notices')
      || !noticesText.includes('not affiliated with or endorsed by DeepSeek')
      || !noticesText.includes('Copyright (c) 2026 DeepSeek')
      || !noticesText.includes('## Bundled component inventory')
      || !noticesText.includes('## Bundled license and notice texts')
      || !noticesText.includes('`@cloudflare/computer@0.2.0` | `MIT`')
      || !noticesText.includes('`diff@9.0.0` (`LICENSE`)')
      || !noticesText.includes('Copyright (c) 2009-2015, Kevin Decker')
      || !noticesText.includes('Redistributions in binary form must reproduce')
      || !noticesText.includes('Apache License')
      || noticesText.includes('apps/dsh-edge/standalone/pnpm-lock.yaml')
    ) {
      throw new Error('packed dsh-edge is missing third-party notices')
    }
    run(process.execPath, [join(packageDirectory, 'scripts', 'cli.mjs'), '--version'])
    run(process.execPath, [join(packageDirectory, 'scripts', 'cli.mjs'), '--help'])
    run(process.execPath, [join(packageDirectory, 'scripts', 'smoke-installed.mjs')])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  verifyPacked(process.argv[2])
}
