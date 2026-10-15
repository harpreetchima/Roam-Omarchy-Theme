# Local palette protocol

Version 1 connects only the Chrome companion and its read-only native host,
`com.harpreetchima.roam_omarchy_theme`. It is not a webpage API. Nothing in this
protocol accepts a path, command, URL, CSS, or Roam content.

Chrome uses native-messaging framing: a native-endian unsigned 32-bit byte
length followed by UTF-8 JSON. Bound incoming and outgoing messages to 64 KiB.
Handle partial reads and EOF; diagnostics go to stderr, never stdout.

The worker sends exactly:

```json
{"version":1,"type":"subscribe"}
```

The host responds immediately with a current palette, then sends changed
palettes while that connection remains open:

```json
{
  "version": 1,
  "type": "palette",
  "palette": {
    "mode": "dark",
    "colors": {
      "background": "#1e1e2e",
      "foreground": "#cdd6f4",
      "accent": "#89b4fa"
    }
  }
}
```

`mode` must be `light` or `dark`. `background` and `foreground` are required.
Only six-digit hex colors are accepted. Optional recognized keys are:

```text
accent muted selection_background selection_foreground
dark_background darker_background lighter_background
dark_foreground light_foreground bright_foreground
red orange yellow green cyan blue magenta brown
bright_red bright_yellow bright_green bright_cyan bright_blue bright_magenta
```

The native host filters Omarchy's resolved output to these known fields; it
does not forward legacy aliases or arbitrary theme-defined keys. Reject an
invalid recognized value rather than interpreting it as CSS. Unknown fields in
messages are rejected. Optional missing roles have nested CSS fallbacks:
accent -> blue -> foreground; selection -> a background/foreground mix;
semantic colors -> accent. Reuse Omarchy's resolver for its own aliases,
derived shades, and mode detection instead of parsing theme TOML again.

If no complete stable palette is readable, the host sends:

```json
{"version":1,"type":"status","status":"unavailable"}
```

Do not include local paths or raw subprocess error output. Retain the last
valid palette with an unavailable/stale indication; if none exists, leave
ordinary Blueprint unchanged. A recovered valid palette clears that status.
The host must exit when the browser closes its input pipe.

## Browser-side contract

Content scripts open a `roam-omarchy` runtime port. The worker checks its own
extension ID, the exact HTTPS Roam origin, and top frame. No page-message
bridge or `externally_connectable` permission is exposed. The worker always
constructs the fixed native subscription itself, never relays page commands.

The generated `theme.js` defines `globalThis.ROAM_OMARCHY_THEME` with:

```text
css: combined tokenized Blueprint CSS and derived palette-role CSS
supportedHashes: SHA-256 hex strings of supported original Blueprint CSS
upstreamCommit: reviewed source revision
```

Hash the original style text before replacement. Supported originals include
the upstream file and its newline-to-space form produced by `add_css.sh`.
Never fingerprint or replace private graph content.

Palette source variables use `--omarchy-` followed by the color key with
underscores changed to hyphens. The content script owns
`data-omarchy-active="true"`, `data-omarchy-mode="light|dark"`, and explicit
`bp3-light`/`bp3-dark` root classes only while following. Restore previous
values on local off, unsupported CSS, theme removal, or leaving an allowed
graph. Do not restore a source style that Roam itself has removed.

Options and cached palettes use `chrome.storage.local` only. Begin with the
graph allowlist `["Sylva"]`; the popup may enable other graph names or `*`
explicitly. Palette data and graph allowlists never leave this browser.
