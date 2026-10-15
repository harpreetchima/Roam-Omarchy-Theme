# Roam Omarchy Theme

Follow your current [Omarchy](https://github.com/omacom/omarchy) palette in
[Roam Research](https://roamresearch.com), while keeping the layout and component
styling of Alexander Rink's [Blueprint](https://github.com/rcvd/blueprint).

There are two **device-local companions**. Keep normal Blueprint enabled:

- **Chrome:** a Manifest V3 extension receives the current palette through a
  read-only native helper. Follow the Chrome instructions below.
- **Roam desktop:** a client-local developer extension reads an Omarchy-generated
  palette JSON file through a user-approved, read-only folder handle. Follow
  [Desktop setup](docs/desktop.md) and [Palette exporter setup](docs/desktop-palette.md).
  No server, application patch, graph token, or Node integration is needed.

Both temporarily substitute the supported Blueprint stylesheet in the current
document. Neither writes colors into graph content/settings, disables Blueprint,
or changes the appearance of other devices.

```text
Chrome:  Omarchy palette -> native helper -> Chrome companion -> Blueprint variables
Desktop: Omarchy template -> local JSON -> approved read-only folder -> Roam adapter
```

There is no list of Omarchy theme names: new themes work when Omarchy resolves a
valid palette for them. Broken/incomplete palettes are rejected rather than
injected as CSS. Updating the installed Blueprint version may require a matching
update to this fork; unsupported stylesheets are left unchanged.

The upstream stylesheet is kept byte-for-byte. A hash-checked **build-time**
converter generates semantic variables with original-value fallbacks; the
browser receives finished CSS and never rewrites colors in page-provided CSS.

## Requirements

- Linux with Omarchy's `omarchy theme color --all` resolver. Development targets
  Omarchy 4.0.4-1 and its semantic/legacy color-resolution contract.
- Chrome/Chromium 111+ with native messaging and CSS `color-mix()` support.
- The normal Blueprint Roam Depot theme enabled in the graph. The reviewed base
  is [`25d98fa`](https://github.com/rcvd/blueprint/commit/25d98fab28d9343acba296b96bc377c339088aa1).
- System Python 3 for the standard-library-only native helper.
- Node.js 20+ to build the companion. **No `npm install` is needed for the browser
  build.** The older Roam extension's dependencies are retained separately.

## Build and activation

These are the **Chrome** instructions. For desktop, use `npm run build:desktop`
and its separate [setup guide](docs/desktop.md). Local-folder developer
extensions need reloading after Roam starts; saved palette-folder access and
extension autostart are different capabilities.

```sh
npm run build:browser
npm run test:native
npm run test:browser
```

Load the generated `dist/chrome` directory with **Load unpacked** in
`chrome://extensions` (Developer mode). Then register the native helper for the
extension's actual ID, following [Native helper setup](docs/native-host.md).
Loading unpacked and registering the helper are explicit installation steps;
building the package does neither.

The popup shows connection/status information and a local follow toggle. The
initial graph allowlist is `Sylva`. Add other exact graph names, or explicitly
choose `*` for all graph-app routes, in the popup. Options and cached colors stay
in `chrome.storage.local`; they are not synchronized through Roam or Chrome Sync.

While following, Omarchy owns light/dark mode as well as colors. The normal
Blueprint mode button is hidden only in the local document. Turning local
following off restores the original stylesheet and root state. If you disable or
remove the Chrome extension itself, reload Roam to clear its document changes.

## Safety and failure behavior

- The browser only receives a bounded message with mode and known six-digit hex
  colors. It cannot ask the helper to read arbitrary files or run commands.
- The helper reads the current palette through a fixed Omarchy resolver command.
  It does not execute a theme's code or serve an HTTP endpoint.
- Theme directory replacement and missing/transient palette files are handled
  without accepting partial colors. A disconnected helper retains the last valid
  palette with a stale indication; without a valid palette, ordinary Blueprint
  remains active.
- Content scripts are limited to the Roam HTTPS origin and top frame. There is
  no page-message API, graph-data access, or request for cookies/history.
- No edits to `/usr/share/omarchy`, Omarchy templates/hooks, or system services
  are necessary. Other existing theme integrations remain untouched.

See [the protocol](docs/protocol.md) for the security boundary and
[verification notes](docs/verification.md) for checks actually performed and
remaining live-activation checks. Arbitrary themes are not guaranteed to have
accessible contrast; the companion cannot make an inherently unreadable palette
universally accessible without changing its colors.

## Upstream and scope

This fork preserves Blueprint's layout, spacing, typography, and component rules
while replacing palette-dependent colors with semantic variables and literal
fallbacks. It is not a new layout or a mobile/desktop Roam integration. The
original Roam entry point/build remains in the repository; use `build:browser`,
not its legacy build script, for this companion.

Blueprint is by **Alexander Rink** and declares the MIT license in its package
metadata. Its original README and support links are preserved in
[Upstream Blueprint](docs/upstream-blueprint.md). Credit for the original theme
and enhancements remains with its author.
