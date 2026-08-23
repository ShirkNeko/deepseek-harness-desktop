#!/usr/bin/env node
/**
 * dsh-remote-settings install/undo driver. Auto-detects every copy of the
 * bundle (via `defaultAnchors`: dsh home, desktop app-data harness-versions
 * snapshots, source trees, node_modules) and patches or restores them all.
 *
 * `node lib/install.js patch`  → apply the fix to every detected copy.
 * `node lib/install.js undo`   → restore every patched copy to its original.
 *
 * This is what the shell/Windows installer scripts and the plugin's npm
 * `postinstall` hook call, so the fix lands once at install time and can be
 * cleanly reverted.
 */
import {
  applyRemoteSettingsPatchAll,
  rollbackRemoteSettingsPatchAll,
  patchStatusAll,
  patchGateway,
  rollbackGateway,
  statusGateway,
} from './patch.js'

const command = process.argv[2] ?? 'patch'

function reportPatch(result) {
  console.log(`[dsh-remote-settings] patch: ${result.applied} applied, ${result.unchanged} unchanged, ${result.missing} missing / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.outcome}  ${detail.target}`)
  }
}

function reportRollback(result) {
  console.log(`[dsh-remote-settings] rollback: ${result.rolledBack} restored, ${result.noBackup} no-backup / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.result}  ${detail.target}`)
  }
}

function reportStatus(copies) {
  const enabled = copies.filter(copy => copy.enabled)
  console.log(`[dsh-remote-settings] ${copies.length} copy/copies found, ${enabled.length} enabled`)
  for (const copy of copies) {
    console.log(`  ${copy.enabled ? 'enabled' : 'disabled'}  ${copy.target}  (${copy.replaced} ternary)`)
  }
}

function reportGatewayPatch(result) {
  console.log(`[dsh-remote-settings-gateway] patch: ${result.applied} applied, ${result.unchanged} unchanged, ${result.missing} missing / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.outcome}  ${detail.target}`)
  }
}

function reportGatewayRollback(result) {
  console.log(`[dsh-remote-settings-gateway] rollback: ${result.rolledBack} restored, ${result.noBackup} no-backup / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.result}  ${detail.target}`)
  }
}

function reportGatewayStatus(copies) {
  const enabled = copies.filter(copy => copy.enabled)
  console.log(`[dsh-remote-settings-gateway] ${copies.length} copy/copies found, ${enabled.length} enabled`)
  for (const copy of copies) {
    console.log(`  ${copy.enabled ? 'enabled' : 'disabled'}  ${copy.target}  (${copy.replaced} checks)`)
  }
}

switch (command) {
  case 'patch':
    reportPatch(applyRemoteSettingsPatchAll())
    reportGatewayPatch(patchGateway())
    break
  case 'undo':
  case 'rollback':
    reportRollback(rollbackRemoteSettingsPatchAll())
    reportGatewayRollback(rollbackGateway())
    break
  case 'status':
    reportStatus(patchStatusAll())
    reportGatewayStatus(statusGateway())
    break
  case 'gateway-patch':
    reportGatewayPatch(patchGateway())
    break
  case 'gateway-undo':
  case 'gateway-rollback':
    reportGatewayRollback(rollbackGateway())
    break
  case 'gateway-status':
    reportGatewayStatus(statusGateway())
    break
  default:
    console.log('Usage: node lib/install.js <patch|undo|status|gateway-patch|gateway-undo|gateway-status>')
    process.exitCode = 1
}
