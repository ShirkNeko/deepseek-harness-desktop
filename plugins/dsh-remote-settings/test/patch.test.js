import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply as applyPlugin } from '../lib/index.js'
import {
  DEFAULT_PACKAGE,
  DEFAULT_RELATIVE,
  applyRemoteSettingsPatch,
  patchStatus,
  patchStatusAt,
  patchFileAt,
  rollbackPatchAt,
  rollbackRemoteSettingsPatch,
  collectAllTargets,
  applyRemoteSettingsPatchAll,
  patchStatusAll,
  rollbackRemoteSettingsPatchAll,
  GATEWAY_PACKAGE,
  GATEWAY_FILE,
  patchGateway,
  statusGateway,
  rollbackGateway,
  defaultAnchors,
  profileAnchors,
  fsPathFromBaseUrl,
} from '../lib/patch.js'

/** Build 2 harness-versions snapshot trees, each with a ui-settings bundle. */
function makeHarnessVersions() {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-hv-'))
  for (const ver of ['verA', 'verB']) {
    const pkgDir = path.join(root, 'harness-versions', ver, 'packages', 'client', 'ui-settings')
    mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: DEFAULT_PACKAGE, version: '1' }))
    writeFileSync(path.join(pkgDir, DEFAULT_RELATIVE), CANONICAL)
  }
  return root
}

/** Build a fake package tree under a temp dir and return its root. */
function makeTree(content) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-remote-settings-test-'))
  const pkgDir = path.join(root, 'node_modules', DEFAULT_PACKAGE)
  mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(path.join(pkgDir, DEFAULT_RELATIVE), content)
  return root
}

function targetPath(root) {
  return path.join(root, 'node_modules', DEFAULT_PACKAGE, DEFAULT_RELATIVE)
}

const CANONICAL = [
  // The two real occurrences dsh ships today: SettingsScopeController + SettingsDescribeMirror.
  'new SettingsScopeController(connection.api, spec, this.mirror, connection.isLoopback ? "host" : "memory", this.schema);\n',
  'const mirror = new SettingsDescribeMirror(connection.api, connection.isLoopback ? "host" : "memory");\n',
].join('')

test('detects the unpatched ternary across quoting/whitespace variants', () => {
  const variants = [
    CANONICAL,
    `connection.isLoopback ? "host" : "memory"`,
    `connection.isLoopback ? 'host' : 'memory'`,
    `connection.isLoopback\n  ? "host"\n  : "memory"`,
    `connection.isLoopback ? "host" : "memory"  // persistence`,
    `connection.isLoopback ? "host" : "memory" ;`,
  ]
  for (const v of variants) {
    const status = patchStatus(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [makeTree(v)])
    assert.equal(status.found, true, `should find ${v}`)
    assert.equal(status.enabled, false, `should be disabled for ${v}`)
    assert.equal(status.replaced >= 1, true, `should see >=1 ternary for ${v}`)
  }
})

test('status reports enabled once patched (ternary gone)', () => {
  const root = makeTree(CANONICAL)
  const status = patchStatus(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [root])
  assert.equal(status.found, true)
  assert.equal(status.enabled, false)
})

test('apply replaces every occurrence and is idempotent', () => {
  const root = makeTree(CANONICAL)
  const first = applyRemoteSettingsPatch(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [root])
  assert.equal(first.outcome, 'applied')
  assert.equal(first.replaced, 2)
  const patched = readFileSync(targetPath(root), 'utf8')
  assert.equal(patched.includes('connection.isLoopback ? "host" : "memory"'), false)
  assert.equal(patched.includes('"host"'), true)

  const second = applyRemoteSettingsPatch(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [root])
  assert.equal(second.outcome, 'unchanged')
  assert.equal(second.replaced, 0)

  const status = patchStatus(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [root])
  assert.equal(status.enabled, true)
  assert.equal(status.replaced, 0)

  rmSync(root, { recursive: true, force: true })
})

test('rollback restores the exact original content', () => {
  const root = makeTree(CANONICAL)
  applyRemoteSettingsPatch(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [root])
  const result = rollbackRemoteSettingsPatch(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [root])
  assert.equal(result, 'rolled-back')
  assert.equal(readFileSync(targetPath(root), 'utf8'), CANONICAL)
  rmSync(root, { recursive: true, force: true })
})

