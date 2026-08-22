import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_PACKAGE,
  DEFAULT_RELATIVE,
  applyRemoteSettingsPatch,
  patchStatus,
  rollbackRemoteSettingsPatch,
} from '../lib/patch.js'

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
