/**
 * Pure version helpers for the desktop updater badge.
 *
 * The desktop shell and its bundled dsh CLI are versioned independently
 * (semver, possibly with prerelease suffixes such as `0.1.0-rc.5`); both are
 * advertised by one GitHub Releases feed on the desktop repository. These
 * helpers compare versions, extract them from release metadata, and pick the
 * right installer asset. Kept free of Electron/Node APIs so it can run under
 * `node --experimental-strip-types` for unit testing.
 * @module
 */

/** A GitHub release asset as consumed from the REST API. */
export interface ReleaseAsset {
  name: string
  browser_download_url: string
}

/** The slice of a GitHub "latest release" response this module needs. */
export interface ReleaseInfo {
  tagName: string
  htmlUrl: string
  body: string | null
  assets: ReleaseAsset[]
}

/**
 * Strip an optional leading `v` and surrounding whitespace.
 * @param version - raw tag or version string.
 * @returns the bare version, e.g. `v0.1.2` -> `0.1.2`.
 */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^[vV]/, '')
}

/** One dot-separated numeric segment plus an optional `-prerelease` tail. */
function splitVersion(version: string): { core: number[]; pre: string | undefined } {
  const [main, ...preParts] = normalizeVersion(version).split('-')
  const core = (main ?? '').split('.').map(part => Number.parseInt(part, 10))
  return { core, pre: preParts.length > 0 ? preParts.join('-') : undefined }
}

/** Split a prerelease tail into semver identifiers (numeric where numeric). */
function prereleaseIds(pre: string): (number | string)[] {
  return pre.split('.').map(id => /^\d+$/.test(id) ? Number.parseInt(id, 10) : id)
}

/**
 * Compare two prerelease tails by semver rules: a release outranks its own
 * prerelease (`rc.5 < final`), numeric identifiers compare numerically
 * (`rc.10 > rc.9`), and numeric ranks below alphanumeric.
 */
function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  const left = prereleaseIds(a)
  const right = prereleaseIds(b)
  const width = Math.max(left.length, right.length)
  for (let index = 0; index < width; index += 1) {
    const x = left[index]
    const y = right[index]
    if (x === undefined && y === undefined) return 0
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (typeof x === 'number' && typeof y === 'number' && x !== y) return x < y ? -1 : 1
    if (typeof x === 'string' && typeof y === 'string' && x !== y) return x < y ? -1 : 1
    if (typeof x !== typeof y) return typeof x === 'number' ? -1 : 1
  }
  return 0
}

/**
 * Compare two semver-ish versions, including prerelease ordering
 * (`0.1.0-rc.5 < 0.1.0-rc.10 < 0.1.0 < 0.1.1`). Unparseable segments count
 * as 0.
 * @param a - left-hand version.
 * @param b - right-hand version.
 * @returns negative when a < b, 0 when equal, positive when a > b.
 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a)
  const right = splitVersion(b)
  const width = Math.max(left.core.length, right.core.length)
  for (let index = 0; index < width; index += 1) {
    const x = Number.isFinite(left.core[index]) ? left.core[index]! : 0
    const y = Number.isFinite(right.core[index]) ? right.core[index]! : 0
    if (x !== y) return x < y ? -1 : 1
  }
  return comparePrerelease(left.pre, right.pre)
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

/**
 * Extract the desktop version from a release tag (`v0.1.2`, `0.1.2`).
 * @returns the bare version or undefined when the tag is not version-like.
 */
export function parseTagVersion(tag: string): string | undefined {
  const match = /^v?([0-9]+(?:\.[0-9]+)+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag.trim())
  return match === null ? undefined : match[1]
}

/**
 * Extract the bundled dsh version a release declares in its body. The
 * convention is one line like `dsh-version: 0.1.0-rc.5` (also accepted:
 * `dsh version:`, `dsh_version:`, case-insensitive).
 * @returns the bare dsh version or undefined when undeclared.
 */
export function parseDshVersionFromBody(body: string | null | undefined): string | undefined {
  if (body === null || body === undefined) return undefined
  const match = /dsh[ _-]?version[*_\s]*[:=][*_\s]*v?([0-9][^\s,)]*)/i.exec(body)
  return match === null ? undefined : match[1]
}

/**
 * Pick the NSIS installer asset a user should download. Portable executables,
 * blockmaps, and update metadata never qualify.
 * @returns the asset's download URL or undefined when the release ships none.
 */
export function pickInstallerAsset(assets: ReleaseAsset[]): string | undefined {
  const setup = assets.find(asset => /^DeepSeek-Harness-Setup-[0-9][^/]*\.exe$/i.test(asset.name))
  return setup?.browser_download_url
}
