const UPSTREAM_PACKAGE_PREFIX = '@deepseek-ai/dsh-'
const { dshEdge } = require('./apps/dsh-edge/package.json')
const UPSTREAM_VERSION = dshEdge?.upstreamVersion

if (typeof UPSTREAM_VERSION !== 'string' || UPSTREAM_VERSION === '') {
  throw new Error('The repository must declare one exact dsh-edge upstream version.')
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

function pinUpstreamDependencies(packageManifest) {
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = packageManifest[field]
    if (!dependencies) continue
    for (const dependencyName of Object.keys(dependencies)) {
      if (dependencyName.startsWith(UPSTREAM_PACKAGE_PREFIX)) {
        dependencies[dependencyName] = UPSTREAM_VERSION
      }
    }
  }
  return packageManifest
}

module.exports = {
  hooks: {
    readPackage: pinUpstreamDependencies,
  },
}