test('rollback without a backup is a no-op', () => {
  const root = makeTree(CANONICAL)
  // No apply first: there is no patched backup.
  const result = rollbackRemoteSettingsPatch(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [root])
  assert.equal(result, 'no-backup')
  rmSync(root, { recursive: true, force: true })
})

test('apply on a missing target reports missing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-remote-settings-empty-'))
  const result = applyRemoteSettingsPatch(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [root])
  assert.equal(result.outcome, 'missing')
  rmSync(root, { recursive: true, force: true })
})

test('already-native bundle (no ternary) is reported enabled and unchanged', () => {
  const native = 'const mirror = new SettingsDescribeMirror(connection.api, "host");\n'
  const root = makeTree(native)
  const status = patchStatus(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [root])
  assert.equal(status.enabled, true)
  assert.equal(status.replaced, 0)
  const result = applyRemoteSettingsPatch(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [root])
  assert.equal(result.outcome, 'unchanged')
  rmSync(root, { recursive: true, force: true })
})

test('patchFileAt / patchStatusAt work on a direct path (the exact served file)', () => {
  const content = CANONICAL
  const root = makeTree(content)
  const target = targetPath(root)
  // Since the running dsh reports the exact file to patch, the plugin patches
  // that path directly, bypassing resolution.
  const before = patchStatusAt(target)
  assert.equal(before.enabled, false)
  const result = patchFileAt(target)
  assert.equal(result.outcome, 'applied')
  assert.equal(result.replaced, 2)
  const after = patchStatusAt(target)
  assert.equal(after.enabled, true)
  assert.equal(after.replaced, 0)
  rmSync(root, { recursive: true, force: true })
})

test('patchFileAt(null) reports missing without throwing', () => {
  const result = patchFileAt(null)
  assert.equal(result.outcome, 'missing')
  assert.equal(patchStatusAt(null).found, false)
})

test('rollbackPatchAt restores the exact served file (and no-backup without one)', () => {
  const root = makeTree(CANONICAL)
  const target = targetPath(root)
  patchFileAt(target)
  assert.equal(rollbackPatchAt(target), 'rolled-back')
  assert.equal(readFileSync(target, 'utf8'), CANONICAL)
  // No backup present now: rolling back again is a no-op.
  assert.equal(rollbackPatchAt(target), 'no-backup')
  assert.equal(rollbackPatchAt(null), 'missing')
  rmSync(root, { recursive: true, force: true })
})

test('collectAllTargets matches every harness-versions snapshot, not just the seeded one', () => {
  const root = makeHarnessVersions()
  const verA = path.join(root, 'harness-versions', 'verA')
  // Anchor at one tree; the sibling-version scan should discover the other too.
  const targets = collectAllTargets(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [verA], [])
  assert.equal(targets.length, 2)
  assert.ok(targets.some(t => t.includes(path.join('verA'))))
  assert.ok(targets.some(t => t.includes(path.join('verB'))))
  rmSync(root, { recursive: true, force: true })
})

test('applyAll patches every copy and rollbackAll (uninstall) restores every copy', () => {
  const root = makeHarnessVersions()
  const verA = path.join(root, 'harness-versions', 'verA')
  const before = patchStatusAll(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [verA])
  assert.equal(before.length, 2)
  assert.ok(before.every(copy => !copy.enabled))

  const patched = applyRemoteSettingsPatchAll(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [verA])
  assert.equal(patched.applied, 2)
  assert.ok(patchStatusAll(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [verA]).every(copy => copy.enabled))

  // Idempotent second apply.
  const again = applyRemoteSettingsPatchAll(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [verA])
  assert.equal(again.unchanged, 2)

  // Uninstall path: restore every copy to its original.
  const restored = rollbackRemoteSettingsPatchAll(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [verA])
  assert.equal(restored.rolledBack, 2)
  assert.ok(patchStatusAll(DEFAULT_PACKAGE, DEFAULT_RELATIVE, [verA]).every(copy => !copy.enabled))
  rmSync(root, { recursive: true, force: true })
})

