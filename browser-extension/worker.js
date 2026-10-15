"use strict";

importScripts("protocol.js");

const protocol = globalThis.RoamOmarchyProtocol;
const NATIVE_HOST = "com.harpreetchima.roam_omarchy_theme";
const RETRY_DELAYS = [1000, 2000, 5000, 10000, 30000];
const documents = new Map();
let options = protocol.defaultOptions();
let snapshot = null;
let nativePort = null;
let handshakeTimer = null;
let nativeStatus = "idle";
let retryTimer = null;
let retryIndex = 0;
let exhausted = false;
let relevantCount = 0;
let writes = Promise.resolve();

// A worker restart never treats a stored palette as proof the host is available.
const ready = chrome.storage.local.get([protocol.OPTIONS_KEY, protocol.SNAPSHOT_KEY])
  .then((stored) => {
    options = protocol.validateOptions(stored[protocol.OPTIONS_KEY]) || protocol.defaultOptions();
    snapshot = protocol.validateSnapshot(stored[protocol.SNAPSHOT_KEY]);
  }).catch(() => {});

function state() {
  return {
    type: "state", options,
    palette: snapshot?.palette ?? null,
    receivedAt: snapshot?.receivedAt ?? null,
    status: nativeStatus,
    stale: nativeStatus !== "live",
  };
}

function send(port, message) {
  try {
    port.postMessage(message);
  } catch {
    if (documents.delete(port)) queueMicrotask(reconcile);
  }
}

function broadcast() {
  const message = state();
  for (const port of documents.keys()) send(port, message);
}

function closeNative() {
  if (handshakeTimer !== null) clearTimeout(handshakeTimer);
  handshakeTimer = null;
  const previous = nativePort;
  nativePort = null;
  if (previous) {
    try { previous.disconnect(); } catch { /* Already closed. */ }
  }
}

function cancelRetry() {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
}

function failed() {
  closeNative();
  nativeStatus = "unavailable";
  cancelRetry();
  if (relevantCount > 0 && retryIndex < RETRY_DELAYS.length) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connectNative();
    }, RETRY_DELAYS[retryIndex++]);
  } else {
    exhausted = true;
  }
  broadcast();
}

function connectNative() {
  if (nativePort || relevantCount === 0 || exhausted) return;
  nativeStatus = "connecting";
  broadcast();
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    handshakeTimer = setTimeout(() => {
      if (nativePort === port) failed();
    }, 10000);
    port.onMessage.addListener((message) => {
      if (nativePort !== port) return;
      const validated = protocol.validateNativeMessage(message);
      if (!validated) {
        failed();
        return;
      }
      if (handshakeTimer !== null) clearTimeout(handshakeTimer);
      handshakeTimer = null;
      if (validated.type === "palette") {
        snapshot = { palette: validated.palette, receivedAt: Date.now() };
        nativeStatus = "live";
        retryIndex = 0;
        exhausted = false;
        const cached = snapshot;
        writes = writes.then(() => chrome.storage.local.set({ [protocol.SNAPSHOT_KEY]: cached }))
          .catch(() => {});
      } else {
        nativeStatus = "unavailable";
      }
      broadcast();
    });
    port.onDisconnect.addListener(() => {
      // Consume Chrome's diagnostic, but never forward local errors or paths.
      void chrome.runtime.lastError;
      if (nativePort === port) failed();
    });
    // Do not relay any message from a document to the native host.
    port.postMessage({ version: 1, type: "subscribe" });
  } catch {
    failed();
  }
}

function reconcile() {
  const previousCount = relevantCount;
  relevantCount = [...documents.values()].filter((document) =>
    protocol.isAllowed(options, document.graph)).length;
  if (relevantCount === 0) {
    cancelRetry();
    closeNative();
    nativeStatus = "idle";
    retryIndex = 0;
    exhausted = false;
  } else if (previousCount === 0) {
    retryIndex = 0;
    exhausted = false;
    connectNative();
  } else if (!nativePort && retryTimer === null && !exhausted) {
    connectNative();
  }
  broadcast();
}

chrome.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  if (port.name !== "roam-omarchy" || sender?.id !== chrome.runtime.id ||
      sender.frameId !== 0 || !protocol.isRoamUrl(sender.url)) {
    port.disconnect();
    return;
  }
  const document = { graph: protocol.graphFromUrl(sender.url), status: "waiting-blueprint" };
  documents.set(port, document);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    documents.delete(port);
    void ready.then(reconcile);
  });
  port.onMessage.addListener((message) => {
    void ready.then(() => {
      if (!documents.has(port)) return;
      if (protocol.exactKeys(message, ["type", "url"]) && message.type === "context" &&
          protocol.isRoamUrl(message.url)) {
        document.graph = protocol.graphFromUrl(message.url);
        reconcile();
      } else if (protocol.exactKeys(message, ["type", "status"]) &&
          message.type === "document-status" && protocol.DOCUMENT_STATUSES.includes(message.status)) {
        document.status = message.status;
      } else if (!protocol.exactKeys(message, ["type"]) || message.type !== "ping") {
        documents.delete(port);
        port.disconnect();
        reconcile();
      }
    });
  });
  void ready.then(reconcile);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.prototype.hasOwnProperty.call(changes, protocol.OPTIONS_KEY)) return;
  void ready.then(() => {
    options = protocol.validateOptions(changes[protocol.OPTIONS_KEY].newValue) || protocol.defaultOptions();
    reconcile();
  });
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html") ||
      !protocol.exactKeys(message, ["type"]) || !["get-status", "retry"].includes(message.type)) return false;
  void ready.then(() => {
    if (message.type === "retry" && relevantCount > 0) {
      cancelRetry();
      closeNative();
      retryIndex = 0;
      exhausted = false;
      connectNative();
    }
    respond({
      ...state(),
      retrying: retryTimer !== null,
      exhausted,
      documents: [...documents.values()].map(({ graph, status }) => ({ graph, status })),
    });
  });
  return true;
});
