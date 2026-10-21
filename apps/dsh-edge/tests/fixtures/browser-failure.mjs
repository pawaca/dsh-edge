import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Keep what a failing browser snapshot saw, so a run that cannot be reproduced
 * (the Windows release runners stall now and then) still shows where it stopped:
 * a full-page screenshot and the console and page errors of every open page,
 * written to DSH_EDGE_BROWSER_ARTIFACTS when it is set. CI uploads that
 * directory on failure. Never throws, so the test's own error stays the one
 * reported.
 */
export async function keepFailingBrowserState(name, ...browsers) {
  const dir = process.env.DSH_EDGE_BROWSER_ARTIFACTS
  if (!dir) return
  try {
    await mkdir(dir, { recursive: true })
    let index = 0
    for (const browser of browsers) {
      for (const context of browser?.contexts() ?? []) {
        for (const page of context.pages()) {
          const base = join(dir, `${name}-${String(++index)}`)
          await page.screenshot({ path: `${base}.png`, fullPage: true, timeout: 10_000 }).catch(() => {})
          const lines = [`url: ${page.url()}`]
          for (const message of await page.consoleMessages()) lines.push(`[${message.type()}] ${message.text()}`)
          for (const error of await page.pageErrors()) lines.push(`[pageerror] ${error.stack ?? error.message}`)
          await writeFile(`${base}.console.txt`, `${lines.join('\n')}\n`)
        }
      }
    }
  } catch (error) {
    console.warn(`Could not keep the failing browser state of ${name}:`, error)
  }
}
