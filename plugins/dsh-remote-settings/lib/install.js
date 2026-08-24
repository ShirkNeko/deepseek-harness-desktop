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
  patchGatewayMediaToken,
  rollbackGatewayMediaToken,
  statusGatewayMediaToken,
  patchDspwClient,
  rollbackDspwClient,
  statusDspwClient,
  patchDspwPatch,
  rollbackDspwPatch,
  statusDspwPatch,
  patchDspwPerms,
  rollbackDspwPerms,
  statusDspwPerms,
  patchComfyuiMediaBase,
  rollbackComfyuiMediaBase,
  statusComfyuiMediaBase,
  patchQqchatComfyuiBase,
  rollbackQqchatComfyuiBase,
  statusQqchatComfyuiBase,
  patchComfyuiPromptSurface,
  rollbackComfyuiPromptSurface,
  statusComfyuiPromptSurface,
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

function reportGatewayMediaTokenPatch(result) {
  console.log(`[dsh-remote-settings-gateway-media-token] patch: ${result.applied} applied, ${result.unchanged} unchanged, ${result.missing} missing / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.outcome}  ${detail.target}`)
  }
}

function reportGatewayMediaTokenRollback(result) {
  console.log(`[dsh-remote-settings-gateway-media-token] rollback: ${result.rolledBack} restored, ${result.noBackup} no-backup / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.result}  ${detail.target}`)
  }
}

function reportGatewayMediaTokenStatus(copies) {
  const enabled = copies.filter(copy => copy.enabled)
  console.log(`[dsh-remote-settings-gateway-media-token] ${copies.length} copy/copies found, ${enabled.length} enabled`)
  for (const copy of copies) {
    console.log(`  ${copy.enabled ? 'enabled' : 'disabled'}  ${copy.target}  (${copy.replaced} media-token)`)
  }
}

function reportDspwClientPatch(result) {
  console.log(`[dsh-remote-settings-dspw-client] patch: ${result.applied} applied, ${result.unchanged} unchanged, ${result.missing} missing / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.outcome}  ${detail.target}`)
  }
}

function reportDspwClientRollback(result) {
  console.log(`[dsh-remote-settings-dspw-client] rollback: ${result.rolledBack} restored, ${result.noBackup} no-backup / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.result}  ${detail.target}`)
  }
}

function reportDspwClientStatus(copies) {
  const enabled = copies.filter(copy => copy.enabled)
  console.log(`[dsh-remote-settings-dspw-client] ${copies.length} copy/copies found, ${enabled.length} enabled`)
  for (const copy of copies) {
    console.log(`  ${copy.enabled ? 'enabled' : 'disabled'}  ${copy.target}  (${copy.replaced} dark-missing)`)
  }
}

function reportDspwPatchStatus(copies) {
  const enabled = copies.filter(copy => copy.enabled)
  console.log(`[dsh-remote-settings-dspw-patch] ${copies.length} copy/copies found, ${enabled.length} enabled`)
  for (const copy of copies) {
    console.log(`  ${copy.enabled ? 'enabled' : 'disabled'}  ${copy.target}  (${copy.replaced} findroot-missing)`)
  }
}

function reportDspwPatchApply(result) {
  console.log(`[dsh-remote-settings-dspw-patch] patch: ${result.applied} applied, ${result.unchanged} unchanged, ${result.missing} missing / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.outcome}  ${detail.target}`)
  }
}

function reportDspwPatchRollback(result) {
  console.log(`[dsh-remote-settings-dspw-patch] rollback: ${result.rolledBack} restored, ${result.noBackup} no-backup / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.result}  ${detail.target}`)
  }
}

function reportDspwPermsStatus(copies) {
  const enabled = copies.filter(copy => copy.enabled)
  console.log(`[dsh-remote-settings-dspw-perms] ${copies.length} copy/copies found, ${enabled.length} enabled`)
  for (const copy of copies) {
    console.log(`  ${copy.enabled ? 'enabled' : 'disabled'}  ${copy.target}  (${copy.replaced} deny-rejected)`)
  }
}

