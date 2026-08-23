# dsh-remote-settings

English | [简体中文](README.md)

A reusable DeepSeek Harness (dsh) plugin that enables the settings/config plane
(settings, plugins, models, credentials pages) for remote browsers served behind
an authenticated gateway — **without weakening dsh's host-side `/api` security
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
`dsh-passwords` rewrites `Host/Origin` to `127.0.0.1:3080` when forwarding, so
gateway traffic is accepted — in practice "an authentication layer + loopback
rewriting". This plugin only does the **client persistence gate** half of that:
it lets an authenticated/trusted remote browser use the config plane.

> Security: this plugin does **not** open the config plane to arbitrary remote
> sources. It only forces the client persistence gate to `"host"`. Any
> LAN/public caller that is **not** going through the gateway still gets a 403
> from the host-side fence on the privileged methods; config data is only
> exposed on the path that has passed the gateway (authentication). dsh's
> security posture is unchanged.

## How it works

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

- A **semantic regex** matches `connection.isLoopback ? "host" : "memory"`
  tolerating arbitrary whitespace and single/double quotes, so a different
  minifier, line wrap or indent in a dsh upgrade cannot break detection. **This
  is the only thing that must survive a dsh upgrade.**
- All occurrences are replaced, covering the **two** spots dsh ships
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
- **Uninstall restores**: DSH plugins have no uninstall hook, so before
  removing the plugin run `dsh-remote-settings rollback` (restores every
  patched copy from its backup) and then
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

The plugin patches automatically on startup. You can also check/apply/roll back
with the CLI:

```bash
# Report whether the config plane is enabled for remote
dsh-remote-settings status

# Apply the patch (idempotent)
dsh-remote-settings patch

# Roll back to the original bundle
dsh-remote-settings rollback

# Override the target and add a resolution anchor
dsh-remote-settings status --package @deepseek-ai/dsh-client-ui-settings --file lib/client.js --dir /path/to/dsh
```

Other plugins can consume the service `ctx.remoteSettings` (`status()` /
`apply()` / `rollback()`), or import the functions from the exported `./patch`
subpath (`dsh-remote-settings/patch`).

## When to "reload the patch"

A dsh upgrade overwrites the compiled bundle. If remote settings start failing
again with `settings are unavailable in this browser`, restart dsh (the plugin
re-applies at startup), or run `dsh-remote-settings patch` once and refresh the
browser.

## Compatibility

- Matching is semantic, not format-specific, so it survives dsh version
  changes.
- If a dsh build already supports the remote config plane natively (no ternary
  in the bundle), `status` reports `enabled` and `patch` reports `unchanged` —
  nothing to do.

## License

MIT
