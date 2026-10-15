# Verification

The target is device-local palette following, not a change to graph data or
Blueprint's layout. Native framing/validation tests protect the filesystem/process
boundary; the browser check uses synthetic content rather than personal notes.

## Reproduce the code checks

```sh
npm run build:browser
npm run test:native
npm run test:browser
```

The browser build uses Node's standard library. Native tests use Python's
`unittest` and temporary directories; they must not register a host in the normal
Chrome profile or write to the live Omarchy theme directory.

## Recorded results

- The focused native suite passes **33 tests** on system Python 3.14.7. These
  cover framing, strict validation, bounded/cancelable resolution, directory
  replacement, stale recovery, and installer ownership/backup behavior.
- The focused browser suite passes **11 tests** on Node.js 26.8.2. These use
  isolated VM/fake-DOM contexts to check strict protocol/sender validation,
  bounded retries, stylesheet-hash races, root-state ownership, source removal,
  and page suspension/recovery. They are not a substitute for a rendered browser
  check.
- The native parser accepts all **22 installed Omarchy palettes**, each with
  its 26 known color roles. A read-only call through the fixed dispatcher also
  returns the current Catppuccin palette successfully. No desktop theme is
  changed by these checks.
- An independent review of the native/Chrome security boundary found no
  confirmed actionable issues in framing, fixed-command execution, directory
  replacement, sender/route restrictions, stale-cache handling, or document
  ownership/restoration. Generated CSS and rendered integration were outside
  that review's scope.
- The dependency-free build produces **4,197 color fallbacks**, 14 inversion
  filter fallbacks, and gates all 620 OS-dark branches. Both supported upstream
  hashes match and every generated semantic role has a definition. The upstream
  CSS itself remains byte-for-byte unchanged. The conversion's structural and
  25-input rendering checks are documented in [the role inventory](../src/omarchy/design.md).
- The complete package was exercised in **Chrome for Testing 153**, using a
  disposable `HOME`, profile, host registration, and theme directory. The real
  read-only Omarchy dispatcher supplied colors through the real native-messaging
  connection. Catppuccin, Catppuccin Latte, and a previously unknown legacy/ANSI
  palette applied without reloading the document. The light palette prevailed
  while the browser still reported OS-dark; sampled visible changes took
  **0.21–0.52 seconds**. These are fixture observations, not a performance
  guarantee for the live graph.
- A malformed foreground was rejected and the previous palette remained visible
  with a stale warning. A subsequent valid snapshot recovered to live status.
  The popup's actual checkbox/save controls restored the exact original CSS,
  root mode, and owned variables when local following was disabled.
- Rendered lifecycle checks passed for disallowed/allowed graph routes,
  unsupported CSS, supported replacement, source removal without resurrection,
  and theme reload. The same document remained loaded throughout, and an
  authored diagram color was preserved. The local popup was checked at 360px
  with readable 16px text and no horizontal overflow.

No normal-profile extension/native host was installed, no Sylva content was
changed, and no desktop theme was switched. Live activation remains unverified.

## Isolated browser method

Use a disposable Chrome for Testing profile with the unpacked companion and a
native-host registration restricted to that extension ID. A loopback-only HTTPS
server serves synthetic Roam-shaped markup and the reviewed original Blueprint
stylesheet. In that disposable browser only, a host-resolver rule maps the Roam
hostname to the fixture, so the companion's real origin checks still apply.

The fixture contains body/sidebar text, links, highlights, code, buttons,
hover/focus states, a menu/dialog, graph variables, and an authored diagram color.
It does not sign in, call Roam APIs, load private graphs, or use the normal Chrome
profile. Palette switching replaces a **temporary** current-theme directory,
not the installed desktop theme. Keep any certificate exceptions confined to
that disposable browser.

Check dark and light palettes against an OS-dark preference, an unknown-name
palette, missing/malformed palette recovery, local off, graph allowlist/route
changes, Blueprint removal/reload, and unsupported stylesheet detection. Compare
geometry and typography before/after with following disabled. Compare normal
body, secondary, selected, and primary-button contrast on the actual rendered
surfaces; a theme's own low contrast is not proof that all arbitrary inputs are
accessible.

## Live activation is a separate step

Code verification does **not** install the extension/native host in the normal
Chrome profile, mutate Sylva, or run `omarchy theme set`. After explicit
activation approval, verify Sylva with a dark and a light desktop theme, confirm
updates without a page reload, and restore the previous desktop theme unless the
user has intentionally selected a new one during the trial.

