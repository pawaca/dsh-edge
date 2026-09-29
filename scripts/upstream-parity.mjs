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

/**
 * Where the reference compositions live in the published packages of one baseline. `units`
 * names the files that each announce one composition (a preset's `preset.yml`); every unit must
 * have a matched composition beside it, so moving a single preset fails instead of dropping it.
 */
export const REFERENCE_SOURCES = [
  { package: 'dsh-base', files: /^cordis\.patch\.yml$/u },
  { package: 'dsh-web-app', files: /^cordis\.patch\.yml$/u },
  { package: 'dsh-agent-presets', files: /^presets\/[^/]+\/agent\.cordis\.yml$/u, units: /^presets\/[^/]+\/preset\.yml$/u },
]

/** Any file that looks like a cordis composition; each one in a reference package must be matched. */
const COMPOSITION_CANDIDATE = /(?:^|\/)[^/]*cordis[^/]*\.ya?ml$/u

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
  // Only the complete expressions: an extra condition must fail as unknown, not be ignored.
  if (/^process\.platform\s*===\s*'win32'$/u.test(value)) return false
  if (/^process\.platform\s*!==\s*'win32'$/u.test(value)) return true
  throw new Error(`upstream-parity: unrecognized disabled expression: ${value}`)
}

/**
 * List the plugin rows of one cordis composition file. A row starts at a `- ` list item; its
 * `name` and `disabled` keys sit at the item's key indentation, so nested groups parse as rows too.
 * Every scoped `name:` anywhere in the text, whatever its YAML form, must come out as a row, so a
 * row written in a layout this parser does not read fails instead of disappearing.
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
  const parsed = rows
    .filter(row => row.name?.startsWith(scope))
    .map(({ name, disabled }) => ({ name, disabled }))
  // Compare occurrences, not names: a package mounted twice needs both rows read.
  const remaining = new Map()
  for (const { name } of parsed) remaining.set(name, (remaining.get(name) ?? 0) + 1)
  const unread = []
  for (const line of text.split('\n')) {
    const code = line.replace(/(^|\s)#.*$/u, '')
    for (const [, name] of code.matchAll(/\bname:\s*['"]?(@deepseek-ai\/[a-z0-9./-]+)/gu)) {
      const left = remaining.get(name) ?? 0
      if (left === 0) unread.push(name)
      else remaining.set(name, left - 1)
    }
  }
  if (unread.length > 0) throw new Error(`upstream-parity: composition rows the parser did not read: ${unread.join(', ')}; update parseComposition`)
  return parsed
}

function assignKey(row, key, raw) {
  const value = raw.replace(/\s+#.*$/u, '').trim()
  if (key === 'name') row.name = value.replace(/^['"]|['"]$/gu, '')
  if (key === 'disabled') row.disabled = disabledOnWorkers(value.replace(/^!!js\s+/u, ''))
}

/**
 * Map each package in the tool catalog's summary table to the model-facing tools it registers.
 * The catalog also gives every package its own `## \`package\`` section, so the two views are
 * cross-checked: a row whose formatting the parser misses, or a row that disappears, fails
 * instead of silently dropping that package from the inventory.
 */
export function parseToolCatalog(text) {
  const tools = {}
  const sections = new Set()
  const unreadable = []
  for (const line of text.split('\n')) {
    const section = /^##\s.*?(@deepseek-ai\/[a-z0-9-]+)/u.exec(line)
    if (section) sections.add(section[1])
    if (!/^\|[^|]*@deepseek-ai\//u.test(line)) continue
    const row = /^\| `(@deepseek-ai\/[^`]+)` \| ([^|]*) \|/u.exec(line)
    if (!row) {
      unreadable.push(line)
      continue
    }
    tools[row[1]] = [...row[2].matchAll(/`([^`]+)`/gu)].map(match => match[1])
  }
  if (unreadable.length > 0) throw new Error(`upstream-parity: unreadable tool-catalog rows; update parseToolCatalog:\n  ${unreadable.join('\n  ')}`)
  const rows = new Set(Object.keys(tools))
  const missingRows = [...sections].filter(name => !rows.has(name))
  const missingSections = [...rows].filter(name => !sections.has(name))
  if (missingRows.length > 0 || missingSections.length > 0) {
    throw new Error(`upstream-parity: the tool-catalog table and its sections disagree (no row: ${missingRows.join(', ') || 'none'}; no section: ${missingSections.join(', ') || 'none'}); update parseToolCatalog`)
  }
  return tools
}

