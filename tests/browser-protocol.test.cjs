const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extension = path.join(__dirname, "../browser-extension");
const script = (name) => fs.readFileSync(path.join(extension, name), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const dark = { mode: "dark", colors: { background: "#123456", foreground: "#abcdef", accent: "#fedcba" } };
const message = (palette = dark) => ({ version: 1, type: "palette", palette });
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
};

class Event {
  listeners = new Set();
  addListener = (listener) => this.listeners.add(listener);
  emit = (...args) => [...this.listeners].map((listener) => listener(...args));
}

class Port {
  name = "roam-omarchy";
  onMessage = new Event();
  onDisconnect = new Event();
  sent = [];
  closed = false;
  postMessage = (value) => {
    if (this.closed) throw new Error("Closed port");
    this.sent.push(plain(value));
  };
  disconnect = () => {
    if (this.closed) return;
    this.closed = true;
    this.onDisconnect.emit();
  };
  receive = (value) => this.onMessage.emit(value);
}

function clock() {
  let next = 0;
  let now = 0;
  const jobs = new Map();
  return {
    jobs,
    setTimeout(fn, delay) { jobs.set(++next, { fn, at: now + delay }); return next; },
    clearTimeout(id) { jobs.delete(id); },
    runNext() {
      const [id, job] = [...jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0] || [];
      if (!job) return false;
      jobs.delete(id);
      now = job.at;
      job.fn();
      return true;
    },
  };
}

function protocolFixture() {
  const context = vm.createContext({ URL, TextEncoder });
  vm.runInContext(script("protocol.js"), context);
  return context.RoamOmarchyProtocol;
}

function workerFixture(stored = {}) {
  const timer = clock();
  const natives = [];
  const storageChanged = new Event();
  const runtime = {
    id: "own-extension",
    onConnect: new Event(),
    onMessage: new Event(),
    getURL: (file) => `chrome-extension://own-extension/${file}`,
    connectNative(host) {
      assert.equal(host, "com.harpreetchima.roam_omarchy_theme");
      const port = new Port();
      natives.push(port);
      return port;
    },
  };
  const storage = {
    onChanged: storageChanged,
    local: {
      get: async () => plain(stored),
      set: async (values) => {
        const changes = {};
        for (const [key, newValue] of Object.entries(plain(values))) {
          changes[key] = { oldValue: stored[key], newValue };
          stored[key] = newValue;
        }
        storageChanged.emit(changes, "local");
      },
    },
  };
  const context = vm.createContext({
    URL, TextEncoder, queueMicrotask, chrome: { runtime, storage },
    setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout,
  });
  context.importScripts = (name) => vm.runInContext(script(name), context);
  vm.runInContext(script("worker.js"), context);
  return {
    natives, timer, stored, storage, runtime,
    document(overrides = {}) {
      const port = new Port();
      port.sender = { id: runtime.id, frameId: 0, url: "https://roamresearch.com/#/app/Sylva", ...overrides };
      runtime.onConnect.emit(port);
      return port;
    },
    status(type = "get-status", sender = { id: runtime.id, url: runtime.getURL("popup.html") }) {
      return new Promise((resolve) => runtime.onMessage.emit({ type }, sender, (value) => resolve(plain(value))));
    },
  };
}

test("native protocol accepts only version 1, exact known fields, and six-digit colors", () => {
  const protocol = protocolFixture();
  assert.deepEqual(plain(protocol.validateNativeMessage(message())), message());
  assert.equal(protocol.validateNativeMessage({ ...message(), command: "ignored?" }), null);
  assert.equal(protocol.validateNativeMessage({ ...message(), version: 2 }), null);
  for (const value of ["red", "#fff", "#123456; color: red", "var(--secret)", "#12345678", null]) {
    assert.equal(protocol.validatePalette({ ...dark, colors: { ...dark.colors, blue: value } }), null);
  }
  assert.equal(protocol.validatePalette({ ...dark, colors: { ...dark.colors, arbitrary_key: "#123456" } }), null);
  assert.equal(protocol.validatePalette({ ...dark, colors: { foreground: "#123456" } }), null);
  assert.equal(protocol.validatePalette({ ...dark, css: "body {}" }), null);
  assert.deepEqual(plain(protocol.validateNativeMessage({ version: 1, type: "status", status: "unavailable" })),
    { version: 1, type: "status", status: "unavailable" });
  assert.equal(protocol.validateNativeMessage({ version: 1, type: "status", status: "unavailable", path: "/private" }), null);
  assert.equal(protocol.validateNativeMessage({ ...message(), padding: "x".repeat(65536) }), null);
});

