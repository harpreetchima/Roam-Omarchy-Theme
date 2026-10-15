(() => {
  "use strict";

  const protocol = globalThis.RoamOmarchyProtocol;
  const enabled = document.getElementById("enabled");
  const graphs = document.getElementById("graphs");
  const status = document.getElementById("status");
  const details = document.getElementById("details");
  const saved = document.getElementById("saved");
  const retry = document.getElementById("retry");

  async function loadOptions() {
    const stored = await chrome.storage.local.get(protocol.OPTIONS_KEY);
    const options = protocol.validateOptions(stored[protocol.OPTIONS_KEY]) || protocol.defaultOptions();
    enabled.checked = options.enabled;
    graphs.value = options.graphs.join("\n");
  }

  async function refresh() {
    try {
      const current = await chrome.runtime.sendMessage({ type: "get-status" });
      if (!current || !protocol.NATIVE_STATUSES.includes(current.status)) throw new Error("No status");
      const unsupported = current.documents.some((document) => document.status === "unsupported");
      const following = current.documents.some((document) => ["following", "stale"].includes(document.status));
      let text;
      if (!current.options.enabled) text = "Local following is off.";
      else if (unsupported) text = "Unsupported Blueprint CSS; original theme unchanged.";
      else if (current.status === "live" && following) text = "Following the local Omarchy palette.";
      else if (current.status === "live") text = "Palette ready; waiting for supported Blueprint CSS.";
      else if (current.status === "connecting") text = "Connecting to the local native host…";
      else if (current.status === "unavailable") text = current.palette ?
        "Native host unavailable. Keeping the last palette (stale)." :
        "Native host unavailable. Blueprint is unchanged.";
      else text = "Waiting for an allowed Roam graph.";
      status.textContent = text;
      status.dataset.warning = String(unsupported || current.status === "unavailable");
      const lines = [];
      if (current.receivedAt) {
        lines.push(`Last palette: ${new Date(current.receivedAt).toLocaleString()}${current.stale ? " (cached/stale)" : ""}`);
      }
      for (const document of current.documents) {
        if (document.graph) lines.push(`${document.graph}: ${document.status.replaceAll("-", " ")}`);
      }
      if (current.retrying) lines.push("A bounded reconnect is scheduled.");
      else if (current.exhausted) lines.push("Automatic retries stopped; retry manually when the host is ready.");
      details.textContent = lines.join("\n");
      retry.hidden = current.status !== "unavailable";
    } catch {
      status.textContent = "Local companion status is unavailable.";
      status.dataset.warning = "true";
      retry.hidden = true;
    }
  }

  document.getElementById("options").addEventListener("submit", async (event) => {
    event.preventDefault();
    const options = protocol.validateOptions({
      enabled: enabled.checked,
      graphs: graphs.value.split(/\r?\n/).map((graph) => graph.trim()).filter(Boolean),
    });
    if (!options) {
      saved.textContent = "Use up to 100 graph names, 128 characters each, without slashes or control characters.";
      return;
    }
    try {
      await chrome.storage.local.set({ [protocol.OPTIONS_KEY]: options });
      graphs.value = options.graphs.join("\n");
      saved.textContent = "Saved only in this browser.";
      await refresh();
    } catch {
      saved.textContent = "Could not save local options.";
    }
  });
  retry.addEventListener("click", async () => {
    try { await chrome.runtime.sendMessage({ type: "retry" }); } catch { /* refresh reports failure. */ }
    await refresh();
  });
  void loadOptions().catch(() => { saved.textContent = "Could not read local options."; });
  void refresh();
  setInterval(refresh, 2000);
})();
