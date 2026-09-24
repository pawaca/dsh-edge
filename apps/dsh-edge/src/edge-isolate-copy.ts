/**
 * JavaScript source shared by the modules each Dynamic Worker isolate loads
 * (workflow runs and code runs). It copies values that are about to cross an
 * RpcTarget bridge into fresh plain JSON data within a byte budget, using
 * primitives captured when the module loads, before any model-written module
 * evaluates. `raise(message, overBudget)` must throw; callers map it to their
 * own failure types.
 */
export const ISOLATE_COPY_SOURCE = `// Captured when this module loads, before the body module evaluates, so a
// script that replaces JSON, Object, Array, or String members cannot change
// how bridge payloads are copied and measured.
const captured = {
  keys: Object.keys,
  getPrototypeOf: Object.getPrototypeOf,
  symbols: Object.getOwnPropertySymbols,
  defineProperty: Object.defineProperty,
  isArray: Array.isArray,
  charCodeAt: Function.prototype.call.bind(String.prototype.charCodeAt),
  slice: Function.prototype.call.bind(String.prototype.slice),
}

function utf8Length(text) {
  let size = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = captured.charCodeAt(text, index)
    if (code < 0x80) size += 1
    else if (code < 0x800) size += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      size += 4
      index += 1
    } else size += 3
  }
  return size
}

/**
 * Return a copier that turns values into fresh plain JSON data within one
 * byte budget. Only the copy crosses the bridge: every property is read once,
 * so getters, proxies, and toJSON hooks cannot change what was measured.
 */
function boundedCopier(limit, what, raise) {
  let left = limit
  const fail = (path, reason) => raise(what + ' ' + path + ': ' + reason, false)
  const spend = amount => {
    left -= amount
    if (left < 0) raise(what + ' is over the ' + limit + '-byte limit; pass smaller inputs or references', true)
  }
  const copy = (item, path, ancestors) => {
    switch (typeof item) {
      case 'string':
        spend(utf8Length(item) + 2)
        return item
      case 'number':
        if (item !== item || item === Infinity || item === -Infinity) fail(path, 'non-finite numbers are not JSON data')
        spend(('' + item).length)
        return item
      case 'boolean':
        spend(5)
        return item
      case 'object':
        break
      default:
        fail(path, typeof item + ' values are not JSON data')
    }
    if (item === null) {
      spend(4)
      return null
    }
    for (let node = ancestors; node !== null; node = node.parent) {
      if (node.item === item) fail(path, 'circular references are not JSON data')
    }
    if (captured.symbols(item).length > 0) fail(path, 'symbol-keyed properties are not JSON data')
    const chain = { item, parent: ancestors }
    const define = (target, key, value) => {
      captured.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
    }
    if (captured.isArray(item)) {
      const length = item.length
      const out = []
      spend(2)
      for (let index = 0; index < length; index += 1) {
        if (!(index in item)) fail(path + '[' + index + ']', 'sparse arrays are not JSON data')
        define(out, index, copy(item[index], path + '[' + index + ']', chain))
        spend(1)
      }
      return out
    }
    const proto = captured.getPrototypeOf(item)
    if (proto !== null && captured.getPrototypeOf(proto) !== null) fail(path, 'only plain objects and arrays are JSON data')
    const out = {}
    spend(2)
    const keys = captured.keys(item)
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]
      spend(utf8Length(key) + 4)
      define(out, key, copy(item[key], path + '.' + key, chain))
    }
    return out
  }
  return value => copy(value, '', null)
}
`
