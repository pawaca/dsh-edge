/** Request-owned timeouts: release the timer when the operation settles so an
 * otherwise idle Durable Object can hibernate. AbortSignal.timeout has no cancel.
 */
export function requestDeadline(timeoutMs: number, parent?: AbortSignal): Disposable & { signal: AbortSignal } {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Request timeout must be an integer between 0 and 2147483647 milliseconds.')
  }
  if (parent?.aborted) return { signal: parent, [Symbol.dispose]() {} }
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
  }, timeoutMs)
  return {
    signal: parent === undefined ? controller.signal : AbortSignal.any([parent, controller.signal]),
    [Symbol.dispose]() { clearTimeout(timer) },
  }
}
