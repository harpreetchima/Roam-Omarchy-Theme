(() => {
  "use strict";

  const statuses = Object.freeze({
    "loading-options": "Loading local options",
    "outside-app": "Outside a desktop graph",
    "not-allowed": "Graph not in scope",
    disabled: "Following off",
    "waiting-folder": "Choose current folder",
    "permission-needed": "Reconnect folder",
    "choosing-folder": "Choosing folder",
    "waiting-blueprint": "Waiting for Blueprint",
    "waiting-palette": "Waiting for a fresh palette",
    unsupported: "Unsupported Blueprint",
    "unsupported-browser": "File access unavailable",
    following: "Following Omarchy",
    stale: "Using last valid palette",
    disconnected: "Stock Blueprint restored",
  });

  function createUI({ css, onChoose, onReconnect, onFollow, onScope, onForget }) {
    const host = document.createElement("aside");
    host.id = "roam-omarchy-desktop-controls";
    host.setAttribute("aria-label", "Local Omarchy palette controls");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style></style>
      <details>
        <summary>Omarchy <span aria-hidden="true">·</span> <span id="summary-status"></span></summary>
        <section aria-label="Omarchy settings on this device">
          <p id="status" role="status" aria-live="polite" aria-atomic="true"></p>
          <label class="follow" for="follow"><input id="follow" name="follow" type="checkbox"> Follow Omarchy on this device</label>
          <p id="graph"></p>
          <p>Read-only source: <code>current/theme/roam-omarchy-palette.json</code>.</p>
          <div class="actions">
            <button id="choose" type="button">Choose current folder</button>
            <button id="reconnect" type="button">Reconnect</button>
          </div>
          <form>
            <label for="scope">Allowed graphs, one per line</label>
            <textarea id="scope" name="scope" rows="3" spellcheck="false" aria-describedby="scope-help scope-error"></textarea>
            <p id="scope-help">Use <code>hosted:Sylva</code>, <code>offline:Name</code>, or explicitly <code>*</code> for all graphs. Empty means none.</p>
            <p id="scope-error" role="alert" hidden></p>
            <button class="primary" type="submit">Save graph scope</button>
          </form>
          <p id="notice" hidden></p>
          <p id="storage" role="status" hidden></p>
          <button id="forget" type="button">Stop and forget folder</button>
          <p>Local-folder developer extensions need a manual reload after app startup. Folder permission is separate.</p>
        </section>
      </details>`;
    shadow.querySelector("style").textContent = css;
    (document.body || document.documentElement).append(host);

    const find = (id) => shadow.getElementById(id);
    const listeners = [];
    function listen(node, event, callback) {
      node.addEventListener(event, callback);
      listeners.push(() => node.removeEventListener(event, callback));
    }
    listen(find("choose"), "click", onChoose);
    listen(find("reconnect"), "click", onReconnect);
    listen(find("forget"), "click", onForget);
    listen(find("follow"), "change", () => onFollow(find("follow").checked));
    listen(shadow.querySelector("form"), "submit", (event) => {
      event.preventDefault();
      onScope(find("scope").value);
    });

    let renderedGraphs = null;
    let disposed = false;
    function text(id, value) {
      const node = find(id);
      if (node.textContent !== value) node.textContent = value;
    }
    function note(id, value) {
      text(id, value || "");
      find(id).hidden = !value;
    }
    return {
      render(state) {
        if (disposed) return;
        const status = statuses[state.status] || "Checking Blueprint";
        text("summary-status", status);
        text("status", `${status}.`);
        text("graph", state.graph ? `Current graph: ${state.graph}.` : "No hosted or offline graph route.");
        find("follow").checked = state.options.enabled;
        find("follow").disabled = !state.loaded;
        find("choose").disabled = !state.loaded || !state.canChoose || state.busy;
        find("reconnect").disabled = !state.loaded || !state.hasHandle || state.busy;
        // Forget remains usable while a chooser or permission request is pending.
        find("forget").disabled = !state.loaded || (!state.hasHandle && !state.busy);
        shadow.querySelector('button[type="submit"]').disabled = !state.loaded;
        find("scope").disabled = !state.loaded;
        const graphs = state.options.graphs.join("\n");
        if (renderedGraphs !== graphs) { find("scope").value = graphs; renderedGraphs = graphs; }
        note("notice", state.notice);
        note("storage", state.storageWarning);
        note("scope-error", state.scopeError);
        find("scope").setAttribute("aria-invalid", state.scopeError ? "true" : "false");
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const remove of listeners) remove();
        host.remove();
      },
    };
  }

  globalThis.RoamOmarchyDesktopUI = Object.freeze({ createUI });
})();
