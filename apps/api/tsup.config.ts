import { defineConfig } from 'tsup'

// One self-contained bundle per app: workspace packages + deps inlined, so Heroku's
// devDependency pruning can't break runtime resolution.
export default defineConfig({
  entry: { server: 'src/server.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/.*/],
  // Optional peer of mppx, only loaded by its MCP transport (unused here). noExternal wins over
  // tsup's `external`, so exclude it at the esbuild level.
  esbuildOptions(o) {
    o.external = [...(o.external ?? []), '@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*']
  },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
})
