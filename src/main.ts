/**
 * Electron main process for the DeepSeek Harness desktop shell.
 *
 * Boots the bundled `dsh web` backend as a child process on Electron's own
 * Node runtime (`ELECTRON_RUN_AS_NODE`), waits for its readiness URL line
 * (`dsh web: http://127.0.0.1:<port>` — the same readiness signal the CLI's
 * supervisors use), and opens one window on the loopback URL. Closing the
 * window tears the backend down. `--port 0` asks the backend for an
 * OS-assigned free port, so the shell never collides with another `dsh web`.
 *
 * Verification modes, used by packaging smoke tests:
 *   --smoke             start the backend, print `SMOKE_READY <url>`, exit 0
 *   --smoke-gui <png>   also open a hidden window, wait for the page, save a
 *                       screenshot to <png>, print `SMOKE_GUI_OK <png>`, exit 0
 *
 * Backend location, in resolution order:
 *   `DSH_DESKTOP_BACKEND` env (absolute path to the CLI `lib/bin.js`),
 *   `resources/backend/lib/bin.js` when packaged, the official repository's
 *   `apps/cli/lib/bin.js` in development (the repo is the sibling directory
 *   `../deepseek-harness`, overridable with `DSH_REPO`).
 * @module @deepseek-ai/dsh-desktop
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron'

/** The backend's readiness line; captures the canonical loopback URL. */
const READY_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/

/** How long the shell waits for the backend's readiness line. */
const BOOT_TIMEOUT_MS = 60_000

/** Directory holding this bundle (`desktop/dist` in dev, `app.asar/dist` packaged). */
const thisDir = dirname(fileURLToPath(import.meta.url))

/** The official dsh repository root, used only by the dev backend path. */
function repoRoot(): string {
  return resolve(process.env.DSH_REPO ?? join(thisDir, '..', '..', 'deepseek-harness'))
}

/** Live backend child plus its parsed URL once ready. */
interface Backend {
  child: ChildProcess
  url?: string
}

let mainWindow: BrowserWindow | undefined
let backend: Backend | undefined
/** True once teardown owns the backend, so its exit is not reported as a crash. */
let stopping = false

/** `--smoke-gui <path>`: screenshot mode. */
const smokeGuiIndex = process.argv.indexOf('--smoke-gui')
const smokeGuiPath = smokeGuiIndex >= 0 && smokeGuiIndex + 1 < process.argv.length
  ? process.argv[smokeGuiIndex + 1]
  : undefined
/** `--smoke`: backend-only readiness mode (not combined with screenshot mode). */
const smokeOnly = process.argv.includes('--smoke') && smokeGuiPath === undefined

/** Absolute path of the dsh CLI entry this shell boots. */
function resolveBackendBin(): string {
  const override = process.env.DSH_DESKTOP_BACKEND
  if (override !== undefined && override !== '') return override
  if (app.isPackaged) return join(process.resourcesPath, 'backend', 'lib', 'bin.js')
  return join(repoRoot(), 'apps', 'cli', 'lib', 'bin.js')
}

/** Where the backend's stdout/stderr is mirrored for this run. */
function backendLogPath(): string {
  return join(app.getPath('userData'), 'backend.log')
}

let logStream: ReturnType<typeof createWriteStream> | undefined

/** Open (truncate) the per-run backend log and remember the stream. */
function openLog(): void {
  mkdirSync(dirname(backendLogPath()), { recursive: true })
  logStream = createWriteStream(backendLogPath(), { flags: 'w' })
}

/** Mirror one backend output chunk to the log and, with `DSH_DESKTOP_DEBUG=1`, the console. */
function logChunk(chunk: string): void {
  if (process.env.DSH_DESKTOP_DEBUG === '1') process.stdout.write(chunk)
  logStream?.write(chunk)
}

/**
 * Spawn the dsh web backend. Packaged builds run on Electron's embedded Node
 * (`ELECTRON_RUN_AS_NODE`) over the deployed flat `backend/node_modules`;
 * development runs on the system `node`, because Electron's Node enables
 * `preserveSymlinks`, which the pnpm workspace symlink layout cannot resolve
 * (the deployed tree has no such links). `DSH_DESKTOP_NODE` overrides both.
 * @param bin - absolute path of the CLI `lib/bin.js`.
 * @returns the running child.
 */
/**
 * The real Node runtime bundled inside the packaged backend, if present.
 * Electron's embedded Node breaks native-FFI codepaths (the Win32
 * folder-dialog worker dies with a fatal NAPI error), so a packaged build
 * runs the backend — and every process the backend spawns — on this engine.
 */
function bundledRuntimeNode(): string | undefined {
  if (!app.isPackaged) return undefined
  const candidate = join(process.resourcesPath, 'backend', 'runtime', 'node.exe')
  return existsSync(candidate) ? candidate : undefined
}

