const SIZE_UNITS = Object.freeze({
  B: 1,
  KiB: 1024,
  MiB: 1024 * 1024,
})

/**
 * Cloudflare's Worker size limit: 64 MiB uncompressed on Workers Free and Paid.
 * There is no compressed-size limit; Wrangler's gzip figure is for reference.
 * https://developers.cloudflare.com/workers/platform/limits/
 */
export const WORKER_SIZE_LIMIT_BYTES = 64 * 1024 * 1024

/** Extract Wrangler's total upload sizes (uncompressed and gzip) in bytes. */
export function parseWranglerUploadSizes(output) {
  const match = /Total Upload:\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KiB|MiB)\s*\/ gzip:\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KiB|MiB)/u.exec(output)
  if (match === null) throw new Error('Wrangler did not report the upload size.')
  return {
    bytes: Math.ceil(Number(match[1]) * SIZE_UNITS[match[2]]),
    gzipBytes: Math.ceil(Number(match[3]) * SIZE_UNITS[match[4]]),
  }
}

/** Reject a Worker artifact above Cloudflare's uncompressed size limit. */
export function requireWorkerSizeLimit(output, maxBytes = WORKER_SIZE_LIMIT_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive safe integer.')
  }
  const sizes = parseWranglerUploadSizes(output)
  if (sizes.bytes > maxBytes) {
    throw new Error(
      `Worker size ${sizes.bytes} bytes exceeds Cloudflare's ${maxBytes}-byte uncompressed limit.`,
    )
  }
  return sizes
}
