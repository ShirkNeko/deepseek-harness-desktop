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

// ── dsh-passwords gateway: short-lived ?token= media bypass ────────────────
// qqchat_send_image fetches ComfyUI media from the public origin, which sits
// behind the dsh-passwords login page; without a session cookie the fetch gets
// 302 -> /gateway/login and uploads the login HTML instead of the image. This
// injects a verifyMediaToken() helper plus a pre-session check that lets a GET
// carrying a short-lived signed ?token= through (bound to the exact path). The
// token is HMAC-SHA256 over base64url(path) + expiry, keyed by
// DSH_GATEWAY_MEDIA_TOKEN_SECRET. With the secret unset the bypass is disabled
// (verifyMediaToken returns false), so an unconfigured install stays locked.
export const DSPW_MEDIA_TOKEN_MARKER = 'dshpw-remote-settings: media-token bypass'
const DSPW_MEDIA_TOKEN_HELPER_ANCHOR =
  '    /** 子用户权限：缺行时默认关闭全部工作区；已有显式空白名单行仍表示不限目录。 */'
const DSPW_MEDIA_TOKEN_MW_ANCHOR = '            const user = sessionOf(req);'
const DSPW_MEDIA_TOKEN_HELPER = `    // ${DSPW_MEDIA_TOKEN_MARKER}
    function verifyMediaToken(req) {
        if (req.method !== 'GET' && req.method !== 'HEAD')
            return false;
        const secret = process.env.DSH_GATEWAY_MEDIA_TOKEN_SECRET || '';
        if (secret === '')
            return false;
        const token = typeof req.query.token === 'string' ? req.query.token : '';
        if (token === '')
            return false;
        const parts = token.split('.');
        if (parts.length !== 3)
            return false;
        const [b64, expStr, sig] = parts;
        const exp = Number(expStr);
        if (!Number.isFinite(exp) || exp < Date.now())
            return false;
        const payload = b64 + '.' + expStr;
        const expected = createHmac('sha256', secret).update(payload).digest('hex');
        if (sig.length !== expected.length)
            return false;
        let a; let b;
        try { a = Buffer.from(sig); b = Buffer.from(expected); } catch { return false; }
        if (!timingSafeEqual(a, b))
            return false;
        let prefix;
        try { prefix = Buffer.from(b64, 'base64url').toString('utf8'); } catch { return false; }
        if (prefix === '')
            return false;
        let pathname;
        try { pathname = new URL(req.originalUrl, 'http://' + (req.headers.host ?? 'localhost')).pathname; } catch { return false; }
        return pathname === prefix;
    }
`
const DSPW_MEDIA_TOKEN_BYPASS = '            if (verifyMediaToken(req))\n                return next();\n'
const isDspwMediaTokenPatched = (c) => c.includes('function verifyMediaToken(req)')
function transformDspwMediaToken(c) {
  if (isDspwMediaTokenPatched(c)) return { content: c, count: 0 }
  if (!c.includes(DSPW_MEDIA_TOKEN_HELPER_ANCHOR) || !c.includes(DSPW_MEDIA_TOKEN_MW_ANCHOR)) return { content: c, count: 0 }
  let patched = c.replace(DSPW_MEDIA_TOKEN_HELPER_ANCHOR, DSPW_MEDIA_TOKEN_HELPER + DSPW_MEDIA_TOKEN_HELPER_ANCHOR)
  patched = patched.replace(DSPW_MEDIA_TOKEN_MW_ANCHOR, DSPW_MEDIA_TOKEN_BYPASS + DSPW_MEDIA_TOKEN_MW_ANCHOR)
  return { content: patched, count: 2 }
}
const dspwMediaToken = filePatchRunner({
  pkg: GATEWAY_PACKAGE,
  relative: GATEWAY_FILE,
  transform: transformDspwMediaToken,
  isPatched: isDspwMediaTokenPatched,
})
export const patchGatewayMediaToken = (anchors, seedPaths = []) => dspwMediaToken.apply(anchors, seedPaths)
export const statusGatewayMediaToken = (anchors, seedPaths = []) => dspwMediaToken.status(anchors, seedPaths)
export const rollbackGatewayMediaToken = (anchors, seedPaths = []) => dspwMediaToken.rollback(anchors, seedPaths)

// ── dsh-passwords client card patches ──────────────────────────────────────
// The dsh-passwords settings card ships a CSS block (compiled into dist/client.js)
// whose status pills, avatar/button contrast, switch track and input hover/focus
// colors are hardcoded light-only. dsh's theme presenter sets `body[data-ds-dark-theme]`
// when the active color scheme is dark (and `color-scheme` on <html>), so the card
// looks wrong in dark mode. This appends a `body[data-ds-dark-theme]` override block
// scoped to the card classes, leaving the token-driven colors untouched.
export const DSPW_CLIENT_PACKAGE = 'dsh-passwords'
export const DSPW_CLIENT_FILE = path.join('dist', 'client.js')

