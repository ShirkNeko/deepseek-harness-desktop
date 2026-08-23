# dsh-remote-settings

English | [简体中文](README.md)

A reusable DeepSeek Harness (dsh) plugin that enables the settings/config plane
(settings, plugins, models, credentials pages) for remote browsers served behind
an authenticated gateway and allows owner/admin roles to bypass download folder allowlist — **without weakening dsh's host-side `/api` security
fence**.

## Problem

dsh treats the browser-side config plane as **loopback-only**:
- The client persistence gate `connection.isLoopback ? "host" : "memory"` is
  baked into the compiled client bundle.
- Any non-loopback origin (public IP / LAN address) therefore runs in `memory`
  mode, the settings mirror reports `view: undefined`, and the page throws
  `settings are unavailable in this browser` — the plugins, models and
  credentials pages fail for the same reason.

The host-side `/api` fence still accepts **only loopback** for the privileged
method set (`settings.*`, `credentials.*`, `agentPreset.*`,
`host.pickDirectory/openPath`, `llm.discoverModels`). A gateway such as
`dsh-passwords` rewrites `Host/Origin` to the loopback address dsh actually
listens on (`127.0.0.1`; the port follows the dsh config / `webServer.port`, not
a fixed 3080) when forwarding, so gateway traffic is accepted — in practice "an
authentication layer + loopback rewriting". This plugin only does the **client
persistence gate** half of that: it lets an authenticated/trusted remote browser
use the config plane.

> Security: this plugin does **not** open the config plane to arbitrary remote
> sources. It only forces the client persistence gate to `"host"`. Any
> LAN/public caller that is **not** going through the gateway still gets a 403
> from the host-side fence on the privileged methods; config data is only
> exposed on the path that has passed the gateway (authentication). dsh's
> security posture is unchanged.

## How it works

This plugin applies two patches at dsh startup:

### 1. Remote Settings Patch

The client persistence gate is baked into the compiled bundle and dsh offers no
plugin seam to open it. So this plugin, at dsh startup, applies a
**version-tolerant, semantic** patch to the compiled
`@deepseek-ai/dsh-client-ui-settings/lib/client.js`:

```js
// matched (any whitespace / quoting):
connection.isLoopback ? "host" : "memory"
// replaced with:
"host"
```

### 2. Gateway Patch

Applies a patch to `dsh-passwords` package's `dist/gateway.js` to allow owner/admin roles to bypass download folder allowlist checks:

```js
// matched:
if (!folderAllowed(real, perms.allowed_folders)) {
// replaced with:
if (me.role !== 'admin' && !folderAllowed(real, perms.allowed_folders)) {
```

**Patch features:**

- A **semantic regex** matches tolerating arbitrary whitespace and single/double quotes, so a different
  minifier, line wrap or indent in a dsh upgrade cannot break detection. **This
  is the only thing that must survive a dsh upgrade.**
- Remote Settings patch replaces all occurrences, covering the **two** spots dsh ships
  (`SettingsScopeController` and `SettingsDescribeMirror`).
- **Locates and patches EVERY copy**: the plugin asks
  `ctx.clientModules.clientPath(pkg)` — the same resolution the browser plugin
  roster uses — and from that seeds a scan of every `node_modules` copy, every
  `packages/*` source image, and (when dsh runs from a `harness-versions`
  snapshot) **every sibling version tree**, patching them all in one pass. So a
  dsh upgrade that moves it to a different snapshot keeps working and no copy is
  missed — fully automatic, no `--dir`, no per-tree step.
- A **backup + sha256 manifest** is kept so `rollback` never restores a file
  from a different dsh version.
- Gateway patch automatically scans all `dsh-passwords` copies and applies permission bypass patch.

### 3. dsh-passwords client / status patches

Three more idempotent, reversible patches on `dsh-passwords`:

- **Dark mode (`dist/client.js`)**: the dsh-passwords settings card CSS hardcodes
  light-only colors for status pills, avatar/button contrast, the switch track and
  input hover/focus. dsh's theme presenter sets `body[data-ds-dark-theme]` on dark,
  so the plugin appends a `body[data-ds-dark-theme]` override block to the card CSS,
  adapting those fixed light colors while leaving the token-driven colors alone.
- **`/patch/status` discovery (`dist/patch.js`)**: dsh-passwords' `findDshRoot()`
  only checks `npm root -g`, the cwd walk-up and `/usr/local`, so a desktop layout
  (dsh packages hoisted under a dsh home / profile `node_modules`) returns `null`,
  and `/api/dsh-passwords/patch/status` returns `null` → the card shows "status
  unknown". The plugin appends a dsh home / `profiles` scan so `findDshRoot()` finds
  the desktop dsh root and the status endpoint reports the real state.
