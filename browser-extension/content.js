(() => {
  "use strict";

  const protocol = globalThis.RoamOmarchyProtocol;
  if (window.top !== window || !protocol.isRoamUrl(location.href)) return;

  const bundle = globalThis.ROAM_OMARCHY_THEME;
  const supportedHashes = new Set(Array.isArray(bundle?.supportedHashes) ?
    bundle.supportedHashes.filter((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/i.test(hash))
      .map((hash) => hash.toLowerCase()) : []);
  const themeCss = typeof bundle?.css === "string" && supportedHashes.size ? bundle.css +
    '\nhtml[data-omarchy-active="true"] .blueprint-dm-toggle { display: none !important; }\n' : null;
  const RECONNECT_DELAYS = [250, 1000, 2000, 5000, 10000];
  let options = protocol.defaultOptions();
  let palette = null;
  let stale = true;
  let port = null;
  let reconnectTimer = null;
  let reconnectIndex = 0;
  let suspended = false;
  let extensionGone = false;
  let lastUrl = location.href;
  let lastStatus = null;
  let queued = false;
  let source = null;
  let observedStyle = null;
  let observedHead = null;
  let rootOwnership = null;
  let pendingHash = null;
  let checkedSource = null;
  let hashRevision = 0;
  let tickTimer = null;
  let ticks = 0;

  function extensionAvailable() {
    try { return Boolean(chrome.runtime.id); } catch { return false; }
  }

  function post(message) {
    if (!port) return;
    try { port.postMessage(message); } catch { /* onDisconnect handles reconnection. */ }
  }

  function report(status) {
    if (lastStatus === status) return;
    lastStatus = status;
    post({ type: "document-status", status });
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

  const styleObserver = new MutationObserver(() => queueReconcile());
  const headObserver = new MutationObserver(() => queueReconcile());

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
    if (queued || suspended) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      reconcile();
    });
  }

  function applyChecked(node, original) {
    // Check again after the asynchronous digest, before making any DOM change.
    if (suspended || extensionGone || !palette || !themeCss ||
        !protocol.isAllowed(options, protocol.graphFromUrl(location.href)) ||
        !node.isConnected || findStyle() !== node || node.textContent !== original) return;
    source = { node, original, appliedCss: themeCss };
    node.textContent = themeCss;
    applyRoot();
    report(stale ? "stale" : "following");
  }

  function reconcile() {
    if (suspended) return;
    const graph = protocol.graphFromUrl(location.href);
    const node = findStyle();
    let blocked = null;
    if (extensionGone) blocked = "disconnected";
    else if (!options.enabled) blocked = "disabled";
    else if (graph === null) blocked = "outside-app";
    else if (!protocol.isAllowed(options, graph)) blocked = "not-allowed";
    else if (!node) blocked = "waiting-blueprint";
    else if (!themeCss) blocked = "unsupported";
    else if (!palette) blocked = "waiting-palette";
    if (blocked) {
      stopFollowing();
      report(blocked);
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
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(original)).then((digest) => {
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

  function connect() {
    if (port || suspended || extensionGone) return;
    if (!extensionAvailable()) {
      extensionGone = true;
      queueReconcile();
      return;
    }
    try {
      const connected = chrome.runtime.connect({ name: "roam-omarchy" });
      port = connected;
      lastStatus = null;
      connected.onMessage.addListener((message) => {
        if (port !== connected) return;
        const validated = protocol.validateState(message);
        if (!validated) return;
        options = validated.options;
        // Never drop the last valid palette because the host is unavailable.
        if (validated.palette) palette = protocol.validatePalette(validated.palette);
        stale = validated.stale;
        reconnectIndex = 0;
        queueReconcile();
      });
      connected.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (port !== connected) return;
        port = null;
        if (!extensionAvailable()) extensionGone = true;
        stale = true;
        queueReconcile();
        scheduleReconnect();
      });
      post({ type: "context", url: location.href });
      queueReconcile();
    } catch {
      if (!extensionAvailable()) extensionGone = true;
      stale = true;
      queueReconcile();
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (suspended || extensionGone || reconnectTimer !== null ||
        !protocol.isAllowed(options, protocol.graphFromUrl(location.href)) ||
        reconnectIndex >= RECONNECT_DELAYS.length) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAYS[reconnectIndex++]);
  }

  function routeChanged() {
    lastUrl = location.href;
    stopFollowing();
    post({ type: "context", url: lastUrl });
    if (!port && protocol.isAllowed(options, protocol.graphFromUrl(lastUrl))) {
      reconnectIndex = 0;
      connect();
    }
    queueReconcile();
  }

  function startTicks() {
    if (tickTimer !== null) return;
    tickTimer = setInterval(() => {
      // Hash routers may also use history.replaceState, which emits no hashchange.
      if (lastUrl !== location.href) routeChanged();
      if (++ticks % 20 === 0 && protocol.isAllowed(options, protocol.graphFromUrl(location.href))) {
        // Port traffic keeps bounded retry timers alive on newer MV3 workers too.
        post({ type: "ping" });
      }
    }, 1000);
  }

  window.addEventListener("hashchange", routeChanged);
  window.addEventListener("popstate", routeChanged);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.prototype.hasOwnProperty.call(changes, protocol.OPTIONS_KEY)) return;
    options = protocol.validateOptions(changes[protocol.OPTIONS_KEY].newValue) || protocol.defaultOptions();
    if (!port && protocol.isAllowed(options, protocol.graphFromUrl(location.href))) {
      reconnectIndex = 0;
      connect();
    }
    queueReconcile();
  });
  window.addEventListener("pagehide", () => {
    suspended = true;
    stale = true;
    clearInterval(tickTimer);
    clearTimeout(reconnectTimer);
    tickTimer = null;
    reconnectTimer = null;
    headObserver.disconnect();
    styleObserver.disconnect();
    observedHead = null;
    observedStyle = null;
    stopFollowing();
    const previous = port;
    port = null;
    try { previous?.disconnect(); } catch { /* Context may already be gone. */ }
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    suspended = false;
    lastUrl = location.href;
    reconnectIndex = 0;
    connect();
    startTicks();
    queueReconcile();
  });

  connect();
  startTicks();
  queueReconcile();
})();
