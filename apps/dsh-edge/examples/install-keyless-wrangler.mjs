import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const [eventsFile, command, ...args] = process.argv.slice(2)
if (eventsFile === undefined || command === undefined) {
  throw new Error('The keyless Wrangler fixture requires an events file and command.')
}

const leakedKeys = Object.keys(process.env)
  .filter(key => /(KEY|PASSWORD|SECRET|TOKEN)/iu.test(key) || key === 'NODE_OPTIONS')
  .sort()

if (command === 'whoami') {
  appendEvent({
    kind: 'wrangler',
    command,
    hasHome: process.env.HOME !== undefined,
    hasPath: process.env.PATH !== undefined,
    leakedKeys,
  })
  process.stdout.write('{"loggedIn":false}\n')
} else if (command === 'deploy') {
  const secretsPath = argumentAfter(args, '--secrets-file')
  const secrets = JSON.parse(readFileSync(secretsPath, 'utf8'))
  if (secrets.DEEPSEEK_API_KEY !== 'sk-keyless-no-call') {
    throw new Error('The keyless example received an unexpected DeepSeek key.')
  }
  if (typeof secrets.DSH_EDGE_ACCESS_KEY !== 'string'
    || Buffer.byteLength(secrets.DSH_EDGE_ACCESS_KEY, 'utf8') < 32) {
    throw new Error('The keyless example did not receive a generated owner key.')
  }
  const outputFile = process.env.WRANGLER_OUTPUT_FILE_PATH
  if (outputFile === undefined) throw new Error('Wrangler output capture was not configured.')
  writeFileSync(outputFile, `${JSON.stringify({
    type: 'deploy',
    version: 1,
    version_id: 'version-keyless',
    targets: ['dsh-edge.preview.workers.dev'],
  })}\n`, 'utf8')
  appendEvent({
    kind: 'wrangler',
    command,
    args: normalizeArgs(args),
    hasOutputCapture: true,
    leakedKeys,
    secretNames: Object.keys(secrets).sort(),
  })
  process.stdout.write(
    'Claim URL: https://dash.cloudflare.com/claim-preview?token={{claim-token}}\n',
  )
} else {
  throw new Error(`Unexpected keyless Wrangler command: ${command}`)
}

function argumentAfter(args, name) {
  const value = args[args.indexOf(name) + 1]
  if (value === undefined) throw new Error(`Missing ${name}.`)
  return value
}

function normalizeArgs(args) {
  const normalized = [...args]
  const configIndex = normalized.indexOf('--config')
  if (configIndex >= 0) normalized[configIndex + 1] = '{{private-config-file}}'
  const secretsIndex = normalized.indexOf('--secrets-file')
  if (secretsIndex >= 0) normalized[secretsIndex + 1] = '{{private-secrets-file}}'
  const defineIndex = normalized.indexOf('--define')
  if (defineIndex >= 0) {
    normalized[defineIndex + 1] = '__DSH_EDGE_DEPLOYMENT_ID__:"{{deployment-id}}"'
  }
  return normalized
}

function appendEvent(event) {
  appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, 'utf8')
}
