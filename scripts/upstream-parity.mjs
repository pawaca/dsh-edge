/**
 * Upstream parity: every plugin an upstream reference composition mounts and every package in the
 * upstream tool catalog is either used by the Edge or classified in apps/dsh-edge/upstream-parity.json.
 *
 *   node scripts/upstream-parity.mjs [verify]         offline check, part of `pnpm run check`
 *   node scripts/upstream-parity.mjs refresh          rebuild upstream-reference.json for the pinned baseline (network)
 *   node scripts/upstream-parity.mjs wiki <dir>       every upstream subsystem page has a wiki page or an omission reason
 *   node scripts/upstream-parity.mjs docs-diff <ver>  upstream docs/ changes from the pinned baseline to <ver> (network)
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import ts from 'typescript'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = join(repoRoot, 'apps/dsh-edge')
const referencePath = join(appRoot, 'upstream-reference.json')
const manifestPath = join(appRoot, 'upstream-parity.json')
const bootGraphPath = join(appRoot, 'standalone/expected-boot-graph.json')
const upstreamRepo = 'deepseek-ai/deepseek-harness'
const scope = '@deepseek-ai/'

/** Where the reference compositions live in the published packages of one baseline. */
export const REFERENCE_SOURCES = [
  { package: 'dsh-base', files: /^cordis\.patch\.yml$/u },
  { package: 'dsh-web-app', files: /^cordis\.patch\.yml$/u },
  { package: 'dsh-agent-presets', files: /^presets\/[^/]+\/agent\.cordis\.yml$/u },
]

export const STATUSES = {
  substitute: 'Edge serves the same seam with its own implementation',
  'not-applicable': 'needs a host capability Workers do not have',
  tracked: 'open work tracked by an issue',
  declined: 'deliberately not offered',
  gap: 'not ported yet',
}

/** The Edge runs on Linux-like Workers; evaluate the upstream platform gates the same way. */
function disabledOnWorkers(raw) {
  const value = raw.trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (/process\.platform\s*===\s*'win32'/u.test(value)) return false
  if (/process\.platform\s*!==\s*'win32'/u.test(value)) return true
  throw new Error(`upstream-parity: unrecognized disabled expression: ${value}`)
}

/**
 * List the plugin rows of one cordis composition file. A row starts at a `- ` list item; its
 * `name` and `disabled` keys sit at the item's key indentation, so nested groups parse as rows too.
 */
export function parseComposition(text) {
  const rows = []
  let current
  for (const line of text.split('\n')) {
    const item = /^(\s*)- (\w+):\s*(.*)$/u.exec(line)
    if (item) {
      current = { indent: item[1].length + 2, name: undefined, disabled: false }
      rows.push(current)
      assignKey(current, item[2], item[3])
      continue
    }
    const key = /^(\s*)(\w+):\s*(.*)$/u.exec(line)
    if (current && key && key[1].length === current.indent) assignKey(current, key[2], key[3])
  }
  return rows
    .filter(row => row.name?.startsWith(scope))
    .map(({ name, disabled }) => ({ name, disabled }))
}

function assignKey(row, key, raw) {
  const value = raw.replace(/\s+#.*$/u, '').trim()
  if (key === 'name') row.name = value.replace(/^['"]|['"]$/gu, '')
  if (key === 'disabled') row.disabled = disabledOnWorkers(value.replace(/^!!js\s+/u, ''))
}

/** Map each package in the tool catalog's summary table to the model-facing tools it registers. */
export function parseToolCatalog(text) {
  const tools = {}
  for (const line of text.split('\n')) {
    const row = /^\| `(@deepseek-ai\/[^`]+)` \| ([^|]*) \|/u.exec(line)
    if (!row) continue
    tools[row[1]] = [...row[2].matchAll(/`([^`]+)`/gu)].map(match => match[1])
  }
  return tools
}

/** Merge composition rows: a plugin is disabled only when every row naming it is disabled. */
export function mergePlugins(sources) {
  const plugins = {}
  for (const { source, rows } of sources) {
    for (const { name, disabled } of rows) {
      const entry = plugins[name] ??= { in: [], disabled: true }
      if (!entry.in.includes(source)) entry.in.push(source)
      entry.disabled &&= disabled
    }
  }
  return Object.fromEntries(Object.entries(plugins).sort(([a], [b]) => a.localeCompare(b)))
}

function sourceFiles(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(?:ts|mts|js|mjs)$/u.test(name) ? [path] : []
  })
}

