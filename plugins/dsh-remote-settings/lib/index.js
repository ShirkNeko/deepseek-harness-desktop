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
  patchGateway,
  statusGateway,
  rollbackGateway,
  patchDspwClient,
  statusDspwClient,
  rollbackDspwClient,
  patchDspwPatch,
  statusDspwPatch,
  rollbackDspwPatch,
  patchDspwPerms,
  statusDspwPerms,
  rollbackDspwPerms,
  fsPathFromBaseUrl,
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
  // `ctx.baseUrl` is the profile directory as a file:// URL; normalize it to a
  // filesystem path so it can seed the bundle/gateway scans. Non-web profiles
  // (no clientModules/baseUrl) fall back to dshRoot + auto-detection.
  const basePath = fsPathFromBaseUrl(ctx.baseUrl)
  const anchors = [basePath, config?.dshRoot].filter(value => value !== undefined)

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

  // Patch the dsh-passwords gateway so owner/admin can download files outside
  // the folder allowlist (the "目录越权" fix). No-op when dsh-passwords is not
  // installed (0 targets).
  const gw = patchGateway(anchors)
  ctx.logger.info(
    `[dsh-remote-settings] gateway: ${gw.applied} applied, ${gw.unchanged} unchanged, `
    + `${gw.missing} missing / ${gw.targets.length} found`,
  )

  // Patch the dsh-passwords client card CSS so its status pills / buttons /
  // switch track / inputs adapt to dark mode (body[data-ds-dark-theme] is set by
  // dsh's theme presenter when the active scheme is dark). No-op without dsh-passwords.
  const dspw = patchDspwClient(anchors)
  ctx.logger.info(
    `[dsh-remote-settings] dspw-client: ${dspw.applied} applied, ${dspw.unchanged} unchanged, `
    + `${dspw.missing} missing / ${dspw.targets.length} found`,
  )

  // Patch dsh-passwords' findDshRoot so its /patch/status reports the real state
  // (instead of "未知") in a desktop/profile dsh layout. No-op without dsh-passwords.
  const dspwPatch = patchDspwPatch(anchors)
  ctx.logger.info(
    `[dsh-remote-settings] dspw-patch: ${dspwPatch.applied} applied, ${dspwPatch.unchanged} unchanged, `
    + `${dspwPatch.missing} missing / ${dspwPatch.targets.length} found`,
  )

  // Patch dsh-passwords' /gateway/api/permissions folder validation so the
  // "deny all" sentinel (`__deny__`) can be saved — otherwise disabling every
  // workspace returns 400 and the permission draft reverts.
  const dspwPerms = patchDspwPerms(anchors)
  ctx.logger.info(
    `[dsh-remote-settings] dspw-perms: ${dspwPerms.applied} applied, ${dspwPerms.unchanged} unchanged, `
    + `${dspwPerms.missing} missing / ${dspwPerms.targets.length} found`,
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
    gatewayStatus: () => statusGateway(anchors),
    gatewayApply: () => patchGateway(anchors),
    gatewayRollback: () => rollbackGateway(anchors),
    dspwClientStatus: () => statusDspwClient(anchors),
    dspwClientApply: () => patchDspwClient(anchors),
    dspwClientRollback: () => rollbackDspwClient(anchors),
    dspwPatchStatus: () => statusDspwPatch(anchors),
    dspwPatchApply: () => patchDspwPatch(anchors),
    dspwPatchRollback: () => rollbackDspwPatch(anchors),
    dspwPermsStatus: () => statusDspwPerms(anchors),
    dspwPermsApply: () => patchDspwPerms(anchors),
    dspwPermsRollback: () => rollbackDspwPerms(anchors),
  })
}
