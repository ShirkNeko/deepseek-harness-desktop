/** dsh-remote-settings core patch declarations. */

export const DEFAULT_PACKAGE: string
export const DEFAULT_RELATIVE: string

/** Semantic matcher for `connection.isLoopback ? "host" : "memory"`. */
export const PERSISTENCE_TERNARY: RegExp

export function hasUnpatchedTernary(content: string): boolean

export interface PatchStatus {
  found: boolean
  enabled: boolean
  replaced: number
}

export interface ApplyResult {
  outcome: 'applied' | 'unchanged' | 'missing'
  replaced: number
}

export function resolveBundlePath(pkg: string, relative: string, anchors?: string[]): string | null

export function patchStatusAt(target: string | null): PatchStatus
export function patchFileAt(target: string | null): ApplyResult
export function rollbackPatchAt(target: string | null): 'rolled-back' | 'no-backup' | 'missing'

export function patchStatus(pkg?: string, relative?: string, anchors?: string[]): PatchStatus
export function applyRemoteSettingsPatch(pkg?: string, relative?: string, anchors?: string[]): ApplyResult
export function rollbackRemoteSettingsPatch(
  pkg?: string,
  relative?: string,
  anchors?: string[],
): 'rolled-back' | 'no-backup' | 'missing'

export function collectAllTargets(pkg: string, relative: string, anchors?: string[], seedPaths?: string[]): string[]
export function defaultAnchors(): string[]

export interface ApplyAllResult {
  targets: string[]
  applied: number
  unchanged: number
  missing: number
  details: Array<{ target: string } & ApplyResult>
}

export interface RollbackAllResult {
  rolledBack: number
  noBackup: number
  targets: string[]
  details: Array<{ target: string; result: 'rolled-back' | 'no-backup' | 'missing' }>
}

export function applyRemoteSettingsPatchAll(
  pkg?: string,
  relative?: string,
  anchors?: string[],
  seedPaths?: string[],
): ApplyAllResult
export function patchStatusAll(
  pkg?: string,
  relative?: string,
  anchors?: string[],
  seedPaths?: string[],
): Array<{ target: string; enabled: boolean; replaced: number }>
export function rollbackRemoteSettingsPatchAll(
  pkg?: string,
  relative?: string,
  anchors?: string[],
  seedPaths?: string[],
): RollbackAllResult

export const GATEWAY_PACKAGE: string
export const GATEWAY_FILE: string

export function patchGateway(anchors?: string[]): ApplyAllResult
export function statusGateway(anchors?: string[]): Array<{ target: string; enabled: boolean; replaced: number }>
export function rollbackGateway(anchors?: string[]): RollbackAllResult

declare const _default: {
  DEFAULT_PACKAGE: string
  DEFAULT_RELATIVE: string
  PERSISTENCE_TERNARY: RegExp
  patchStatus: typeof patchStatus
  patchStatusAt: typeof patchStatusAt
  patchStatusAll: typeof patchStatusAll
  applyRemoteSettingsPatch: typeof applyRemoteSettingsPatch
  applyRemoteSettingsPatchAll: typeof applyRemoteSettingsPatchAll
  patchFileAt: typeof patchFileAt
  rollbackPatchAt: typeof rollbackPatchAt
  rollbackRemoteSettingsPatch: typeof rollbackRemoteSettingsPatch
  rollbackRemoteSettingsPatchAll: typeof rollbackRemoteSettingsPatchAll
  collectAllTargets: typeof collectAllTargets
  resolveBundlePath: typeof resolveBundlePath
  GATEWAY_PACKAGE: string
  GATEWAY_FILE: string
  patchGateway: typeof patchGateway
  statusGateway: typeof statusGateway
  rollbackGateway: typeof rollbackGateway
}
export default _default
