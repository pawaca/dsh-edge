const SIZE_UNITS = Object.freeze({
  B: 1,
  KiB: 1024,
  MiB: 1024 * 1024,
})

/** Extract Wrangler's total compressed upload size in bytes. */
export function parseWranglerGzipBytes(output) {
  const match = /Total Upload:[^\n/]+\/ gzip:\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KiB|MiB)/u.exec(output)
  if (match === null) throw new Error('Wrangler did not report a compressed upload size.')
  return Math.ceil(Number(match[1]) * SIZE_UNITS[match[2]])
}

/** Reject a compressed Worker artifact above the repository budget. */
export function requireGzipBudget(output, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer.')
  }
  const actualBytes = parseWranglerGzipBytes(output)
  if (actualBytes > maxBytes) {
    throw new Error(
      `Direct Worker gzip size ${actualBytes} bytes exceeds the ${maxBytes}-byte budget.`,
    )
  }
  return actualBytes
}
