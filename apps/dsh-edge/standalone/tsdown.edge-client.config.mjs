import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'

const pluginId = 'dsh-edge-client-ui'
const standaloneRequire = createRequire(import.meta.url)
const cssVirtualPrefix = '\0dsh-edge-css:'
const cssVirtualSuffix = '.mjs'
const edgeClientRoot = fileURLToPath(new URL('../../../packages/client/ui-edge/', import.meta.url))
const cssFiles = new Map()
const external = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-store',
]

export default {
  name: `${pluginId}/standalone-client`,
  entry: { client: '../../../packages/client/ui-edge/src/client/index.ts' },
  outDir: 'edge-client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: external,
    alwaysBundle: id => external.includes(id) ? undefined : true,
    onlyBundle: ['compare-versions'],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'dsh-edge-standalone-dependency-resolution',
    resolveId(source) {
      if (external.includes(source) || !isBareSpecifier(source)) return null
      try {
        return standaloneRequire.resolve(source)
      } catch (error) {
        throw new Error(
          `Edge client dependency ${source} is absent from the standalone lock.`,
          { cause: error },
        )
      }
    },
  }, {
    name: 'dsh-edge-css-modules-inline',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css')) return null
      const path = importer === undefined ? source : resolve(dirname(importer), source)
      const sourceId = relative(edgeClientRoot, path)
      if (sourceId === '' || sourceId === '..' || sourceId.startsWith(`..${sep}`)) {
        throw new Error(`Edge client CSS is outside ${edgeClientRoot}: ${path}`)
      }
      const virtualId = cssVirtualPrefix + sourceId.split(sep).join('/') + cssVirtualSuffix
      cssFiles.set(virtualId, path)
      return virtualId
    },
    async load(virtualId) {
      if (!virtualId.startsWith(cssVirtualPrefix)) return null
      const path = cssFiles.get(virtualId)
      if (path === undefined) throw new Error(`Unknown Edge client CSS module: ${virtualId}`)
      const sourceId = virtualId.slice(cssVirtualPrefix.length, -cssVirtualSuffix.length)
      this.addWatchFile(path)
      const { code, exports } = transform({
        filename: sourceId,
        code: await readFile(path),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = Object.fromEntries(
        Object.entries(exports ?? {})
          .sort(([left], [right]) => {
            if (left < right) return -1
            if (left > right) return 1
            return 0
          })
          .map(([local, value]) => [local, value.name]),
      )
      const tagId = `${pluginId}/${sourceId}`
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
        '  const tag = document.createElement("style");',
        `  tag.dataset.plugin = ${JSON.stringify(pluginId)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

function isBareSpecifier(source) {
  return !source.startsWith('.') && !source.startsWith('/') && !source.startsWith('\0')
}
