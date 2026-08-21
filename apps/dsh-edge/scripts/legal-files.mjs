import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePnpmInvocation } from './pnpm-invocation.mjs'

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

const edgeLicense = `MIT License

Copyright (c) 2026 pawaca

${MIT_TERMS}
`

const upstreamLicense = `MIT License

Copyright (c) 2026 DeepSeek

${MIT_TERMS}`

const LEGAL_FILE = /^(?:licen[cs]e|copying|notice)(?:$|[._-])/iu
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const standaloneRoot = join(packageRoot, 'standalone')

function bundledComponents() {
  const invocation = resolvePnpmInvocation(process.env.npm_execpath ?? 'pnpm', [
    '--dir',
    standaloneRoot,
    'licenses',
    'list',
    '--prod',
    '--json',
  ])
  const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`unable to inventory the standalone production closure:\n${result.stdout}${result.stderr}`)
  }

  const report = JSON.parse(result.stdout)
  const components = new Map()
  for (const [license, packages] of Object.entries(report)) {
    if (!Array.isArray(packages)) throw new Error(`invalid pnpm license group ${license}`)
    for (const item of packages) {
      if (typeof item?.name !== 'string' || !Array.isArray(item.versions) || !Array.isArray(item.paths)) {
        throw new Error(`invalid pnpm license entry in ${license}`)
      }
      for (const path of item.paths) {
        if (typeof path !== 'string') throw new Error(`invalid package path for ${item.name}`)
        const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
        if (manifest.os !== undefined || manifest.cpu !== undefined || manifest.libc !== undefined) continue
        if (typeof manifest.version !== 'string' || !item.versions.includes(manifest.version)) {
          throw new Error(`pnpm license versions do not cover ${item.name} at ${path}`)
        }
        const component = {
          license,
          name: item.name,
          version: manifest.version,
          path,
          author: manifest.author,
          repository: manifest.repository,
        }
        const key = `${component.name}\0${component.version}\0${component.license}`
        const current = components.get(key)
        if (current === undefined || component.path.localeCompare(current.path, 'en') < 0) {
          components.set(key, component)
        }
      }
    }
  }
  return [...components.values()].sort((left, right) => (
    left.name.localeCompare(right.name, 'en')
    || left.version.localeCompare(right.version, 'en')
    || left.license.localeCompare(right.license, 'en')
  ))
}

function authorName(author) {
  if (typeof author === 'string' && author.trim() !== '') return author.trim()
  if (author !== null && typeof author === 'object' && typeof author.name === 'string' && author.name.trim() !== '') {
    return author.name.trim()
  }
}

function repositoryUrl(repository) {
  if (typeof repository === 'string' && repository.trim() !== '') return repository.trim()
  if (repository !== null && typeof repository === 'object' && typeof repository.url === 'string' && repository.url.trim() !== '') {
    return repository.url.trim()
  }
}

function normalizeLegalText(text) {
  return text
    .replace(/^\uFEFF/u, '')
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim()
}

function missingLicenseFallback(component, apacheTerms) {
  const author = authorName(component.author) ?? `contributors to ${component.name}`
  const repository = repositoryUrl(component.repository)
  const provenance = [
    `The published ${component.name}@${component.version} package declared ${component.license}`,
    'but did not include a license or notice file.',
    `Attribution from its package metadata: ${author}.`,
    ...(repository === undefined ? [] : [`Repository: ${repository}.`]),
  ].join(' ')
  if (component.license === 'MIT' || component.license === 'MIT OR Apache-2.0') {
    return `${provenance}\n\nThe MIT branch is reproduced for this distribution:\n\nMIT License\n\nPublished package author: ${author}\n\n${MIT_TERMS}`
  }
  if (component.license === 'Apache-2.0' && apacheTerms !== undefined) {
    return `${provenance}\n\n${apacheTerms}`
  }
  throw new Error(`${component.name}@${component.version} has no distributable license text for ${component.license}`)
}