test('gateway patch lets owner/admin bypass the download allowlist (reversible)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-gw-'))
  const pkgDir = path.join(root, 'node_modules', 'dsh-passwords', 'dist')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: GATEWAY_PACKAGE }))
  const gateway =
    "        const perms = effectivePermissions(me.userId);\n" +
    "        if (!folderAllowed(real, perms.allowed_folders)) {\n" +
    "          res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '目录越权' });\n" +
    "          return;\n" +
    "        }\n"
  writeFileSync(path.join(pkgDir, 'gateway.js'), gateway)

  const target = path.join(pkgDir, 'gateway.js')
  const before = statusGateway([root])
  assert.equal(before[0].enabled, false)
  const patched = patchGateway([root])
  assert.equal(patched.applied, 1)
  const content = readFileSync(target, 'utf8')
  assert.ok(content.includes("me.role !== 'admin' && !folderAllowed(real, perms.allowed_folders)"))
  assert.ok(statusGateway([root])[0].enabled)

  const rolled = rollbackGateway([root])
  assert.equal(rolled.rolledBack, 1)
  assert.ok(readFileSync(target, 'utf8').includes('if (!folderAllowed(real, perms.allowed_folders)) {'))
  rmSync(root, { recursive: true, force: true })
})

test('profileAnchors lists existing profile dirs under a dsh base', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-profiles-'))
  const web = path.join(root, 'profiles', 'web')
  const headless = path.join(root, 'profiles', 'headless')
  mkdirSync(web, { recursive: true })
  mkdirSync(headless, { recursive: true })
  const anchors = profileAnchors(root)
  assert.ok(anchors.includes(web))
  assert.ok(anchors.includes(headless))
  rmSync(root, { recursive: true, force: true })
})

test('defaultAnchors expands dsh profile dirs under DSH_HOME', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-defanchors-'))
  const web = path.join(root, 'profiles', 'web')
  mkdirSync(web, { recursive: true })
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const anchors = defaultAnchors()
    assert.ok(anchors.includes(root))
    assert.ok(anchors.includes(web))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(root, { recursive: true, force: true })
  }
})

test('fsPathFromBaseUrl converts a file:// base URL to a filesystem path', () => {
  const p = fsPathFromBaseUrl('file:///C:/Users/x/.dsh/profiles/web/')
  assert.equal(typeof p, 'string')
  assert.equal(p.includes('C:\\Users\\x\\.dsh\\profiles\\web'), true)
  assert.equal(fsPathFromBaseUrl(undefined), undefined)
  assert.equal(fsPathFromBaseUrl('http://127.0.0.1:9000'), 'http://127.0.0.1:9000')
})

test('cordis apply() converts baseUrl and patches the gateway at boot', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-boot-'))
  const profile = path.join(root, 'profiles', 'web')
  // The served client bundle.
  const clientRoot = path.join(profile, 'node_modules', DEFAULT_PACKAGE)
  mkdirSync(path.join(clientRoot, 'lib'), { recursive: true })
  writeFileSync(path.join(clientRoot, DEFAULT_RELATIVE), CANONICAL)
  // The dsh-passwords gateway in the same profile.
  const gwDir = path.join(profile, 'node_modules', 'dsh-passwords', 'dist')
  mkdirSync(gwDir, { recursive: true })
  writeFileSync(path.join(gwDir, 'package.json'), JSON.stringify({ name: GATEWAY_PACKAGE }))
  const gateway =
    "        const perms = effectivePermissions(me.userId);\n" +
    "        if (!folderAllowed(real, perms.allowed_folders)) {\n" +
    "          res.status(403).json({ ok: false, code: 'FORBIDDEN', error: '目录越权' });\n" +
    "          return;\n" +
    "        }\n"
  writeFileSync(path.join(gwDir, 'gateway.js'), gateway)

  const ctx = {
    baseUrl: pathToFileURL(profile).href + '/',
    clientModules: {
      clientPath: () => path.join(clientRoot, DEFAULT_RELATIVE),
      rebuilt: () => {},
    },
    logger: { info: () => {} },
    provide: () => {},
  }
  applyPlugin(ctx, {})

  const gwContent = readFileSync(path.join(gwDir, 'gateway.js'), 'utf8')
  assert.ok(gwContent.includes("me.role !== 'admin' && !folderAllowed(real, perms.allowed_folders)"))
  const clientContent = readFileSync(path.join(clientRoot, DEFAULT_RELATIVE), 'utf8')
  assert.equal(clientContent.includes('connection.isLoopback ? "host" : "memory"'), false)
  rmSync(root, { recursive: true, force: true })
})
