import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parse, printParseErrorCode } from 'jsonc-parser'
import {
  renderParsedPrebuiltModeWranglerConfig,
  renderParsedSourceModeWranglerConfig,
  workerArtifactPath,
} from './wrangler-config-core.mjs'

const sourceConfigPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))

export { workerArtifactPath }

/** Render one mode-specific build configuration from the repository source. */
export function renderSourceModeWranglerConfig(mode, source, options = {}) {
  const parsed = parseSourceConfig(source)
  return renderParsedSourceModeWranglerConfig(mode, parsed, options)
}

/** Render an upload configuration that deploys the released Worker without rebuilding it. */
export function renderPrebuiltModeWranglerConfig(mode, source, options = {}) {
  const parsed = parseSourceConfig(source)
  return renderParsedPrebuiltModeWranglerConfig(mode, parsed, options)
}

/** Write the source configuration used to build one released Worker artifact. */
export async function writeSourceModeWranglerConfig(mode, destination, options = {}) {
  const source = await readFile(options.sourceConfigPath ?? sourceConfigPath, 'utf8')
  const rendered = renderSourceModeWranglerConfig(mode, source, options)
  await writePrivateConfig(destination, rendered)
}

/** Write the private no-bundle configuration used by one installation attempt. */
export async function writePrebuiltModeWranglerConfig(mode, destination, options = {}) {
  const source = await readFile(options.sourceConfigPath ?? sourceConfigPath, 'utf8')
  const rendered = renderPrebuiltModeWranglerConfig(mode, source, options)
  await writePrivateConfig(destination, rendered)
}

async function writePrivateConfig(destination, rendered) {
  await writeFile(destination, rendered, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}

function parseSourceConfig(source) {
  const errors = []
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
