#!/usr/bin/env node

import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'

const appDirectory = fileURLToPath(new URL('..', import.meta.url))
const cli = join(appDirectory, 'scripts/cli.mjs')
const preload = fileURLToPath(new URL('./install-keyless-preload.cjs', import.meta.url))
const fixtureWrangler = fileURLToPath(new URL('./install-keyless-wrangler.mjs', import.meta.url))
const PTY_DRIVER = String.raw`
import errno, fcntl, json, os, pty, select, signal, struct, sys, termios, time
node, cli, cwd, launch_env_json, timeout_seconds = sys.argv[1:]
env = os.environ.copy()
env.update(json.loads(launch_env_json))
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(node, [node, cli, "install"], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

steps = [
    (b"Choose a runtime", b"\r"),
    (b"Choose a Cloudflare account", b"\r"),
    (b"Worker name", b"\r"),
    (b"Install this instance?", b"\r"),
    (b"Accept these terms and create a temporary Cloudflare account?", b"y\r"),
    (b"Set the owner access key", b"\r"),
    (b"DeepSeek API key setup", b"\r"),
    (b"DeepSeek API key", b"sk-keyless-no-call\r"),
]
output = bytearray()
step = 0
deadline = time.monotonic() + float(timeout_seconds)
status = None
while time.monotonic() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.05)
    if ready:
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            chunk = b""
        if chunk:
            output.extend(chunk)
    if step < len(steps) and steps[step][0] in output:
        os.write(fd, steps[step][1])
        step += 1
    waited, candidate = os.waitpid(pid, os.WNOHANG)
    if waited == pid:
        status = candidate
        break

if status is None:
    os.kill(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
if step != len(steps):
    sys.stderr.write(f"completed {step}/{len(steps)} installer prompts before timeout\n")
    sys.exit(124)
actual_exit = os.waitstatus_to_exitcode(status)
if actual_exit != 0:
    sys.stderr.write(f"expected installer exit 0, got {actual_exit}\n")
    sys.exit(125)
`

/**
 * Run the shipped installer through a PTY with only its network boundary replaced.
 * @returns {Promise<string>} Stable terminal and process-boundary transcript.
 */
export async function runKeylessInstall() {
  if (process.platform === 'win32') {
    throw new Error('The keyless installer PTY example supports macOS and Linux.')
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-edge-keyless-install-'))
  const bin = join(directory, 'dsh-edge')
  const eventsFile = join(directory, 'events.jsonl')
  try {
    await symlink(cli, bin, 'file')
    const timeoutMs = 20_000
    const result = await execa('python3', [
      '-c',
      PTY_DRIVER,
      process.execPath,
      bin,
      appDirectory,
      JSON.stringify({
        DEEPSEEK_API_KEY: 'ambient-deepseek-must-not-leak',
        DSH_EDGE_INSTALL_FIXTURE_EVENTS: eventsFile,
        DSH_EDGE_INSTALL_FIXTURE_WRANGLER: fixtureWrangler,
        GITHUB_TOKEN: 'ambient-github-must-not-leak',
        NODE_OPTIONS: `--require=${preload}`,
        OTHER_SECRET: 'ambient-secret-must-not-leak',
      }),
      String(timeoutMs / 1_000),
    ], {
      stdin: 'ignore',
      timeout: timeoutMs + 5_000,
      killSignal: 'SIGKILL',
      reject: false,
      stripFinalNewline: false,
    })
    if (result.timedOut || result.failed) {
      throw new Error(
        `Keyless installer example failed. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      )
    }
    const events = (await readFile(eventsFile, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line))
    return [
      'TERMINAL',
      normalizeTerminal(result.stdout),
      'BOUNDARY EVENTS',
      ...events.map(event => JSON.stringify(event)),
      '',
    ].join('\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function normalizeTerminal(source) {
  return stripVTControlCharacters(source)
    .replaceAll('\r', '')
    .replaceAll('sk-keyless-no-call', '{{deepseek-key}}')
    .replace(/Owner access key: [A-Za-z0-9_-]+/u, 'Owner access key: {{generated-access-key}}')
    .replace(/^│  •_.*◇  DeepSeek API key$/gmu, '◇  DeepSeek API key')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line !== '')
    .join('\n')
}

if (process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.stdout.write(await runKeylessInstall())
}
