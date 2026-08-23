/**
 * dsh-remote-settings — cordis host plugin.
 *
 * On activation it enables the settings/config plane for remote browsers by
 * patching the compiled client bundle's persistence gate. It does NOT touch
 * dsh's host-side /api fence, so unauthenticated LAN/public callers still get
 * a 403 on the privileged method set; only an authenticated gateway (which
 * rewrites Host/Origin to loopback) passes the fence and is served settings.
 *
 * It AUTO-MATCHES every copy of the bundle that could be served — the exact
 * file `ctx.clientModules.clientPath(pkg)` resolves, plus every `node_modules`
 * copy, every source-checkout `packages/*` copy, and (when dsh runs from a
 * `harness-versions` snapshot) every sibling version tree — and patches them
 * all, so an upgrade that moves dsh to a different snapshot keeps working and
 * the patch never misses the served copy. It is fully automatic: no manual
 * --dir, no per-tree step.
 *
 * `ctx.remoteSettings.rollback()` (or the `dsh-remote-settings rollback` CLI)
 * restores every patched copy to its original, which is the clean uninstall
 * path. See README.md.
 */
import {
  applyRemoteSettingsPatchAll,
  patchStatusAll,
  rollbackRemoteSettingsPatchAll,
} from './patch.js'

/** Stable cordis plugin name. */
export const name = 'dsh-remote-settings'

/** Services this plugin waits for before applying the patch. */
export const inject = ['clientModules']

/** Plugin config: default target settings package and file. */
export const configure = {
  settingsPackage: '@deepseek-ai/dsh-client-ui-settings',
  settingsFile: 'lib/client.js',
  /**
   * Optional dsh source/install root used as an extra bundle-resolution
   * anchor. Set it when auto-detection cannot find the served bundle (a
   * `harness-versions` snapshot, a dev checkout, a split profile).
   */
  dshRoot: '',
}

/**
 * Apply the remote-settings persistence patch at boot, and expose status /
 * apply / rollback (restore) to other plugins through a service.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {{ settingsPackage?: string, settingsFile?: string, dshRoot?: string }} [config] - optional target overrides.
 * @returns {void}
 */
export function apply(ctx, config) {
  const pkg = config?.settingsPackage ?? configure.settingsPackage
  const relative = config?.settingsFile ?? configure.settingsFile
  const anchors = [ctx.baseUrl, config?.dshRoot].filter(value => value !== undefined)

  // Seed the scan with the exact bundle the running dsh serves so it is always
  // patched even if the generic scan misses it.
  let served
  try {
    served = ctx.clientModules?.clientPath?.(pkg)
  } catch {
    served = undefined
  }
  const seed = served === undefined ? [] : [served]
  const result = applyRemoteSettingsPatchAll(pkg, relative, anchors, seed)
  ctx.logger.info(
    `[dsh-remote-settings] all copies: ${result.applied} applied, ${result.unchanged} unchanged, `
    + `${result.missing} missing / ${result.targets.length} found`,
  )

  // Refresh the client-module graph rev so the served bundle URL matches the
  // patched content. Non-web profiles have no clientModules; the /plugins route
  // reads the file per request with `cache-control: no-cache`, so the browser
  // gets patched content regardless of the rev.
  try {
    ctx.clientModules?.rebuilt?.(pkg)
  } catch {
    // best-effort rev refresh
  }

  // Provide the patch face as a service so any other plugin can query it.
  // rollback() is the clean uninstall path: it restores every patched copy.
  ctx.provide('remoteSettings', {
    status: () => patchStatusAll(pkg, relative, anchors, seed),
    apply: () => applyRemoteSettingsPatchAll(pkg, relative, anchors, seed),
    rollback: () => rollbackRemoteSettingsPatchAll(pkg, relative, anchors, seed),
  })
}
