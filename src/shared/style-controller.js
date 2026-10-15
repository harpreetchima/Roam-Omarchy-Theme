/* Transport-independent ownership of a supported Blueprint stylesheet. */
(() => {
  "use strict";

  function createController({ theme, protocol, onStatus = () => {}, getBlocked = () => null }) {
    const supportedHashes = new Set(Array.isArray(theme?.supportedHashes) ?
      theme.supportedHashes.filter((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/i.test(hash))
        .map((hash) => hash.toLowerCase()) : []);
    const themeCss = typeof theme?.css === "string" && supportedHashes.size ? theme.css +
      '\nhtml[data-omarchy-active="true"] .blueprint-dm-toggle { display: none !important; }\n' : null;
    let palette = null;
    let stale = true;
    let blocked = null;
    let active = false;
    let suspended = false;
    let disposed = false;
    let queued = false;
    let source = null;
    let observedStyle = null;
    let observedHead = null;
    let rootOwnership = null;
    let pendingHash = null;
    let checkedSource = null;
    let hashRevision = 0;

    function report(status) {
      if (active && !suspended && !disposed) onStatus(status);
    }

    // Track individual attributes, class tokens, and properties, not whole class/style strings.
    // If the page changes a value, preserve that newer intent when following ends.
    function own(map, key, read, write, desired) {
      const current = read();
      let entry = map.get(key);
      if (!entry) {
        entry = { original: current, last: current, read, write };
        map.set(key, entry);
      } else if (current !== entry.last) {
        entry.original = current;
      }
      if (current !== desired) write(desired);
      entry.last = read();
    }

    function releaseEntry(map, key) {
      const entry = map.get(key);
      if (!entry) return;
      if (entry.read() === entry.last) entry.write(entry.original);
      map.delete(key);
    }

    const rootObserver = new MutationObserver(() => queueReconcile());

    function releaseRoot() {
      rootObserver.disconnect();
      if (!rootOwnership) return;
      for (const key of [...rootOwnership.values.keys()]) releaseEntry(rootOwnership.values, key);
      rootOwnership = null;
    }

    function applyRoot() {
      const root = document.documentElement;
      if (rootOwnership?.root !== root) {
        releaseRoot();
        rootOwnership = { root, values: new Map() };
        rootObserver.observe(root, {
          attributes: true, attributeFilter: ["class", "data-omarchy-active", "data-omarchy-mode"],
        });
      }
      const values = rootOwnership.values;
      for (const [name, value] of [["data-omarchy-active", "true"], ["data-omarchy-mode", palette.mode]]) {
        own(values, `attr:${name}`, () => root.getAttribute(name),
          (next) => next === null ? root.removeAttribute(name) : root.setAttribute(name, next), value);
      }
      // These two tokens are one appearance choice (including neither = upstream auto).
      own(values, "classes:mode",
        () => JSON.stringify([root.classList.contains("bp3-dark"), root.classList.contains("bp3-light")]),
        (next) => {
          const [dark, light] = JSON.parse(next);
          root.classList.toggle("bp3-dark", dark);
          root.classList.toggle("bp3-light", light);
        }, JSON.stringify([palette.mode === "dark", palette.mode === "light"]));
      for (const key of protocol.COLOR_KEYS) {
        const name = `--omarchy-${key.replaceAll("_", "-")}`;
        const ownershipKey = `style:${name}`;
        if (!Object.prototype.hasOwnProperty.call(palette.colors, key)) {
          releaseEntry(values, ownershipKey);
          continue;
        }
        // Include priority in the ownership check so a later !important value is not lost.
        own(values, ownershipKey,
          () => JSON.stringify([root.style.getPropertyValue(name), root.style.getPropertyPriority(name)]),
          (next) => {
            const [value, priority] = JSON.parse(next);
            if (value) root.style.setProperty(name, value, priority);
            else root.style.removeProperty(name);
          }, JSON.stringify([palette.colors[key], ""]));
      }
    }

    function releaseSource() {
      const previous = source;
      source = null;
      if (previous?.node.isConnected && previous.node.textContent === previous.appliedCss) {
        previous.node.textContent = previous.original;
      }
    }

    function stopFollowing() {
      pendingHash = null;
      hashRevision++;
      releaseRoot();
      releaseSource();
    }

    function stopIfBlocked() {
      let liveBlocked;
      try { liveBlocked = getBlocked(); } catch { liveBlocked = "disconnected"; }
      const reason = blocked ?? (liveBlocked === null ? null :
        typeof liveBlocked === "string" && liveBlocked ? liveBlocked : "disconnected");
      if (reason === null) return false;
      stopFollowing();
      report(reason);
      return true;
    }

    const styleObserver = new MutationObserver(() => queueReconcile());
    const headObserver = new MutationObserver(() => queueReconcile());

    function disconnectObservers() {
      headObserver.disconnect();
      styleObserver.disconnect();
      observedHead = null;
      observedStyle = null;
    }

    function findStyle() {
      const head = document.head;
      if (head !== observedHead) {
        headObserver.disconnect();
        observedHead = head;
        if (head) headObserver.observe(head, { childList: true, subtree: true });
      }
      const styles = head?.querySelectorAll("style#blueprint-css");
      const node = styles?.length === 1 ? styles[0] : null;
      if (node !== observedStyle) {
        styleObserver.disconnect();
        observedStyle = node;
        if (node) styleObserver.observe(node, {
          childList: true, characterData: true, subtree: true,
          attributes: true, attributeFilter: ["id", "type", "media"],
        });
      }
      return node;
    }

    function queueReconcile() {
      if (queued || !active || suspended || disposed) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        reconcile();
      });
    }

    function applyChecked(node, original) {
      // Check again after the asynchronous digest, before making any DOM change.
      if (!active || suspended || disposed) return;
      if (stopIfBlocked() || !palette || !themeCss ||
          !node.isConnected || findStyle() !== node || node.textContent !== original) return;
      source = { node, original, appliedCss: themeCss };
      node.textContent = themeCss;
      applyRoot();
      report(stale ? "stale" : "following");
    }

    function reconcile() {
      if (!active || suspended || disposed) return;
      if (stopIfBlocked()) return;
      const node = findStyle();
      let waiting = null;
      if (!node) waiting = "waiting-blueprint";
      else if (!themeCss) waiting = "unsupported";
      else if (!palette) waiting = "waiting-palette";
      if (waiting) {
        stopFollowing();
        report(waiting);
        return;
      }

      if (source && source.node === node && node.textContent === source.appliedCss) {
        applyRoot();
        report(stale ? "stale" : "following");
        return;
      }
      // A replacement style or changed text belongs to Roam, not to this extension.
      if (source) stopFollowing();
      const original = node.textContent;
      if (checkedSource?.node === node && checkedSource.text === original) {
        if (checkedSource.supported) applyChecked(node, original);
        else report("unsupported");
        return;
      }
      if (pendingHash?.node === node && pendingHash.text === original) return;
      const revision = ++hashRevision;
      pendingHash = { node, text: original };
      report("waiting-blueprint");
      let digest;
      try {
        digest = crypto.subtle.digest("SHA-256", new TextEncoder().encode(original));
      } catch {
        pendingHash = null;
        checkedSource = { node, text: original, supported: false };
        report("unsupported");
        return;
      }
      digest.then((digest) => {
        if (revision !== hashRevision) return;
        pendingHash = null;
        const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        checkedSource = { node, text: original, supported: supportedHashes.has(hash) };
        if (node.textContent !== original || findStyle() !== node) {
          queueReconcile();
        } else if (checkedSource.supported) {
          applyChecked(node, original);
        } else {
          report("unsupported");
        }
      }).catch(() => {
        if (revision !== hashRevision) return;
        pendingHash = null;
        checkedSource = { node, text: original, supported: false };
        report("unsupported");
      });
    }

    function update({ palette: nextPalette, stale: nextStale = true, blocked: nextBlocked = null } = {}) {
      if (disposed) return;
      // Callers own their caches; an invalid supplied palette must not keep an override active.
      try { palette = protocol.validatePalette(nextPalette); } catch { palette = null; }
      stale = nextStale !== false;
      blocked = nextBlocked === null ? null :
        typeof nextBlocked === "string" && nextBlocked ? nextBlocked : "disconnected";
      active = true;
      if (suspended) return;
      if (blocked !== null) {
        disconnectObservers();
        stopFollowing();
        report(blocked);
        return;
      }
      if (!palette) stopFollowing();
      queueReconcile();
    }

    function reset() {
      if (disposed) return;
      active = false;
      disconnectObservers();
      stopFollowing();
    }

    function suspend() {
      if (disposed || suspended) return;
      suspended = true;
      disconnectObservers();
      stopFollowing();
    }

    function resume() {
      if (disposed || !suspended) return;
      suspended = false;
      queueReconcile();
    }

    function dispose() {
      if (disposed) return;
      reset();
      disposed = true;
      palette = null;
      checkedSource = null;
    }

    return Object.freeze({ update, reset, suspend, resume, dispose });
  }

  globalThis.RoamOmarchyStyles = Object.freeze({ createController });
})();
