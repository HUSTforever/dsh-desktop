import { defineConfig } from 'tsdown'

/**
 * The desktop shell ships one entry: the Electron main process. `electron`
 * stays external — Electron's own runtime provides it — so the bundle holds
 * only this app's code. `dist/` is both the dev entry and the electron-builder
 * payload.
 */
export default defineConfig({
  entry: ['src/main.ts'],
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  fixedExtension: false,
  deps: { neverBundle: ['electron'] },
})