/** Merge composition rows: a plugin is disabled only when every row naming it is disabled. */
export function mergePlugins(sources) {
  const plugins = {}
  for (const { source, rows } of sources) {
    for (const { name, disabled } of rows) {
      const entry = own(plugins, name) ?? (plugins[name] = { in: [], disabled: true })
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
  const counts = { used: 0 }
  for (const [name, sources] of required) {
    const entry = own(manifest.packages, name)
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
  for (const name of Object.keys(manifest.packages)) {
    // Stale unless still required: a plugin upstream now disables everywhere drops its
    // classification, so re-enabling it later forces a fresh review.
    if (!required.has(name)) errors.push(`${name} is not required by the upstream reference; remove its entry from upstream-parity.json.`)
  }
  errors.push(...validateManifest(manifest))
  return { errors, counts, required: required.size }
}

const ENTRY_KEYS = new Set(['status', 'reason', 'issue', 'priority'])
const PRIORITIES = new Set(['P1', 'P2', 'P3'])

/** The manifest's own shape: every field the check trusts is validated in one place. */
export function validateManifest(manifest) {
  const errors = []
  for (const [name, entry] of Object.entries(manifest.packages ?? {})) {
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) errors.push(`${name} has unknown field "${key}".`)
    }
    if (own(STATUSES, entry.status) === undefined) errors.push(`${name} has unknown status "${String(entry.status)}".`)
    if (!hasReason(entry.reason)) errors.push(`${name} needs a reason.`)
    if (entry.issue !== undefined && !isIssueNumber(entry.issue)) errors.push(`${name} names an invalid issue ${JSON.stringify(entry.issue)}.`)
    if (entry.status === 'tracked' && entry.issue === undefined) errors.push(`${name} is tracked but names no issue.`)
    if (entry.priority !== undefined && (entry.status !== 'gap' || !PRIORITIES.has(entry.priority))) {
      errors.push(`${name} has priority ${JSON.stringify(entry.priority)}; only gap entries take P1, P2, or P3.`)
    }
  }
  for (const [slug, reason] of Object.entries(manifest.wikiOmit ?? {})) {
    if (!hasReason(reason)) errors.push(`wikiOmit "${slug}" needs a reason.`)
  }
  return errors
}

function isIssueNumber(value) {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * Read an own property only. Manifest and table lookups never consult Object.prototype, so a
 * value such as "constructor" or "__proto__" cannot pass for a status, entry, or reason.
 */
function own(object, key) {
  return typeof key === 'string' && Object.hasOwn(object, key) ? object[key] : undefined
}

function hasReason(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** Every upstream subsystem page needs a wiki page that links it, or an omission reason. */
export function checkWiki({ reference, manifest, pages }) {
  const linked = new Set()
  for (const text of pages) {
    for (const [, slug] of text.matchAll(/subsystems\/([a-z0-9-]+)/gu)) linked.add(slug)
  }
  const omitted = manifest.wikiOmit ?? {}
  const missing = reference.subsystems.filter(slug => !linked.has(slug) && !hasReason(own(omitted, slug)))
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

/** Whether any of the page versions names a package the Edge uses. */
export function mentionsUsedPackage(texts, usage) {
  return texts.some(text => [...text.matchAll(/@deepseek-ai\/[a-z0-9-]+/gu)].some(([name]) => usage.packages.has(name)))
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
  for (const { package: name, files, units } of REFERENCE_SOURCES) {
    const packageFiles = compositions.filter(file => file.package === name)
    const matched = packageFiles.filter(file => files.test(file.path))
    if (matched.length === 0) throw new Error(`upstream-parity: ${scope}${name}@${version} has no reference composition; update REFERENCE_SOURCES`)
    // Every composition the package ships is read: a moved or renamed file fails here.
    for (const { path } of packageFiles) {
      if (COMPOSITION_CANDIDATE.test(path) && !files.test(path)) {
        throw new Error(`upstream-parity: ${scope}${name}@${version} ships ${path}, which REFERENCE_SOURCES does not read`)
      }
      if (units?.test(path) && !matched.some(file => dirname(file.path) === dirname(path))) {
        throw new Error(`upstream-parity: ${scope}${name}@${version} ${path} has no matched composition beside it; update REFERENCE_SOURCES`)
      }
    }
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
      // Both versions: a page that drops its last mention of a used package is still relevant.
      const texts = await Promise.all([
        fromTree.has(path) ? docsFile(from, path) : '',
        docsFile(argument, path),
      ])
      if (mentionsUsedPackage(texts, usage)) relevantPaths.add(path)
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