Local off should restore the original stylesheet/root state. When disabling or
uninstalling the Chrome extension itself, reload Roam to remove content-script
changes. Confirm that other devices and existing Omarchy hooks are unaffected.

## Desktop transport evidence

Before implementing the desktop adapter, a disposable client-local developer
extension was tested in the actual Roam 0.0.40 desktop app (Electron 38.2.0,
Chromium 140). The user reported read-only directory selection, a handle stored
in client-local IndexedDB, and successful reads of both test palette changes
across replacement of the child theme directory. After a genuine full app
restart, the saved handle was granted and reads resumed without another folder
selection. Independent process inspection confirmed that the old Roam process
had exited. No graph content, normal theme, or installed application file was
changed by that probe.

The permission test used a palette folder outside the developer-extension code
folder, so loading the extension did not implicitly select its palette folder.
The probe's original directory-change counter was corrected: Chromium's
`isSameEntry` compares handle paths, not OS directory inode identity. Successful
changed-palette reads and independent fixture directory identities established
the replacement behavior.

This proves the file-access mechanism in the tested installation, not activation
of the finished desktop adapter. Local-folder extension startup still requires
Roam's documented manual developer-extension reload; it is separate from saved
palette-folder permission.

The stylesheet ownership logic is now shared rather than copied into the two
transports. All 11 existing Chrome browser cases retain their assertions; their
fixture also loads the shared controller. A new isolated Chrome/native-helper
smoke check verified that the refactored unpacked package applies Catppuccin and
that its real popup off/save action restores the exact original stylesheet and
root variables. That test used only a disposable Chrome HOME/profile/native-host
registration, which was removed afterward; the user's working installation was
not rebuilt, reloaded, or reconfigured.

## Desktop implementation checks

- Both dependency-free builds pass: `npm run build:desktop` and
  `npm run build:browser`. The existing 33 native and 11 browser tests pass.
  No new permanent test suite was added.
- The desktop exporter's disposable verification exercised the installed Omarchy
  template renderer against all 22 packaged palettes, five optional/legacy
  fixtures, and four invalid fixtures, entirely in fake HOME. Python message
  validation rejected 29 malformed cases. Installer/uninstaller previews,
  no-follow traversal, bounds, collisions, ownership, changed-file retention,
  resolver cleanup, rollback, and persistent seed-backup survival were checked
  with disposable files. No real theme-set/app-retint command was run.
- Desktop-specific disposable checks covered 15 parsing/scope/freshness/failure/
  permission/race/lifecycle/module-isolation cases, eight actual IndexedDB
  ordering/cancellation cases, and the controls' narrow/dark rendering.
- A full-package isolated Chromium fixture used **real OPFS directory handles**
  and actual IndexedDB, with an explicitly simulated desktop flag and picker.
  The production installer seeded a fake HOME; the installed Omarchy templater
  rendered a light palette into a replacement fake theme directory. That exact
  output then passed through the adapter's file reader and shared controller:
  light mode prevailed over OS-dark without a document reload.
- The same fixture passed unknown-palette/optional-placeholder normalization,
  invalid-file rejection and three-failure stock restoration, valid recovery,
  hosted/offline same-name exclusion, allowed-route return, unknown/supported
  stylesheet replacement, unload restoration, and stored-handle reload without
  another picker. Authored diagram color and private source exports were checked.
- Simulated permission loss restored stock and did not prompt. A synthetic click
  could not request permission; an actual trusted Reconnect click recovered.
  Actual follow-off and forget controls restored the exact original stylesheet
  and removed only the saved directory record. With the desktop flag false,
  the packaged module created no UI, opened no storage, and changed no source.
- Independent review found and helped fix a shared-controller eligibility race:
  silent history changes must be rechecked during reconciliation and just before
  async stylesheet application. A disposable differential reproduced the old
  regression and verified the fix. Final review found no further confirmed
  actionable issues. Seed collision backups were also moved outside Omarchy's
  replaceable theme tree and verified to survive a switch.

OPFS/mocked-picker integration is not presented as a native-dialog or live-graph
activation test. The earlier user-run actual-Roam probe supplies separate native
file-access/cold-restart evidence. The completed desktop adapter and real user
template still require deliberate activation and a real graph/theme-switch trial.
