# Automatic desktop palette export

The desktop integration uses one Omarchy user template and one JSON palette file.
It needs no server, listening port, daemon, service, theme-set hook, or additional
Python package. It does not install or modify the Chrome native helper. The
[desktop contract](desktop-format.md) defines the payload and desktop reader.

## Preview and install

Run these repository helpers with the system Python 3 interpreter:

```sh
./scripts/install-desktop-palette --dry-run
./scripts/install-desktop-palette
```

Installation is an explicit user action, not part of building the desktop
extension. This repository helper must remain available for uninstallation; no
Python helper is copied into HOME. These commands use HOME's fixed `.config` and
`.local/state` paths, matching Omarchy; they do not redirect through XDG variables.

Installer flags:

- `--dry-run`: inspect destinations and print the plan. No writes, subprocesses,
  resolver execution, template rendering, or theme application.
- `--omarchy /absolute/path/to/omarchy`: override the default
  `/usr/share/omarchy/bin/omarchy` executable. This is an executable path, never a
  command string. Installation executes exactly that resolved absolute path with
  `theme color --all`, without a shell, with a three-second deadline and a 64 KiB
  stdout limit. Use this only for another trusted Omarchy installation or isolated
  fake-HOME verification.
- `-h`, `--help`: show usage.

Actual installation requires an existing
`~/.local/state/omarchy/current/theme/colors.toml`. It reads the normalized palette,
filters aliases and unknown fields, omits absent/blank optional roles, and validates
the remaining v1 palette before writing anything. Missing or invalid mode,
background, or foreground fails installation. Other malformed known colors also
fail. It checks that the theme directory and palette inputs did not change during
resolution; retry after an overlapping theme switch has finished.

Only these files are installed, with mode `0600`:

```text
~/.config/omarchy/themed/roam-omarchy-palette.json.tpl
~/.local/state/omarchy/current/theme/roam-omarchy-palette.json
~/.local/state/roam-omarchy-desktop-palette/install-record.json
```

The ownership record uses owner
`com.harpreetchima.roam_omarchy_desktop_palette`, version `1`, and a `files` object
mapping the two exact HOME-relative template/seed paths to their SHA-256 checksums.
It is separate from Chrome's `~/.local/lib/roam-omarchy-theme/install-record.json`.
No Chrome manifest, configuration, or ownership record is read or changed.

Existing user-owned regular files at those three paths are preserved, including
on reinstall. Template and ownership-record backups are siblings of those files,
named `<original-name>.backup-<UTC>-<random>`. Seed backups instead live at:

```text
~/.local/state/roam-omarchy-desktop-palette/backups/roam-omarchy-palette.json.backup-<UTC>-<random>
```

Seed backups are outside both `current/theme` and `current/next-theme`, so replacing
the theme tree does not delete them. All backups are bounded, independent copies
that preserve the original file's permission mode. They are not overwritten or
automatically restored on uninstall. Destinations must be small, regular,
user-owned files; symlinks, special files, oversized collisions, and unowned files
are rejected.
Directory traversal uses no-follow directory descriptors and rejects symlinks or
non-user-owned directories at/below HOME. New directories request mode `0700`
(subject to umask). Complete files are published atomically without overwriting a
file created concurrently.
If a write fails, rollback removes only the exact writes it still owns and tries
to restore unchanged backups into the original directories without clobbering
intervening changes. A changed backup, replacement target directory, or new target
file prevents that restore; the backup remains for manual recovery. Copies are
published atomically in their destination directories, including when backup and
target are on different filesystems. Empty parent directories may remain.

The initial seed changes only the palette filename. It does not reapply the
current theme, render other templates, restart apps, retint the desktop, or edit
`/usr/share/omarchy`.

## Future theme switches

Omarchy's normal built-in template renderer reads the user `.tpl` file during a
subsequent user-initiated theme switch and stages the palette alongside other
theme output. Its normalized resolver supplies legacy aliases, shades, and mode;
the desktop integration does not implement a second alias cascade. No persistent
process or hook is installed. Do not run a theme switch just to finish installing
this exporter.

The template contains only fixed, known role names, using this envelope:

```json
{"version":1,"type":"palette","palette":{"mode":"{{ mode }}","colors":{"background":"{{ background }}","foreground":"{{ foreground }}","accent":"{{ accent }}"}}}
```

The actual template includes all known optional roles. Omarchy may leave an absent
optional role as its exact `{{ role }}` token, or substitute an empty string. The
desktop reader omits only those optional values, then applies strict validation.
Required mode/background/foreground never accept placeholders or blanks. Other
malformed values, unknown fields, and input over 64 KiB are rejected rather than
interpreted as CSS. The Python decoder also rejects duplicate raw JSON fields;
this does not claim that the JavaScript desktop reader detects duplicates before
`JSON.parse` collapses them. The optional-value relaxation is desktop-only; the
Chrome/native protocol is unchanged.

Omarchy's renderer skips generation if a staged theme already supplies a file
named `roam-omarchy-palette.json`. Such a theme-provided file must satisfy the same
reader contract. A legacy/custom theme without a usable `colors.toml` may not
produce a valid export; the desktop reader must return to ordinary Blueprint.

## Uninstall

```sh
./scripts/uninstall-desktop-palette --dry-run
./scripts/uninstall-desktop-palette
```

Uninstaller flags are only `--dry-run`, `-h`, and `--help`. It never executes
Omarchy. It validates the desktop-specific ownership record, then removes only
template/seed files whose exact content checksums still match that record. A
missing/invalid record does not grant deletion authority. Modified files, unsafe
files, all backups, and unrelated files are preserved; no recursive deletion is
used. The record remains when a file is preserved, so a later review is possible.

**Conservative retention:** a future theme switch can regenerate the palette with
different bytes. Uninstall removes the unchanged template, but retains that
generated current palette and its record instead of claiming it owns the new
file. This is expected. The retained JSON is inert without the desktop extension;
review it manually if removal is desired. Backups also require manual review and
restoration.
