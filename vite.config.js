import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

/**
 * Vendor chunk assignment.
 *
 * This used to be the object form of `manualChunks` (a package name per chunk),
 * which quietly broke the split it was supposed to describe: package *names* do
 * not match the ids Rollup actually hands out, because Vite's CommonJS interop
 * appends query suffixes (`react/jsx-runtime.js?commonjs-es-import`). The
 * unmatched JSX runtime proxy was therefore assigned to whichever manual chunk
 * reached it first — `vendor-codemirror`, via @uiw/react-codemirror — so every
 * component in the entry chunk statically depended on the 690 KB editor bundle
 * and Vite kept `modulepreload`ing it on every cold load. Matching on the
 * resolved id keeps that from happening again (issue #267).
 *
 * Order matters: the first pattern to match wins.
 */
const VENDOR_CHUNK_PATTERNS = [
  // `@babel/runtime` rides along with React: its helpers are a couple of KB
  // shared between the highlighter chunk (react-syntax-highlighter, demand-loaded
  // since #287) and the editor bundle, and left unassigned Rollup folded them
  // into `vendor-codemirror` — which is enough on its own to make the editor a
  // static entry dependency.
  [
    'vendor-react',
    /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler|@babel[\\/]runtime)[\\/]/,
  ],
  ['vendor-xterm', /[\\/]node_modules[\\/]@xterm[\\/]/],
  [
    'vendor-codemirror',
    /[\\/]node_modules[\\/](@codemirror|@lezer|@uiw|@replit|@marijn|style-mod|w3c-keyname|crelt)[\\/]/,
  ],
]

function assignVendorChunk(id) {
  for (const [name, pattern] of VENDOR_CHUNK_PATTERNS) {
    if (pattern.test(id)) return name
  }
  return undefined
}

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  // Build identity (#458): scripts/dante-build.sh exports VITE_BUILD_SHA/VITE_BUILT_AT
  // (falling back to empty for plain `npm run dev` / `npm run build`), and Vite inlines
  // them into every bundle here. useVersionCheck compares the embedded SHA against the
  // one the server reports from /health; because the dante fork ships by ansible-pull
  // with no version bumps, the SHA is the only thing that actually changes per deploy.
  const buildSha = process.env.VITE_BUILD_SHA || env.VITE_BUILD_SHA || ''
  const buildTime = process.env.VITE_BUILT_AT || env.VITE_BUILT_AT || ''

  return {
    plugins: [react()],
    define: {
      __CLOUDCLI_BUILD_SHA__: JSON.stringify(buildSha),
      __CLOUDCLI_BUILT_AT__: JSON.stringify(buildTime),
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/plugin-ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: assignVendorChunk
        }
      }
    }
  }
})