/**
 * Collect the upstream specifiers the Edge uses at runtime: value (not type-only) static imports
 * and dynamic imports in the Worker source, plus the reviewed browser boot graph. Parsed with the
 * TypeScript compiler, so imports inside comments or strings never count.
 */
export function collectEdgeUsage(sources, bootGraph) {
  const specifiers = new Set()
  for (const text of sources) {
    const file = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
    const visit = node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !isTypeOnlyImport(node)) {
        addUpstream(specifiers, node.moduleSpecifier.text)
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [argument] = node.arguments
        // `import('x' as string)` hides a specifier from the bundler's type resolution.
        const literal = argument && ts.isAsExpression(argument) ? argument.expression : argument
        if (literal && ts.isStringLiteral(literal)) addUpstream(specifiers, literal.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  for (const node of bootGraph) specifiers.add(node.id)
  const packages = new Set([...specifiers].map(packageOf))
  return { specifiers, packages }
}

function addUpstream(specifiers, specifier) {
  if (specifier.startsWith(scope)) specifiers.add(specifier)
}

function isTypeOnlyImport(declaration) {
  const clause = declaration.importClause
  if (!clause) return false
  if (clause.isTypeOnly) return true
  if (clause.name) return false
  const bindings = clause.namedBindings
  return bindings !== undefined && ts.isNamedImports(bindings)
    && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly)
}

function packageOf(specifier) {
  return specifier.split('/').slice(0, 2).join('/')
}

/** A bare package counts as used through any runtime import; a subpath plugin only by itself. */
function isUsed(name, usage) {
  return name.split('/').length > 2 ? usage.specifiers.has(name) : usage.packages.has(name)
}

/** Everything the Edge must account for: enabled reference plugins and tool-catalog packages. */
export function requiredEntries(reference) {
  const required = new Map()
  for (const [name, plugin] of Object.entries(reference.plugins)) {
    if (!plugin.disabled) required.set(name, plugin.in)
  }
  for (const name of Object.keys(reference.tools)) {
    required.set(name, [...(required.get(name) ?? []), 'tool-catalog'])
  }
  return required
}

export function verifyParity({ upstreamVersion, reference, manifest, usage }) {
  const errors = []
  if (reference.upstreamVersion !== upstreamVersion) {
    errors.push(`upstream-reference.json describes ${reference.upstreamVersion}, but the baseline is ${upstreamVersion}; run \`pnpm run upstream-parity -- refresh\`.`)
  }
  const required = requiredEntries(reference)
  const known = new Set([...Object.keys(reference.plugins), ...Object.keys(reference.tools)])
  const counts = { used: 0 }
  for (const [name, sources] of required) {
    const entry = manifest.packages[name]
    if (isUsed(name, usage)) {
      counts.used += 1
      if (entry) errors.push(`${name} is used by the Edge; remove its "${entry.status}" entry from upstream-parity.json.`)
      continue
    }
    if (!entry) {
      errors.push(`${name} (${sources.join(', ')}) is not used by the Edge and not classified in upstream-parity.json.`)
      continue
    }
    counts[entry.status] = (counts[entry.status] ?? 0) + 1
  }
  for (const [name, entry] of Object.entries(manifest.packages)) {
    if (!known.has(name)) errors.push(`${name} is not in the upstream reference; remove its entry from upstream-parity.json.`)
    if (!(entry.status in STATUSES)) errors.push(`${name} has unknown status "${entry.status}".`)
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') errors.push(`${name} needs a reason.`)
    if (entry.status === 'tracked' && !Number.isInteger(entry.issue)) errors.push(`${name} is tracked but names no issue.`)
  }
  return { errors, counts, required: required.size }
}

/** Every upstream subsystem page needs a wiki page that links it, or an omission reason. */
export function checkWiki({ reference, manifest, pages }) {
  const linked = new Set()
  for (const text of pages) {
    for (const [, slug] of text.matchAll(/subsystems\/([a-z0-9-]+)/gu)) linked.add(slug)
  }
  const omitted = manifest.wikiOmit ?? {}
  const missing = reference.subsystems.filter(slug => !linked.has(slug) && !(slug in omitted))
  const staleOmissions = Object.keys(omitted).filter(slug => !reference.subsystems.includes(slug))
  return { missing, staleOmissions }
}

/**
 * Sort the upstream docs/ changes between two trees into the four review buckets of a baseline
 * upgrade. `relevant` decides whether a changed subsystem page covers something the Edge uses.
 */
export function classifyDocsDiff({ fromTree, toTree, relevant }) {
  const buckets = { subsystemsAdded: [], subsystemsRemoved: [], catalogs: [], edgeSubsystems: [], other: [] }
  const subsystem = path => /^docs\/subsystems\/([a-z0-9-]+)\.md$/u.exec(path)?.[1]
  const paths = new Set([...fromTree.keys(), ...toTree.keys()])
  for (const path of [...paths].sort()) {
    if (!path.startsWith('docs/') || path.endsWith('.zh.md') || path.endsWith('.i18n.yaml')) continue
    const before = fromTree.get(path)
    const after = toTree.get(path)
    if (before === after) continue
    const slug = subsystem(path)
    if (slug && slug !== 'README' && before === undefined) buckets.subsystemsAdded.push(slug)
    else if (slug && slug !== 'README' && after === undefined) buckets.subsystemsRemoved.push(slug)
    else if (/^docs\/[a-z-]*catalog\.(?:md|json)$|^docs\/session-format-status\.md$/u.test(path)) buckets.catalogs.push(path)
    else if (slug && relevant(path)) buckets.edgeSubsystems.push(path)
    else buckets.other.push(path)
  }
  return buckets
}

// ---- network helpers (refresh, docs-diff) ----

async function fetchOk(url, init) {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`upstream-parity: ${url} answered ${String(response.status)}`)
  return response
}

