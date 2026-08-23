#!/usr/bin/env node
/**
 * dsh-remote-settings CLI.
 *
 * All three commands AUTO-MATCH every copy of the target bundle that could be
 * served (node_modules, source-checkout packages, and every harness-versions
 * snapshot) and operate on all of them — no per-tree step:
 *
 * `status`   → report whether each copy's config plane is enabled.
 * `patch`    → apply the (idempotent) persistence patch to every copy.
 * `rollback` → restore every patched copy to its original (the uninstall path).
 *
 * `--package <name>`, `--file <rel>`, and `--dir <path>` are optional; `--dir`
 * seeds an extra resolution anchor.
 */
import path from 'node:path'
import {
  DEFAULT_PACKAGE,
  DEFAULT_RELATIVE,
  applyRemoteSettingsPatchAll,
  patchStatusAll,
  rollbackRemoteSettingsPatchAll,
} from './patch.js'

function parseArgs(argv) {
  const args = {
    package: DEFAULT_PACKAGE,
    file: DEFAULT_RELATIVE,
    dir: undefined,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (value === '--package') args.package = argv[++i]
    else if (value === '--file') args.file = argv[++i]
    else if (value === '--dir') args.dir = argv[++i]
  }
  return args
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  const anchors = args.dir === undefined ? undefined : [path.resolve(args.dir)]

  switch (command) {
    case 'status': {
      const copies = patchStatusAll(args.package, args.file, anchors)
      const enabled = copies.filter(copy => copy.enabled)
      console.log(`[dsh-remote-settings] ${copies.length} copy/copies found, ${enabled.length} enabled`)
      for (const copy of copies) {
        console.log(`  ${copy.enabled ? 'enabled' : 'disabled'}  ${copy.target}  (${copy.replaced} ternary)`)
      }
      process.exitCode = copies.length === 0 ? 1 : (copies.every(copy => copy.enabled) ? 0 : 2)
      return
    }
    case 'patch': {
      const result = applyRemoteSettingsPatchAll(args.package, args.file, anchors)
      console.log(`[dsh-remote-settings] patch: ${result.applied} applied, ${result.unchanged} unchanged, ${result.missing} missing / ${result.targets.length} found`)
      for (const detail of result.details) {
        console.log(`  ${detail.outcome}  ${detail.target}`)
      }
      process.exitCode = result.targets.length === 0 ? 1 : 0
      return
    }
    case 'rollback': {
      const result = rollbackRemoteSettingsPatchAll(args.package, args.file, anchors)
      console.log(`[dsh-remote-settings] rollback: ${result.rolledBack} restored, ${result.noBackup} no-backup / ${result.targets.length} found`)
      for (const detail of result.details) {
        console.log(`  ${detail.result}  ${detail.target}`)
      }
      process.exitCode = result.targets.length === 0 ? 1 : 0
      return
    }
    default:
      console.log('Usage: dsh-remote-settings <status|patch|rollback> [--package <name>] [--file <rel>] [--dir <path>]')
      process.exitCode = 1
  }
}

main()
