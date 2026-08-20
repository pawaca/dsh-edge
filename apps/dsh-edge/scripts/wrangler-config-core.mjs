import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDirectory = fileURLToPath(new URL('..', import.meta.url))
const DIRECT_SHELL_CORE = '@cloudflare/computer/shell/core'
const DIRECT_SHELL_CORE_REPLACEMENT = 'src/direct-shell-core-empty.ts'
const ISOLATED_DIRECT_SHELL = './direct-shell.ts'
const ISOLATED_DIRECT_SHELL_REPLACEMENT = 'src/isolated-direct-shell-unavailable.ts'
const RESERVED_ALIASES = new Set([DIRECT_SHELL_CORE, ISOLATED_DIRECT_SHELL])
const WORKER_ARTIFACTS = Object.freeze({
  direct: 'worker/direct/index.js',
  isolated: 'worker/isolated/index.js',
})

/** Render one mode-specific build configuration from an already parsed source object. */
export function renderParsedSourceModeWranglerConfig(mode, parsed, options = {}) {
  requireRuntimeMode(mode)
  requireSourceConfig(parsed)
  const root = options.appDirectory ?? appDirectory
  const aliases = options.aliases ?? {}
  if (!isStringRecord(aliases)) {
    throw new Error('Source-build aliases must map module names to paths.')
  }
  const reservedAlias = Object.keys(aliases).find(alias => RESERVED_ALIASES.has(alias))
  if (reservedAlias !== undefined) {
    throw new Error(`Source-build aliases reserve ${reservedAlias} for mode builds.`)
  }
  if (options.assetsDirectory !== undefined
    && (typeof options.assetsDirectory !== 'string' || options.assetsDirectory === '')) {
    throw new Error('Source-build assetsDirectory must be a non-empty path.')
  }
  const config = structuredClone(parsed)
  delete config.$schema
  config.main = resolve(root, parsed.main)
  config.assets.directory = options.assetsDirectory ?? resolve(root, parsed.assets.directory)
  config.minify = true
  if (mode === 'direct') {
    config.alias = {
      ...config.alias,
      ...aliases,
      [DIRECT_SHELL_CORE]: resolve(root, DIRECT_SHELL_CORE_REPLACEMENT),
    }
  } else {
    config.alias = {
      ...config.alias,
      ...aliases,
      [ISOLATED_DIRECT_SHELL]: resolve(root, ISOLATED_DIRECT_SHELL_REPLACEMENT),
    }
  }
  return `${JSON.stringify(config, undefined, 2)}\n`
}

/** Render an upload configuration from an already parsed source object. */
export function renderParsedPrebuiltModeWranglerConfig(mode, parsed, options = {}) {
  requireRuntimeMode(mode)
  requireSourceConfig(parsed)
  const root = options.appDirectory ?? appDirectory
  const config = structuredClone(parsed)
  delete config.$schema
  delete config.alias
  delete config.minify
  config.main = resolve(root, WORKER_ARTIFACTS[mode])
  config.assets.directory = resolve(root, parsed.assets.directory)
  config.no_bundle = true
  config.find_additional_modules = false
  return `${JSON.stringify(config, undefined, 2)}\n`
}

/** Return the released entrypoint for a runtime mode. */
export function workerArtifactPath(mode, options = {}) {
  requireRuntimeMode(mode)
  return resolve(options.appDirectory ?? appDirectory, WORKER_ARTIFACTS[mode])
}

function requireSourceConfig(parsed) {
  if (!isRecord(parsed)) throw new Error('wrangler.jsonc must contain one object.')
  if (typeof parsed.main !== 'string' || parsed.main === '') {
    throw new Error('wrangler.jsonc must declare a main entry point.')
  }
  if (!isRecord(parsed.assets) || typeof parsed.assets.directory !== 'string'
    || parsed.assets.directory === '') {
    throw new Error('wrangler.jsonc must declare an assets directory.')
  }
  if (parsed.alias !== undefined && !isStringRecord(parsed.alias)) {
    throw new Error('wrangler.jsonc aliases must map module names to paths.')
  }
  const reservedAlias = parsed.alias === undefined
    ? undefined
    : Object.keys(parsed.alias).find(alias => RESERVED_ALIASES.has(alias))
  if (reservedAlias !== undefined) {
    throw new Error(`wrangler.jsonc reserves the ${reservedAlias} alias for mode builds.`)
  }
}

function requireRuntimeMode(mode) {
  if (mode !== 'direct' && mode !== 'isolated') {
    throw new Error(`Unsupported runtime mode: ${String(mode)}`)
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value) {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string')
}
