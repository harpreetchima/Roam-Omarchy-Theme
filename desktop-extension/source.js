/* Fixed read-only file source. This classic script is bundled into a private scope. */
(() => {
  "use strict";

  const MAX_BYTES = 65536;
  const ORIGIN = "https://roamresearch.com";
  const DB_NAME = "roam-omarchy-desktop-local-v1";

  function graphName(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 128 &&
      value.trim() === value && !/[\u0000-\u001f\u007f/\\]/.test(value);
  }

  function graphFromUrl(value) {
    try {
      if (typeof value !== "string") return null;
      const url = new URL(value);
      if (url.origin !== ORIGIN) return null;
      const match = url.hash.match(/^#\/(app|offline)\/([^/?#]+)(?=[/?#]|$)/);
      if (!match) return null;
      const name = decodeURIComponent(match[2]);
      return graphName(name) ? `${match[1] === "app" ? "hosted" : "offline"}:${name}` : null;
    } catch {
      return null;
    }
  }

  function defaultOptions() {
    return { enabled: true, graphs: ["hosted:Sylva"] };
  }

  function validateOptions(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== 2 || !Object.hasOwn(value, "enabled") ||
        !Object.hasOwn(value, "graphs") || typeof value.enabled !== "boolean" ||
        !Array.isArray(value.graphs) || value.graphs.length > 100) return null;
    if (value.graphs.some((graph) => {
      if (graph === "*") return false;
      if (typeof graph !== "string") return true;
      const match = graph.match(/^(?:hosted|offline):(.+)$/);
      return !match || !graphName(match[1]);
    })) return null;
    return { enabled: value.enabled, graphs: [...new Set(value.graphs)] };
  }

  function allowed(options, graph) {
    return graph !== null && (options.graphs.includes(graph) || options.graphs.includes("*"));
  }

  function validHandle(handle) {
    return handle?.kind === "directory" && handle.name === "current" &&
      ["getDirectoryHandle", "queryPermission", "requestPermission"].every((key) => typeof handle[key] === "function");
  }

  function parsePalette(text, protocol) {
    if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > MAX_BYTES) {
      throw new Error("Palette exceeds the 64 KiB limit.");
    }
    const message = JSON.parse(text);
    const colors = message?.palette?.colors;
    if (colors && typeof colors === "object" && !Array.isArray(colors)) {
      for (const key of protocol.COLOR_KEYS) {
        if (key !== "background" && key !== "foreground" && Object.hasOwn(colors, key) &&
            (colors[key] === "" || colors[key] === `{{ ${key} }}`)) delete colors[key];
      }
    }
    const validated = protocol.validateNativeMessage(message);
    if (validated?.type !== "palette") throw new Error("Invalid palette file.");
    return validated.palette;
  }

  async function readPalette(handle, protocol) {
    // Do not cache the theme child: Omarchy replaces this directory on activation.
    const theme = await handle.getDirectoryHandle("theme", { create: false });
    const entry = await theme.getFileHandle("roam-omarchy-palette.json", { create: false });
    const file = await entry.getFile();
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BYTES) {
      throw new Error("Palette exceeds the 64 KiB limit.");
    }
    return parsePalette(await file.text(), protocol);
  }

  globalThis.RoamOmarchyDesktopSource = Object.freeze({
    DB_NAME, ORIGIN, MAX_BYTES, graphFromUrl, defaultOptions, validateOptions,
    allowed, validHandle, parsePalette, readPalette,
  });
})();
