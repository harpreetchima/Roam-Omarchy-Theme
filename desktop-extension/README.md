# Local Omarchy palettes for Roam desktop

Keep the normal Blueprint theme enabled. This developer extension follows a
read-only local palette file; it does not replace the Blueprint installation,
write graph settings, run a helper/server, or read graph data.

## Build and load

Unload the disposable read-only test probe if it is still loaded. Leave the
normal Blueprint theme enabled.

From the repository root, with Node.js 20 or later:

```sh
node scripts/build-desktop.mjs
```

No dependency installation is needed. In the Roam desktop app's developer
extension controls, load the **built `dist/desktop` folder**, containing this
README and `extension.js`. Do not load the `desktop-extension` source folder.
Building does not install an extension or activate an Omarchy template.

**Local-folder developer extensions need a manual reload after app startup.**
Persisted file permission is separate from extension startup; this package does
not arrange autostart. Unloading removes the controls and restores owned
stylesheet/root values. Leave normal Blueprint enabled throughout.

## Connect the read-only source

First prepare the palette exporter described in `docs/desktop.md` in the source
repository. Expand **Omarchy** at the bottom right, click **Choose current
folder**, and select exactly:

```text
~/.local/state/omarchy/current
```

The picker requests read access only. The adapter accepts a directory named
`current`; it cannot verify an absolute path through the browser handle API.
It reads only `theme/roam-omarchy-palette.json`, reopening `theme` every time.
Do not select `theme`, HOME, or the entire Omarchy configuration directory.

On a later load, the adapter checks an existing handle's permission without a
prompt. If access is needed, click **Reconnect**. Choose/Reconnect must be real
user clicks, not programmatic button clicks. No stale saved palette is applied:
every extension load waits for a fresh valid read.

## Scope and failures

Following is enabled locally by default only for `hosted:Sylva`. Save exact
`hosted:Name` and `offline:Name` entries, one per line, in **Allowed graphs**.
`*` explicitly opts into all hosted/offline graphs; an empty list allows none.
The adapter also requires the exact `https://roamresearch.com` origin and the
boolean desktop platform flag. Ordinary browsers are left untouched.

Reads occur at one-second intervals only while following is enabled and the
graph/folder is eligible. The first two failed reads can retain a last valid
palette with a stale status. Three consecutive failures restore stock Blueprint
while reads continue looking for recovery. Permission loss restores immediately
when detected and stops reads until a click reconnects the folder.

**Stop and forget folder** removes this extension's saved handle and restores
Blueprint. It does not revoke Chromium's underlying permission. Options and the
handle live only in the client-local IndexedDB database
`roam-omarchy-desktop-local-v1`, not `extensionAPI.settings`. Other trusted Roam
extensions on the same origin can see that database: this is not a sandbox
against them.

The palette file is bounded to 64 KiB, limited to the known version-1 protocol,
and never evaluated as code or CSS. Unsupported Blueprint stylesheet hashes are
left unchanged. See `docs/desktop.md` and `docs/desktop-format.md` in the source
repository for setup, the wire contract, and verification limits.
