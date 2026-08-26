/**
 * Update coordinator for the desktop shell.
 *
 * Checks one GitHub Releases feed (the desktop repository) for both update
 * channels the badge advertises:
 *  - `desktop`: this Electron shell, versioned by release tag vs app.getVersion();
 *  - `dsh`: the bundled dsh CLI, recorded at package time in
 *    backend/.dsh-version and compared against the `dsh-version:` line of
 *    the latest release body (both ship together inside one installer).
 *
 * The coordinator owns a JSON-safe state object, pushes it to subscribers
 * (the renderer badge, over IPC), and drives the native download of the
 * installer into the user's Downloads folder via the default session.
 * @module
 */

import { get as httpsGet } from 'node:https'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, session, type BrowserWindow } from 'electron'
import {
  isNewer,
  normalizeVersion,
  parseDshVersionFromBody,
  parseTagVersion,
  pickInstallerAsset,
  type ReleaseInfo,
} from './version.js'

/** Repository whose Releases feed is consulted; override for testing. */
const UPDATES_REPO = process.env.DSH_DESKTOP_UPDATES_REPO ?? 'HUSTforever/dsh-desktop'

/** Full API URL override (tests / mirrors); bypasses UPDATES_REPO. */
const UPDATES_URL = process.env.DSH_DESKTOP_UPDATES_URL

/** Inline fake release payload (badge development without network). */
const FAKE_RELEASE = process.env.DSH_DESKTOP_FAKE_RELEASE

/** One outdated component advertised by the badge. */
export interface OutdatedItem {
  /** Which channel fell behind. */
  kind: 'desktop' | 'dsh'
  /** Version running right now. */
  current: string
  /** Version offered by the latest release. */
  latest: string
}

/** Everything the badge needs, JSON-safe across IPC. */
export interface UpdateState {
  status:
    | 'idle' // no check has completed yet
    | 'up-to-date' // nothing to show
    | 'available' // at least one channel is behind
    | 'downloading' // installer mid-flight
    | 'downloaded' // installer ready on disk
  /** Outdated channels when status === 'available'. */
  items: OutdatedItem[]
  /** Latest desktop version from the release tag, when known. */
  latestDesktop?: string
  /** Bundled dsh version found locally, when known. */
  dshLocal?: string
  /** dsh version declared by the latest release, when known. */
  dshLatest?: string
  /** Installer URL chosen for download, when available. */
  downloadUrl?: string
  /** Release page URL. */
  releaseUrl?: string
  /** Download progress, when status === 'downloading'. */
  receivedBytes?: number
  totalBytes?: number
  /** Installer path on disk, when status === 'downloaded'. */
  filePath?: string
  /** Human-readable failure note (network/rate limit); never fatal. */
  errorNote?: string
  /** Epoch ms of the last completed check. */
  checkedAt?: number
}

/** Fetch one URL as text with a bounded timeout and User-Agent. */
function fetchText(url: string, timeoutMs = 15_000): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolveFetch, rejectFetch) => {
    const request = httpsGet(url, {
      headers: {
        'User-Agent': 'dsh-desktop-updater',
        Accept: 'application/vnd.github+json',
      },
      timeout: timeoutMs,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => {
        resolveFetch({
          status: response.statusCode ?? 0,
          headers: Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k, Array.isArray(v) ? (v[0] ?? '') : (v ?? '')])),
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    request.on('timeout', () => { request.destroy(new Error('request timed out')) })
    request.on('error', rejectFetch)
  })
}

/** Fetch the latest release info from the configured feed. */
async function fetchLatestRelease(): Promise<ReleaseInfo> {
  if (FAKE_RELEASE !== undefined && FAKE_RELEASE !== '') return JSON.parse(FAKE_RELEASE) as ReleaseInfo
  const url = UPDATES_URL ?? ('https://api.github.com/repos/' + UPDATES_REPO + '/releases/latest')
  const response = await fetchText(url)
  if (response.status === 403 && response.headers['x-ratelimit-remaining'] === '0') {
    throw new Error('GitHub API rate limit reached; retry later')
  }
  if (response.status !== 200) throw new Error('release lookup failed: HTTP ' + response.status)
  const payload = JSON.parse(response.body) as {
    tag_name?: string
    html_url?: string
    body?: string
    assets?: { name?: string; browser_download_url?: string }[]
  }
  return {
    tagName: typeof payload.tag_name === 'string' ? payload.tag_name : '',
    htmlUrl: typeof payload.html_url === 'string' ? payload.html_url : '',
    body: typeof payload.body === 'string' ? payload.body : null,
    assets: (payload.assets ?? [])
      .filter(asset => typeof asset.name === 'string' && typeof asset.browser_download_url === 'string')
      .map(asset => ({ name: asset.name!, browser_download_url: asset.browser_download_url! })),
  }
}

/**
 * Locate the bundled dsh version. Packaged builds read the marker written by
 * prepare-backend.mjs (falling back to the deployed manifest); development
 * reads the sibling repository's CLI manifest.
 */
export function readBundledDshVersion(): string | undefined {
  // Bundled into dist/main.js (ESM): derive the module directory portably.
  const thisDir = dirname(fileURLToPath(import.meta.url))
  const resources = app.isPackaged ? process.resourcesPath : join(thisDir, '..')
  const candidates = [
    join(resources, 'backend', '.dsh-version'),
    join(resources, 'backend', 'package.json'),
    // Dev layout: the official repo checkout beside this project.
    join(thisDir, '..', '..', 'deepseek-harness', 'apps', 'cli', 'package.json'),
  ]
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      if (candidate.endsWith('.dsh-version')) {
        const value = normalizeVersion(readFileSync(candidate, 'utf8'))
        if (value !== '') return value
        continue
      }
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
      if (manifest.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string') return normalizeVersion(manifest.version)
    } catch {
      // Try the next candidate; the badge simply hides without a local version.
    }
  }
  return undefined
}