function startBackend(bin: string): ChildProcess {
  const nodeBinary = process.env.DSH_DESKTOP_NODE
    ?? bundledRuntimeNode()
    ?? (app.isPackaged ? process.execPath : 'node')
  // --expose-internals: the Loader's internal-hook access (HMR, bare-module
  // imports) needs Node internals.
  const child = spawn(nodeBinary, ['--expose-internals', bin, 'web', '--host', '127.0.0.1', '--port', '0'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    cwd: dirname(bin),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout?.on('data', (chunk: Buffer | string) => { logChunk(String(chunk)) })
  child.stderr?.on('data', (chunk: Buffer | string) => { logChunk(String(chunk)) })
  return child
}

/**
 * Wait for the backend's readiness URL line, bounded by `timeoutMs`.
 * @param child - the backend child.
 * @param timeoutMs - bound in milliseconds.
 * @returns the canonical loopback URL from the readiness line.
 */
function waitForReady(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    const finish = (): void => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.off('exit', onExit)
    }
    const timer = setTimeout(() => {
      finish()
      reject(new Error(`the backend did not become ready within ${timeoutMs} ms (see ${backendLogPath()})`))
    }, timeoutMs)
    const onData = (chunk: Buffer | string): void => {
      stdout += String(chunk)
      const match = READY_LINE.exec(stdout)
      if (match === null) return
      finish()
      // The capture group is what the regex matched on; it cannot be undefined here.
      resolve(match[1]!)
    }
    const onExit = (code: number | null): void => {
      finish()
      reject(new Error(`the backend exited before becoming ready (code ${String(code)}; see ${backendLogPath()})`))
    }
    child.stdout?.on('data', onData)
    child.once('exit', onExit)
  })
}

/** Force-kill the backend's whole process tree (it spawns pwsh children). */
function killTree(pid: number | undefined): Promise<void> {
  return new Promise(resolve => {
    if (pid === undefined) { resolve(); return }
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => { resolve() })
    killer.on('exit', () => { resolve() })
  })
}

/** One-time splash shown while the backend boots; destroyed when the window is ready. */
let splash: BrowserWindow | undefined

/** Splash content: static inline page, no assets to resolve. */
const SPLASH_HTML = '<!doctype html><html><head><meta charset="utf-8"><style>'
  + 'html,body{height:100%}body{margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;'
  + 'background:#10141c;color:#c9d4e3;font-family:"Segoe UI",system-ui,sans-serif;user-select:none;-webkit-app-region:drag}'
  + 'h1{font-size:19px;font-weight:600;margin:0 0 6px}p{margin:0 0 20px;font-size:12.5px;color:#8b98ab}'
  + '.spin{width:26px;height:26px;border:3px solid #22304a;border-top-color:#4d6bfe;border-radius:50%;animation:s 1s linear infinite}'
  + '@keyframes s{to{transform:rotate(360deg)}}'
  + '</style></head><body><h1>DeepSeek Harness</h1><p>正在启动，请稍候&hellip; / Starting up&hellip;</p><div class="spin"></div></body></html>'

