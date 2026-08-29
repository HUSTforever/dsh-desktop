/**
 * Remove electron-builder's unpacked directory and metadata after a successful
 * NSIS build. The release directory is deliberately reduced to the installer
 * for the current package version so portable or stale artifacts cannot be
 * published accidentally.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(scriptDir, '..')
const releaseDir = resolve(projectDir, 'release')

if (basename(releaseDir) !== 'release' || dirname(releaseDir) !== projectDir) {
  throw new Error(`refusing to clean unexpected output directory: ${releaseDir}`)
}

const packageJson = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))
const installerName = `DeepSeek-Harness-Setup-${packageJson.version}.exe`
const installerPath = join(releaseDir, installerName)

if (!existsSync(installerPath)) {
  throw new Error(`installer was not produced: ${installerPath}`)
}

for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
  if (entry.name === installerName) continue
  const entryPath = join(releaseDir, entry.name)
  try {
    rmSync(entryPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
  } catch (error) {
    if (entry.name === 'win-unpacked' && error?.code === 'EPERM') {
      throw new Error(`cannot remove ${entryPath}; close any app running from this directory and rebuild`, { cause: error })
    }
    throw error
  }
}

console.log(`+ release: kept installer only -> ${installerPath}`)
