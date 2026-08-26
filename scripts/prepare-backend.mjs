/**
 * Rebuild the desktop project's `backend/`: a self-contained copy of the dsh
 * CLI and its production dependency closure, flat-hoisted so every bare
 * specifier resolves on any Node engine, then smoke-tested by actually
 * booting `dsh web` on the same engine the packaged app uses (a bundled real
 * Node runtime — Electron's embedded Node breaks native-FFI codepaths).
 * The dsh sources come from the sibling official repository (`DSH_REPO`).
 *
 * Steps:
 *   1. `pnpm --filter @deepseek-ai/dsh deploy --legacy --prod` into `backend/`
 *      — resolves every registry dependency and its transitive closure.
 *   2. Flat-hoist every package in the CLI's dependency closure
 *      (dependencies + peerDependencies) into `backend/node_modules/<name>`,
 *      mirroring the flat layout npm would produce. The legacy deploy skips
 *      workspace peers (their `workspace:^` ranges are unresolvable), and a
 *      flat top level makes every bare import resolvable from anywhere in
 *      the tree — including from `.pnpm` realpaths and under
 *      preserveSymlinks. Workspace packages copy their published surface
 *      (which carries the built web frontend `dist/`), registry packages
 *      copy whole from the deploy's `.pnpm` virtual store.
 *   3. Bundle a real Node runtime (`backend/runtime/node.exe`) for the same
 *      reason: Electron's embedded Node dies with a fatal NAPI error inside
 *      native-FFI code (the Win32 folder-dialog worker's koffi calls).
 *   4. Boot `backend/lib/bin.js web --port 0` with that bundled Node and wait
 *      for the readiness URL line — this exercises profile init, module
 *      resolution, config load, the webserver bind, and the frontend dist
 *      path in one run.
 *
 * Run from the desktop project root: `node scripts/prepare-backend.mjs`.
 */

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The official dsh repository: the sibling directory by default (this project
// lives beside it), overridable for any other checkout.
const repoRoot = process.env.DSH_REPO ?? resolve(desktopDir, '..', 'deepseek-harness')
const backendDir = join(desktopDir, 'backend')
const electronNode = join(desktopDir, 'node_modules', 'electron', 'dist', 'electron.exe')
const SMOKE_TIMEOUT_MS = 90_000

/** The real Node runtime version bundled into `backend/runtime/node.exe`. */
const BUNDLED_NODE_VERSION = 'v24.15.0'

/** Run one command to completion, failing the script on a non-zero exit. */
function run(command, args, options = {}) {
  console.log(`+ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`)
}

/** Quote one argv token for the cmd.exe /c command line. */
function quoteArg(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
}

/**
 * Run pnpm. Windows cannot CreateProcess a `.cmd` shim directly (pnpm is one),
 * so route through `cmd.exe /s /c`, which resolves it like an interactive shell.
 */
function runPnpm(args, options = {}) {
  if (process.platform !== 'win32') {
    run('pnpm', args, options)
    return
  }
  console.log(`+ pnpm ${args.join(' ')}`)
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', ['pnpm', ...args.map(quoteArg)].join(' ')], {
    stdio: 'inherit',
    shell: false,
    windowsVerbatimArguments: true,
    ...options,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`pnpm exited with status ${result.status}`)
}

/** Copy a file or directory into an existing parent directory, replacing the leaf entry. */
function copy(from, to) {
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true, force: true, dereference: true })
  console.log(`+ copy ${from} -> ${to}`)
}

/**
 * Replace the top-level entry for one package with real copied files. The
 * deploy's top-level entries are symlinks into `.pnpm`; any path operation on
 * a child of such a symlink resolves THROUGH it, so the whole entry must be
 * unlinked first (`fs.rm` removes a final-component symlink, it does not
 * follow it).
 */
function hoistPackage(name, source, keepEntries) {
  const target = join(backendDir, 'node_modules', ...name.split('/'))
  rmSync(target, { recursive: true, force: true })
  mkdirSync(dirname(target), { recursive: true })
  for (const entry of keepEntries) {
    const from = join(source, entry)
    if (!existsSync(from)) continue
    copy(from, join(target, entry))
  }
}

/** Read one package manifest, or return undefined when the file is absent. */
function readManifest(dir) {
  const path = join(dir, 'package.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

/** Workspace-owned package dirs (vendor, packages, apps, native), mapped by package name. */
function collectWorkspacePackages() {
  const map = new Map()
  const roots = [
    [join(repoRoot, 'vendor'), 1],
    [join(repoRoot, 'packages'), 2],
    [join(repoRoot, 'apps'), 1],
    [join(repoRoot, 'native', 'landlock-run', 'packages'), 1],
  ]
  const walk = (dir, depth) => {
    if (depth === 0) {
      const manifest = readManifest(dir)
      if (manifest !== undefined && typeof manifest.name === 'string') {
        map.set(manifest.name, realpathSync(dir))
      }
      return
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), depth - 1)
    }
  }
  for (const [root, depth] of roots) walk(root, depth)
  return map
}

