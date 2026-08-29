/**
 * electron-builder afterPack hook: copy the prepared backend tree (including
 * its node_modules) into the packed app's resources directory.
 *
 * electron-builder unconditionally excludes `node_modules` from every file
 * copy (see app-builder-lib/src/fileMatcher.ts), so the backend dependency
 * tree cannot ride `extraResources`. afterPack runs after `win-unpacked` is
 * assembled and before the NSIS target packages it, which is exactly
 * the window this copy needs.
 * @type {import('app-builder-lib').AfterPackContext}
 */
const { cpSync, existsSync, rmSync } = require('node:fs')
const path = require('node:path')

exports.default = async function afterPack(context) {
  const source = path.join(__dirname, '..', 'backend')
  const target = path.join(context.appOutDir, 'resources', 'backend')
  if (!existsSync(path.join(source, 'lib', 'bin.js'))) {
    throw new Error('after-pack: backend not prepared; run backend:prepare first')
  }
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true, force: true, dereference: true })
  console.log(`+ after-pack: copied backend -> ${target}`)
}