/** Unique anchor: the last standalone rule before the reduced-motion / width media queries. */
const DSPW_DARK_ANCHOR = '.dshpw-ok{color:#10815f;font-size:12px}'
/** Dark-mode override block. Pure CSS; every rule is a `body[data-ds-dark-theme]` descendant. */
const DSPW_DARK_BLOCK = [
  'body[data-ds-dark-theme] .dshpw-status-neutral{background:#2a3239;color:var(--dshpw-muted)}',
  'body[data-ds-dark-theme] .dshpw-status-success{background:#12362b;color:#6fd9b0}',
  'body[data-ds-dark-theme] .dshpw-status-warning{background:#3a2f14;color:#ecc06a}',
  'body[data-ds-dark-theme] .dshpw-status-danger{background:#3a1f1e;color:#ff9a92}',
  'body[data-ds-dark-theme] .dshpw-avatar{background:#263038;color:#fff}',
  'body[data-ds-dark-theme] .dshpw-btn{background:#8b98a3;color:#10181d}',
  'body[data-ds-dark-theme] .dshpw-btn.danger{border-color:#e56a62;color:#ff9a92}',
  'body[data-ds-dark-theme] .dshpw-btn.danger:hover:not(:disabled){background:#3a1f1e}',
  'body[data-ds-dark-theme] .dshpw-switch-track{background:#3a424a}',
  'body[data-ds-dark-theme] .dshpw-input:hover{border-color:#4a545c;background:#1c242b}',
  'body[data-ds-dark-theme] .dshpw-input:focus{border-color:var(--dshpw-accent);background:#1c242b}',
  'body[data-ds-dark-theme] .dshpw-error{color:#ff9a92}',
  'body[data-ds-dark-theme] .dshpw-ok{color:#6fd9b0}',
  'body[data-ds-dark-theme] .dshpw-badge{color:#6fd9b0;background:#12362b}',
  'body[data-ds-dark-theme] .dshpw-badge.admin{color:#ecc06a;background:#3a2f14}',
].join('\n')

function hasDspwDarkOverride(content) {
  return content.includes('body[data-ds-dark-theme] .dshpw-status-neutral')
}

function transformDspwClient(content) {
  if (!content.includes(DSPW_DARK_ANCHOR)) return { content, count: 0 }
  return {
    content: content.replace(DSPW_DARK_ANCHOR, `${DSPW_DARK_ANCHOR}\n${DSPW_DARK_BLOCK}`),
    count: 1,
  }
}

function patchDspwClientFileAt(target) {
  if (!target || !existsSync(target)) return { outcome: 'missing', replaced: 0 }
  const original = readFileSync(target, 'utf8')
  if (hasDspwDarkOverride(original)) return { outcome: 'unchanged', replaced: 0 }
  const { content: patched, count } = transformDspwClient(original)
  if (count === 0) return { outcome: 'unchanged', replaced: 0 }
  ensureOriginalBackup(target, original, patched)
  writeFileSync(target, patched, 'utf8')
  return { outcome: 'applied', replaced: count }
}

function statusDspwClientAt(target) {
  if (!target || !existsSync(target)) return { found: false, enabled: false, replaced: 0 }
  const content = readFileSync(target, 'utf8')
  return { found: true, enabled: hasDspwDarkOverride(content), replaced: hasDspwDarkOverride(content) ? 0 : 1 }
}

export function patchDspwClient(anchors) {
  const targets = collectAllTargets(DSPW_CLIENT_PACKAGE, DSPW_CLIENT_FILE, anchors, [])
  let applied = 0
  let unchanged = 0
  let missing = 0
  const details = []
  for (const target of targets) {
    const result = patchDspwClientFileAt(target)
    details.push({ target, ...result })
    if (result.outcome === 'applied') applied += 1
    else if (result.outcome === 'unchanged') unchanged += 1
    else missing += 1
  }
  return { targets: [...targets], applied, unchanged, missing, details }
}

export function statusDspwClient(anchors) {
  return collectAllTargets(DSPW_CLIENT_PACKAGE, DSPW_CLIENT_FILE, anchors, []).map((target) => ({
    target,
    ...statusDspwClientAt(target),
  }))
}

