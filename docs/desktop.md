# Roam desktop: read-only local palettes

The desktop adapter is a client-local Roam developer extension. It reads a
bounded palette file through a user-approved directory handle and passes the
validated palette to the same stylesheet controller as the Chrome companion.
It needs no server, native messaging helper, runtime imports, remote assets,
graph-data API, or graph settings. Keep normal Blueprint enabled.

## Prepare and build

The separate desktop exporter uses the user-owned template
`~/.config/omarchy/themed/roam-omarchy-palette.json.tpl`. Omarchy renders it into:

```text
~/.local/state/omarchy/current/theme/roam-omarchy-palette.json
```

Preview the exporter installation without running the color resolver or writing
files:

```sh
/usr/bin/python3 scripts/install-desktop-palette --dry-run
```

When you deliberately choose to activate it, run the same command without
`--dry-run`. It installs the template, seeds only the owned palette filename from
`/usr/share/omarchy/bin/omarchy theme color --all`, and writes its separate
ownership record at
`~/.local/state/roam-omarchy-desktop-palette/install-record.json`. If Omarchy is
elsewhere, pass its absolute executable path with `--omarchy`. The resolver uses
a fixed argument list, not a shell. Template/record collisions receive sibling
backups; seed collisions are copied to the persistent desktop ownership directory
so the next theme switch cannot delete their backup. The current theme is not
reapplied; future switches use Omarchy's built-in template renderer. See
[exporter ownership and recovery](desktop-palette.md) for exact locations.

See [the desktop wire contract](desktop-format.md) for the exact template and
snapshot rules. Building the adapter does not run this installer, activate a
template, seed a palette, or change the running theme. The Chrome native helper
and its configuration are not used or changed.

With Node.js 20 or later, from the repository root:

```sh
node scripts/build-desktop.mjs
```

This uses only Node built-ins and the existing Blueprint converter/upstream
metadata. It generates a self-contained ES module at
`dist/desktop/extension.js` and copies `desktop-extension/README.md` alongside
it. No `npm install` is needed. The existing strict protocol and shared style
controller are enclosed in a private module scope, not exported onto Roam's
window. The build requires `src/shared/style-controller.js` to be present.

## Load and connect

If you used the disposable folder-access probe, stop/forget its test folder and
unload that probe first. Keep the normal Blueprint extension enabled; the new
adapter is separate from both Blueprint and the temporary probe.

1. Unload any previous Omarchy desktop adapter. In Roam desktop's developer
   extension controls, load this checkout's **built `dist/desktop` directory**,
   not `desktop-extension`. Keep normal Blueprint enabled.
2. Open **Settings → Omarchy**. If no folder is saved, click **Choose current
   folder** and select `~/.local/state/omarchy/current`. The picker requests
   **read** access.
3. Keep **Follow Omarchy on this device** enabled. The default graph allowlist
   is `hosted:Sylva`. Save any other exact hosted/offline names explicitly.

Upgrading from the earlier bottom-right panel preserves the same client-local
database, saved folder, and options. Do not run both adapters at once. The
exporter does not need reinstalling; an existing granted folder needs no new
selection. Use **Reconnect** if its permission needs renewing.

The source handle must name a directory `current`; browser handles do not reveal
an absolute path, so the adapter cannot establish that it is the intended
Omarchy directory. It never offers a configurable filename or arbitrary path:
each read reopens only `theme/roam-omarchy-palette.json` under that handle.
Retaining the parent handle supports theme-child replacement; `isSameEntry` is
not treated as an inode detector.

**A local-folder developer extension still needs manual reload at app startup.**
Persisted directory permission does not make the extension autostart. This build
does not publish, install into a normal profile, or change Roam's startup setup.

## Local controls and lifecycle

The **Settings → Omarchy** tab uses one custom React component, with native
controls in an isolated shadow tree. There is no floating panel. Closing
Settings detaches the controls without stopping palette following or losing an
unsaved graph-scope draft. Choose/Reconnect require a trusted user click. On
load, an existing handle's permission is only queried; timers and startup never
request permission.

