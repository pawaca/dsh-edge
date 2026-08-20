/** Promote verified standalone artifacts into dsh-edge's stable release paths. */

import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const standaloneRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = resolve(standaloneRoot, '..')
const target = process.argv[2]
const selections = Object.freeze({
  web: [['dist', 'dist']],
  direct: [['worker/direct', 'worker/direct']],
  isolated: [['worker/isolated', 'worker/isolated']],
  all: [
    ['dist', 'dist'],
    ['worker/direct', 'worker/direct'],
    ['worker/isolated', 'worker/isolated'],
  ],
})

if (!Object.hasOwn(selections, target)) {
  process.stderr.write('Usage: node standalone/scripts/promote.mjs <web|direct|isolated|all>\n')
  process.exitCode = 2
} else {
  try {
    for (const [sourceRelative, destinationRelative] of selections[target]) {
      await promoteDirectory(
        join(standaloneRoot, sourceRelative),
        join(appRoot, destinationRelative),
      )
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

async function promoteDirectory(source, destination) {
  await requirePlainDirectory(source, 'standalone artifact')
  const destinationExists = await requireReplaceableDirectory(destination)

  const parent = dirname(destination)
  const nonce = randomUUID()
  const staging = join(parent, `.${basename(destination)}.staging.${nonce}`)
  const backup = join(parent, `.${basename(destination)}.backup.${nonce}`)
  let backupActive = false
  await mkdir(parent, { recursive: true })
  try {
    await cp(source, staging, { recursive: true, errorOnExist: true, force: false })
    await requireEquivalentTrees(source, staging)
    if (destinationExists) {
      await rename(destination, backup)
      backupActive = true
    }
    try {
      await rename(staging, destination)
      await requireEquivalentTrees(source, destination)
    } catch (error) {
      if (backupActive) {
        try {
          await rm(destination, { recursive: true, force: true })
          await rename(backup, destination)
          backupActive = false
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `Could not promote or restore ${destination}; the backup remains at ${backup}`,
          )
        }
      } else {
        await rm(destination, { recursive: true, force: true })
      }
      throw error
    }
    if (backupActive) {
      await rm(backup, { recursive: true })
      backupActive = false
    }
    process.stdout.write(
      `Promoted ${relative(appRoot, source)} to ${relative(appRoot, destination)}.\n`,
    )
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function requirePlainDirectory(path, label) {
  let entry
  try {
    entry = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Missing ${label}: ${path}`)
    throw error
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symbolic directory: ${path}`)
  }
}

async function requireReplaceableDirectory(path) {
  try {
    const entry = await lstat(path)
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-directory release path: ${path}`)
    }
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function requireEquivalentTrees(expectedRoot, actualRoot) {
  const expected = await tree(expectedRoot)
  const actual = await tree(actualRoot)
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`Promoted artifact differs from its standalone source: ${actualRoot}`)
  }
}

async function tree(root) {
  const entries = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Artifact tree contains a symbolic link: ${path}`)
    if (entry.isDirectory()) {
      for (const child of await tree(path)) entries.push(`${entry.name}/${child}`)
    } else if (entry.isFile()) {
      const contents = await readFile(path)
      entries.push(
        `${entry.name}\0${contents.byteLength}\0${createHash('sha256').update(contents).digest('hex')}`,
      )
    } else {
      throw new Error(`Artifact tree contains an unsupported entry: ${path}`)
    }
  }
  return entries.sort()
}
