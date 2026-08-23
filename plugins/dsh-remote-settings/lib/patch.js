/**
 * Core remote-settings patch.
 *
 * dsh's browser sidebar, models, plugin-inventory and credential surfaces all
 * derive from one client "settings mirror" whose persistence mode is chosen at
 * construction:
 *
 *   connection.isLoopback ? "host" : "memory"
 *
 * The flag comes from the browser's own page hostname, so any non-loopback
 * origin (LAN IP / public host) is treated as "memory" and the mirror reports
 * `view: undefined` — the page throws "settings are unavailable in this
 * browser". The host-side /api fence is a separate, stronger boundary: for
 * privileged methods it still only accepts loopback, and a gateway (the
 * authentication layer) rewrites Host/Origin to loopback on its way in.
 *
 * This module flips ONLY the client persistence gate, so an authenticated
 * remote browser can read and write settings through the gateway. It never
 * touches the host-side fence: any caller that is not going through the
 * gateway still gets a 403 on the privileged methods, so the config plane is
 * never exposed to an unauthenticated LAN/public caller.
 *
 * The patch is version-tolerant: it matches the semantic ternary (any
 * whitespace/quoting) instead of a fixed byte string, so it survives dsh's
 * minified / re-formatted client bundles across versions. It keeps a backup
 * plus a sha256 manifest so rollback never restores a file from a different
 * dsh version.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Default target: the settings plugin's compiled client bundle. */
export const DEFAULT_PACKAGE = '@deepseek-ai/dsh-client-ui-settings'
export const DEFAULT_RELATIVE = path.join('lib', 'client.js')

/** Backup suffix (kept on disk next to the target). */
const BAK_SUFFIX = '.bak-dsh-remote-settings'
const BAK_META_SUFFIX = '.sha256-dsh-remote-settings'

/**
 * Semantic matcher for the persistence ternary. Matches the operator shape
 * `connection.isLoopback ? "host" : "memory"` with any whitespace and either
 * quote style, so dsh's formatter/minifier cannot break detection. This is the
 * ONLY thing that must survive a dsh upgrade.
 */
