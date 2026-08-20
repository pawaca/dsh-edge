import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const ignoredDirectories = new Set(['.git', 'dist', 'node_modules', 'worker'])
const manifestHeader = [
  '# Bilingual-pair consistency record: the git blob hash of each side at the',
  '# last confirmed-consistent state. Both languages carry equal authority.',
  '# After editing either side, update both and re-record every pair with:',
  '#   pnpm run doc-pairs -- --write',
]

function findManifests(directory) {
  const manifests = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) manifests.push(...findManifests(join(directory, entry.name)))
    } else if (entry.name.endsWith('.i18n.yaml')) {
      manifests.push(join(directory, entry.name))
    }
  }
  return manifests
}

function blobHash(path) {
  const content = readFileSync(path)
  return createHash('sha1')
    .update(`blob ${String(content.byteLength)}\0`)
    .update(content)
    .digest('hex')
}

function entries(manifest) {
  const parsed = []
  const failures = []
  const lines = readFileSync(manifest, 'utf8').split('\n')
  for (const [index, line] of lines.entries()) {
    if (line === '' || line.startsWith('#')) continue
    const match = /^([^#:]+): ([0-9a-f]{40})$/u.exec(line)
    if (match === null) failures.push(`${manifest}: malformed pairing row ${String(index + 1)}`)
    else parsed.push({ filename: match[1], hash: match[2], index })
  }

  const stem = basename(manifest).slice(0, -'.i18n.yaml'.length)
  const expected = [`${stem}.md`, `${stem}.zh.md`]
  const filenames = parsed.map(entry => entry.filename)
  if (parsed.length !== expected.length || expected.some(filename => !filenames.includes(filename))) {
    failures.push(`${manifest}: must contain exactly ${expected.join(' and ')}`)
  }
  if (new Set(filenames).size !== filenames.length) failures.push(`${manifest}: contains duplicate pairing rows`)
  return { failures, parsed }
}

function verify(manifest) {
  const failures = []
  const lines = readFileSync(manifest, 'utf8').split('\n')
  if (!manifestHeader.every((line, index) => lines[index] === line)) {
    failures.push(`${manifest}: stale instructions; run pnpm run doc-pairs -- --write`)
  }
  const manifestEntries = entries(manifest)
  failures.push(...manifestEntries.failures)
  for (const entry of manifestEntries.parsed) {
    const path = resolve(dirname(manifest), entry.filename)
    if (!existsSync(path) || !statSync(path).isFile()) failures.push(`${manifest}: missing ${entry.filename}`)
    else if (blobHash(path) !== entry.hash) failures.push(`${manifest}: stale hash for ${entry.filename}`)
  }
  return failures
}

function write(manifest) {
  const lines = readFileSync(manifest, 'utf8').split('\n')
  const manifestEntries = entries(manifest)
  if (manifestEntries.failures.length > 0) throw new Error(manifestEntries.failures.join('\n'))
  for (const entry of manifestEntries.parsed) {
    const path = resolve(dirname(manifest), entry.filename)
    if (!existsSync(path)) throw new Error(`${manifest}: missing ${entry.filename}`)
    lines[entry.index] = `${entry.filename}: ${blobHash(path)}`
  }
  const firstEntry = manifestEntries.parsed.at(0).index
  writeFileSync(manifest, [...manifestHeader, ...lines.slice(firstEntry)].join('\n'))
}

const manifests = findManifests(process.cwd()).sort()
if (process.argv.includes('--write')) {
  for (const manifest of manifests) write(manifest)
  console.log(`doc pairs: recorded ${String(manifests.length)} bilingual pair(s)`)
} else {
  const failures = manifests.flatMap(verify)
  if (failures.length > 0) throw new Error(failures.join('\n'))
  console.log(`doc pairs: ${String(manifests.length)} bilingual pair(s) consistent`)
}