/** Resolve one package dir inside the deployed tree, mirroring Node's parent-directory walk. */
function deployedPackageDir(anchor, packageName) {
  const require = createRequire(anchor)
  for (const searchPath of require.resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** Every package in the deploy's `.pnpm` virtual store, mapped by package name (first wins). */
function collectDeployedPackages() {
  const map = new Map()
  const storeDir = join(backendDir, 'node_modules', '.pnpm')
  const addPackage = (pkgDir) => {
    const manifest = readManifest(pkgDir)
    if (manifest === undefined || typeof manifest.name !== 'string' || map.has(manifest.name)) return
    // Consumer-side entries symlink into the canonical store entry; realpath
    // collapses both onto the directory that holds the real (hard-linked) files.
    try {
      map.set(manifest.name, realpathSync(pkgDir))
    } catch {
      // A dangling link is not a usable copy source; the canonical entry is.
    }
  }
  for (const entry of readdirSync(storeDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const inner = join(storeDir, entry.name, 'node_modules')
    if (!existsSync(inner)) continue
    for (const sub of readdirSync(inner, { withFileTypes: true })) {
      const pkgDir = join(inner, sub.name)
      if (existsSync(join(pkgDir, 'package.json'))) {
        addPackage(pkgDir)
        continue
      }
      // Scoped packages live one level deeper: <inner>/@scope/<name>.
      if (!sub.isDirectory()) continue
      for (const scoped of readdirSync(pkgDir, { withFileTypes: true })) {
        addPackage(join(pkgDir, scoped.name))
      }
    }
  }
  return map
}

/**
 * Entry set a workspace package's copy needs: the published surface, never
 * src/tests/node_modules. Registry packages copy everything but node_modules.
 */
const KEEP_ENTRIES = ['package.json', 'lib', 'dist', 'config', 'cordis.patch.yml', 'assets', 'presets', 'public', 'bin']

// 1. Deploy the CLI and its production closure into backend/.
rmSync(backendDir, { recursive: true, force: true })
runPnpm(['--filter', '@deepseek-ai/dsh', 'deploy', '--legacy', '--prod', backendDir], { cwd: repoRoot })

// 2. Flat-hoist the workspace packages of the CLI's dependency closure.
const workspacePackages = collectWorkspacePackages()
const deployedPackages = collectDeployedPackages()
const appDir = backendDir
const appManifest = readManifest(appDir)
if (appManifest === undefined) throw new Error('deploy produced no app manifest at backend/package.json')
const appAnchor = join(appDir, 'package.json')
const closure = new Set()
const queue = [appManifest]
for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
  const rangeNames = [
    ...Object.keys(next.dependencies ?? {}),
    ...Object.keys(next.peerDependencies ?? {}),
    ...Object.keys(next.optionalDependencies ?? {}),
  ]
  for (const name of rangeNames) {
    if (closure.has(name)) continue
    closure.add(name)
    const workspaceDir = workspacePackages.get(name)
    const child = workspaceDir !== undefined
      ? readManifest(workspaceDir)
      : readManifest(deployedPackages.get(name) ?? deployedPackageDir(appAnchor, name) ?? '')
    if (child !== undefined) queue.push(child)
  }
}
/** True when a manifest does not exclude this platform (win32/x64) via positive os/cpu lists. */
function supportsThisPlatform(manifest) {
  if (manifest === undefined) return true
  if (Array.isArray(manifest.os) && !manifest.os.includes('win32')) return false
  if (Array.isArray(manifest.cpu) && !manifest.cpu.includes('x64')) return false
  return true
}

/** Registry-package top-level entries that never matter at runtime. */
const JUNK_ENTRIES = new Set(['.github', 'test', 'tests', 'docs', 'benchmark', 'example', 'examples', '.nycrc'])

let hoisted = 0
for (const name of closure) {
  const workspaceDir = workspacePackages.get(name)
  if (workspaceDir !== undefined) {
    const manifest = readManifest(workspaceDir)
    if (!supportsThisPlatform(manifest)) continue
    hoistPackage(name, workspaceDir, KEEP_ENTRIES)
  } else {
    const registryDir = deployedPackages.get(name)
    if (registryDir === undefined) continue
    const manifest = readManifest(registryDir)
    if (!supportsThisPlatform(manifest)) continue
    hoistPackage(name, registryDir, readdirSync(registryDir).filter(entry => entry !== 'node_modules' && !JUNK_ENTRIES.has(entry)))
  }
  hoisted += 1
}
console.log(`+ flat-hoisted ${hoisted} packages into backend/node_modules`)

// The frontend dist and the vendored group plugin are the two paths the flat
// hoist must have carried; fail loud before the smoke test wastes a boot.
const required = [
  join(backendDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'),
  join(backendDir, 'node_modules', '@deepseek-ai', 'cordis-plugin-group', 'lib', 'index.js'),
]
for (const path of required) {
  if (!existsSync(path)) throw new Error(`flat hoist did not produce ${path}`)
}

// The flat tree is self-contained: drop the redundant .pnpm virtual store and
// every now-dangling link that pointed into it. The smoke below runs against
// exactly the tree that ships, so a pruned-away dependency fails the build.
const modulesRoot = join(backendDir, 'node_modules')
rmSync(join(modulesRoot, '.pnpm'), { recursive: true, force: true })
const pruneBrokenLinks = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    let stat
    try {
      stat = lstatSync(path)
    } catch {
      rmSync(path, { recursive: true, force: true })
      continue
    }
    if (stat.isSymbolicLink()) {
      try {
        realpathSync(path)
      } catch {
        rmSync(path, { recursive: true, force: true })
      }
    } else if (stat.isDirectory()) {
      pruneBrokenLinks(path)
    }
  }
}
pruneBrokenLinks(modulesRoot)
console.log('+ pruned the .pnpm virtual store and dangling links')

// 3. Bundle the real Node runtime the packaged backend runs on. Downloaded
// from the npmmirror mirror first, nodejs.org as fallback; verified by
// running it before the smoke boot below.
const runtimeDir = join(backendDir, 'runtime')
const runtimeNode = join(runtimeDir, 'node.exe')
if (!existsSync(runtimeNode)) {
  mkdirSync(runtimeDir, { recursive: true })
  const sources = [
    `https://npmmirror.com/mirrors/node/${BUNDLED_NODE_VERSION}/win-x64/node.exe`,
    `https://nodejs.org/dist/${BUNDLED_NODE_VERSION}/win-x64/node.exe`,
  ]
  let lastError
  for (const source of sources) {
    try {
      console.log(`+ downloading bundled Node ${BUNDLED_NODE_VERSION} from ${source}`)
      const response = await fetch(source, { redirect: 'follow' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      writeFileSync(runtimeNode, Buffer.from(await response.arrayBuffer()))
      lastError = undefined
      break
    } catch (error) {
      lastError = error
      rmSync(runtimeNode, { force: true })
    }
  }
  if (lastError !== undefined) throw new Error(`could not download Node ${BUNDLED_NODE_VERSION}: ${String(lastError)}`)
}
const runtimeVersion = spawnSync(runtimeNode, ['--version'], { encoding: 'utf8', windowsHide: true })
if (runtimeVersion.status !== 0 || !runtimeVersion.stdout?.trim().startsWith('v')) {
  throw new Error(`bundled Node at ${runtimeNode} does not run: ${(runtimeVersion.stderr ?? '').slice(0, 200)}`)
}
console.log(`+ bundled Node runtime ready: ${runtimeNode} (${runtimeVersion.stdout.trim()})`)

// 4. Smoke: boot dsh web on exactly the engine the packaged app uses — the
// bundled real Node — and wait for readiness.
const smokeHome = join(tmpdir(), `dsh-desktop-smoke-${process.pid}`)
const nodeBinary = runtimeNode
const bin = join(backendDir, 'lib', 'bin.js')
console.log(`+ smoke boot: ${nodeBinary} ${bin} web (DSH_HOME=${smokeHome})`)
const child = spawn(nodeBinary, ['--expose-internals', bin, 'web', '--host', '127.0.0.1', '--port', '0'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: smokeHome },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
let out = ''
let err = ''
child.stdout.on('data', chunk => {
  out += String(chunk)
  process.stdout.write(chunk)
})
child.stderr.on('data', chunk => {
  err += String(chunk)
  process.stderr.write(chunk)
})
const readyUrl = await new Promise((resolveReady, reject) => {
  const timer = setTimeout(() => {
    reject(new Error(`smoke boot timed out after ${SMOKE_TIMEOUT_MS} ms\nstdout:\n${out}\nstderr:\n${err}`))
  }, SMOKE_TIMEOUT_MS)
  child.once('exit', code => {
    clearTimeout(timer)
    reject(new Error(`smoke boot exited early (code ${code})\nstdout:\n${out}\nstderr:\n${err}`))
  })
  // Registered after the buffer listener above, so `out` is current on every
  // chunk before this check runs.
  child.stdout.on('data', () => {
    const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/.exec(out)
    if (match === null) return
    clearTimeout(timer)
    resolveReady(match[1])
  })
})
console.log(`+ smoke ready: ${readyUrl}`)
if (/expose-internals is required/.test(err)) {
  throw new Error(`smoke boot lost the loader internal hook (HMR unavailable)\nstderr:\n${err}`)
}
const page = await fetch(readyUrl)
const html = await page.text()
if (!page.ok || !html.includes('__DSH_BOOT__')) {
  throw new Error(`smoke served page check failed: status ${page.status}, boot marker ${html.includes('__DSH_BOOT__')}`)
}
console.log('+ smoke served the GUI page with the __DSH_BOOT__ marker')
await new Promise(resolveKill => {
  const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  killer.on('error', () => { resolveKill() })
  killer.on('exit', () => { resolveKill() })
})
rmSync(smokeHome, { recursive: true, force: true })
console.log('+ backend prepared and smoke-tested OK')