/** Read the regular files of a gzipped npm tarball, keyed by path inside `package/`. */
export function untar(gzipped) {
  const tar = gunzipSync(gzipped)
  const files = new Map()
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/su, '')
    if (name === '') break
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/su, '')
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/su, '').trim() || '0', 8)
    const type = String.fromCharCode(header[156] || 48)
    const path = (prefix ? `${prefix}/${name}` : name).replace(/^package\//u, '')
    if (type === '0') files.set(path, tar.subarray(offset + 512, offset + 512 + size).toString('utf8'))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

async function packageFiles(name, version) {
  const url = `https://registry.npmjs.org/${scope}${name}/-/${name}-${version}.tgz`
  return untar(Buffer.from(await (await fetchOk(url)).arrayBuffer()))
}

async function docsTree(version) {
  const url = `https://api.github.com/repos/${upstreamRepo}/git/trees/dsh-v${version}?recursive=1`
  const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}
  const tree = await (await fetchOk(url, { headers })).json()
  if (tree.truncated) throw new Error(`upstream-parity: the dsh-v${version} tree listing is truncated`)
  return new Map(tree.tree.filter(node => node.type === 'blob' && node.path.startsWith('docs/')).map(node => [node.path, node.sha]))
}

async function docsFile(version, path) {
  return (await fetchOk(`https://raw.githubusercontent.com/${upstreamRepo}/dsh-v${version}/${path}`)).text()
}

/**
 * Build the reference snapshot from fetched upstream inputs. An input that parses to nothing fails
 * loudly: a layout change the parsers miss must not silently erase part of the inventory.
 */
export function assembleReference({ version, compositions, toolCatalog, docsPaths }) {
  const sources = []
  for (const { package: name, files } of REFERENCE_SOURCES) {
    const matched = compositions.filter(file => file.package === name && files.test(file.path))
    if (matched.length === 0) throw new Error(`upstream-parity: ${scope}${name}@${version} has no reference composition; update REFERENCE_SOURCES`)
    for (const { path, text } of matched) {
      const rows = parseComposition(text)
      if (rows.length === 0) throw new Error(`upstream-parity: ${scope}${name}@${version} ${path} parsed to no plugins; update parseComposition`)
      sources.push({ source: `${name}:${path}`, rows })
    }
  }
  const tools = parseToolCatalog(toolCatalog)
  if (Object.keys(tools).length === 0) throw new Error(`upstream-parity: docs/tool-catalog.md at dsh-v${version} parsed to no packages; update parseToolCatalog`)
  const subsystems = docsPaths
    .map(path => /^docs\/subsystems\/([a-z0-9-]+)\.md$/u.exec(path)?.[1])
    .filter(slug => slug !== undefined && slug !== 'README')
    .sort()
  if (subsystems.length === 0) throw new Error(`upstream-parity: dsh-v${version} lists no docs/subsystems pages`)
  return {
    upstreamVersion: version,
    note: 'Generated by `pnpm run upstream-parity -- refresh`; do not edit by hand.',
    plugins: mergePlugins(sources),
    tools,
    subsystems,
  }
}

