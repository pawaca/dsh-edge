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
  const origin = 'https://dsh-edge.preview.workers.dev'
  const path = url.slice(origin.length)
  const ownerCookie = '__Host-dsh_edge_owner=v1.1234567890.fixture'
  if (!url.startsWith(origin) || !['/api/health', '/api/auth/login', '/api/ready'].includes(path)) {
    throw new Error(`Unexpected activation URL: ${url}`)
  }
  const leakedHeaders = [...headers.keys()].filter(name => (
    name === 'authorization'
    || (name === 'cookie' && path !== '/api/ready')
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
  if (path === '/api/auth/login') {
    if (init.method !== 'POST' || new URLSearchParams(init.body).get('accessKey')?.length < 32) {
      throw new Error('Missing owner login in installation fixture.')
    }
    return new Response(null, { status: 303, headers: { 'set-cookie': `${ownerCookie}; Secure; HttpOnly; Path=/` } })
  }
  if (path === '/api/ready' && headers.get('cookie') !== ownerCookie) {
    throw new Error('Missing authenticated readiness check in installation fixture.')
  }
  return Response.json({
    ...(path === '/api/ready' ? { runtime: true } : {}),
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