test("graph routes and options fail closed and require explicit wildcard opt-in", () => {
  const protocol = protocolFixture();
  assert.deepEqual(plain(protocol.defaultOptions()), { enabled: true, graphs: ["Sylva"] });
  assert.equal(protocol.graphFromUrl("https://roamresearch.com/#/app/My%20Graph/page/uid"), "My Graph");
  for (const url of ["http://roamresearch.com/#/app/Sylva", "https://evil.roamresearch.com/#/app/Sylva",
    "https://roamresearch.com.evil.test/#/app/Sylva", "https://roamresearch.com:444/#/app/Sylva",
    "https://roamresearch.com/#/app/%zz", "https://roamresearch.com/#/app/A%2fB",
    "https://roamresearch.com/#/signin"]) assert.equal(protocol.graphFromUrl(url), null);
  assert.equal(protocol.isAllowed(protocol.defaultOptions(), "Other"), false);
  assert.equal(protocol.isAllowed({ enabled: true, graphs: ["*"] }, "Other"), true);
  assert.equal(protocol.isAllowed({ enabled: false, graphs: ["*"] }, "Other"), false);
  assert.equal(protocol.validateOptions({ enabled: true, graphs: ["Sylva"], url: "bad" }), null);
  assert.equal(protocol.validateOptions({ enabled: true, graphs: ["\nSylva"] }), null);
  assert.equal(protocol.validateSnapshot({ palette: { ...dark, mode: "auto" }, receivedAt: Date.now() }), null);
});

test("worker rejects foreign origins, frames, and IDs; shares one fixed native subscription", async () => {
  const worker = workerFixture();
  for (const overrides of [{ id: "foreign" }, { frameId: 1 }, { url: "http://roamresearch.com/#/app/Sylva" },
    { url: "https://roamresearch.com.evil.test/#/app/Sylva" }]) {
    assert.equal(worker.document(overrides).closed, true);
  }
  const blocked = worker.document({ url: "https://roamresearch.com/#/app/Other" });
  await flush();
  assert.equal(worker.natives.length, 0);
  const first = worker.document();
  const second = worker.document();
  await flush();
  assert.equal(worker.natives.length, 1);
  assert.deepEqual(worker.natives[0].sent, [{ version: 1, type: "subscribe" }]);
  first.receive({ type: "context", url: "https://roamresearch.com/#/app/Other" });
  await flush();
  assert.equal(worker.natives[0].closed, false);
  second.disconnect();
  await flush();
  assert.equal(worker.natives[0].closed, true);
  assert.equal(worker.timer.jobs.size, 0);
  assert.equal((await worker.status()).status, "idle");
  blocked.disconnect();
});