/** Show the splash immediately so a slow first boot still reads as a working launch. */
function createSplash(): void {
  splash = new BrowserWindow({
    width: 440,
    height: 280,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    center: true,
    show: false,
    backgroundColor: '#10141c',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  splash.once('ready-to-show', () => { splash?.show() })
  splash.on('closed', () => { splash = undefined })
  void splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`)
}

/** Open the app window on the backend URL and keep external links in the default browser. */
function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'DeepSeek Harness',
    backgroundColor: '#10141c',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  })
  win.once('ready-to-show', () => {
    splash?.destroy()
    win.show()
  })
  const origin = new URL(url).origin
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin === origin) return
    event.preventDefault()
    if (/^https?:/.test(target)) void shell.openExternal(target)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    logChunk(`renderer gone: ${details.reason}\n`)
  })
  win.on('closed', () => { mainWindow = undefined })
  void win.loadURL(url)
  return win
}

/** Application menu: minimal, but Edit roles keep Ctrl+C/V working in the GUI. */
function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { label: '&File', submenu: [{ role: 'quit', label: 'E&xit' }] },
    { label: '&Edit', submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ] },
    { label: '&View', submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { label: '&Help', submenu: [
      {
        label: 'DeepSeek Harness repository',
        click: () => { void shell.openExternal('https://github.com/deepseek-ai/deepseek-harness') },
      },
      {
        label: 'About DeepSeek Harness',
        click: () => {
          void dialog.showMessageBox({
            type: 'info',
            title: 'About DeepSeek Harness',
            message: 'DeepSeek Harness',
            detail: `Version ${app.getVersion()}\nA desktop window over the dsh web agent.`,
          })
        },
      },
    ] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Report a boot failure, kill the half-started backend, and exit. Smoke modes
 * must never open a modal dialog: they run unattended, and a dialog would
 * hang the verification; the log file carries the failure instead.
 * @param message - what went wrong.
 */
async function failBoot(message: string): Promise<void> {
  splash?.destroy()
  if (smokeOnly || smokeGuiPath !== undefined) {
    logChunk(`BOOT_FAIL ${message}\n`)
    process.exitCode = 1
    await killTree(backend?.child.pid)
    app.exit(1)
    return
  }
  dialog.showErrorBox('DeepSeek Harness', `${message}\n\nBackend log: ${backendLogPath()}`)
  await killTree(backend?.child.pid)
  app.exit(1)
}

/**
 * Screenshot mode: load the page in a hidden, still-painted window and capture it.
 * @param url - the backend URL to load.
 * @param outPath - where the PNG screenshot lands.
 */
async function runSmokeGui(url: string, outPath: string): Promise<void> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#10141c',
    paintWhenInitiallyHidden: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  void win.loadURL(url)
  try {
    await Promise.race([
      (async () => {
        await new Promise<void>((resolve, reject) => {
          win.webContents.once('did-finish-load', () => { resolve() })
          win.webContents.once('did-fail-load', (_event, code, description) => {
            reject(new Error(`page failed to load: ${code} ${description}`))
          })
        })
        await new Promise(resolve => setTimeout(resolve, 3_000))
        const image = await win.webContents.capturePage()
        writeFileSync(outPath, image.toPNG())
        console.log(`SMOKE_GUI_OK ${outPath}`)
        logChunk(`SMOKE_GUI_OK ${outPath}\n`)
      })(),
      new Promise((_resolve, reject) => {
        setTimeout(() => { reject(new Error('smoke-gui timed out')) }, 90_000)
      }),
    ])
  } catch (error) {
    console.error(`SMOKE_GUI_FAIL ${String(error)}`)
    logChunk(`SMOKE_GUI_FAIL ${String(error)}\n`)
    process.exitCode = 2
  } finally {
    stopping = true
    win.destroy()
    await killTree(backend?.child.pid)
    // process.exitCode admits string values ('SIGINT'); app.exit needs a number.
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0
    app.exit(code)
  }
}

/** Boot the backend, open the surface, and own process lifetime from here. */
async function run(): Promise<void> {
  openLog()
  installMenu()
  if (!smokeOnly && smokeGuiPath === undefined) createSplash()
  const bin = resolveBackendBin()
  if (!existsSync(bin)) {
    await failBoot(`The bundled dsh backend is missing at:\n${bin}`)
    return
  }
  const child = startBackend(bin)
  backend = { child }
  let url: string
  try {
    url = await waitForReady(child, BOOT_TIMEOUT_MS)
  } catch (error) {
    await failBoot(`Could not start the DeepSeek Harness backend:\n${String(error)}`)
    return
  }
  backend.url = url
  console.log(`SMOKE_READY ${url}`)
  logChunk(`SMOKE_READY ${url}\n`)
  // A backend death after readiness is a crash, not a boot race.
  child.on('exit', (code) => {
    if (stopping) return
    splash?.destroy()
    const win = mainWindow
    if (win !== undefined && !win.isDestroyed()) win.destroy()
    void dialog.showMessageBox({
      type: 'error',
      title: 'DeepSeek Harness',
      message: `The DeepSeek Harness backend exited unexpectedly (code ${String(code)}).`,
      detail: `See ${backendLogPath()} for the backend log.`,
    }).finally(() => {
      stopping = true
      app.quit()
    })
  })
  if (smokeGuiPath !== undefined) {
    await runSmokeGui(url, smokeGuiPath)
    return
  }
  if (smokeOnly) {
    stopping = true
    await killTree(child.pid)
    app.exit(0)
    return
  }
  mainWindow = createWindow(url)
}

// Registering this listener takes over Electron's default quit-on-all-closed:
// the splash closing alone must not quit the app mid-startup.
app.on('window-all-closed', () => {
  if (mainWindow === undefined && splash === undefined) app.quit()
})

// Teardown: the before-quit preventDefault pattern gives the tree kill time to
// settle before the process exits.
app.on('before-quit', (event) => {
  const current = backend
  if (current === undefined || current.child.exitCode !== null || stopping) return
  event.preventDefault()
  stopping = true
  void killTree(current.child.pid).then(() => { app.quit() })
})

// The userData directory (and the single-instance lock keyed on it) follows
// the package `name` unless set explicitly; pin the product name first.
// `DSH_DESKTOP_USER_DATA` moves both to an arbitrary directory — parallel
// instances and isolated verification runs need that.
app.setName('DeepSeek Harness')
const customUserData = process.env.DSH_DESKTOP_USER_DATA
if (customUserData !== undefined && customUserData !== '') app.setPath('userData', resolve(customUserData))
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.setAppUserModelId('ai.deepseek.dsh.desktop')
  app.on('second-instance', () => {
    const win = mainWindow
    if (win === undefined) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  void app.whenReady().then(run)
}