export function rollbackDspwClient(anchors) {
  const targets = collectAllTargets(DSPW_CLIENT_PACKAGE, DSPW_CLIENT_FILE, anchors, [])
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

// ── dsh-passwords patch/status discovery fix ───────────────────────────────
// dsh-passwords' /api/dsh-passwords/patch/status reports "未知" when it cannot
// locate a dsh install root: its findDshRoot() only checks `npm root -g`, the
// cwd walk-up and /usr/local, so a desktop setup (dsh packages hoisted under a
// dsh home / profile node_modules) returns null and the card shows "unknown".
// This appends a dsh-home/"profiles" scan so it finds the desktop dsh root.
export const DSPW_PATCH_PACKAGE = 'dsh-passwords'
export const DSPW_PATCH_FILE = path.join('dist', 'patch.js')

const DSPW_FINDROOT_IMPORT_ANCHOR = "import { readFileSync, writeFileSync, existsSync } from 'node:fs';"
const DSPW_FINDROOT_IMPORT_TO = "import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';"
const DSPW_FINDROOT_ANCHOR = "    for (const candidate of [\n        '/usr/local/lib/node_modules/@deepseek-ai/dsh',"
const DSPW_FINDROOT_MARKER = 'dshpw-remote-settings: dsh home/profiles node_modules'
const DSPW_FINDROOT_SCAN = `    // ${DSPW_FINDROOT_MARKER}\n    const dshHomes = [\n        process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.dsh'),\n        process.env.HOME && path.join(process.env.HOME, '.dsh'),\n        process.env.APPDATA && path.join(process.env.APPDATA, 'DeepSeek Harness'),\n        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'DeepSeek Harness'),\n    ].filter(Boolean);\n    for (const home of dshHomes) {\n        const direct = path.join(home, 'node_modules', '@deepseek-ai', 'dsh');\n        if (existsSync(direct))\n            return direct;\n        const profiles = path.join(home, 'profiles');\n        if (existsSync(profiles)) {\n            const hoisted = path.join(profiles, 'node_modules', '@deepseek-ai', 'dsh');\n            if (existsSync(hoisted))\n                return hoisted;\n            for (const profile of readdirSync(profiles)) {\n                const candidate = path.join(profiles, profile, 'node_modules', '@deepseek-ai', 'dsh');\n                if (existsSync(candidate))\n                    return candidate;\n            }\n        }\n    }\n    `

function hasDspwFindRootPatch(content) {
  return content.includes(DSPW_FINDROOT_MARKER)
}

function patchDspwPatchFileAt(target) {
  if (!target || !existsSync(target)) return { outcome: 'missing', replaced: 0 }
  const original = readFileSync(target, 'utf8')
  if (hasDspwFindRootPatch(original)) return { outcome: 'unchanged', replaced: 0 }
  if (!original.includes(DSPW_FINDROOT_IMPORT_ANCHOR) || !original.includes(DSPW_FINDROOT_ANCHOR)) {
    return { outcome: 'unchanged', replaced: 0 }
  }
  let patched = original.replace(DSPW_FINDROOT_IMPORT_ANCHOR, DSPW_FINDROOT_IMPORT_TO)
  patched = patched.replace(DSPW_FINDROOT_ANCHOR, `${DSPW_FINDROOT_SCAN}${DSPW_FINDROOT_ANCHOR}`)
  ensureOriginalBackup(target, original, patched)
  writeFileSync(target, patched, 'utf8')
  return { outcome: 'applied', replaced: 1 }
}

function statusDspwPatchAt(target) {
  if (!target || !existsSync(target)) return { found: false, enabled: false, replaced: 0 }
  const content = readFileSync(target, 'utf8')
  return { found: true, enabled: hasDspwFindRootPatch(content), replaced: hasDspwFindRootPatch(content) ? 0 : 1 }
}

export function patchDspwPatch(anchors) {
  const targets = collectAllTargets(DSPW_PATCH_PACKAGE, DSPW_PATCH_FILE, anchors, [])
  let applied = 0
  let unchanged = 0
  let missing = 0
  const details = []
  for (const target of targets) {
    const result = patchDspwPatchFileAt(target)
    details.push({ target, ...result })
    if (result.outcome === 'applied') applied += 1
    else if (result.outcome === 'unchanged') unchanged += 1
    else missing += 1
  }
  return { targets: [...targets], applied, unchanged, missing, details }
}

export function statusDspwPatch(anchors) {
  return collectAllTargets(DSPW_PATCH_PACKAGE, DSPW_PATCH_FILE, anchors, []).map((target) => ({
    target,
    ...statusDspwPatchAt(target),
  }))
}

export function rollbackDspwPatch(anchors) {
  const targets = collectAllTargets(DSPW_PATCH_PACKAGE, DSPW_PATCH_FILE, anchors, [])
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

// ── dsh-passwords /gateway/api/permissions "deny all" save fix ─────────────
// The UI's workspace toggles send `allowedFolders: ['__deny__']` when every
// workspace is disabled, but the server's folder validation rejects `__deny__`
// (it is not an absolute path), so saving "no workspaces" returns 400 and the
// draft reverts. This exempts the `__deny__` sentinel from that validation.
export const DSPW_PERMS_PACKAGE = 'dsh-passwords'
export const DSPW_PERMS_FILE = path.join('dist', 'gateway.js')

const DSPW_PERMS_ANCHOR1 = "            return (trimmed === '' ||"
const DSPW_PERMS_ANCHOR2 = "            /^[a-z]:\\/$/i.test(normalizePath(trimmed)));"
const DSPW_PERMS_MARKER = 'dshpw-remote-settings: allow __deny__ in allowedFolders'
const DSPW_PERMS_TO1 = "            return (trimmed !== '__deny__' && (trimmed === '' ||"
const DSPW_PERMS_TO2 = "            /^[a-z]:\\/$/i.test(normalizePath(trimmed))));"

function hasDspwPermsPatch(content) {
  return content.includes(DSPW_PERMS_MARKER)
}

function patchDspwPermsFileAt(target) {
  if (!target || !existsSync(target)) return { outcome: 'missing', replaced: 0 }
  const original = readFileSync(target, 'utf8')
  if (hasDspwPermsPatch(original)) return { outcome: 'unchanged', replaced: 0 }
  if (!original.includes(DSPW_PERMS_ANCHOR1) || !original.includes(DSPW_PERMS_ANCHOR2)) {
    return { outcome: 'unchanged', replaced: 0 }
  }
  const patched = original
    .replace(DSPW_PERMS_ANCHOR1, `            // ${DSPW_PERMS_MARKER}\n${DSPW_PERMS_TO1}`)
    .replace(DSPW_PERMS_ANCHOR2, DSPW_PERMS_TO2)
  ensureOriginalBackup(target, original, patched)
  writeFileSync(target, patched, 'utf8')
  return { outcome: 'applied', replaced: 2 }
}

function statusDspwPermsAt(target) {
  if (!target || !existsSync(target)) return { found: false, enabled: false, replaced: 0 }
  const content = readFileSync(target, 'utf8')
  return { found: true, enabled: hasDspwPermsPatch(content), replaced: hasDspwPermsPatch(content) ? 0 : 1 }
}

export function patchDspwPerms(anchors) {
  const targets = collectAllTargets(DSPW_PERMS_PACKAGE, DSPW_PERMS_FILE, anchors, [])
  let applied = 0
  let unchanged = 0
  let missing = 0
  const details = []
  for (const target of targets) {
    const result = patchDspwPermsFileAt(target)
    details.push({ target, ...result })
    if (result.outcome === 'applied') applied += 1
    else if (result.outcome === 'unchanged') unchanged += 1
    else missing += 1
  }
  return { targets: [...targets], applied, unchanged, missing, details }
}

export function statusDspwPerms(anchors) {
  return collectAllTargets(DSPW_PERMS_PACKAGE, DSPW_PERMS_FILE, anchors, []).map((target) => ({
    target,
    ...statusDspwPermsAt(target),
  }))
}

export function rollbackDspwPerms(anchors) {
  const targets = collectAllTargets(DSPW_PERMS_PACKAGE, DSPW_PERMS_FILE, anchors, [])
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

// ── Generic marker-driven file patch runner ─────────────────────────────────
// Shared plumbing for the comfyui / qqchat patches below: resolve every copy of
// a target file, apply its transform with an original backup + sha256 manifest,
// report status, and roll back to the saved original. Mirrors the per-patch
// helpers above but parameterised so the new patches stay small.
function filePatchRunner({ pkg, relative, transform, isPatched }) {
  const apply = (anchors, seedPaths = []) => {
    const targets = collectAllTargets(pkg, relative, anchors, seedPaths)
    let applied = 0
    let unchanged = 0
    let missing = 0
    const details = []
    for (const target of targets) {
      if (!target || !existsSync(target)) {
        details.push({ target, outcome: 'missing', replaced: 0 })
        missing += 1
        continue
      }
      let original
      try {
        original = readFileSync(target, 'utf8')
      } catch {
        details.push({ target, outcome: 'missing', replaced: 0 })
        missing += 1
        continue
      }
      if (isPatched(original)) {
        details.push({ target, outcome: 'unchanged', replaced: 0 })
        unchanged += 1
        continue
      }
      const { content: patched, count } = transform(original)
      if (count === 0 || patched === original) {
        details.push({ target, outcome: 'unchanged', replaced: 0 })
        unchanged += 1
        continue
      }
      ensureOriginalBackup(target, original, patched)
      writeFileSync(target, patched, 'utf8')
      details.push({ target, outcome: 'applied', replaced: count })
      applied += 1
    }
    return { targets: [...targets], applied, unchanged, missing, details }
  }
  const status = (anchors, seedPaths = []) => collectAllTargets(pkg, relative, anchors, seedPaths).map((target) => {
    if (!target || !existsSync(target)) return { target, found: false, enabled: false, replaced: 0 }
    let content
    try {
      content = readFileSync(target, 'utf8')
    } catch {
      return { target, found: false, enabled: false, replaced: 0 }
    }
    const enabled = isPatched(content)
    return { target, found: true, enabled, replaced: enabled ? 0 : 1 }
  })
  const rollback = (anchors, seedPaths = []) => {
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
  return { apply, status, rollback }
}

// ── dsh-comfyui: media base three-address auto-detection ─────────────────────
// The original proxyBase() chose explicit mediaHost > hostHint.origin() > LAN >
// loopback, but hostHint.origin() returned external ?? loopback — so a
// loopback request (server-side tool calls) preempted the LAN/public address,
// and the selection never verified reachability. This patch:
//   - rewrites host-hint.js so it captures the browser-accessed origin
//     (x-forwarded-* / Host / Referer) separately from loopback, exposes
//     externalOrigin()/probeCandidates()/resolveMediaBase(), and probes the
//     reachable address segments (LAN IPv4, then loopback) with caching;
//   - rewires index.js proxyBase() to be async and call resolveMediaBase(), and
//     awaits it in the sweep path;
//   - awaits proxyBase in tools.js / routes.js.
export const COMFYUI_PACKAGE = 'dsh-comfyui'
export const COMFYUI_INDEX_FILE = path.join('lib', 'index.js')
export const COMFYUI_HOSTHINT_FILE = path.join('lib', 'host-hint.js')
export const COMFYUI_TOOLS_FILE = path.join('lib', 'tools.js')
export const COMFYUI_ROUTES_FILE = path.join('lib', 'routes.js')
export const COMFYUI_CLIENT_FILE = path.join('client', 'client.js')

const PATCH_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'patches')
function readPatchData(...parts) {
  return readFileSync(path.join(PATCH_DATA_DIR, ...parts), 'utf8')
}

// host-hint.js: whole-file rewrite (anchored on the original createHostHint tail).
const COMFYUI_HOSTHINT_ORIG_MARKER = 'return external ?? loopback;'
const COMFYUI_HOSTHINT_PATCH_MARKER = 'resolveMediaBase(port)'
const isComfyuiHostHintPatched = (c) => c.includes(COMFYUI_HOSTHINT_PATCH_MARKER)
function transformComfyuiHostHint(c) {
  if (isComfyuiHostHintPatched(c)) return { content: c, count: 0 }
  if (!c.includes(COMFYUI_HOSTHINT_ORIG_MARKER)) return { content: c, count: 0 }
  return { content: readPatchData('comfyui', 'host-hint.js'), count: 1 }
}

// index.js: async proxyBase + hostHint.resolveMediaBase + import + sweep await.
const CIX_IMPORT_ORIG = "import { createHostHint, detectLanOrigin } from './host-hint.js';"
const CIX_IMPORT_NEW = "import { createHostHint } from './host-hint.js';"
const CIX_ASYNC_ORIG = 'proxyBase: () => {'
const CIX_ASYNC_NEW = 'proxyBase: async () => {'
const CIX_SELECT_ORIG =
  '            const hinted = hostHint.origin();\n' +
  '            if (hinted !== undefined)\n' +
  '                return hinted;\n' +
  '            const ws = ctx.get(\'webServer\');\n' +
  '            if (ws === undefined || ws.port === undefined)\n' +
  '                return undefined;\n' +
  '            const lan = detectLanOrigin(ws.port);\n' +
  '            if (lan !== undefined)\n' +
  '                return lan;\n' +
  '            const host = ws.host === \'0.0.0.0\' ? \'127.0.0.1\' : ws.host ?? \'127.0.0.1\';\n' +
  '            return `http://${host}:${ws.port}`;'
const CIX_SELECT_NEW =
  '            const ws = ctx.get(\'webServer\');\n' +
  '            if (ws === undefined || ws.port === undefined)\n' +
  '                return undefined;\n' +
  '            return hostHint.resolveMediaBase(ws.port);'
const CIX_SWEEP_ORIG = 'proxyBase: runtime.proxyBase()'
const CIX_SWEEP_NEW = 'proxyBase: await runtime.proxyBase()'
const CIX_PATCH_MARKER = 'resolveMediaBase(ws.port)'
const isComfyuiIndexPatched = (c) => c.includes(CIX_PATCH_MARKER)
function transformComfyuiIndex(c) {
  if (isComfyuiIndexPatched(c)) return { content: c, count: 0 }
  if (!c.includes(CIX_IMPORT_ORIG) || !c.includes(CIX_SELECT_ORIG)) return { content: c, count: 0 }
  let patched = c.replace(CIX_IMPORT_ORIG, CIX_IMPORT_NEW)
  patched = patched.replace(CIX_ASYNC_ORIG, CIX_ASYNC_NEW)
  patched = patched.replace(CIX_SELECT_ORIG, CIX_SELECT_NEW)
  patched = patched.replace(CIX_SWEEP_ORIG, CIX_SWEEP_NEW)
  return { content: patched, count: 4 }
}

// tools.js / routes.js: await the now-async proxyBase().
const CFX_AWAIT_NEW = 'proxyBase: await runtime.proxyBase()'
const isComfyuiAwaitPatched = (c) => c.includes(CFX_AWAIT_NEW)
function transformComfyuiAwait(c) {
  if (isComfyuiAwaitPatched(c)) return { content: c, count: 0 }
  const count = (c.match(/proxyBase: runtime\.proxyBase\(\)/g) ?? []).length
  if (count === 0) return { content: c, count: 0 }
  return { content: c.replace(/proxyBase: runtime\.proxyBase\(\)/g, CFX_AWAIT_NEW), count }
}

const comfyuiHostHint = filePatchRunner({
  pkg: COMFYUI_PACKAGE, relative: COMFYUI_HOSTHINT_FILE,
  transform: transformComfyuiHostHint, isPatched: isComfyuiHostHintPatched,
})
const comfyuiIndex = filePatchRunner({
  pkg: COMFYUI_PACKAGE, relative: COMFYUI_INDEX_FILE,
  transform: transformComfyuiIndex, isPatched: isComfyuiIndexPatched,
})
const comfyuiTools = filePatchRunner({
  pkg: COMFYUI_PACKAGE, relative: COMFYUI_TOOLS_FILE,
  transform: transformComfyuiAwait, isPatched: isComfyuiAwaitPatched,
})
const comfyuiRoutes = filePatchRunner({
  pkg: COMFYUI_PACKAGE, relative: COMFYUI_ROUTES_FILE,
  transform: transformComfyuiAwait, isPatched: isComfyuiAwaitPatched,
})

// client.js: media URLs that point at loopback are rewritten to the origin the
// browser is actually on, so the generated media loads no matter which address
// the user opened the page with (loopback / LAN / public). Adds a mediaSrc()
// helper and uses it for the card <img>/<video>/<audio>, the download link and
// the lightbox.
const CFX_CLIENT_LIGHTBOX_ORIG = 'const src = images[index];'
const CFX_CLIENT_LIGHTBOX_NEW = 'const src = mediaSrc(images[index]);'
const CFX_CLIENT_SRC_ORIG = 'src: item.url,'
const CFX_CLIENT_SRC_NEW = 'src: mediaSrc(item.url),'
const CFX_CLIENT_HREF_ORIG = 'href: item.url,'
const CFX_CLIENT_HREF_NEW = 'href: mediaSrc(item.url),'
const CFX_CLIENT_MEDIAITEM_START = '\t\tfunction MediaItem({ item, t, onOpen }) {'
const CFX_CLIENT_MEDIASRC_FN =
  '\t\t/** Resolve a media URL to the origin the browser is actually on when the\n' +
  '\t\t * baked URL points at loopback (127.0.0.1/localhost), so images load no\n' +
  '\t\t * matter which address the user opened the page with (loopback / LAN / public). */\n' +
  '\t\tfunction mediaSrc(url) {\n' +
  '\t\t\tif (typeof url !== "string" || url === "") return url;\n' +
  '\t\t\tlet u;\n' +
  '\t\t\ttry { u = new URL(url, window.location.href); } catch { return url; }\n' +
  '\t\t\tconst host = window.location.host;\n' +
  '\t\t\tconst loop = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1" || u.hostname === "0.0.0.0";\n' +
  '\t\t\tif (host && loop) { u.protocol = window.location.protocol; u.host = host; return u.href; }\n' +
  '\t\t\treturn url;\n' +
  '\t\t}'
const CFX_CLIENT_MARKER = 'function mediaSrc(url)'
const isComfyuiClientPatched = (c) => c.includes(CFX_CLIENT_MARKER)
function transformComfyuiClient(c) {
  if (isComfyuiClientPatched(c)) return { content: c, count: 0 }
  if (!c.includes(CFX_CLIENT_LIGHTBOX_ORIG) || !c.includes(CFX_CLIENT_SRC_ORIG)
    || !c.includes(CFX_CLIENT_HREF_ORIG) || !c.includes(CFX_CLIENT_MEDIAITEM_START)) {
    return { content: c, count: 0 }
  }
  let patched = c.replace(CFX_CLIENT_LIGHTBOX_ORIG, CFX_CLIENT_LIGHTBOX_NEW)
  patched = patched.replaceAll(CFX_CLIENT_SRC_ORIG, CFX_CLIENT_SRC_NEW)
  patched = patched.replace(CFX_CLIENT_HREF_ORIG, CFX_CLIENT_HREF_NEW)
  patched = patched.replace(CFX_CLIENT_MEDIAITEM_START, `${CFX_CLIENT_MEDIASRC_FN}\n${CFX_CLIENT_MEDIAITEM_START}`)
  return { content: patched, count: 6 }
}
const comfyuiClient = filePatchRunner({
  pkg: COMFYUI_PACKAGE, relative: COMFYUI_CLIENT_FILE,
  transform: transformComfyuiClient, isPatched: isComfyuiClientPatched,
})

export const patchComfyuiMediaBase = (anchors, seedPaths = []) => {
  const runs = [
    comfyuiIndex.apply(anchors, seedPaths),
    comfyuiHostHint.apply(anchors, seedPaths),
    comfyuiTools.apply(anchors, seedPaths),
    comfyuiRoutes.apply(anchors, seedPaths),
    comfyuiClient.apply(anchors, seedPaths),
  ]
  const applied = runs.reduce((sum, r) => sum + r.applied, 0)
  const unchanged = runs.reduce((sum, r) => sum + r.unchanged, 0)
  const missing = runs.reduce((sum, r) => sum + r.missing, 0)
  return {
    applied, unchanged, missing,
    targets: [...new Set(runs.flatMap((r) => r.targets))],
    details: runs.flatMap((r) => r.details),
  }
}
export const statusComfyuiMediaBase = (anchors, seedPaths = []) => [
  ...comfyuiIndex.status(anchors, seedPaths),
  ...comfyuiHostHint.status(anchors, seedPaths),
  ...comfyuiTools.status(anchors, seedPaths),
  ...comfyuiRoutes.status(anchors, seedPaths),
  ...comfyuiClient.status(anchors, seedPaths),
]
export const rollbackComfyuiMediaBase = (anchors, seedPaths = []) => {
  const results = [
    comfyuiIndex.rollback(anchors, seedPaths),
    comfyuiHostHint.rollback(anchors, seedPaths),
    comfyuiTools.rollback(anchors, seedPaths),
    comfyuiRoutes.rollback(anchors, seedPaths),
    comfyuiClient.rollback(anchors, seedPaths),
  ]
  return {
    rolledBack: results.reduce((sum, r) => sum + r.rolledBack, 0),
    noBackup: results.reduce((sum, r) => sum + r.noBackup, 0),
    targets: [...new Set(results.flatMap((r) => r.targets))],
    details: results.flatMap((r) => r.details),
  }
}
export const patchComfyuiClient = (anchors, seedPaths = []) => comfyuiClient.apply(anchors, seedPaths)
export const statusComfyuiClient = (anchors, seedPaths = []) => comfyuiClient.status(anchors, seedPaths)
export const rollbackComfyuiClient = (anchors, seedPaths = []) => comfyuiClient.rollback(anchors, seedPaths)

// ── dsh-comfyui: surface the LLM-generated prompt in results ────────────────
// TextGenerate (Qwen) builds the prompt at runtime and ComfyUI never persists
// that text in /history, so the tool results carried no prompt. This patch
// captures the text from the WebSocket `executed` event (progress.js) and, with
// the history graph (comfyui.js collectPromptText), adds a `prompt` field to the
// comfyui_run / comfyui_workflow results and the workflow-job media endpoint.
export const COMFYUI_PROGRESS_FILE = path.join('lib', 'progress.js')
export const COMFYUI_COMFYUI_FILE = path.join('lib', 'comfyui.js')

// comfyui.js: whole-file rewrite (adds collectPromptText + historyNodeText).
const CFX_CP_MARKER = 'collectPromptText'
const isComfyuiPromptPatched = (c) => c.includes(CFX_CP_MARKER)
function transformComfyuiPrompt(c) {
  if (isComfyuiPromptPatched(c)) return { content: c, count: 0 }
  if (!c.includes('export function collectMedia')) return { content: c, count: 0 }
  return { content: readPatchData('comfyui', 'comfyui.js'), count: 1 }
}
// progress.js: whole-file rewrite (captures `executed` text outputs).
const CFX_PROG_MARKER = 'promptOutputs(promptId)'
const isProgressPatched = (c) => c.includes(CFX_PROG_MARKER)
function transformProgressPrompt(c) {
  if (isProgressPatched(c)) return { content: c, count: 0 }
  if (!c.includes('export class ProgressTracker {')) return { content: c, count: 0 }
  return { content: readPatchData('comfyui', 'progress.js'), count: 1 }
}
// tools.js: import collectPromptText + add the `prompt` field to each sync result.
const CFXT_IMPORT_ORIG = "import { collectMedia } from './comfyui.js';"
const CFXT_IMPORT_NEW = "import { collectMedia, collectPromptText } from './comfyui.js';"
const CFXT_PROMPT_LINE = 'prompt: collectPromptText(entry, runtime.queuedPromptOutputs(promptId)),\n'
const CFXT_MARKER = 'collectPromptText(entry, runtime.queuedPromptOutputs(promptId))'
const isToolsPromptPatched = (c) => c.includes(CFXT_MARKER)
function transformToolsPrompt(c) {
  if (isToolsPromptPatched(c)) return { content: c, count: 0 }
  if (!c.includes(CFXT_IMPORT_ORIG) || !c.includes('media: items,')) return { content: c, count: 0 }
  let patched = c.replace(CFXT_IMPORT_ORIG, CFXT_IMPORT_NEW)
  patched = patched.replace(/media: items,\n(\s+)summary: summarizeMedia\(items\),/g, (m, sp) => `media: items,\n${sp}${CFXT_PROMPT_LINE}${sp}summary: summarizeMedia(items),`)
  return { content: patched, count: 1 }
}
// index.js: expose queuedPromptOutputs (runtime) + pass wsOutputs to sweep.
const CFXI_QUEUE_ORIG = 'queueProgress: (promptId) => progress.get(promptId),'
const CFXI_QUEUE_NEW = CFXI_QUEUE_ORIG + "\n        queuedPromptOutputs: (promptId) => progress.promptOutputs(promptId),"
const CFXI_MARKER = 'queuedPromptOutputs'
const CFXI_WS_ORIG = '        const wsUrl = resolved.baseUrl.replace(/^http:/, \'ws:\').replace(/^https:/, \'wss:\').replace(/\\/$/, \'\') + `\/ws?clientId=${CLIENT_ID}`;\n        progress.attach(wsUrl);'
const CFXI_WS_NEW = '        progress.attach(() => resolved.baseUrl.replace(/^http:/, \'ws:\').replace(/^https:/, \'wss:\').replace(/\\/$/, \'\') + `\/ws?clientId=${CLIENT_ID}`);'
const isIndexPromptPatched = (c) => c.includes(CFXI_MARKER)
function transformIndexPrompt(c) {
  if (isIndexPromptPatched(c)) return { content: c, count: 0 }
  if (!c.includes(CFXI_QUEUE_ORIG) || !c.includes(CFXI_WS_ORIG)) return { content: c, count: 0 }
  let patched = c.replace(CFXI_QUEUE_ORIG, CFXI_QUEUE_NEW)
  patched = patched.replace(/proxyBase: (await )?runtime\.proxyBase\(\) \}\);/, (m, a) => `proxyBase: ${a ?? ''}runtime.proxyBase(), wsOutputs: runtime.queuedPromptOutputs });`)
  patched = patched.replace(CFXI_WS_ORIG, CFXI_WS_NEW)
  return { content: patched, count: 3 }
}

const comfyuiCp = filePatchRunner({ pkg: COMFYUI_PACKAGE, relative: COMFYUI_COMFYUI_FILE, transform: transformComfyuiPrompt, isPatched: isComfyuiPromptPatched })
const comfyuiProgress = filePatchRunner({ pkg: COMFYUI_PACKAGE, relative: COMFYUI_PROGRESS_FILE, transform: transformProgressPrompt, isPatched: isProgressPatched })
const comfyuiToolsPs = filePatchRunner({ pkg: COMFYUI_PACKAGE, relative: COMFYUI_TOOLS_FILE, transform: transformToolsPrompt, isPatched: isToolsPromptPatched })
const comfyuiIndexPs = filePatchRunner({ pkg: COMFYUI_PACKAGE, relative: COMFYUI_INDEX_FILE, transform: transformIndexPrompt, isPatched: isIndexPromptPatched })

export const patchComfyuiPromptSurface = (anchors, seedPaths = []) => {
  const runs = [comfyuiCp.apply(anchors, seedPaths), comfyuiProgress.apply(anchors, seedPaths), comfyuiToolsPs.apply(anchors, seedPaths), comfyuiIndexPs.apply(anchors, seedPaths)]
  return {
    applied: runs.reduce((s, r) => s + r.applied, 0),
    unchanged: runs.reduce((s, r) => s + r.unchanged, 0),
    missing: runs.reduce((s, r) => s + r.missing, 0),
    targets: [...new Set(runs.flatMap((r) => r.targets))],
    details: runs.flatMap((r) => r.details),
  }
}
export const statusComfyuiPromptSurface = (anchors, seedPaths = []) => [
  ...comfyuiCp.status(anchors, seedPaths),
  ...comfyuiProgress.status(anchors, seedPaths),
  ...comfyuiToolsPs.status(anchors, seedPaths),
  ...comfyuiIndexPs.status(anchors, seedPaths),
]
export const rollbackComfyuiPromptSurface = (anchors, seedPaths = []) => {
  const results = [comfyuiCp.rollback(anchors, seedPaths), comfyuiProgress.rollback(anchors, seedPaths), comfyuiToolsPs.rollback(anchors, seedPaths), comfyuiIndexPs.rollback(anchors, seedPaths)]
  return {
    rolledBack: results.reduce((s, r) => s + r.rolledBack, 0),
    noBackup: results.reduce((s, r) => s + r.noBackup, 0),
    targets: [...new Set(results.flatMap((r) => r.targets))],
    details: results.flatMap((r) => r.details),
  }
}

// ── dsh-qqchat: ComfyUI image-download base address ─────────────────────────
// qqchat_send_image downloaded an http(s) image URL verbatim. A ComfyUI media
// URL on the public origin sits behind the dsh-passwords login page, so the
// server-side fetch is redirected to /gateway/login and uploads the login HTML
// instead of the image. This injects resolveComfyuiMediaUrl(), which appends a
// short-lived signed ?token= (HMAC via DSH_GATEWAY_MEDIA_TOKEN_SECRET) that the
// gateway accepts, so the fetch gets past the login page. When the secret is
// unset the URL is left unchanged (no bypass).
export const QQCHAT_PACKAGE = 'dsh-qqchat'
export const QQCHAT_SENDTOOL_FILE = path.join('lib', 'media', 'send-tool.js')

const QQCHAT_FETCH_ORIG = 'const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });'
const QQCHAT_FETCH_NEW = 'const response = await fetch(resolveComfyuiMediaUrl(source), { signal: AbortSignal.timeout(30_000) });'
const QQCHAT_IMPORT_ORIG = "import { defineTool } from '@deepseek-ai/dsh-tools';"
const QQCHAT_HELPER = '\n' + [
  "import { createHmac } from 'node:crypto';",
  '/** Append a short-lived signed ?token= to a ComfyUI media URL so a fetch of the',
  ' * public origin gets past the dsh-passwords login page. The gateway validates the',
  ' * token (HMAC-SHA256 over base64url(path) + expiry, keyed by',
  ' * DSH_GATEWAY_MEDIA_TOKEN_SECRET) and only for the exact path it was minted for.',
  ' * When the secret is unset the URL is left unchanged (no bypass). */',
  'function resolveComfyuiMediaUrl(source) {',
  '    if (!/\\/comfyui\\/media(\\?|$)/.test(source)) return source;',
  "    const secret = process.env.DSH_GATEWAY_MEDIA_TOKEN_SECRET || '';",
  "    if (secret === '') return source;",
  '    let url; try { url = new URL(source); } catch { return source; }',
  "    const b64 = Buffer.from(url.pathname, 'utf8').toString('base64url');",
  '    const exp = Date.now() + 5 * 60 * 1000;',
  '    const payload = b64 + \'.\' + exp;',
  "    const sig = createHmac('sha256', secret).update(payload).digest('hex');",
  '    const token = payload + \'.\' + sig;',
  "    return source + (source.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);",
  '}',
].join('\n')
const QQCHAT_PATCH_MARKER = 'resolveComfyuiMediaUrl'
const isQqchatSendToolPatched = (c) => c.includes(QQCHAT_PATCH_MARKER)
function transformQqchatSendTool(c) {
  if (isQqchatSendToolPatched(c)) return { content: c, count: 0 }
  if (!c.includes(QQCHAT_FETCH_ORIG)) return { content: c, count: 0 }
  let patched = c.replace(QQCHAT_FETCH_ORIG, QQCHAT_FETCH_NEW)
  patched = patched.replace(QQCHAT_IMPORT_ORIG, QQCHAT_IMPORT_ORIG + QQCHAT_HELPER)
  return { content: patched, count: 2 }
}
const qqchatSendTool = filePatchRunner({
  pkg: QQCHAT_PACKAGE, relative: QQCHAT_SENDTOOL_FILE,
  transform: transformQqchatSendTool, isPatched: isQqchatSendToolPatched,
})
export const patchQqchatComfyuiBase = (anchors, seedPaths = []) => qqchatSendTool.apply(anchors, seedPaths)
export const statusQqchatComfyuiBase = (anchors, seedPaths = []) => qqchatSendTool.status(anchors, seedPaths)
export const rollbackQqchatComfyuiBase = (anchors, seedPaths = []) => qqchatSendTool.rollback(anchors, seedPaths)

export const applyComfyuiMediaBase = patchComfyuiMediaBase
export const applyQqchatComfyuiBase = patchQqchatComfyuiBase

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
  DSPW_MEDIA_TOKEN_MARKER,
  patchGatewayMediaToken,
  statusGatewayMediaToken,
  rollbackGatewayMediaToken,
  DSPW_CLIENT_PACKAGE,
  DSPW_CLIENT_FILE,
  patchDspwClient,
  statusDspwClient,
  rollbackDspwClient,
  DSPW_PATCH_PACKAGE,
  DSPW_PATCH_FILE,
  patchDspwPatch,
  statusDspwPatch,
  rollbackDspwPatch,
  DSPW_PERMS_PACKAGE,
  DSPW_PERMS_FILE,
  patchDspwPerms,
  statusDspwPerms,
  rollbackDspwPerms,
  COMFYUI_PACKAGE,
  COMFYUI_INDEX_FILE,
  COMFYUI_HOSTHINT_FILE,
  COMFYUI_TOOLS_FILE,
  COMFYUI_ROUTES_FILE,
  COMFYUI_CLIENT_FILE,
  patchComfyuiMediaBase,
  applyComfyuiMediaBase,
  statusComfyuiMediaBase,
  rollbackComfyuiMediaBase,
  patchComfyuiClient,
  statusComfyuiClient,
  rollbackComfyuiClient,
  COMFYUI_PROGRESS_FILE,
  COMFYUI_COMFYUI_FILE,
  patchComfyuiPromptSurface,
  statusComfyuiPromptSurface,
  rollbackComfyuiPromptSurface,
  QQCHAT_PACKAGE,
  QQCHAT_SENDTOOL_FILE,
  patchQqchatComfyuiBase,
  applyQqchatComfyuiBase,
  statusQqchatComfyuiBase,
  rollbackQqchatComfyuiBase,
}