Graph scope accepts up to 100 entries, one per line: `hosted:Sylva`,
`offline:Name`, or the explicit all-graphs opt-in `*`. Empty allows none. Hosted
and offline names are distinct, URI-decoded once, case-sensitive, and matched
exactly. The runtime also requires top-frame `https://roamresearch.com` and
`roamAlphaAPI.platform.isDesktop === true`. It reads only platform metadata,
never graph content. Browser hash/history navigation events update eligibility;
the current route is checked again before delivering every asynchronous read.

Options and the cloned handle are kept in IndexedDB database
`roam-omarchy-desktop-local-v1`, store `local`, keys `options` and `directory`.
No palette is persisted. `extensionAPI.settings.panel.create` registers the tab,
but its custom component saves no graph-synced setting values. Built-in
automatically saving switch/input/select rows and settings get/set are not used.
A storage failure is visible in the tab and permits session-only use. This
database is client-local, **not a security sandbox**: other trusted Roam
extensions on the same origin can inspect or alter it.

The adapter uses React supplied by Roam; it bundles no React dependency. If
React or the custom settings API is unavailable, or panel registration fails,
stock Blueprint remains active. There is no fallback overlay.

Turning following off, leaving graph scope, forgetting the folder, or losing
permission restores the controller's owned stylesheet/root state. Forgetting
does not revoke Chromium's underlying folder permission and leaves graph scope
options intact. Unload cancels polling, invalidates outstanding reads and
selection/storage callbacks, aborts pending storage transactions, disconnects
the shared controller, and removes the native controls and every registered
listener. Roam removes the registered settings tab on extension unload. No
commands, history patches, or app-global exports are registered.

## Validation and recovery

Each read is limited to 64 KiB and uses the existing strict version-1 native
palette-message validator. Before validation, only known optional color keys
whose value is exactly `""` or their own unresolved `"{{ key }}"` placeholder
are omitted. Whitespace strings, placeholders for another key, unknown fields,
missing required colors, and every other malformed value are rejected. The
Chrome/native protocol remains unchanged.

Nothing is applied until a fresh successful read. While eligible, at most one
read runs at a time, with a one-second timer. Missing files or invalid snapshots
may keep the last valid palette for two consecutive failures, marked stale.
At the third failure normal Blueprint is restored. The timer continues so a
later valid file can recover. Permission denial/revocation restores immediately
when detected, stops polling, and offers Reconnect. A newly selected folder or
graph context must produce a fresh palette; a late old read cannot apply.

The shared controller independently validates palettes and verifies the original
Blueprint stylesheet hash before substitution. Unknown Blueprint versions are
left unchanged. Omarchy owns light/dark mode while following, and ending
following restores only values still owned by this adapter.

## Evidence and limits

The user has separately verified directory picking, read-only access,
IndexedDB handle cloning, reopening a replaced theme child, and persisted file
permission after a genuine cold restart in Roam 0.0.40 / Electron 38. The user
subsequently activated the earlier floating-panel adapter and exporter and
reported that palette following worked. The move into Settings still needs
confirmation in the actual app. Building and disposable verification do not
authorize interaction with a live graph, installation into a normal profile,
or live template activation.

Disposable checks exercised the real shared controller with mocked handles and
routes: fresh-read gating, strict template normalization, scoped polling,
serialization, stale/third-failure recovery, permission loss, selection/unload
races, and lifecycle restoration. The built ES module was parsed and checked for
runtime imports and leaked source globals. An isolated browser fixture exercised
the real IndexedDB write ordering/cancellation and the control panel at desktop
and narrow dark-mode sizes. The Settings move was also checked with real React
18 StrictMode, actual IndexedDB and OPFS handles: background following while
closed, draft-preserving remount, trusted picker activation, local saves,
stored-handle reload, and registration/unload failures. No permanent tests or
live-app activation were added by these checks. See [verification](verification.md).

## Remove the exporter

Unload the developer extension and preview cleanup first:

```sh
/usr/bin/python3 scripts/uninstall-desktop-palette --dry-run
```

Without `--dry-run`, uninstall removes only unchanged checksum-owned files. A
changed generated palette snapshot may conservatively remain in
`current/theme`, with its ownership record retained; this avoids deleting a file
whose current ownership cannot be established. Backups remain for manual
recovery and are not automatically restored. The extension's **Stop and forget
folder** control is separate from removing the exporter or revoking Chromium's
folder permission.
