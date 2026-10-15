(() => {
  "use strict";

  function createAdapter({ theme, protocol, styles, uiCss }) {
    const source = globalThis.RoamOmarchyDesktopSource;
    const isDesktop = () => window.top === window && protocol.isRoamUrl(location.href) &&
      window.roamAlphaAPI?.platform?.isDesktop === true;
    // Do not create UI, open storage, observe styles, or ask for access elsewhere.
    if (!isDesktop()) return () => {};

    const storage = globalThis.RoamOmarchyDesktopStorage.createStorage();
    let options = source.defaultOptions();
    let handle = null;
    let permission = "prompt";
    let palette = null;
    let failures = 0;
    let loaded = false;
    let disposed = false;
    let suspended = false;
    let busy = false;
    let actionBusy = false;
    let timer = null;
    let readRevision = 0;
    let selectionRevision = 0;
    let optionsRevision = 0;
    let graph = source.graphFromUrl(location.href);
    let status = "loading-options";
    let notice = "";
    let storageWarning = "";
    let scopeError = "";
    let view = null;
    const listeners = [];
    const canChoose = () => isDesktop() && window.isSecureContext === true &&
      typeof window.showDirectoryPicker === "function";

    function render() {
      if (!disposed) view?.render({
        status, graph, options, loaded, canChoose: canChoose(), hasHandle: handle !== null,
        busy: actionBusy || suspended, notice, storageWarning, scopeError,
      });
    }

    const controller = styles.createController({
      theme, protocol,
      onStatus(next) { if (!disposed) { status = next; render(); } },
      getBlocked: () => blockReason() || (failures >= 3 ? "disconnected" : null),
    });

    function invalidate() {
      readRevision++;
      palette = null;
      failures = 0;
    }

    function blockReason() {
      const liveGraph = source.graphFromUrl(location.href);
      if (suspended) return "disconnected";
      if (!loaded) return "loading-options";
      if (!isDesktop() || liveGraph === null) return "outside-app";
      if (!options.enabled) return "disabled";
      if (!source.allowed(options, liveGraph)) return "not-allowed";
      if (actionBusy) return "choosing-folder";
      if (!handle) return canChoose() ? "waiting-folder" : "unsupported-browser";
      if (permission !== "granted") return "permission-needed";
      return null;
    }

    function reconcile(readNow = false) {
      if (disposed) return;
      const blocked = blockReason();
      const styleBlock = blocked || (failures >= 3 ? "disconnected" : null);
      if (styleBlock) status = styleBlock;
      else if (!palette) status = "waiting-palette";
      controller.update({ palette, stale: failures > 0, blocked: styleBlock });
      if (blocked) {
        clearInterval(timer);
        timer = null;
      } else {
        if (timer === null) timer = setInterval(() => { syncRoute(); reconcile(); void poll(); }, 1000);
        if (readNow) void poll();
      }
      render();
    }

    function syncRoute() {
      if (disposed) return;
      const next = source.graphFromUrl(location.href);
      if (next === graph) return;
      graph = next;
      invalidate();
      notice = "";
      reconcile(true);
    }

    function selectionCurrent(revision, selected) {
      return !disposed && revision === selectionRevision && selected === handle;
    }

    function persist(operation, current) {
      void operation.catch((error) => {
        if (disposed || !current() || error?.name === "AbortError") return;
        storageWarning = "Local storage is unavailable. Changes last only for this extension session; forgetting may need to be repeated after reload.";
        render();
      });
    }

    function permissionNeeded() {
      permission = "prompt";
      invalidate();
      notice = "Read permission is no longer available. Click Reconnect to request it; no automatic prompt will appear.";
      reconcile();
    }

    async function poll() {
      syncRoute();
      if (disposed || busy || blockReason()) return;
      const selected = handle;
      const revision = readRevision;
      const selectedGraph = graph;
      const current = () => !disposed && revision === readRevision && selected === handle &&
        selectedGraph === source.graphFromUrl(location.href) && !blockReason();
      busy = true;
      try {
        // Queries never prompt, including after extension reload and cold startup.
        const granted = await selected.queryPermission({ mode: "read" });
        if (!current()) return;
        if (granted !== "granted") { permissionNeeded(); return; }
        const next = await source.readPalette(selected, protocol);
        if (!current()) return;
        palette = next;
        failures = 0;
        notice = "";
        reconcile();
      } catch (error) {
        if (!current()) return;
        if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
          permissionNeeded();
        } else {
          failures = Math.min(failures + 1, 3);
          notice = failures >= 3 ? "Three consecutive palette reads failed. Stock Blueprint is restored; eligible reads continue once per second." :
            palette ? `Palette read failed (${failures}/3). Keeping the last valid palette briefly.` :
              `Palette read failed (${failures}/3). Waiting for a fresh valid file; stock Blueprint is unchanged.`;
          reconcile();
        }
      } finally {
        busy = false;
        if (!disposed) {
          syncRoute();
          // A new selection/context may have been waiting behind this read.
          if (revision !== readRevision && !blockReason()) void poll();
        }
      }
    }

    async function choose(event) {
      if (event?.isTrusted !== true || disposed || !loaded || suspended || actionBusy || !canChoose()) return;
      const revision = ++selectionRevision;
      actionBusy = true;
      invalidate();
      notice = "Choose ~/.local/state/omarchy/current, not its theme child or your home folder.";
      reconcile();
      try {
        // Keep the picker directly in the real click's activation, before any await.
        const selected = await window.showDirectoryPicker({ id: "roam-omarchy-desktop-current", mode: "read" });
        if (disposed || revision !== selectionRevision) return;
        if (!source.validHandle(selected)) {
          notice = "Choose the read-only folder named current. The selected folder was not retained.";
          return;
        }
        handle = selected;
        permission = "prompt";
        const current = () => !disposed && handle === selected;
        persist(storage.saveHandle(selected, current), current);
        try {
          const result = await selected.queryPermission({ mode: "read" });
          if (!selectionCurrent(revision, selected)) return;
          permission = result === "granted" ? "granted" : "prompt";
        } catch {
          if (!selectionCurrent(revision, selected)) return;
          permission = "prompt";
        }
        notice = permission === "granted" ? "" : "Folder retained without read access. Click Reconnect to request permission.";
      } catch (error) {
        if (disposed || revision !== selectionRevision) return;
        notice = error?.name === "AbortError" ? "Folder selection canceled; the previous folder is unchanged." :
          "Folder selection failed. No new folder was retained.";
      } finally {
        if (!disposed && revision === selectionRevision) { actionBusy = false; reconcile(true); }
      }
    }

    async function reconnect(event) {
      if (event?.isTrusted !== true || disposed || !loaded || suspended || actionBusy || !handle || !isDesktop()) return;
      const revision = ++selectionRevision;
      const selected = handle;
      actionBusy = true;
      invalidate();
      reconcile();
      try {
        // The only requestPermission call: never reached by startup, timers or code clicks.
        const result = await selected.requestPermission({ mode: "read" });
        if (!selectionCurrent(revision, selected)) return;
        permission = result === "granted" ? "granted" : "prompt";
        notice = permission === "granted" ? "" : "Read access was not granted. Stock Blueprint remains active.";
      } catch {
        if (!selectionCurrent(revision, selected)) return;
        permission = "prompt";
        notice = "The folder could not be reconnected. Choose current again if its handle is no longer usable.";
      } finally {
        if (!disposed && revision === selectionRevision) { actionBusy = false; reconcile(true); }
      }
    }

    function changeOptions(next) {
      if (disposed || !loaded) return;
      options = next;
      const revision = ++optionsRevision;
      const current = () => !disposed && revision === optionsRevision;
      persist(storage.saveOptions(options, current), current);
      invalidate();
      notice = "";
      reconcile(true);
    }

    function forget() {
      if (disposed || !loaded) return;
      selectionRevision++;
      handle = null;
      permission = "prompt";
      actionBusy = false;
      invalidate();
      notice = "The saved folder is forgotten locally. This does not revoke Chromium's folder permission for other trusted extensions.";
      // A later canceled chooser must not cancel an already requested forget.
      const current = () => !disposed && handle === null;
      persist(storage.forgetHandle(current), current);
      reconcile();
    }

    view = globalThis.RoamOmarchyDesktopUI.createUI({
      css: uiCss, onChoose: choose, onReconnect: reconnect, onForget: forget,
      onFollow: (enabled) => changeOptions({ ...options, enabled }),
      onScope(value) {
        if (disposed || !loaded) return;
        const graphs = value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
        const next = source.validateOptions({ ...options, graphs });
        scopeError = next ? "" : "Use up to 100 exact hosted:Name or offline:Name entries, or *. Names cannot contain slashes or control characters.";
        if (next) changeOptions(next);
        else render();
      },
    });

    function listen(target, event, callback) {
      target.addEventListener(event, callback);
      listeners.push(() => target.removeEventListener(event, callback));
    }
    listen(window, "hashchange", syncRoute);
    listen(window, "popstate", syncRoute);
    // Navigation API also observes history.replaceState without patching Roam's history.
    if (window.navigation?.addEventListener) listen(window.navigation, "currententrychange", syncRoute);
    listen(window, "pagehide", () => {
      if (disposed) return;
      suspended = true;
      invalidate();
      clearInterval(timer);
      timer = null;
      controller.update({ palette: null, stale: false, blocked: "disconnected" });
      controller.suspend();
      status = "disconnected";
      render();
    });
    listen(window, "pageshow", (event) => {
      if (disposed || !event.persisted) return;
      suspended = false;
      invalidate();
      controller.resume();
      syncRoute();
      reconcile(true);
    });

    reconcile();
    void (async () => {
      const initialSelection = selectionRevision;
      const initialOptions = optionsRevision;
      try {
        const stored = await storage.load();
        if (disposed) return;
        if (initialOptions === optionsRevision) options = source.validateOptions(stored.options) || source.defaultOptions();
        if (initialSelection === selectionRevision && source.validHandle(stored.handle)) handle = stored.handle;
      } catch {
        if (disposed) return;
        storageWarning = "Local storage is unavailable. Options and folder selection will last only for this extension session.";
      }
      if (disposed) return;
      loaded = true;
      const selected = handle;
      const revision = selectionRevision;
      reconcile();
      if (!selected) return;
      try {
        const result = await selected.queryPermission({ mode: "read" });
        if (!selectionCurrent(revision, selected)) return;
        permission = result === "granted" ? "granted" : "prompt";
      } catch {
        if (!selectionCurrent(revision, selected)) return;
        permission = "prompt";
      }
      notice = permission === "granted" ? "" : "Saved folder needs read permission. Click Reconnect; permission is never requested automatically.";
      reconcile(true);
    })();

    return function dispose() {
      if (disposed) return;
      disposed = true;
      selectionRevision++;
      optionsRevision++;
      invalidate();
      clearInterval(timer);
      timer = null;
      for (const remove of listeners) remove();
      storage.dispose();
      controller.dispose();
      view.dispose();
      handle = null;
    };
  }

  globalThis.RoamOmarchyDesktop = Object.freeze({ createAdapter });
})();
