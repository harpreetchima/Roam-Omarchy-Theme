# Read-only native host

The Chrome companion connects to `com.harpreetchima.roam_omarchy_theme` through
Chrome Native Messaging. The host reads the active Omarchy palette; it never
sets a theme, changes Omarchy configuration, starts a server, or installs a
systemd service. It needs only the system `/usr/bin/python3` and Omarchy.

## Install explicitly

Load the unpacked companion in `chrome://extensions`, then copy its **actual
extension ID**. It must be exactly 32 lowercase letters from `a` through `p`.
There is no shared development ID or wildcard origin.

From the repository, preview registration first:

```sh
scripts/install-native-host --extension-id YOUR_ACTUAL_EXTENSION_ID --dry-run
```

Replace the placeholder with the real ID. The dry run validates the ID,
executable, and destinations and prints its plan **without creating or changing
files**, running Omarchy, or registering the host. To register after reviewing:

```sh
scripts/install-native-host --extension-id YOUR_ACTUAL_EXTENSION_ID
```

Run as your ordinary desktop user, not with `sudo`. The installer copies the
host, minimal configuration, and a checksum ownership record into
`~/.local/lib/roam-omarchy-theme/`. It resolves `omarchy` from the installer's
`PATH` once and records that absolute executable. Moving or replacing that
executable may require reinstalling.

Google Chrome's manifest is installed at:

```text
~/.config/google-chrome/NativeMessagingHosts/com.harpreetchima.roam_omarchy_theme.json
```

Its sole `allowed_origins` entry is `chrome-extension://ACTUAL_ID/`. The host
also requires that exact origin as its sole native-launch argument. A reload
whose extension ID changes requires reinstallation with the new ID.

For a different user-local Chrome-compatible browser directory, pass
`--browser-dir /absolute/path/inside/your/home/NativeMessagingHosts` to both
commands. One installation supports one registration directory at a time;
uninstall before changing browsers. Destinations must be user-owned directories
inside `HOME`, without symlink directory components. No system-wide browser
directories are changed.

Existing colliding files, including symlinks, are renamed to unique sibling
`.backup-TIMESTAMP-IDENTIFIER` files before replacement. A directory in place of
an expected file is rejected. Backups are not deleted or automatically restored.

## Connection and recovery

The [version 1 protocol](protocol.md) accepts only the fixed `subscribe` request.
Both frame directions are bounded to 64 KiB. Partial frames are assembled;
malformed JSON, duplicate fields, unknown fields or commands, invalid versions,
oversized frames, and EOF during a frame close the connection. Clean browser
EOF stops the host even if no palette has ever been readable.

Only after subscription, and at most once per second after each observation,
the host reopens `~/.local/state/omarchy/current/theme/colors.toml` and the
optional `light.mode` marker. It fingerprints their small contents and metadata
and checks the stable `current` path and theme directory identities before and
after observation. It does not follow a cached directory handle: Omarchy removes
and replaces `current/theme` during a theme change.

When the fingerprint changes, the host runs only:

```text
/absolute/installed/omarchy theme color --all
```

No shell is involved in launching this fixed command. Omarchy itself supplies
its aliases, shades, and mode detection. Its output is size-limited, timed out
after three seconds, and canceled when the browser disconnects. The host checks
the fingerprint again after resolution, discards mixed/racing snapshots, and
retries on the next connected poll. Missing, incomplete, oversized, invalid,
or temporarily replaced palettes produce one `unavailable` status; a valid
recovery produces a palette even when its colors match the last valid one.
Unchanged valid palettes are not repeatedly emitted.

Only `light`/`dark`, the required background and foreground, and the protocol's
fixed optional six-digit hex color roles are emitted. Invalid recognized roles
reject the whole snapshot; unknown Omarchy fields and legacy aliases are
filtered. Native messages never include theme names, local paths, resolver
stderr, CSS, or page/graph content. Diagnostics are generic and go only to
stderr. The companion retains its last valid palette while unavailable and
clears its stale indication on recovery.

## Remove safely

```sh
scripts/uninstall-native-host --dry-run
scripts/uninstall-native-host
```

Use the same `--browser-dir` if one was supplied during installation. Removal
uses the ownership record and checksums, unregisters only the unchanged owned
manifest, and removes only unchanged owned host/config files. Modified files,
symlinks replacing installed files, unrelated files, and all backups are kept.
If modified files remain, the ownership record stays as well. Without a valid
ownership record, nothing is removed. Only the empty installation directory is
eligible for removal; no directory tree is recursively deleted. Inspect backups
and restore any previous registration manually if wanted.

## Native verification

```sh
/usr/bin/python3 -B -m unittest discover -s tests -p 'test_native*.py' -v
```

Tests use only temporary fake homes/browser directories and fake resolvers.
They cover bounded and partial framing, strict requests and origins, value
validation/injection, filtering, directory-swap races, mode-marker changes,
stale/recovery transitions, resolver limits, connected EOF, dry runs, backups,
and ownership-preserving removal. They do not install into the real home,
execute the installed Omarchy resolver, or switch desktop themes.
