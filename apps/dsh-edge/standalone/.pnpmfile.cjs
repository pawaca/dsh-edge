const UPSTREAM_PACKAGE_PREFIX = '@deepseek-ai/dsh-'
const { dependencies } = require('./package.json')
const UPSTREAM_VERSION = dependencies['@deepseek-ai/dsh-base']

if (typeof UPSTREAM_VERSION !== 'string' || UPSTREAM_VERSION === '') {
  throw new Error('Standalone assembly must pin @deepseek-ai/dsh-base to one exact version.')
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

    if (!dependencies) {
      continue
    }

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
