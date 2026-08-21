const childProcess = require('node:child_process')
const { appendFileSync } = require('node:fs')
const { syncBuiltinESMExports } = require('node:module')

const fixtureWrangler = requireEnvironment('DSH_EDGE_INSTALL_FIXTURE_WRANGLER')
const eventsFile = requireEnvironment('DSH_EDGE_INSTALL_FIXTURE_EVENTS')
const edgePackage = require('../package.json')
const originalSpawn = childProcess.spawn

childProcess.spawn = function spawn(command, args = [], options) {
  const wranglerCommand = args[1]
  if (command === process.execPath
    && typeof args[0] === 'string'
    && ['auth', 'deploy', 'deployments', 'whoami'].includes(wranglerCommand)) {
    return originalSpawn.call(this, command, [fixtureWrangler, eventsFile, ...args.slice(1)], options)
  }
  return originalSpawn.call(this, command, args, options)
}

syncBuiltinESMExports()

globalThis.fetch = async function fetch(input, init = {}) {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL ? input.href : input.url
  const headers = new Headers(init.headers)
  if (url !== 'https://dsh-edge.preview.workers.dev/api/health') {
    throw new Error(`Unexpected activation URL: ${url}`)
  }
  const leakedHeaders = [...headers.keys()].filter(name => (
    name === 'authorization'
    || name === 'cookie'
    || name.includes('key')
    || name.includes('secret')
    || name.includes('token')
  ))
  appendFileSync(eventsFile, `${JSON.stringify({
    kind: 'activation',
    url,
    redirect: init.redirect,
    leakedHeaders,
  })}\n`, 'utf8')
  return Response.json({
    ok: true,
    service: 'dsh-edge',
    status: 'ready',
    storage: 'durable-object-sqlite-vfs',
    shell: 'just-bash-direct',
    deploymentId: `dsh-edge@${edgePackage.version}/direct`,
    version: edgePackage.version,
  })
}

function requireEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required.`)
  return value
}