/** Subscribers notified on every state transition. */
type StateListener = (state: UpdateState) => void

/**
 * Owns the update state machine: periodic checks, the download pipeline on
 * the default session, and listener notification. UI surfaces (badge, menu)
 * call into it.
 */
export class UpdateCoordinator {
  private state: UpdateState = { status: 'idle', items: [] }

  private readonly listeners = new Set<StateListener>()

  private checking = false

  private pendingDownloadUrl: string | undefined

  private downloadHooked = false

  constructor() {
    const dshLocal = readBundledDshVersion()
    if (dshLocal !== undefined) this.state.dshLocal = dshLocal
  }

  getState(): UpdateState {
    return this.state
  }

  subscribe(listener: StateListener): void {
    this.listeners.add(listener)
    listener(this.state)
  }

  private push(patch: { [K in keyof UpdateState]?: UpdateState[K] | undefined }): void {
    // The patch may clear optionals with explicit undefined; the cast is safe
    // because every caller keeps the required fields (status/items) present.
    this.state = { ...this.state, ...patch } as UpdateState
    for (const listener of [...this.listeners]) listener(this.state)
  }

  /**
   * Run one check. Failures leave the previous visible state untouched and
   * only record an internal note - silence beats nagging on flaky networks.
   */
  async refresh(): Promise<UpdateState> {
    if (this.checking) return this.state
    this.checking = true
    try {
      const release = await fetchLatestRelease()
      this.applyRelease(release)
    } catch (error) {
      this.push({ errorNote: String((error as Error).message ?? error), checkedAt: Date.now() })
    } finally {
      this.checking = false
    }
    return this.state
  }

  /** Fold one fetched release into the state. Exposed for tests. */
  applyRelease(release: ReleaseInfo): void {
    if (this.state.status === 'downloading' || this.state.status === 'downloaded') return
    const currentDesktop = normalizeVersion(app.getVersion())
    const latestDesktop = parseTagVersion(release.tagName)
    const dshLocal = this.state.dshLocal ?? readBundledDshVersion()
    const dshLatest = parseDshVersionFromBody(release.body)
    const items: OutdatedItem[] = []
    if (latestDesktop !== undefined && isNewer(latestDesktop, currentDesktop)) {
      items.push({ kind: 'desktop', current: currentDesktop, latest: latestDesktop })
    }
    if (dshLocal !== undefined && dshLatest !== undefined && isNewer(dshLatest, dshLocal)) {
      items.push({ kind: 'dsh', current: dshLocal, latest: dshLatest })
    }
    this.push({
      status: items.length > 0 ? 'available' : 'up-to-date',
      items,
      latestDesktop,
      dshLocal,
      dshLatest,
      downloadUrl: pickInstallerAsset(release.assets),
      releaseUrl: release.htmlUrl !== '' ? release.htmlUrl : undefined,
      checkedAt: Date.now(),
      errorNote: undefined,
    })
  }

  /** Begin downloading the installer into Downloads; no-op while active. */
  startDownload(win?: BrowserWindow): void {
    if (this.state.status !== 'available') return
    const url = this.state.downloadUrl
    if (url === undefined || url === '') return
    if (!this.downloadHooked) {
      session.defaultSession.on('will-download', (_event, item) => { this.onWillDownload(item) })
      this.downloadHooked = true
    }
    this.pendingDownloadUrl = url
    this.push({
      status: 'downloading',
      receivedBytes: 0,
      totalBytes: 0,
      filePath: undefined,
      errorNote: undefined,
    })
    if (win !== undefined && !win.isDestroyed()) win.webContents.downloadURL(url)
    else session.defaultSession.downloadURL(url)
  }

  /** Route exactly our triggered downloads to a fixed save path with progress. */
  private onWillDownload(item: Electron.DownloadItem): void {
    if (this.pendingDownloadUrl === undefined || item.getURL() !== this.pendingDownloadUrl) return
    const directory = app.getPath('downloads')
    const base = item.getFilename() || 'DeepSeek-Harness-Setup.exe'
    let target = join(directory, base)
    const dot = base.lastIndexOf('.')
    const stem = dot > 0 ? base.slice(0, dot) : base
    const ext = dot > 0 ? base.slice(dot) : ''
    for (let index = 2; existsSync(target); index += 1) target = join(directory, stem + ' (' + index + ')' + ext)
    item.setSavePath(target)
    item.on('updated', (_event, state) => {
      this.push({
        status: 'downloading',
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        filePath: target,
        errorNote: state === 'interrupted' ? '下载已中断，正在重试…' : undefined,
      })
    })
    item.once('done', (_event, state) => {
      this.pendingDownloadUrl = undefined
      if (state === 'completed') {
        this.push({ status: 'downloaded', filePath: target, errorNote: undefined })
      } else {
        // Fall back to the offer so the user can retry.
        this.push({ status: 'available', filePath: undefined, errorNote: '下载失败（' + state + '），可重试' })
      }
    })
  }

  /** True between startDownload and completion; guards double clicks. */
  get downloading(): boolean {
    return this.pendingDownloadUrl !== undefined
  }
}
