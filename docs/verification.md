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
