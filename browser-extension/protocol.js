/* Shared only by this extension's isolated scripts, worker, and popup. */
(() => {
  "use strict";

  const COLOR_KEYS = Object.freeze([
    "background", "foreground", "accent", "muted",
    "selection_background", "selection_foreground",
    "dark_background", "darker_background", "lighter_background",
    "dark_foreground", "light_foreground", "bright_foreground",
    "red", "orange", "yellow", "green", "cyan", "blue", "magenta", "brown",
    "bright_red", "bright_yellow", "bright_green", "bright_cyan", "bright_blue", "bright_magenta",
  ]);
  const colorKeys = new Set(COLOR_KEYS);
  const DOCUMENT_STATUSES = Object.freeze([
    "outside-app", "not-allowed", "disabled", "waiting-blueprint", "waiting-palette",
    "unsupported", "following", "stale", "disconnected",
  ]);
  const NATIVE_STATUSES = Object.freeze(["idle", "connecting", "live", "unavailable"]);

  function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function exactKeys(value, keys) {
    return record(value) && Object.keys(value).length === keys.length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  }

  function validatePalette(value) {
    if (!exactKeys(value, ["mode", "colors"]) ||
        !["dark", "light"].includes(value.mode) || !record(value.colors)) return null;
    const keys = Object.keys(value.colors);
    if (!keys.includes("background") || !keys.includes("foreground") ||
        keys.some((key) => !colorKeys.has(key))) return null;
    const colors = {};
    for (const key of keys) {
      const color = value.colors[key];
      if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) return null;
      colors[key] = color.toLowerCase();
    }
    return { mode: value.mode, colors };
  }

  function validateNativeMessage(value) {
    try {
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536) return null;
    } catch {
      return null;
    }
    if (!record(value) || value.version !== 1) return null;
    if (value.type === "palette" && exactKeys(value, ["version", "type", "palette"])) {
      const palette = validatePalette(value.palette);
      return palette ? { version: 1, type: "palette", palette } : null;
    }
    if (value.type === "status" && value.status === "unavailable" &&
        exactKeys(value, ["version", "type", "status"])) {
      return { version: 1, type: "status", status: "unavailable" };
    }
    return null;
  }

  function defaultOptions() {
    return { enabled: true, graphs: ["Sylva"] };
  }

  function validateOptions(value) {
    if (!exactKeys(value, ["enabled", "graphs"]) || typeof value.enabled !== "boolean" ||
        !Array.isArray(value.graphs) || value.graphs.length > 100) return null;
    if (value.graphs.some((graph) => typeof graph !== "string" || graph.length === 0 ||
        graph.length > 128 || graph.trim() !== graph || /[\u0000-\u001f\u007f/]/.test(graph))) return null;
    return { enabled: value.enabled, graphs: [...new Set(value.graphs)] };
  }

  function isRoamUrl(value) {
    try {
      return typeof value === "string" && new URL(value).origin === "https://roamresearch.com";
    } catch {
      return false;
    }
  }

  function graphFromUrl(value) {
    if (!isRoamUrl(value)) return null;
    const match = new URL(value).hash.match(/^#\/app\/([^/]+)(?:\/|$)/);
    if (!match) return null;
    try {
      const graph = decodeURIComponent(match[1]);
      return validateOptions({ enabled: true, graphs: [graph] }) ? graph : null;
    } catch {
      return null;
    }
  }

  function isAllowed(options, graph) {
    return options.enabled && graph !== null &&
      (options.graphs.includes(graph) || options.graphs.includes("*"));
  }

  function validateSnapshot(value) {
    if (!exactKeys(value, ["palette", "receivedAt"]) ||
        !Number.isSafeInteger(value.receivedAt) || value.receivedAt <= 0 ||
        value.receivedAt > Date.now() + 60000) return null;
    const palette = validatePalette(value.palette);
    return palette ? { palette, receivedAt: value.receivedAt } : null;
  }

  function validateState(value) {
    if (!exactKeys(value, ["type", "options", "palette", "receivedAt", "status", "stale"]) ||
        value.type !== "state" || !NATIVE_STATUSES.includes(value.status) ||
        typeof value.stale !== "boolean") return null;
    const options = validateOptions(value.options);
    const snapshot = value.palette === null && value.receivedAt === null ? null :
      validateSnapshot({ palette: value.palette, receivedAt: value.receivedAt });
    if (!options || (value.palette !== null && !snapshot) ||
        (value.palette === null && value.receivedAt !== null)) return null;
    return { ...value, options, palette: snapshot?.palette ?? null };
  }

  globalThis.RoamOmarchyProtocol = Object.freeze({
    COLOR_KEYS, DOCUMENT_STATUSES, NATIVE_STATUSES,
    OPTIONS_KEY: "options", SNAPSHOT_KEY: "snapshot",
    exactKeys, validatePalette, validateNativeMessage, validateOptions, defaultOptions,
    validateSnapshot, validateState, isRoamUrl, graphFromUrl, isAllowed,
  });
})();
