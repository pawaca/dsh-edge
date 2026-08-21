/** Build one Worker mode from Edge-owned source plus pinned published packages. */

import { createRequire } from 'node:module'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { parse, printParseErrorCode } from 'jsonc-parser'
import edgePackage from '../../package.json' with { type: 'json' }
import { requireGzipBudget } from '../../scripts/bundle-size.mjs'
import { renderParsedSourceModeWranglerConfig } from '../../scripts/wrangler-config-core.mjs'

const DIRECT_GZIP_BUDGET_BYTES = 900 * 1024
const standaloneDirectory = fileURLToPath(new URL('..', import.meta.url))
const appDirectory = resolve(standaloneDirectory, '..')
const standaloneRequire = createRequire(join(standaloneDirectory, 'package.json'))
const wranglerCli = standaloneRequire.resolve('wrangler')
const mode = process.argv[2]

if (mode !== 'direct' && mode !== 'isolated') {
  process.stderr.write('Usage: node scripts/bundle-standalone.mjs <direct|isolated>\n')
  process.exitCode = 2
} else {
  const directory = await mkdtemp(join(tmpdir(), `dsh-edge-standalone-${mode}-bundle-`))
  try {
    const configFile = join(directory, 'wrangler.json')
    const outputDirectory = join(directory, 'worker')
    const sourceConfig = await readSourceConfig()
    const config = renderParsedSourceModeWranglerConfig(mode, sourceConfig, {
      appDirectory,
      aliases: await publishedPackageAliases(),
      assetsDirectory: join(standaloneDirectory, 'dist'),
    })
    await writeFile(configFile, config, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const result = await execa(process.execPath, [
      wranglerCli,
      'deploy',
      '--config', configFile,
      '--env', mode === 'direct' ? '' : 'isolated',
      '--define',
      `__DSH_EDGE_DEPLOYMENT_ID__:${JSON.stringify(`dsh-edge@${edgePackage.version}/${mode}`)}`,
      '--dry-run',
      '--outdir', outputDirectory,
      '--metafile',
    ], {
      cwd: appDirectory,
      reject: false,
      all: true,
    })
    const output = result.all ?? `${result.stdout}\n${result.stderr}`
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`)
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode
    } else {
      await requirePublishedDependencyInputs(join(outputDirectory, 'bundle-meta.json'))
      if (mode === 'direct') {
        let bytes
        try {
          bytes = requireGzipBudget(output, DIRECT_GZIP_BUDGET_BYTES)
        } catch (error) {
          await reportLargestInputs(join(outputDirectory, 'bundle-meta.json'))
          throw error
        }
        process.stdout.write(
          `Standalone direct Worker gzip budget: ${bytes}/${DIRECT_GZIP_BUDGET_BYTES} bytes.\n`,
        )
      }
      await publishArtifact(mode, join(outputDirectory, 'index.js'))
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function publishedPackageAliases() {
  const specifiers = new Set()
  for (const path of await sourceFiles(join(appDirectory, 'src'))) {
    const source = await readFile(path, 'utf8')
    for (const match of source.matchAll(
      /['"]((?:@deepseek-ai|@cloudflare)\/[^'"]+|(?:just-bash|fast-png|jpeg-js)(?:\/[^'"]*)?)['"]/g,
    )) {
      specifiers.add(match[1])
    }
  }
  const aliases = {}
  for (const specifier of [...specifiers].sort()) {
    const name = packageName(specifier)
    const directory = await resolvePackageDirectory(name)
    aliases[specifier] = specifier === name
      ? await resolvePackageRoot(directory)
      : await resolvePackageExport(specifier, name, directory)
  }
  return aliases
}

async function readSourceConfig() {
  const errors = []
  const source = await readFile(join(appDirectory, 'wrangler.jsonc'), 'utf8')
  const parsed = parse(source, errors, {
    allowEmptyContent: false,
    allowTrailingComma: true,
    disallowComments: false,
  })
  if (errors.length > 0) {
    const detail = errors.map(error => printParseErrorCode(error.error)).join(', ')
    throw new Error(`Could not parse wrangler.jsonc: ${detail}.`)
  }
  return parsed
}

async function resolvePackageDirectory(name) {
  const directory = join(standaloneDirectory, 'node_modules', ...name.split('/'))
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  if (manifest.name !== name) {
    throw new Error(`Installed package ${name} resolved to manifest ${String(manifest.name)}.`)
  }
  return directory
}

async function resolvePackageRoot(directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const target = manifest.exports?.['.'] ?? manifest.exports
  const path = exportPath(target)
  return path === undefined ? directory : join(directory, path)
}

async function resolvePackageExport(specifier, name, directory) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const subpath = `.${specifier.slice(name.length)}`
  let matchedSubpath = subpath
  let target = manifest.exports?.[subpath]
  if (target === undefined) {
    matchedSubpath = Object.keys(manifest.exports ?? {}).find(key => {
      if (!key.includes('*')) return false
      const [prefix, suffix] = key.split('*')
      return subpath.startsWith(prefix) && subpath.endsWith(suffix)
    })
    target = matchedSubpath === undefined ? undefined : manifest.exports[matchedSubpath]
  }
  let path = exportPath(target)
  if (path === undefined) {
    throw new Error(`${name} does not export ${subpath} for the standalone Worker build.`)
  }
  if (matchedSubpath?.includes('*')) {
    const [prefix, suffix] = matchedSubpath.split('*')
    const wildcard = subpath.slice(prefix.length, subpath.length - suffix.length)
    path = path.replace('*', wildcard)
  }
  return join(directory, path)
}

function exportPath(target) {
  if (typeof target === 'string') return target
  if (target === null || typeof target !== 'object') return undefined
  return exportPath(target.worker)
    ?? exportPath(target.browser)
    ?? exportPath(target.import)
    ?? exportPath(target.default)
}

async function sourceFiles(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(path))
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

function packageName(specifier) {
  if (!specifier.startsWith('@')) return specifier.split('/')[0]
  return specifier.split('/').slice(0, 2).join('/')
}

async function publishArtifact(runtimeMode, source) {
  const destinationDirectory = join(standaloneDirectory, 'worker', runtimeMode)
  const destination = join(destinationDirectory, 'index.js')
  await removeGeneratedDirectory(destinationDirectory)
  await mkdir(destinationDirectory, { recursive: true, mode: 0o755 })
  const bundle = (await readFile(source, 'utf8'))
    .replace(/\n\/\/# sourceMappingURL=index\.js\.map\s*$/u, '\n')
  await writeFile(destination, bundle, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
  process.stdout.write(`Wrote standalone ${runtimeMode} Worker artifact to ${destination}.\n`)
}

async function reportLargestInputs(metafilePath) {
  const metafile = JSON.parse(await readFile(metafilePath, 'utf8'))
  const bytesByInput = new Map()
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const [path, detail] of Object.entries(output.inputs ?? {})) {
      bytesByInput.set(path, (bytesByInput.get(path) ?? 0) + Number(detail.bytesInOutput ?? 0))
    }
  }
  const largest = [...bytesByInput]
    .filter(([, bytes]) => bytes > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10)
  process.stderr.write('Largest standalone Worker inputs:\n')
  for (const [path, bytes] of largest) {
    process.stderr.write(`  ${bytes} bytes  ${path}\n`)
  }
}

async function requirePublishedDependencyInputs(metafilePath) {
  const metafile = JSON.parse(await readFile(metafilePath, 'utf8'))
  for (const path of Object.keys(metafile.inputs ?? {})) {
    if (path.includes('/packages/') && !path.includes('/node_modules/')) {
      throw new Error(`Standalone Worker imported upstream workspace source: ${path}`)
    }
    const isPinnedRuntimeDependency = path.includes('@deepseek-ai')
      || path.includes('@deepseek-ai+')
      || path.includes('@cloudflare+computer')
      || path.includes('just-bash')
      || path.includes('fast-png')
      || path.includes('jpeg-js')
    if (isPinnedRuntimeDependency
      && !path.includes('/apps/dsh-edge/standalone/node_modules/')) {
      throw new Error(`Standalone Worker resolved a runtime dependency outside its lock: ${path}`)
    }
  }
}

async function removeGeneratedDirectory(directory) {
  try {
    const entry = await lstat(directory)
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-directory Worker artifact path: ${directory}`)
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  await rm(directory, { recursive: true })
}