export function collectLicenseDocuments(components) {
  const documents = new Map()
  const componentsWithoutFiles = []
  let apacheTerms
  const addDocument = (text, use) => {
    const normalized = normalizeLegalText(text)
    if (normalized === '') throw new Error(`empty legal text for ${use.name}@${use.version}`)
    const document = documents.get(normalized) ?? { text: normalized, uses: [] }
    document.uses.push(use)
    documents.set(normalized, document)
  }

  for (const component of components) {
    const files = readdirSync(component.path)
      .filter(name => LEGAL_FILE.test(name))
      .sort((left, right) => left.localeCompare(right, 'en'))
    if (files.length === 0) {
      componentsWithoutFiles.push(component)
      continue
    }
    for (const file of files) {
      const text = normalizeLegalText(readFileSync(join(component.path, file), 'utf8'))
      if (component.license === 'Apache-2.0' && /^Apache License\s+Version 2\.0/imu.test(text)) {
        apacheTerms ??= text
      }
      addDocument(text, { file, name: component.name, version: component.version })
    }
  }

  for (const component of componentsWithoutFiles) {
    addDocument(missingLicenseFallback(component, apacheTerms), {
      file: 'package metadata fallback',
      name: component.name,
      version: component.version,
    })
  }

  return [...documents.values()]
    .map(document => ({
      ...document,
      id: createHash('sha256').update(document.text).digest('hex').slice(0, 12),
      uses: document.uses.sort((left, right) => (
        left.name.localeCompare(right.name, 'en')
        || left.version.localeCompare(right.version, 'en')
        || left.file.localeCompare(right.file, 'en')
      )),
    }))
    .sort((left, right) => left.id.localeCompare(right.id, 'en'))
}

export function renderBundledTerms(components) {
  return collectLicenseDocuments(components)
    .map(document => {
      const uses = document.uses
        .map(use => `- \`${use.name}@${use.version}\` (\`${use.file}\`)`)
        .join('\n')
      return `### License/notice ${document.id}\n\nApplies to:\n\n${uses}\n\n\`\`\`text\n${document.text}\n\`\`\``
    })
    .join('\n\n')
}

function renderNotices(components) {
  const inventory = components
    .map(component => `| \`${component.name}@${component.version}\` | \`${component.license}\` |`)
    .join('\n')
  const bundledTerms = renderBundledTerms(components)
  return `<!-- Generated by apps/dsh-edge/scripts/legal-files.mjs — do not edit by hand.
     Run \`pnpm --filter dsh-edge run legal:write\` to regenerate. -->

# Third-Party Notices

\`dsh-edge\` is an independent community project maintained by pawaca. It is not affiliated with or endorsed by DeepSeek.

## DeepSeek Harness

\`dsh-edge\` assembles published DeepSeek Harness packages and applies six version-bound adaptations to the pinned \`0.1.0-rc.7\` release. DeepSeek Harness remains under its upstream MIT license:

\`\`\`text
${upstreamLicense}
\`\`\`

## Bundled component inventory

The following ${components.length} package versions form the conservative, platform-neutral production closure used to assemble the Web and Worker artifacts in this distribution. Platform-specific build binaries that are not distributed in those artifacts are excluded; tree shaking can omit additional code. The inventory and legal texts are generated during packaging rather than referring recipients to a source checkout. License expressions are SPDX identifiers supplied by each package. Dependencies installed separately by npm remain declared in this package's \`package.json\`.

| Component | License |
| --- | --- |
${inventory}

## Bundled license and notice texts

License, copyright, attribution, and NOTICE files supplied by the published packages are reproduced below with line endings and trailing whitespace normalized and identical texts deduplicated. When a package omits those files, the entry records that fact, preserves its published metadata attribution, and reproduces a permitted branch of its declared SPDX terms.

${bundledTerms}
`
}

function legalFiles() {
  const notices = renderNotices(bundledComponents())
  return new Map([
    [join(repositoryRoot, 'LICENSE'), edgeLicense],
    [join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), notices],
    [join(packageRoot, 'LICENSE'), edgeLicense],
    [join(packageRoot, 'THIRD_PARTY_NOTICES.md'), notices],
  ])
}

function verify() {
  for (const [path, expected] of legalFiles()) {
    if (readFileSync(path, 'utf8') !== expected) {
      throw new Error(`${path} is stale; run \`pnpm --filter dsh-edge run legal:write\``)
    }
  }
}

function write() {
  for (const [path, content] of legalFiles()) writeFileSync(path, content)
}

if (process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const action = process.argv[2]
  if (action === 'verify') verify()
  else if (action === 'write') write()
  else throw new Error('Usage: node scripts/legal-files.mjs <verify|write>')
}