async function buildReference(version) {
  const compositions = []
  for (const { package: name } of REFERENCE_SOURCES) {
    const contents = await packageFiles(name, version)
    for (const [path, text] of contents) compositions.push({ package: name, path, text })
  }
  const [tree, toolCatalog] = await Promise.all([docsTree(version), docsFile(version, 'docs/tool-catalog.md')])
  return assembleReference({ version, compositions, toolCatalog, docsPaths: [...tree.keys()] })
}

// ---- CLI ----

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function upstreamVersion() {
  return readJson(join(appRoot, 'package.json')).dshEdge.upstreamVersion
}

function edgeUsage() {
  const sources = sourceFiles(join(appRoot, 'src')).map(path => readFileSync(path, 'utf8'))
  return collectEdgeUsage(sources, readJson(bootGraphPath))
}

function markdownFiles(directory) {
  return readdirSync(directory).filter(name => name.endsWith('.md')).map(name => readFileSync(join(directory, name), 'utf8'))
}

async function main([command = 'verify', argument]) {
  if (command === 'verify') {
    const result = verifyParity({ upstreamVersion: upstreamVersion(), reference: readJson(referencePath), manifest: readJson(manifestPath), usage: edgeUsage() })
    if (result.errors.length > 0) throw new Error(`upstream-parity:\n  ${result.errors.join('\n  ')}`)
    const tally = Object.entries(result.counts).map(([status, count]) => `${status} ${String(count)}`).join(', ')
    console.log(`upstream parity: ${String(result.required)} upstream entries accounted for (${tally}).`)
    return
  }
  if (command === 'refresh') {
    const version = upstreamVersion()
    writeFileSync(referencePath, `${JSON.stringify(await buildReference(version), null, 2)}\n`)
    console.log(`upstream parity: wrote ${relative(repoRoot, referencePath)} for ${version}.`)
    return
  }
  if (command === 'wiki') {
    if (!argument) throw new Error('usage: upstream-parity wiki <wiki-checkout>')
    const { missing, staleOmissions } = checkWiki({ reference: readJson(referencePath), manifest: readJson(manifestPath), pages: markdownFiles(argument) })
    for (const slug of missing) console.error(`missing wiki page for upstream subsystem "${slug}"`)
    for (const slug of staleOmissions) console.error(`wikiOmit names "${slug}", which is not an upstream subsystem`)
    if (missing.length > 0 || staleOmissions.length > 0) process.exitCode = 1
    else console.log('upstream parity: every upstream subsystem has a wiki page or an omission reason.')
    return
  }
  if (command === 'docs-diff') {
    if (!argument) throw new Error('usage: upstream-parity docs-diff <target-version>')
    const from = upstreamVersion()
    const [fromTree, toTree] = await Promise.all([docsTree(from), docsTree(argument)])
    const usage = edgeUsage()
    const changed = [...toTree.keys()].filter(path => /^docs\/subsystems\/[a-z0-9-]+\.md$/u.test(path) && fromTree.get(path) !== toTree.get(path))
    const relevantPaths = new Set()
    for (const path of changed) {
      const text = await docsFile(argument, path)
      if ([...text.matchAll(/@deepseek-ai\/[a-z0-9-]+/gu)].some(([name]) => usage.packages.has(name))) relevantPaths.add(path)
    }
    const buckets = classifyDocsDiff({ fromTree, toTree, relevant: path => relevantPaths.has(path) })
    const compare = `https://github.com/${upstreamRepo}/compare/dsh-v${from}...dsh-v${argument}`
    console.log(`# Upstream docs changes ${from} → ${argument}\n\nFull comparison: ${compare}\n`)
    const titles = {
      subsystemsAdded: 'Subsystems added: add a wiki page or a wikiOmit reason',
      subsystemsRemoved: 'Subsystems removed: retire the wiki page',
      catalogs: 'Catalogs changed: re-check parity, configuration, persistence, and session format',
      edgeSubsystems: 'Subsystem pages for packages the Edge uses: review behavior changes',
      other: 'Other docs changes',
    }
    for (const [key, title] of Object.entries(titles)) {
      console.log(`## ${title} (${String(buckets[key].length)})\n`)
      for (const item of buckets[key]) console.log(`- ${item}`)
      console.log('')
    }
    return
  }
  throw new Error(`upstream-parity: unknown command "${command}"`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `pnpm run upstream-parity -- <command>` forwards the separator itself.
  main(process.argv.slice(2).filter(argument => argument !== '--')).catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