test("worker keeps a valid cache stale, rejects malformed native data, and bounds retries", async () => {
  const worker = workerFixture({ snapshot: { palette: dark, receivedAt: Date.now() - 1000 } });
  const document = worker.document();
  await flush();
  assert.equal(document.sent.at(-1).stale, true);
  worker.natives[0].receive(message());
  await flush();
  assert.equal(document.sent.at(-1).stale, false);
  assert.deepEqual(worker.stored.snapshot.palette, dark);
  worker.natives[0].receive({ version: 1, type: "status", status: "unavailable" });
  await flush();
  assert.equal(document.sent.at(-1).stale, true);
  assert.equal(worker.natives[0].closed, false);
  worker.natives[0].receive(message({ ...dark, colors: { ...dark.colors, accent: "url(file:///private)" } }));
  await flush();
  assert.equal(worker.natives[0].closed, true);
  assert.deepEqual(document.sent.at(-1).palette, dark);
  for (let retry = 0; retry < 5; retry++) {
    assert.equal(worker.timer.runNext(), true);
    worker.natives.at(-1).disconnect();
    await flush();
  }
  assert.equal(worker.natives.length, 6);
  assert.equal(worker.timer.jobs.size, 0);
  document.receive({ type: "ping" });
  await flush();
  assert.equal(worker.natives.length, 6);
  assert.equal((await worker.status()).exhausted, true);
  await worker.status("retry");
  assert.equal(worker.natives.length, 7);
  document.disconnect();
  await flush();
  assert.equal(worker.timer.jobs.size, 0);
});

test("worker times out an unresponsive host and never relays document commands", async () => {
  const worker = workerFixture();
  const document = worker.document();
  await flush();
  assert.equal(worker.timer.runNext(), true);
  assert.equal(worker.natives[0].closed, true);
  assert.equal((await worker.status()).retrying, true);
  document.receive({ version: 1, type: "subscribe", command: "anything" });
  await flush();
  assert.equal(document.closed, true);
  assert.deepEqual(worker.natives[0].sent, [{ version: 1, type: "subscribe" }]);
  assert.equal(worker.timer.jobs.size, 0);
});

