// Unit checks for the updater's pure logic. Run: node tests/update-logic.test.mjs
import assert from 'node:assert/strict'
import { compareVersions, isNewer, normalizeVersion, parseDshVersionFromBody, parseTagVersion, pickInstallerAsset } from '../src/version.ts'
import { applyBadgeStateJs, BADGE_BOOTSTRAP, BADGE_CSS } from '../src/badge.ts'

// --- version comparison -----------------------------------------------------
const ordering = [
  '0.1.0', '0.1.0-rc.5', '0.1.0-rc.10', // wait: rc.5 < rc.10 numerically
]
assert.equal(compareVersions('0.1.0-rc.5', '0.1.0'), -1, 'prerelease below release')
assert.equal(compareVersions('0.1.0', '0.1.1'), -1)
assert.equal(compareVersions('0.1.2', '0.1.1'), 1)
assert.equal(compareVersions('0.2.0', '0.1.9'), 1)
assert.equal(compareVersions('1.0', '1.0.0'), 0)
assert.equal(compareVersions('1.0-rc.x', '1.0-rc.x'), 0, 'identical tails equal')
// numeric prerelease identifiers
assert.ok(isNewer('0.1.0-rc.10', '0.1.0-rc.9'), 'rc.10 > rc.9')
assert.ok(!isNewer('0.1.0-rc.9', '0.1.0-rc.10'))
assert.ok(isNewer('0.1.1', '0.1.0-rc.99'), 'release beats any prerelease of same core')
assert.ok(!isNewer('0.1.1', '0.1.1'))
assert.ok(!isNewer('0.1.0-rc.5', '0.1.0-rc.5'))
assert.equal(normalizeVersion(' v0.2.3 '), '0.2.3')

// --- tag parsing ------------------------------------------------------------
assert.equal(parseTagVersion('v0.1.2'), '0.1.2')
assert.equal(parseTagVersion('0.1.0-rc.5'), '0.1.0-rc.5')
assert.equal(parseTagVersion('nightly'), undefined)
assert.equal(parseTagVersion('v1.2'), '1.2')

// --- release body parsing ---------------------------------------------------
assert.equal(parseDshVersionFromBody('dsh-version: 0.2.0'), '0.2.0')
assert.equal(parseDshVersionFromBody('- dsh version: v1.2.3-rc.1'), '1.2.3-rc.1')
assert.equal(parseDshVersionFromBody('**dsh_version:** 2.0.0'), '2.0.0')
assert.equal(parseDshVersionFromBody('DSH-Version: 3.4.5'), '3.4.5')
assert.equal(parseDshVersionFromBody('no marker here'), undefined)
assert.equal(parseDshVersionFromBody(null), undefined)
assert.equal(parseDshVersionFromBody('dsh-version: 0.2.0, plus notes'), '0.2.0', 'stops at comma')

// --- installer asset picking --------------------------------------------------
const assets = [
  { name: 'latest.yml', browser_download_url: 'https://x/latest.yml' },
  { name: 'DeepSeek-Harness-Setup-0.2.0.exe.blockmap', browser_download_url: 'https://x/bm' },
  { name: 'DeepSeek-Harness-0.2.0-portable.exe', browser_download_url: 'https/x/portable' },
  { name: 'DeepSeek-Harness-Setup-0.2.0.exe', browser_download_url: 'https://x/setup' },
]
assert.equal(pickInstallerAsset(assets), 'https://x/setup')
const portableOnly = [
  { name: 'DeepSeek-Harness-0.2.0-portable.exe', browser_download_url: 'https://x/portable' },
  { name: 'latest.yml', browser_download_url: 'https://x/latest.yml' },
]
assert.equal(pickInstallerAsset(portableOnly), undefined, 'portable builds are not supported')
assert.equal(pickInstallerAsset([{ name: 'readme.txt', browser_download_url: 'https://x/r' }]), undefined)

// --- badge script integrity ---------------------------------------------------
assert.ok(!BADGE_BOOTSTRAP.includes('__BADGE_CSS__'), 'css spliced in')
assert.ok(BADGE_BOOTSTRAP.includes(BADGE_CSS.slice(0, 24)), 'css payload present')
new Function(BADGE_BOOTSTRAP) // must compile
const state = { status: 'available', items: [{ kind: 'dsh', current: 'a', latest: 'b' }] }
const apply = applyBadgeStateJs(state)
assert.ok(apply.startsWith('window.__dshDesktopApplyUpdateState && window.__dshDesktopApplyUpdateState('))
const embedded = JSON.parse(apply.slice(apply.indexOf('(') + 1, -1))
assert.deepEqual(embedded, state)
new Function(apply) // must compile

console.log('update-logic tests: all passed')
