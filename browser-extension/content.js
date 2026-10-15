(() => {
  "use strict";

  const protocol = globalThis.RoamOmarchyProtocol;
  if (window.top !== window || !protocol.isRoamUrl(location.href)) return;

  const styles = globalThis.RoamOmarchyStyles.createController({
    theme: globalThis.ROAM_OMARCHY_THEME, protocol, onStatus: report, getBlocked,
  });
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

  function getBlocked() {
    const graph = protocol.graphFromUrl(location.href);
    if (extensionGone) return "disconnected";
    if (!options.enabled) return "disabled";
    if (graph === null) return "outside-app";
    if (!protocol.isAllowed(options, graph)) return "not-allowed";
    return null;
  }

  function updateStyles() {
    styles.update({ palette, stale, blocked: getBlocked() });
  }

  function connect() {
    if (port || suspended || extensionGone) return;
    if (!extensionAvailable()) {
      extensionGone = true;
      updateStyles();
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
        updateStyles();
      });
      connected.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (port !== connected) return;
        port = null;
        if (!extensionAvailable()) extensionGone = true;
        stale = true;
        updateStyles();
        scheduleReconnect();
      });
      post({ type: "context", url: location.href });
      updateStyles();
    } catch {
      if (!extensionAvailable()) extensionGone = true;
      stale = true;
      updateStyles();
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
    styles.reset();
    post({ type: "context", url: lastUrl });
    if (!port && protocol.isAllowed(options, protocol.graphFromUrl(lastUrl))) {
      reconnectIndex = 0;
      connect();
    }
    updateStyles();
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
    updateStyles();
  });
  window.addEventListener("pagehide", () => {
    suspended = true;
    stale = true;
    clearInterval(tickTimer);
    clearTimeout(reconnectTimer);
    tickTimer = null;
    reconnectTimer = null;
    styles.suspend();
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
    updateStyles();
    styles.resume();
  });

  connect();
  startTicks();
  updateStyles();
})();