function contentFixture({ original = "supported original", deferredHash = false } = {}) {
  const observers = new Set();
  function notify(target, type, attributeName) {
    for (const observer of observers) {
      const watch = observer.watch;
      if (!watch || !watch.options[type]) continue;
      if (type === "attributes" && watch.options.attributeFilter &&
          !watch.options.attributeFilter.includes(attributeName)) continue;
      let node = target;
      while (node && node !== watch.target && watch.options.subtree) node = node.parent;
      if (node !== watch.target) continue;
      if (observer.queued) continue;
      observer.queued = true;
      queueMicrotask(() => {
        observer.queued = false;
        if (observer.watch) observer.callback([]);
      });
    }
  }
  class Observer {
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe(target, options) { this.watch = { target, options }; }
    disconnect() { this.watch = null; }
  }
  const root = { attributes: new Map(), parent: null, isConnected: true };
  root.getAttribute = (name) => root.attributes.get(name) ?? null;
  root.setAttribute = (name, value) => { root.attributes.set(name, value); notify(root, "attributes", name); };
  root.removeAttribute = (name) => { root.attributes.delete(name); notify(root, "attributes", name); };
  const tokens = new Set(["bp3-light", "unrelated"]);
  root.classList = {
    contains: (token) => tokens.has(token),
    toggle: (token, enabled) => {
      if (enabled) tokens.add(token); else tokens.delete(token);
      notify(root, "attributes", "class");
    },
  };
  const properties = new Map();
  root.style = {
    getPropertyValue: (key) => properties.get(key)?.value || "",
    getPropertyPriority: (key) => properties.get(key)?.priority || "",
    setProperty: (key, value, priority = "") => properties.set(key, { value, priority }),
    removeProperty: (key) => properties.delete(key),
  };
  root.setAttribute("data-omarchy-active", "prior");
  root.setAttribute("data-omarchy-mode", "local");
  root.style.setProperty("--omarchy-background", "#010101", "important");
  const head = { parent: root, children: [], isConnected: true };
  head.querySelectorAll = () => head.children.filter((node) => node.id === "blueprint-css");
  const style = { parent: head, id: "blueprint-css", isConnected: true, writes: 0 };
  let text = original;
  Object.defineProperty(style, "textContent", {
    get: () => text,
    set: (value) => { text = value; style.writes++; notify(style, "childList"); },
  });
  style.remove = () => {
    style.isConnected = false;
    style.parent = null;
    head.children = head.children.filter((node) => node !== style);
    notify(head, "childList");
  };
  head.children.push(style);
  const events = new Map();
  const window = {
    addEventListener: (name, callback) => {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(callback);
    },
    emit: (name, value = {}) => (events.get(name) || []).forEach((callback) => callback(value)),
  };
  window.top = window;
  const location = { href: "https://roamresearch.com/#/app/Sylva" };
  const ports = [];
  const storageChanged = new Event();
  const runtime = {
    id: "own-extension",
    connect: () => { const port = new Port(); ports.push(port); return port; },
  };
  const timer = clock();
  const intervals = new Map();
  let intervalId = 0;
  const digests = [];
  const crypto = { subtle: { digest: (algorithm, bytes) => {
    assert.equal(algorithm, "SHA-256");
    const result = () => Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer;
    if (!deferredHash) return Promise.resolve(result());
    return new Promise((resolve) => digests.push(() => resolve(result())));
  } } };
  const context = vm.createContext({
    URL, TextEncoder, queueMicrotask, window, location, crypto,
    document: { documentElement: root, head }, MutationObserver: Observer,
    chrome: { runtime, storage: { onChanged: storageChanged } },
    setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout,
    setInterval: (fn) => { intervals.set(++intervalId, fn); return intervalId; },
    clearInterval: (id) => intervals.delete(id),
    ROAM_OMARCHY_THEME: {
      css: "/* generated tokenized CSS */",
      supportedHashes: [createHash("sha256").update("supported original").digest("hex")],
      upstreamCommit: "reviewed-test-revision",
    },
  });
  vm.runInContext(script("protocol.js"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/shared/style-controller.js"), "utf8"), context);
  vm.runInContext(script("content.js"), context);
  return {
    root, head, style, ports, runtime, digests, timer,
    state(palette = dark, changes = {}) {
      ports.at(-1).receive({
        type: "state", options: { enabled: true, graphs: ["Sylva"] },
        palette, receivedAt: Date.now(), status: "live", stale: false, ...changes,
      });
    },
    options(value) { storageChanged.emit({ options: { newValue: value } }, "local"); },
    route(graph) {
      location.href = `https://roamresearch.com/#/${graph === null ? "signin" : `app/${graph}`}`;
      window.emit("hashchange");
    },
    hide() { window.emit("pagehide"); },
    show() { window.emit("pageshow", { persisted: true }); },
  };
}

test("content hashes before substitution, updates only variables, and restores owned values", async () => {
  const content = contentFixture();
  await flush();
  assert.equal(content.style.textContent, "supported original");
  content.state();
  await flush();
  assert.equal(content.style.writes, 1);
  assert.equal(content.root.getAttribute("data-omarchy-active"), "true");
  assert.equal(content.root.classList.contains("bp3-dark"), true);
  assert.equal(content.root.classList.contains("bp3-light"), false);
  assert.equal(content.root.style.getPropertyValue("--omarchy-accent"), "#fedcba");
  content.state({ mode: "dark", colors: { background: "#222222", foreground: "#eeeeee", selection_background: "#333333" } });
  await flush();
  assert.equal(content.style.writes, 1, "palette updates do not replace the stylesheet");
  assert.equal(content.root.style.getPropertyValue("--omarchy-accent"), "");
  assert.equal(content.root.style.getPropertyValue("--omarchy-selection-background"), "#333333");
  content.root.classList.toggle("bp3-dark", false);
  content.root.classList.toggle("bp3-light", true);
  await flush();
  assert.equal(content.root.classList.contains("bp3-dark"), true, "local mode remains authoritative while active");
  content.root.style.setProperty("--omarchy-foreground", "#424242", "important");
  content.options({ enabled: false, graphs: ["Sylva"] });
  await flush();
  assert.equal(content.style.textContent, "supported original");
  assert.equal(content.root.getAttribute("data-omarchy-active"), "prior");
  assert.equal(content.root.getAttribute("data-omarchy-mode"), "local");
  assert.equal(content.root.classList.contains("bp3-light"), true);
  assert.equal(content.root.classList.contains("bp3-dark"), false);
  assert.equal(content.root.classList.contains("unrelated"), true);
  assert.equal(content.root.style.getPropertyValue("--omarchy-background"), "#010101");
  assert.equal(content.root.style.getPropertyPriority("--omarchy-background"), "important");
  assert.equal(content.root.style.getPropertyValue("--omarchy-foreground"), "#424242");
  assert.equal(content.root.style.getPropertyValue("--omarchy-selection-background"), "");
});

test("content keeps a last valid palette stale but rejects an invalid palette", async () => {
  const content = contentFixture();
  content.state({ ...dark, colors: { ...dark.colors, red: "red" } });
  await flush();
  assert.equal(content.style.writes, 0);
  content.state();
  await flush();
  const applied = content.style.textContent;
  content.state(dark, { status: "unavailable", stale: true });
  await flush();
  assert.equal(content.style.textContent, applied);
  assert.equal(content.ports[0].sent.at(-1).status, "stale");
  content.route("Other");
  await flush();
  assert.equal(content.style.textContent, "supported original");
  assert.equal(content.root.getAttribute("data-omarchy-active"), "prior");
});

test("root mode ownership preserves a later upstream auto choice, not just changed tokens", async () => {
  const content = contentFixture();
  content.state();
  await flush();
  content.root.classList.toggle("bp3-dark", false);
  content.root.classList.toggle("bp3-light", false);
  await flush();
  assert.equal(content.root.classList.contains("bp3-dark"), true);
  content.options({ enabled: false, graphs: ["Sylva"] });
  await flush();
  assert.equal(content.root.classList.contains("bp3-dark"), false);
  assert.equal(content.root.classList.contains("bp3-light"), false);
});

test("unknown Blueprint stays unchanged; source removal is never resurrected", async () => {
  const content = contentFixture({ original: "unknown original" });
  content.state();
  await flush();
  assert.equal(content.style.textContent, "unknown original");
  assert.equal(content.style.writes, 0);
  assert.equal(content.ports[0].sent.at(-1).status, "unsupported");
  content.style.textContent = "supported original";
  await flush();
  assert.equal(content.root.getAttribute("data-omarchy-active"), "true");
  const applied = content.style.textContent;
  content.style.remove();
  await flush();
  assert.equal(content.head.children.length, 0);
  assert.equal(content.style.textContent, applied, "removed source text is not restored either");
  assert.equal(content.root.getAttribute("data-omarchy-active"), "prior");
});

test("digest races never apply an old source or apply after leaving an allowed graph", async () => {
  const content = contentFixture({ deferredHash: true });
  content.state();
  await flush();
  assert.equal(content.digests.length, 1);
  content.style.textContent = "new unsupported source";
  await flush();
  assert.equal(content.digests.length, 2);
  content.digests[0]();
  await flush();
  assert.equal(content.style.textContent, "new unsupported source");
  content.digests[1]();
  await flush();
  assert.equal(content.ports[0].sent.at(-1).status, "unsupported");
  content.style.textContent = "supported original";
  await flush();
  content.route(null);
  content.digests[2]();
  await flush();
  assert.equal(content.style.textContent, "supported original");
  assert.equal(content.root.getAttribute("data-omarchy-active"), "prior");
});

test("page suspension restores state, resumes safely, and extension invalidation restores again", async () => {
  const content = contentFixture();
  content.state();
  await flush();
  content.hide();
  await flush();
  assert.equal(content.style.textContent, "supported original");
  assert.equal(content.ports[0].closed, true);
  content.show();
  await flush();
  assert.equal(content.root.getAttribute("data-omarchy-active"), "true");
  assert.equal(content.ports[1].sent.at(-1).status, "stale");
  content.runtime.id = undefined;
  content.ports[1].disconnect();
  await flush();
  assert.equal(content.style.textContent, "supported original");
  assert.equal(content.root.getAttribute("data-omarchy-active"), "prior");
  assert.equal(content.timer.jobs.size, 0);
});
