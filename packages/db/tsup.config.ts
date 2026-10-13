import { defineConfig } from 'tsup'

// Bundles the migrator (and its deps) into one file for Heroku's release phase.
export default defineConfig({
  entry: { migrate: 'src/migrate.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  noExternal: [/.*/],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
})