export const PERSISTENCE_TERNARY =
  /connection\s*\.\s*isLoopback\s*\?\s*["']host["']\s*:\s*["']memory["']/g

/** Single-match form used by status detection. */
export const PERSISTENCE_TERNARY_ONCE =
  /connection\s*\.\s*isLoopback\s*\?\s*["']host["']\s*:\s*["']memory["']/

/** Replacement: force host persistence. */
const PERSISTENCE_TO = '"host"'

/**
 * Whether a content string still carries the unpatched ternary.
 * @param {string} content - bundle text.
 * @returns {boolean} true when at least one unpatched ternary remains.
 */
export function hasUnpatchedTernary(content) {
  return PERSISTENCE_TERNARY_ONCE.test(content)
}

/**
 * Replace every persistence ternary with the host literal.
 * @param {string} content - bundle text.
 * @returns {{ content: string, count: number }} the patched text and occurrence count.
 */
function transform(content) {
  const count = (content.match(PERSISTENCE_TERNARY) ?? []).length
  if (count === 0) return { content, count: 0 }
  return { content: content.replace(PERSISTENCE_TERNARY, PERSISTENCE_TO), count }
}

/**
 * @param {string | Buffer} value - input.
 * @returns {string} hex sha256.
 */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * @param {string} target - absolute path of the patched file.
 * @returns {string} the backup path.
 */
function backupPath(target) {
  return target + BAK_SUFFIX
}

/**
 * @param {string} target - absolute path of the patched file.
 * @returns {string} the manifest path.
 */
function backupMetaPath(target) {
  return target + BAK_META_SUFFIX
}

/**
 * @returns {BackupMeta | null} the validated manifest, or null when absent/corrupt.
 */
function readBackupMeta(target) {
  const metaFile = backupMetaPath(target)
  if (!existsSync(metaFile) || !existsSync(backupPath(target))) return null
  try {
    const value = JSON.parse(readFileSync(metaFile, 'utf8'))
    if (
      typeof value.originalSha256 !== 'string' || typeof value.patchedSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.originalSha256)
      || !/^[a-f0-9]{64}$/.test(value.patchedSha256)
    ) {
      return null
    }
    const backup = readFileSync(backupPath(target))
    return sha256(backup) === value.originalSha256 ? value : null
  } catch {
    return null
  }
}

/**
 * @param {string} target - absolute path.
 * @param {string} originalSha256 - hash of the original.
 * @param {string} patchedSha256 - hash of the patched.
 * @returns {void}
 */
function writeBackupMeta(target, originalSha256, patchedSha256) {
  writeFileSync(backupMetaPath(target), `${JSON.stringify({ originalSha256, patchedSha256 })}\n`)
}

/**
 * Ensure a backup exists for a newly patched file; refresh the manifest when the
 * algorithm version bumps but always keep the true original.
 * @param {string} target - absolute path.
 * @param {string} original - pre-patch content.
 * @param {string} patched - post-patch content.
 * @returns {void}
 */
function ensureOriginalBackup(target, original, patched) {
  const existing = readBackupMeta(target)
  const originalHash = sha256(original)
  const patchedHash = sha256(patched)
  if (existing !== null && existing.originalSha256 === originalHash) {
    if (existing.patchedSha256 !== patchedHash) writeBackupMeta(target, originalHash, patchedHash)
    return
  }
  // A prior run's patched file may now be presented as "original" (upgrade path).
  // Keep the real original and just note the new patched id.
  if (existing !== null && existing.patchedSha256 === originalHash) {
    writeBackupMeta(target, existing.originalSha256, patchedHash)
    return
  }
  saveOriginalBackup(target, original, patched)
}

/**
 * @param {string} target - absolute path.
 * @param {string} original - the pre-patch content.
 * @param {string} patched - the post-patch content.
 * @returns {void}
 */
function saveOriginalBackup(target, original, patched) {
  writeFileSync(backupPath(target), original)
  writeFileSync(backupMetaPath(target), `${JSON.stringify({ originalSha256: sha256(original), patchedSha256: sha256(patched) })}\n`)
}

/**
 * Whether the on-disk target content equals the recorded patched hash.
 * @param {string} target - absolute path.
 * @returns {boolean} true when the file matches the patched manifest.
 */
function matchesPatchedBackup(target) {
  const meta = readBackupMeta(target)
  if (meta === null || !existsSync(target)) return false
  try {
    return sha256(readFileSync(target)) === meta.patchedSha256
  } catch {
    return false
  }
}

/**
 * Resolve the absolute path of a bundled file inside the dsh package tree.
 *
 * The plugin may be installed at a different depth than the target package, so
 * it walks Node's `node_modules` resolution rule upward from a series of
 * anchors (the caller's, the plugin's own module location, then `process.cwd()`),
 * which covers both a hoisted profile install and a nested `@deepseek-ai/dsh` tree.
 * @param {string} pkg - npm package name.
 * @param {string} relative - file inside the package.
 * @param {string[]} [anchors] - extra directories to seed resolution from.
 * @returns {string | null} the absolute path, or null when no copy is found.
 */
/**
 * Try to resolve the package inside a dsh SOURCE checkout, where the served
 * client bundles live under `packages/<group>/<pkg>/<file>` rather than in a
 * `node_modules` copy. The package directory name does not always derive from
 * the npm name (`@deepseek-ai/dsh-client-ui-settings` sits at
 * `packages/client/ui-settings`), so the scan matches each package's manifest
 * `name` field. A dsh launched from a source tree (the desktop shell's
 * `harness-versions` snapshot) serves exactly these files, so the patch must
 * find them here.
 * @param {string} pkg - npm package name.
 * @param {string} relative - file inside the package.
 * @param {string} root - an assumed dsh source root.
 * @returns {string | null} the absolute path, or null when not found.
 */
function resolveInSourceTree(pkg, relative, root) {
  const packagesDir = path.join(root, 'packages')
  if (!existsSync(packagesDir)) return null
  for (const group of readdirSync(packagesDir)) {
    const groupDir = path.join(packagesDir, group)
    if (!existsSync(groupDir)) continue
    for (const name of readdirSync(groupDir)) {
      const manifest = path.join(groupDir, name, 'package.json')
      if (!existsSync(manifest)) continue
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).name !== pkg) continue
      } catch {
        continue
      }
      const candidate = path.join(groupDir, name, relative)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Resolve the absolute path of a bundled file in the dsh package tree.
 *
 * The dsh web server serves client bundles from the resolved package entry:
 * in an installed profile that is `node_modules/<pkg>/<file>`, and in a source
 * tree (the desktop-served `harness-versions` snapshot, or a dev checkout) it
 * is `packages/<group>/<pkg>/<file>`. This walks Node's `node_modules` rule
 * upward from several anchors, then scans the source-tree layout, then falls
 * back to plain `require.resolve` from the plugin and from each anchor — so it
 * finds whichever copy the running dsh actually serves.
 * @param {string} pkg - npm package name.
 * @param {string} relative - file inside the package.
 * @param {string[]} [anchors] - extra directories to seed resolution from.
 * @returns {string | null} the absolute path, or null when no copy is found.
 */
export function resolveBundlePath(pkg, relative, anchors) {
  const candidates = [
    ...(anchors ?? []),
    path.dirname(import.meta.url),
    process.cwd(),
  ]
  for (const anchor of candidates) {
    // Installed profile: `node_modules/<pkg>/<file>` walked upward.
    let dir = anchor
    for (;;) {
      const candidate = path.join(dir, 'node_modules', pkg, relative)
      if (existsSync(candidate)) return candidate
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    // Source checkout: `packages/*/<pkg>/<file>` under the anchor.
    const source = resolveInSourceTree(pkg, relative, anchor)
    if (source !== null) return source
  }
  // Plain Node resolution from the plugin (hoisted profile) and from each
  // anchor (matching how the running dsh resolves the served bundle path).
  for (const anchor of candidates) {
    try {
      const require = createRequire(path.join(anchor, 'package.json'))
      const pkgJson = require.resolve(`${pkg}/package.json`)
      const candidate = path.join(path.dirname(pkgJson), relative)
      if (existsSync(candidate)) return candidate
    } catch {
      // Unresolvable from this anchor; try the next.
    }
  }
  return null
}

/**
 * Read the patch status of an already-resolved bundle path.
 * @param {string | null} target - absolute path of the bundle.
 * @returns {{ found: boolean, enabled: boolean, replaced: number }} the status.
 */
export function patchStatusAt(target) {
  if (target === null || target === undefined) return { found: false, enabled: false, replaced: 0 }
  let content
  try {
    content = readFileSync(target, 'utf8')
  } catch {
    return { found: false, enabled: false, replaced: 0 }
  }
  return {
    found: true,
    enabled: !hasUnpatchedTernary(content),
    replaced: (content.match(PERSISTENCE_TERNARY) ?? []).length,
  }
}

/**
 * Read the current patch status for a package's bundled file.
 * @param {string} [pkg] - target package; defaults to the settings bundle.
 * @param {string} [relative] - file inside the package.
 * @param {string[]} [anchors] - extra resolution anchors.
 * @returns {{ found: boolean, enabled: boolean, replaced: number }} the status.
 */
export function patchStatus(pkg = DEFAULT_PACKAGE, relative = DEFAULT_RELATIVE, anchors) {
  return patchStatusAt(resolveBundlePath(pkg, relative, anchors))
}

/**
 * Apply the persistence patch to an already-resolved bundle path
 * (idempotent, version-tolerant). This is the entry the cordis plugin uses when
 * the running dsh hands it the exact served bundle path via
 * `clientModules.clientPath(pkg)`.
 * @param {string | null} target - absolute path of the bundle to patch.
 * @returns {{ outcome: 'applied' | 'unchanged' | 'missing', replaced: number }} the result.
 */
export function patchFileAt(target) {
  if (target === null || target === undefined) return { outcome: 'missing', replaced: 0 }
  let content
  try {
    content = readFileSync(target, 'utf8')
  } catch {
    return { outcome: 'missing', replaced: 0 }
  }
  const { content: next, count } = transform(content)
  if (count === 0) return { outcome: 'unchanged', replaced: 0 }
  ensureOriginalBackup(target, content, next)
  writeFileSync(target, next)
  return { outcome: 'applied', replaced: count }
}

/**
 * Apply the persistence patch to a bundled file (idempotent, version-tolerant).
 * @param {string} [pkg] - target package; defaults to the settings bundle.
 * @param {string} [relative] - file inside the package.
 * @param {string[]} [anchors] - extra resolution anchors.
 * @returns {{ outcome: 'applied' | 'unchanged' | 'missing', replaced: number }} the result.
 */
export function applyRemoteSettingsPatch(pkg = DEFAULT_PACKAGE, relative = DEFAULT_RELATIVE, anchors) {
  return patchFileAt(resolveBundlePath(pkg, relative, anchors))
}

/**
 * Roll an already-resolved bundle path back from its saved backup.
 * @param {string | null} target - absolute path of the bundle.
 * @returns {'rolled-back' | 'no-backup' | 'missing'} the outcome.
 */
export function rollbackPatchAt(target) {
  if (target === null || target === undefined) return 'missing'
  if (!matchesPatchedBackup(target)) return 'no-backup'
  writeFileSync(target, readFileSync(backupPath(target)))
  return 'rolled-back'
}

/**
 * Roll the patch back from the saved backup.
 * @param {string} [pkg] - target package; defaults to the settings bundle.
 * @param {string} [relative] - file inside the package.
 * @param {string[]} [anchors] - extra resolution anchors.
 * @returns {'rolled-back' | 'no-backup' | 'missing'} the outcome.
 */
export function rollbackRemoteSettingsPatch(pkg = DEFAULT_PACKAGE, relative = DEFAULT_RELATIVE, anchors) {
  return rollbackPatchAt(resolveBundlePath(pkg, relative, anchors))
}

/**
 * Collect every bundle copy of `@deepseek-ai/dsh-*` in a dsh SOURCE tree.
 * The directory name does not always derive from the npm name, so it matches
 * each package's manifest `name` field.
 */
function collectSourceCopies(pkg, relative, root, out) {
  const packagesDir = path.join(root, 'packages')
  if (!existsSync(packagesDir)) return
  for (const group of readdirSync(packagesDir)) {
    const groupDir = path.join(packagesDir, group)
    if (!existsSync(groupDir)) continue
    for (const name of readdirSync(groupDir)) {
      const manifest = path.join(groupDir, name, 'package.json')
      if (!existsSync(manifest)) continue
      try {
        if (JSON.parse(readFileSync(manifest, 'utf8')).name !== pkg) continue
      } catch {
        continue
      }
      const candidate = path.join(groupDir, name, relative)
      if (existsSync(candidate)) out.set(candidate, candidate)
    }
  }
}

/** If any known target lives under a `harness-versions/<hash>/packages` tree,
 * return the `harness-versions` directory so sibling version trees can be
 * scanned too; otherwise null. */
function harnessVersionsRoot(paths) {
  for (const p of paths) {
    const parts = p.split(path.sep)
    const idx = parts.findIndex((seg, i) => seg === 'harness-versions' && i + 1 < parts.length)
    if (idx !== -1) return parts.slice(0, idx + 1).join(path.sep)
  }
  return null
}

/**
 * Every profile directory under a dsh home/base dir (`<base>/profiles/<name>`),
 * for the dirs that exist. A profile's `node_modules` is where profile plugins
 * like `dsh-passwords` are installed, so these anchors make the auto-detection
 * find a gateway served from the active profile even when the caller gives no
 * explicit anchor.
 * @param {string} home - a dsh home/base directory.
 * @returns {string[]} existing profile directories.
 */
export function profileAnchors(home) {
  const profiles = path.join(home, 'profiles')
  if (!existsSync(profiles)) return []
  const out = []
  for (const name of readdirSync(profiles)) {
    const profileDir = path.join(profiles, name)
    if (existsSync(profileDir)) out.push(profileDir)
  }
  return out
}

/**
 * Normalize a dsh `ctx.baseUrl` (a `file://` URL pointing at the profile
 * directory) into a filesystem path suitable for a resolution/scan anchor.
 * Non-file URLs (e.g. an `http://` base for a non-web profile) are returned
 * unchanged and simply fail to exist, so they are harmless.
 * @param {string | undefined} value - a base URL string.
 * @returns {string | undefined} the filesystem path, or undefined when absent.
 */
export function fsPathFromBaseUrl(value) {
  if (typeof value !== 'string') return undefined
  try {
    return value.startsWith('file:') ? fileURLToPath(value) : value
  } catch {
    return value
  }
}

/**
 * Candidate roots for auto-detection, independent of the current working
 * directory: the dsh home env, the desktop app-data tree (where the shell keeps
 * its `harness-versions` snapshots), the user dsh config dir, and each profile
 * directory under those bases. This lets the install script and the startup
 * patch self-detect even when dsh was launched from elsewhere, and reach
 * `node_modules` of the active profile where `dsh-passwords` lives.
 * @returns {string[]} existing candidate roots.
 */
export function defaultAnchors() {
  const bases = [
    process.env.DSH_HOME,
    process.env.APPDATA !== undefined ? path.join(process.env.APPDATA, 'DeepSeek Harness') : undefined,
    process.env.LOCALAPPDATA !== undefined ? path.join(process.env.LOCALAPPDATA, 'DeepSeek Harness') : undefined,
    process.platform === 'darwin' && process.env.HOME !== undefined
      ? path.join(process.env.HOME, 'Library', 'Application Support', 'DeepSeek Harness')
      : undefined,
    process.env.HOME !== undefined ? path.join(process.env.HOME, '.dsh') : undefined,
    process.env.USERPROFILE !== undefined ? path.join(process.env.USERPROFILE, '.dsh') : undefined,
  ].filter((value) => value !== undefined)
  const anchors = new Set()
  for (const base of bases) {
    if (!existsSync(base)) continue
    anchors.add(base)
    for (const profileDir of profileAnchors(base)) anchors.add(profileDir)
  }
  return [...anchors]
}

/**
 * Scan every `harness-versions/<version>/packages/<group>/<pkg>` copy under an
 * app-data root, so an anchor like the desktop app-data tree yields every
 * snapshot even before any live target pins the version set.
 */
function collectHarnessVersionsAt(pkg, relative, root, out) {
  const hv = path.join(root, 'harness-versions')
  if (!existsSync(hv)) return
  for (const ver of readdirSync(hv)) {
    collectSourceCopies(pkg, relative, path.join(hv, ver), out)
  }
}

/**
 * Find every candidate copy of the bundle that might be served: the served
 * path(s) handed in, every `node_modules` copy walked up from the anchors, every
 * source-checkout `packages/<group>/<pkg>` copy, and — when any live path sits in
 * a `harness-versions` snapshot — every sibling version tree. Patching "all"
 * instead of one means an upgrade that points dsh at a different snapshot tree
 * keeps working, and the patch never targets the wrong copy.
 * @param {string} pkg - npm package name.
 * @param {string} relative - file inside the package.
 * @param {string[]} [anchors] - extra resolution anchors.
 * @param {string[]} [seedPaths] - known served paths (from clientModules.clientPath).
 * @returns {string[]} unique absolute bundle paths.
 */
export function collectAllTargets(pkg, relative, anchors, seedPaths = []) {
  const targets = new Map()
  for (const seed of seedPaths) {
    if (seed) targets.set(seed, seed)
  }
  // Auto-detect from the dsh home / app-data roots when the caller gave no
  // explicit anchor (the install script, the plugin's no-anchor path); explicit
  // anchors (a --dir, the plugin's baseUrl seed) keep scanning deterministic.
  const explicit = (anchors ?? []).length > 0
  const candidates = [...(explicit ? [] : defaultAnchors()), ...(anchors ?? []), process.cwd()]
  for (const anchor of candidates) {
    // node_modules copy walked upward from each anchor.
    let dir = anchor
    for (;;) {
      const candidate = path.join(dir, 'node_modules', pkg, relative)
      if (existsSync(candidate)) targets.set(candidate, candidate)
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    // source-checkout copy under the anchor, and every harness-versions snapshot.
    collectSourceCopies(pkg, relative, anchor, targets)
    collectHarnessVersionsAt(pkg, relative, anchor, targets)
  }
  // Scan every harness-versions snapshot when one is present, so all version
  // trees get patched regardless of which one dsh currently serves from.
  const hv = harnessVersionsRoot([...targets.keys()])
  if (hv !== null) {
    for (const ver of readdirSync(hv)) {
      collectSourceCopies(pkg, relative, path.join(hv, ver), targets)
    }
  }
  return [...targets.keys()]
}

/**
 * Apply the patch to every found copy.
 * @param {string} [pkg] - target package; defaults to the settings bundle.
 * @param {string} [relative] - file inside the package.
 * @param {string[]} [anchors] - extra resolution anchors.
 * @param {string[]} [seedPaths] - known served paths to definitely patch.
 * @returns {{ targets: string[], applied: number, unchanged: number, missing: number }} summary.
 */
export function applyRemoteSettingsPatchAll(pkg = DEFAULT_PACKAGE, relative = DEFAULT_RELATIVE, anchors, seedPaths = []) {
  const targets = collectAllTargets(pkg, relative, anchors, seedPaths)
  let applied = 0
  let unchanged = 0
  let missing = 0
  const details = []
  for (const target of targets) {
    const result = patchFileAt(target)
    details.push({ target, ...result })
    if (result.outcome === 'applied') applied += 1
    else if (result.outcome === 'unchanged') unchanged += 1
    else missing += 1
  }
  return { targets: [...targets], applied, unchanged, missing, details }
}

/**
 * Report the patch status of every found copy.
 * @param {string} [pkg] - target package; defaults to the settings bundle.
 * @param {string} [relative] - file inside the package.
 * @param {string[]} [anchors] - extra resolution anchors.
 * @param {string[]} [seedPaths] - known served paths to definitely inspect.
 * @returns {Array<{ target: string, enabled: boolean, replaced: number }>} the copies.
 */
export function patchStatusAll(pkg = DEFAULT_PACKAGE, relative = DEFAULT_RELATIVE, anchors, seedPaths = []) {
  return collectAllTargets(pkg, relative, anchors, seedPaths).map((target) => ({
    target,
    ...patchStatusAt(target),
  }))
}

/**
 * Roll back every patched copy to its saved original (the uninstall path).
 * @param {string} [pkg] - target package; defaults to the settings bundle.
 * @param {string} [relative] - file inside the package.
 * @param {string[]} [anchors] - extra resolution anchors.
 * @param {string[]} [seedPaths] - known served paths to definitely inspect.
 * @returns {{ rolledBack: number, noBackup: number, targets: string[] }} summary.
 */
export function rollbackRemoteSettingsPatchAll(pkg = DEFAULT_PACKAGE, relative = DEFAULT_RELATIVE, anchors, seedPaths = []) {
  const targets = collectAllTargets(pkg, relative, anchors, seedPaths)
  let rolledBack = 0
  let noBackup = 0
  const details = []
  for (const target of targets) {
    const result = rollbackPatchAt(target)
    details.push({ target, result })
    if (result === 'rolled-back') rolledBack += 1
    else if (result === 'no-backup') noBackup += 1
  }
  return { rolledBack, noBackup, targets: [...targets], details }
}

export const GATEWAY_PACKAGE = 'dsh-passwords'
export const GATEWAY_FILE = path.join('dist', 'gateway.js')

const GATEWAY_TERNARY = /if\s*\(\s*!folderAllowed\s*\(\s*real\s*,\s*perms\.allowed_folders\s*\)\s*\)\s*\{/g
const GATEWAY_TERNARY_ONCE = /if\s*\(\s*!folderAllowed\s*\(\s*real\s*,\s*perms\.allowed_folders\s*\)\s*\)\s*\{/
const GATEWAY_REPLACEMENT = "if (me.role !== 'admin' && !folderAllowed(real, perms.allowed_folders)) {"

function hasUnpatchedGateway(content) {
  return GATEWAY_TERNARY_ONCE.test(content)
}

function transformGateway(content) {
  const count = (content.match(GATEWAY_TERNARY) ?? []).length
  if (count === 0) return { content, count: 0 }
  return { content: content.replace(GATEWAY_TERNARY, GATEWAY_REPLACEMENT), count }
}

function patchGatewayFileAt(target) {
  if (!target || !existsSync(target)) return { outcome: 'missing', replaced: 0 }
  const original = readFileSync(target, 'utf8')
  if (!hasUnpatchedGateway(original)) {
    return matchesPatchedBackup(target)
      ? { outcome: 'unchanged', replaced: 0 }
      : { outcome: 'unchanged', replaced: 0 }
  }
  const { content: patched, count } = transformGateway(original)
  ensureOriginalBackup(target, original, patched)
  writeFileSync(target, patched, 'utf8')
  return { outcome: 'applied', replaced: count }
}

function statusGatewayAt(target) {
  if (!target || !existsSync(target)) return { found: false, enabled: false, replaced: 0 }
  const content = readFileSync(target, 'utf8')
  const unpatchedCount = (content.match(GATEWAY_TERNARY) ?? []).length
  return {
    found: true,
    enabled: unpatchedCount === 0,
    replaced: unpatchedCount,
  }
}

export function patchGateway(anchors) {
  const targets = collectAllTargets(GATEWAY_PACKAGE, GATEWAY_FILE, anchors, [])
  let applied = 0
  let unchanged = 0
  let missing = 0
  const details = []
  for (const target of targets) {
    const result = patchGatewayFileAt(target)
    details.push({ target, ...result })
    if (result.outcome === 'applied') applied += 1
    else if (result.outcome === 'unchanged') unchanged += 1
    else missing += 1
  }
  return { targets: [...targets], applied, unchanged, missing, details }
}

export function statusGateway(anchors) {
  return collectAllTargets(GATEWAY_PACKAGE, GATEWAY_FILE, anchors, []).map((target) => ({
    target,
    ...statusGatewayAt(target),
  }))
}

export function rollbackGateway(anchors) {
  const targets = collectAllTargets(GATEWAY_PACKAGE, GATEWAY_FILE, anchors, [])
  let rolledBack = 0
  let noBackup = 0
  const details = []
  for (const target of targets) {
    const result = rollbackPatchAt(target)
    details.push({ target, result })
    if (result === 'rolled-back') rolledBack += 1
    else if (result === 'no-backup') noBackup += 1
  }
  return { rolledBack, noBackup, targets: [...targets], details }
}

export default {
  DEFAULT_PACKAGE,
  DEFAULT_RELATIVE,
  PERSISTENCE_TERNARY,
  patchStatus,
  patchStatusAt,
  patchStatusAll,
  applyRemoteSettingsPatch,
  applyRemoteSettingsPatchAll,
  patchFileAt,
  rollbackPatchAt,
  rollbackRemoteSettingsPatch,
  rollbackRemoteSettingsPatchAll,
  collectAllTargets,
  defaultAnchors,
  profileAnchors,
  fsPathFromBaseUrl,
  resolveBundlePath,
  GATEWAY_PACKAGE,
  GATEWAY_FILE,
  patchGateway,
  statusGateway,
  rollbackGateway,
}