function reportDspwPermsApply(result) {
  console.log(`[dsh-remote-settings-dspw-perms] patch: ${result.applied} applied, ${result.unchanged} unchanged, ${result.missing} missing / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.outcome}  ${detail.target}`)
  }
}

function reportDspwPermsRollback(result) {
  console.log(`[dsh-remote-settings-dspw-perms] rollback: ${result.rolledBack} restored, ${result.noBackup} no-backup / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.result}  ${detail.target}`)
  }
}

function reportComfyuiPatch(result) {
  console.log(`[dsh-remote-settings-comfyui] patch: ${result.applied} applied, ${result.unchanged} unchanged, ${result.missing} missing / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.outcome}  ${detail.target}`)
  }
}

function reportComfyuiRollback(result) {
  console.log(`[dsh-remote-settings-comfyui] rollback: ${result.rolledBack} restored, ${result.noBackup} no-backup / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.result}  ${detail.target}`)
  }
}

function reportComfyuiStatus(copies) {
  const enabled = copies.filter(copy => copy.enabled)
  console.log(`[dsh-remote-settings-comfyui] ${copies.length} copy/copies found, ${enabled.length} enabled`)
  for (const copy of copies) {
    console.log(`  ${copy.enabled ? 'enabled' : 'disabled'}  ${copy.target}  (${copy.replaced} media-base missing)`)
  }
}

function reportComfyuiPromptPatch(result) {
  console.log(`[dsh-remote-settings-comfyui-prompt] patch: ${result.applied} applied, ${result.unchanged} unchanged, ${result.missing} missing / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.outcome}  ${detail.target}`)
  }
}
function reportComfyuiPromptRollback(result) {
  console.log(`[dsh-remote-settings-comfyui-prompt] rollback: ${result.rolledBack} restored, ${result.noBackup} no-backup / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.result}  ${detail.target}`)
  }
}
function reportComfyuiPromptStatus(copies) {
  const enabled = copies.filter(copy => copy.enabled)
  console.log(`[dsh-remote-settings-comfyui-prompt] ${copies.length} copy/copies found, ${enabled.length} enabled`)
  for (const copy of copies) {
    console.log(`  ${copy.enabled ? 'enabled' : 'disabled'}  ${copy.target}  (${copy.replaced} prompt missing)`)
  }
}

function reportQqchatPatch(result) {
  console.log(`[dsh-remote-settings-qqchat] patch: ${result.applied} applied, ${result.unchanged} unchanged, ${result.missing} missing / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.outcome}  ${detail.target}`)
  }
}

function reportQqchatRollback(result) {
  console.log(`[dsh-remote-settings-qqchat] rollback: ${result.rolledBack} restored, ${result.noBackup} no-backup / ${result.targets.length} found`)
  for (const detail of result.details) {
    console.log(`  ${detail.result}  ${detail.target}`)
  }
}

function reportQqchatStatus(copies) {
  const enabled = copies.filter(copy => copy.enabled)
  console.log(`[dsh-remote-settings-qqchat] ${copies.length} copy/copies found, ${enabled.length} enabled`)
  for (const copy of copies) {
    console.log(`  ${copy.enabled ? 'enabled' : 'disabled'}  ${copy.target}  (${copy.replaced} comfyui-base missing)`)
  }
}

