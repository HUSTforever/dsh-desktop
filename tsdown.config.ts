import { defineConfig } from 'tsdown'

/**
 * The desktop shell ships two entries from `src/` into `dist/`:
 *
 * - main.ts -> dist/main.js (ESM): the Electron main process, including the
 *   update coordinator and badge injector. `electron` stays external —
 *   Electron's own runtime provides it.
 * - preload.ts -> dist/preload.cjs (CJS): the sandboxed preload bridge. A
 *   sandboxed preload is loaded as a plain script, so it must be CommonJS;
 *   everything except `electron` is bundled into it.
 *
 * `dist/` is both the dev entry and the electron-builder payload.
 */
export default defineConfig([
  {
    entry: ['src/main.ts'],
    outDir: 'dist',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: true,
    fixedExtension: false,
    deps: { neverBundle: ['electron'] },
  },
  {
    entry: ['src/preload.ts'],
    outDir: 'dist',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    outExtensions: () => ({ js: '.cjs', dts: '.d.cts' }),
    deps: { neverBundle: ['electron'] },
  },
])