- **"deny all" save (`dist/gateway.js`)**: when the workspace toggles disable every
  workspace the client sends `allowedFolders: ['__deny__']` (dsh-passwords'
  "deny all" sentinel), but `/gateway/api/permissions` validation rejects it as a
  non-path, so saving returns 400 and the permission draft reverts. The plugin
  exempts the `__deny__` sentinel so "disable all workspaces" can be saved.


> Note: `/patch/status` now reports the real state (e.g. "not applied" while
> dsh-passwords' own sidebar-search sub-patch is missing). Showing "applied" also
> needs that workspaceSearch sub-patch — it is a separate dsh-passwords patch,
> outside this plugin's scope.

**Uninstall restores**: DSH plugins have no uninstall hook, so before
  removing the plugin run `dsh-remote-settings rollback` (restores every
  patched copy from its backup, including both patches) and then
  `dsh plugin --profile web remove dsh-remote-settings`.

## Install

This is a dsh patch-layer bundle. Add it to your dsh profile (e.g. `web`) with a
`link:` to this directory:

```bash
# register in the dsh profile (equivalent to adding link:<this-dir> to package.json deps + dsh.profile.bundles)
pnpm install
```

Or manually: merge the contents of `cordis.yml` into
`~/.dsh/profiles/web/cordis.patch.yml` and add `dsh-remote-settings` to the
profile's dependencies.

> Gateway plugins such as `dsh-passwords` can declare `dsh-remote-settings` as a
> dependency and get this fix automatically, instead of reimplementing the patch.

dsh applies the patch (idempotently) at startup. The log shows
`[dsh-remote-settings] applied/unchanged`.

## Usage

The plugin patches automatically on startup (including both Remote Settings and Gateway patches). You can also check/apply/roll back
with the CLI:

```bash
# Report whether the config plane is enabled for remote
# Shows status for both remote-settings and gateway patches
dsh-remote-settings status

# Apply the patch (idempotent)
# Applies both remote-settings and gateway patches
dsh-remote-settings patch

# Roll back to the original bundle
# Rolls back both remote-settings and gateway patches
dsh-remote-settings rollback

# Override the target and add a resolution anchor
dsh-remote-settings status --package @deepseek-ai/dsh-client-ui-settings --file lib/client.js --dir /path/to/dsh
```

### Installation scripts (auto-detect + apply/rollback all)

Includes **cmd / sh installation and rollback scripts**. After `dsh plugin` installation, run once to auto-detect and patch all copies (both patches); use undo scripts before uninstalling:

```bash
# Install: auto-detect and patch all copies (remote-settings + gateway)
scripts/install.sh        # Linux/macOS
scripts\install.bat       # Windows

# Undo: restore all copies to original state (both patches)
scripts/undo.sh           # Linux/macOS
scripts\undo.bat          # Windows
```

> You can also use `node lib/install.js patch|undo|status` directly (internally auto-detects and operates on all copies, including both patches).
> For specific patch operations only, use `gateway-patch|gateway-undo|gateway-status` commands.
> The package declares `postinstall` (`node lib/install.js patch`); when `pnpm add` runs the package lifecycle script (requires adding this package to `allowBuilds` in profile's `pnpm-workspace.yaml`, pnpm 10+ blocks scripts by default) it auto-patches once.

> **Uninstall restore**: DSH plugins have no uninstall hook, so before uninstalling run `dsh-remote-settings rollback` (or `scripts/undo.*`) (restores every patched copy from backup to original bundle, including both patches), then `dsh plugin --profile web remove dsh-remote-settings` to fully restore original functionality.

Other plugins can consume the service `ctx.remoteSettings` (`status()` /
`apply()` / `rollback()`), or import the functions from the exported `./patch`
subpath (`dsh-remote-settings/patch`).

## When to "reload the patch"

A dsh or dsh-passwords upgrade overwrites the compiled bundle. If remote settings start failing
again with `settings are unavailable in this browser` or permission checks are restored, restart dsh (the plugin
re-applies both patches at startup), or run `dsh-remote-settings patch` once and refresh the
browser.

## Compatibility

- Matching is semantic, not format-specific, so it survives dsh version
  changes.
- If a dsh build already supports the remote config plane natively (no ternary
  in the bundle), `status` reports `enabled` and `patch` reports `unchanged` —
  nothing to do.

## License

MIT