switch (command) {
  case 'patch':
    reportPatch(applyRemoteSettingsPatchAll())
    reportGatewayPatch(patchGateway())
    reportGatewayMediaTokenPatch(patchGatewayMediaToken())
    reportDspwClientPatch(patchDspwClient())
    reportDspwPatchApply(patchDspwPatch())
    reportDspwPermsApply(patchDspwPerms())
    reportComfyuiPatch(patchComfyuiMediaBase())
    reportQqchatPatch(patchQqchatComfyuiBase())
    reportComfyuiPromptPatch(patchComfyuiPromptSurface())
    break
  case 'undo':
  case 'rollback':
    reportRollback(rollbackRemoteSettingsPatchAll())
    reportGatewayRollback(rollbackGateway())
    reportGatewayMediaTokenRollback(rollbackGatewayMediaToken())
    reportDspwClientRollback(rollbackDspwClient())
    reportDspwPatchRollback(rollbackDspwPatch())
    reportDspwPermsRollback(rollbackDspwPerms())
    reportComfyuiRollback(rollbackComfyuiMediaBase())
    reportQqchatRollback(rollbackQqchatComfyuiBase())
    reportComfyuiPromptRollback(rollbackComfyuiPromptSurface())
    break
  case 'status':
    reportStatus(patchStatusAll())
    reportGatewayStatus(statusGateway())
    reportGatewayMediaTokenStatus(statusGatewayMediaToken())
    reportDspwClientStatus(statusDspwClient())
    reportDspwPatchStatus(statusDspwPatch())
    reportDspwPermsStatus(statusDspwPerms())
    reportComfyuiStatus(statusComfyuiMediaBase())
    reportQqchatStatus(statusQqchatComfyuiBase())
    reportComfyuiPromptStatus(statusComfyuiPromptSurface())
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
  case 'gateway-media-token-patch':
    reportGatewayMediaTokenPatch(patchGatewayMediaToken())
    break
  case 'gateway-media-token-undo':
  case 'gateway-media-token-rollback':
    reportGatewayMediaTokenRollback(rollbackGatewayMediaToken())
    break
  case 'gateway-media-token-status':
    reportGatewayMediaTokenStatus(statusGatewayMediaToken())
    break
  case 'dspw-client-patch':
    reportDspwClientPatch(patchDspwClient())
    break
  case 'dspw-client-undo':
  case 'dspw-client-rollback':
    reportDspwClientRollback(rollbackDspwClient())
    break
  case 'dspw-client-status':
    reportDspwClientStatus(statusDspwClient())
    break
  case 'dspw-patch-patch':
    reportDspwPatchApply(patchDspwPatch())
    break
  case 'dspw-patch-undo':
  case 'dspw-patch-rollback':
    reportDspwPatchRollback(rollbackDspwPatch())
    break
  case 'dspw-patch-status':
    reportDspwPatchStatus(statusDspwPatch())
    break
  case 'dspw-perms-patch':
    reportDspwPermsApply(patchDspwPerms())
    break
  case 'dspw-perms-undo':
  case 'dspw-perms-rollback':
    reportDspwPermsRollback(rollbackDspwPerms())
    break
  case 'dspw-perms-status':
    reportDspwPermsStatus(statusDspwPerms())
    break
  case 'comfyui-patch':
    reportComfyuiPatch(patchComfyuiMediaBase())
    break
  case 'comfyui-undo':
  case 'comfyui-rollback':
    reportComfyuiRollback(rollbackComfyuiMediaBase())
    break
  case 'comfyui-status':
    reportComfyuiStatus(statusComfyuiMediaBase())
    break
  case 'qqchat-patch':
    reportQqchatPatch(patchQqchatComfyuiBase())
    break
  case 'qqchat-undo':
  case 'qqchat-rollback':
    reportQqchatRollback(rollbackQqchatComfyuiBase())
    break
  case 'qqchat-status':
    reportQqchatStatus(statusQqchatComfyuiBase())
    break
  case 'comfyui-prompt-patch':
    reportComfyuiPromptPatch(patchComfyuiPromptSurface())
    break
  case 'comfyui-prompt-undo':
  case 'comfyui-prompt-rollback':
    reportComfyuiPromptRollback(rollbackComfyuiPromptSurface())
    break
  case 'comfyui-prompt-status':
    reportComfyuiPromptStatus(statusComfyuiPromptSurface())
    break
  default:
    console.log('Usage: node lib/install.js <patch|undo|status|gateway-patch|gateway-undo|gateway-status|gateway-media-token-patch|gateway-media-token-undo|gateway-media-token-status|dspw-client-patch|dspw-client-undo|dspw-client-status|dspw-patch-patch|dspw-patch-undo|dspw-patch-status|dspw-perms-patch|dspw-perms-undo|dspw-perms-status|comfyui-patch|comfyui-undo|comfyui-status|comfyui-prompt-patch|comfyui-prompt-undo|comfyui-prompt-status|qqchat-patch|qqchat-undo|qqchat-status>')
    process.exitCode = 1
}
