const childProcess = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')

const fixtureWrangler = requireEnvironment('DSH_EDGE_INSTALL_FIXTURE_WRANGLER')
const eventsFile = requireEnvironment('DSH_EDGE_INSTALL_FIXTURE_EVENTS')
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

function requireEnvironment(name) {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required.`)
  return value
}
