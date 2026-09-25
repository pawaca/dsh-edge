import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import edgePackage from '../package.json' with { type: 'json' }

const appDirectory = fileURLToPath(new URL('..', import.meta.url))
const DIRECT_SHELL_CORE = '@cloudflare/computer/shell/core'
const DIRECT_SHELL_CORE_REPLACEMENT = 'src/direct-shell-core-empty.ts'
const ISOLATED_DIRECT_SHELL = './direct-shell.ts'
const ISOLATED_DIRECT_SHELL_REPLACEMENT = 'src/isolated-direct-shell-unavailable.ts'
const RESERVED_ALIASES = new Set([DIRECT_SHELL_CORE, ISOLATED_DIRECT_SHELL])
const WORKER_ARTIFACTS = Object.freeze({
  direct: 'worker/direct/index.js',
  isolated: 'worker/isolated/index.js',
  // The Container mode deploys the isolated Worker; only its environment differs.
  container: 'worker/isolated/index.js',
})
const PREBUILT_MODES = new Set(Object.keys(WORKER_ARTIFACTS))
/** The public repository each release pushes its Container image to, tagged with the release version. */
export const CONTAINER_IMAGE_REPOSITORY = 'docker.io/pawaca/dsh-edge-computer'
const ATTACHMENT_BINDING = 'DSH_EDGE_ATTACHMENTS'
const ATTACHMENT_STORAGE_BINDING = 'DSH_EDGE_ATTACHMENT_STORAGE'

/** Render one mode-specific build configuration from an already parsed source object. */
export function renderParsedSourceModeWranglerConfig(mode, parsed, options = {}) {
  requireSourceMode(mode)
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
  applyAttachmentStorage(config, mode, options.r2BucketName)
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
  requirePrebuiltMode(mode)
  requireSourceConfig(parsed)
  const root = options.appDirectory ?? appDirectory
  const config = structuredClone(parsed)
  delete config.$schema
  delete config.alias
  delete config.minify
  config.main = resolve(root, WORKER_ARTIFACTS[mode])
  config.assets.directory = resolve(root, parsed.assets.directory)
  // Cloudflare names a Container application from the configuration, not from
  // `wrangler deploy --name`, so each Worker renders its own name.
  if (options.workerName !== undefined) {
    if (typeof options.workerName !== 'string' || options.workerName === '') {
      throw new Error('The Worker name must be a non-empty string.')
    }
    config.name = options.workerName
  }
  config.no_bundle = true
  config.find_additional_modules = false
  applyAttachmentStorage(config, mode, options.r2BucketName)
  if (options.enableImages) {
    const target = modeTarget(config, mode)
    if (isRecord(target)) target.images = { binding: 'IMAGES' }
  }
  if (mode === 'container') resolveContainerImages(config, root, options)
  return `${JSON.stringify(config, undefined, 2)}\n`
}

/** The Container application a Worker's Container mode deploys. */
export function containerApplicationName(workerName) {
  if (typeof workerName !== 'string' || workerName === '') {
    throw new Error('A Worker name is required to name its Container application.')
  }
  return `${workerName}-container`
}

/** The published image reference for one release version. */
export function containerImageReference(version = edgePackage.version) {
  if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Invalid release version for the Container image: ${String(version)}`)
  }
  return `${CONTAINER_IMAGE_REPOSITORY}:${version}`
}

// An installed package deploys the published image for its own version and
// never builds; only development (`localContainerImage`) builds the checked-in
// Dockerfile, resolved beside the source config.
function resolveContainerImages(config, root, options) {
  const containers = config.env?.container?.containers
  if (!Array.isArray(containers) || containers.length === 0) {
    throw new Error('wrangler.jsonc must declare the container environment\'s containers.')
  }
  if (options.localContainerImage === true && options.containerImage !== undefined) {
    throw new Error('Choose either a local Container image build or a registry image, not both.')
  }
  if (options.containerImage !== undefined
    && (typeof options.containerImage !== 'string' || !/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/\S+$/u.test(options.containerImage))) {
    throw new Error('A Container image override must be a registry reference.')
  }
  if (containers.length !== 1) throw new Error('The container environment must declare exactly one container.')
  for (const container of containers) {
    if (!isRecord(container) || typeof container.image !== 'string' || container.image === '') {
      throw new Error('Each container must declare an image.')
    }
    container.name = containerApplicationName(config.name)
    if (options.localContainerImage === true) {
      if (!container.image.startsWith('./') && !container.image.startsWith('../')) {
        throw new Error('A local Container image build needs a Dockerfile path in wrangler.jsonc.')
      }
      container.image = resolve(root, container.image)
    } else {
      container.image = options.containerImage ?? containerImageReference(options.version)
    }
  }
}

function modeTarget(config, mode) {
  return mode === 'direct' ? config : config.env?.[mode]
}

function applyAttachmentStorage(config, mode, bucketName) {
  if (bucketName !== undefined && (typeof bucketName !== 'string' || bucketName.length === 0)) {
    throw new Error('R2 attachment bucket name must be a non-empty string.')
  }
  const target = modeTarget(config, mode)
  if (!isRecord(target)) {
    throw new Error(`wrangler.jsonc must declare the ${mode} environment.`)
  }
  if (target.vars !== undefined && !isRecord(target.vars)) {
    throw new Error('wrangler.jsonc vars must be an object.')
  }
  target.vars = {
    ...target.vars,
    [ATTACHMENT_STORAGE_BINDING]: bucketName === undefined ? 'temporary-do' : 'private-r2',
  }
  if (bucketName === undefined) return
  const binding = [{ binding: ATTACHMENT_BINDING, bucket_name: bucketName }]
  if (mode === 'direct') {
    config.r2_buckets = binding
    return
  }
  target.r2_buckets = binding
}

/** Return the released entrypoint for a runtime mode. */
export function workerArtifactPath(mode, options = {}) {
  requirePrebuiltMode(mode)
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

/** Source builds produce the two Worker artifacts. */
function requireSourceMode(mode) {
  if (mode !== 'direct' && mode !== 'isolated') {
    throw new Error(`Unsupported runtime mode: ${String(mode)}`)
  }
}

/** Prebuilt modes deploy one of those artifacts into a wrangler environment. */
function requirePrebuiltMode(mode) {
  if (!PREBUILT_MODES.has(mode)) {
    throw new Error(`Unsupported runtime mode: ${String(mode)}`)
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value) {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === 'string')
}
