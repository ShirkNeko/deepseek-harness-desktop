/** dsh-remote-settings cordis plugin declarations. */
import type { Context } from '@deepseek-ai/cordis'
import type { ApplyAllResult, RollbackAllResult } from './patch.js'

export const name: string

export const inject: string[]

export const configure: {
  settingsPackage: string
  settingsFile: string
  dshRoot: string
}

export declare function apply(
  ctx: Context,
  config?: { settingsPackage?: string; settingsFile?: string; dshRoot?: string },
): void

export interface RemoteSettingsService {
  /** Status of every matched copy. */
  status(): Array<{ target: string; enabled: boolean; replaced: number }>
  /** Patch every matched copy (idempotent). */
  apply(): ApplyAllResult
  /** Restore every patched copy to its original (the uninstall path). */
  rollback(): RollbackAllResult
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteSettings?: RemoteSettingsService
  }
}
