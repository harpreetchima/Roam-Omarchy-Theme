/**
 * Build-time conversion of the pinned, LOCAL Blueprint source, never page CSS.
 * The small parser preserves comments, selectors, declaration order, whitespace,
 * non-color values, and every replaced color's exact original spelling.
 * See design.md for the reviewed role inventory and intentional exclusions.
 */
import { createHash } from "node:crypto";
import { supportedHashes } from "./upstream.mjs";

const ACTIVE = 'html[data-omarchy-active="true"]';
const OS_GATE = `:where(:not(${ACTIVE}, ${ACTIVE} *))`;
const DARK_MEDIA = "@media (prefers-color-scheme: dark)";
const canonical = (value) => value.toLowerCase().replace(/\s+/g, "");

// Enumerated Blueprint colors, NOT theme-name presets or nearest-color guesses.
const families = new Map();
function family(role, literals) {
  for (const literal of literals) families.set(canonical(literal), role);
}
family("accent", [
  "hsl(203, 82%, 41%)", "#106ba3", "#0e5a8a", "#137cbd", "#2b95d6",
  "#48aff0", "#47aff0", "#0e5b8b", "rgba(7.38%, 48.8446666667%, 74.62%, 1)",
]);
family("red", ["red", "#a82a2a", "#c23030", "rgb(219, 57, 57)", "#ff7373", "rgb(245, 86, 86)"]);
family("orange", ["#a66321", "#bf7326", "hsl(30, 70%, 51%)", "#ffb366", "#d13913", "#c99765"]);
family("green", ["#0a6640", "#0d8050", "hsl(155, 82%, 33%)", "#15b371", "#3dcc91", "#238c2c"]);
family("yellow", ["#d99e0b", "#ffc940", "rgb(166, 121, 8)", "#728c23", "#87a629"]);
family("blue", ["#2965cc", "#4580e6", "#669eff"]);
family("cyan", ["#00b3a4", "#2ee6d6", "#14ccbd"]);
family("magenta", ["#db2c6f", "#8f398f", "#c274c2", "#f5498b"]);
family("brown", ["#96622d", "#b07b46"]);

const neutrals = new Set([
  "#ffffff", "#fff", "white", "black", "grey", "gray", "#10161a", "#182026",
  "#202b33", "#293742", "#30404d", "#394b59", "#5c7080", "#738694",
  "#8a9ba8", "#a7b6c2", "#bfccd6", "#ced9e0", "#d8e1e8", "#e1e8ed",
  "#ebf1f5", "#f5f8fa", "#d4d8de", "#ececec", "#696969", "#a8c2ce",
  "rgb(245,248,250)", "rgb(206,217,224)", "rgb(213,218,223)",
]);
const secondary = new Set(["#5c7080", "#738694", "#8a9ba8", "#a7b6c2", "#bfccd6", "#ced9e0", "#696969", "grey", "gray"]);

const pluginRoles = {
  "--zr-accent-1": "accent-ink", "--zr-accent-2": "orange-ink",
  "--zr-negative-co": "red-ink", "--zr-positive-co": "green-ink",
  "--zr-auxiliary": "text-secondary", "--zr-border-co": "border",
  "--zr-box-bg": "surface", "--zr-dialog-bg": "surface-raised",
  "--zr-box-shadow-co": "shadow", "--zr-minimal-bg": "hover",
  "--zr-negative-bg": "red-tint", "--zr-positive-bg": "green-tint",
  "--zr-secondary-co": "text-secondary",
};
const diagramRoles = {
  "--group-area-fill-color": "diagram-group", "--block-fill-color": "surface",
  "--block-text-color": "text", "--block-border-color": "border-strong",
  "--group-title-text-color": "text", "--group-border-color": "border-strong",
  "--global-edge-stroke-color": "text-secondary",
};
const graphRoles = {
  "--graph-overview-label-color": "text",
  "--graph-overview-default-node-color": "graph-node",
  "--graph-overview-selected-node-color": "role-accent",
  "--graph-overview-selected-neighbors-node-color": "graph-neighbor",
  "--graph-overview-unselected-node-color": "graph-muted-node",
  "--graph-overview-explore-node-color": "role-accent",
  "--graph-overview-default-edge-color": "graph-edge",
  "--graph-overview-selected-edge-color": "role-accent",
  "--graph-overview-unselected-edge-color": "graph-muted-edge",
};

// Commas/semicolons in quoted selectors and nested functions are not delimiters.
function delimiter(text, start, sought) {
  let quote = null;
  let parentheses = 0;
  let brackets = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Error("Unterminated CSS comment");
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") parentheses++;
    else if (c === ")") parentheses--;
    else if (c === "[") brackets++;
    else if (c === "]") brackets--;
    else if (!parentheses && !brackets && sought.includes(c)) return i;
  }
  return text.length;
}

function split(text, separator) {
  const parts = [];
  for (let start = 0; start < text.length;) {
    const end = delimiter(text, start, separator);
    parts.push(text.slice(start, end));
    start = end + 1;
  }
  return parts;
}

export function parseStylesheet(text) {
  const nodes = [];
  let start = 0;
  while (start < text.length) {
    const end = delimiter(text, start, "{;");
    if (end === text.length || text[end] === ";") {
      const stop = Math.min(end + 1, text.length);
      nodes.push({ raw: text.slice(start, stop) });
      start = stop;
      continue;
    }
    const leading = text.slice(start, end);
    const match = leading.match(/^((?:\s|\/\*[\s\S]*?\*\/)*)([\s\S]*?)(\s*)$/);
    const [, before, prelude, after] = match;
    let close = end + 1;
    let depth = 1;
    while (depth) {
      close = delimiter(text, close, "{}");
      if (close === text.length) throw new Error(`Unclosed CSS rule: ${prelude}`);
      depth += text[close] === "{" ? 1 : -1;
      if (depth) close++;
    }
    const body = text.slice(end + 1, close);
    const node = { before, prelude, after, body };
    if (prelude.startsWith("@")) {
      if (!prelude.startsWith("@media ")) throw new Error(`Unreviewed CSS at-rule: ${prelude}`);
      node.children = parseStylesheet(body);
    } else if (delimiter(body, 0, "{}") !== body.length) {
      throw new Error(`Unreviewed nested CSS rule: ${prelude}`);
    }
    nodes.push(node);
    start = close + 1;
  }
  return nodes;
}

function declarations(body) {
  return split(body, ";").filter((part) => part.replace(/\/\*[\s\S]*?\*\//g, "").trim()).map((part) => {
    const match = part.match(/^((?:\s|\/\*[\s\S]*?\*\/)*)([\w-]+)(\s*:\s*)([\s\S]*?)\s*$/);
    if (!match) throw new Error(`Unreviewed CSS declaration: ${part}`);
    return { property: match[2], value: match[4] };
  });
}

function colorTokens(value) {
  const tokens = [];
  const re = /(?:\b(?:rgba?|hsla?)\(|#[\da-f]{3,8}\b|\b(?:black|white|red|grey|gray)\b)/gi;
  let match;
  while ((match = re.exec(value))) {
    const start = match.index;
    let end = re.lastIndex;
    if (match[0].endsWith("(")) {
      let depth = 1;
      while (end < value.length && depth) {
        if (value[end] === "(") depth++;
        if (value[end] === ")") depth--;
        end++;
      }
      if (depth) throw new Error(`Unclosed color function: ${value}`);
      re.lastIndex = end;
    }
    tokens.push({ start, end, literal: value.slice(start, end) });
  }
  return tokens;
}

// RGBA shades are explicitly the same reviewed families as their opaque peers.
// Keep alpha in the original fallback; active-state roles control usable opacity.
function colorFamily(literal) {
  const key = canonical(literal);
  if (families.has(key)) return families.get(key);
  if (neutrals.has(key)) return "neutral";
  const rgba = key.match(/^rgba\((.*),([^,]+)\)$/);
  const hsla = key.match(/^hsla\((.*),([^,]+)\)$/);
  if (rgba) {
    const base = rgba[1];
    if (["16,22,26", "24,32,38", "255,255,255", "92,112,128", "167,182,194", "138,155,168", "115,134,148", "191,204,214", "206,217,224", "57,75,89", "#e1e8ed"].includes(base)) return "neutral";
    if (["7.38%,48.8446666667%,74.62%", "16,107,163", "72,175,240", "19,124,189", "14,90,138", "125,188,255"].includes(base)) return "accent";
    if (["219,57,57", "194,48,48", "255,115,115"].includes(base)) return "red";
    if (["85.3%,51%,16.7%", "191,115,38", "255,179,102"].includes(base)) return "orange";
    if (["5.94%,60.06%,37.51%", "13,128,80", "61,204,145"].includes(base)) return "green";
    if (base === "255,201,64") return "yellow";
  }
  if (hsla && hsla[1] === "0,0%,100%") return "neutral";
  return null;
}

function alpha(literal) {
  const match = canonical(literal).match(/^(?:rgba|hsla)\(.*,(\.?\d+(?:\.\d+)?%?)\)$/);
  if (!match) return 1;
  return match[1].endsWith("%") ? parseFloat(match[1]) / 100 : Number(match[1]);
}

// Selector-context exceptions come BEFORE neutral color lookup. White can be an
// input surface, ordinary dark-mode text, or inverse text on a colored button.
function roleFor(property, literal, selector, value, offset) {
  if (pluginRoles[property]) return pluginRoles[property];
  if (diagramRoles[property]) return diagramRoles[property];
  if (graphRoles[property]) return graphRoles[property];
  const kind = colorFamily(literal);
  if (!kind) throw new Error(`Unreviewed color ${literal} in ${selector} { ${property}: ${value} }`);
  const opacity = alpha(literal);
  if (opacity === 0) return null; // Intentional invisible shadow/gradient endpoint.
  const foreground = property === "color" || property === "fill" || property === "stroke";
  const border = property.startsWith("border") || property.startsWith("outline");
  const background = property.startsWith("background");
  const disabled = /:disabled|\.bp3-disabled|aria-disabled=true/.test(selector.replace(/:not\([^)]*\)/g, ""));
  const intent = selector.match(/bp3-intent-(primary|danger|success|warning)/)?.[1];
  const intentFamily = { primary: "accent", danger: "red", success: "green", warning: "orange" }[intent];
  const inverse = /rm-command-palette__shortcut|bp3-tooltip|rm-hotkeys-hotkey__part|bp3-slider-label|\.bp3-tag\b/.test(selector) && !/roamjs-workbench-livepreview/.test(selector);
  const solidIntent = intentFamily && /\.bp3-button|\.bp3-tag|\.bp3-menu-item|\.bp3-toast/.test(selector)
    && !/bp3-minimal|bp3-outlined|rm-install-menu-item/.test(selector)
    && (/\.bp3-button|\.bp3-tag|\.bp3-toast/.test(selector) || /\.bp3-active/.test(selector));
  const selectedDate = /DayPicker-Day--selected/.test(selector);
  const checkedControl = /:checked.*~ \.bp3-control-indicator\s*$|:checked.*~ \.checkmark\s*$/.test(selector);
  const pill = /\.rm-clickable-pill\b/.test(selector);
  const warningButton = /(?:rm-roam-css|rm-code-warning)--(in)?active.*\.bp3-button/.test(selector);
  const fillState = /:active|\.bp3-active/.test(selector) ? "-active" : /:hover/.test(selector) ? "-hover" : "";
  if (selector.includes("::selection") || selector.includes("cm-selectionBackground")) return "selection-bg";
  if (selector.includes(".rm-highlight") && !selector.includes(".css-a759x7")) return foreground ? "text" : "yellow-tint";
  if (selector.includes("block-highlight-blue") && background && !selector.includes("rm-bullet__inner")) return "selection-bg";
  if (solidIntent && (foreground || background) && property !== "background-image") return foreground ? "page" : `${intentFamily}-fill${fillState}`;
  if (inverse && property === "fill" && /arrow-border/.test(selector)) return "border";
  if (inverse && property === "fill" && /arrow-fill/.test(selector)) return "text";
  if (inverse && (foreground || background)) return foreground ? "page" : "text";
  if (/\.bp3-toast\[class\*=bp3-intent-\]/.test(selector) && foreground) return "page";
  if (/\.bp3-toast\[class\*=bp3-intent-\]/.test(selector) && background && property !== "background-image") return "on-fill-overlay";
  if (pill && (foreground || background)) return foreground ? "page" : "accent-fill";
  if (checkedControl && (foreground || background) && property !== "background-image") return foreground ? "page" : `accent-fill${fillState}`;
  if (/\.bp3-radio.*:checked.*::before/.test(selector) && property === "background-image") return "page";
  if (warningButton && (foreground || background) && property !== "background-image") return foreground ? "page" : `${/--inactive/.test(selector) ? "red" : "orange"}-fill${fillState}`;
  if (selectedDate && (foreground || background)) return foreground ? "page" : `accent-fill${fillState}`;
  if (property === "background-image") return "gradient";
  if (property.includes("shadow")) {
    if (kind !== "neutral") return opacity < 1 ? `${kind}-halo` : `role-${kind}`;
    // Thin zero-blur outlines are borders; blurred elevation keeps a real shadow.
    const before = value.slice(0, offset);
    const segment = split(before, ",").at(-1).trim().replace(/^inset\s+/, "");
    const lengths = segment.match(/-?[\d.]+(?:px)?/g) ?? [];
    return lengths.length >= 3 && parseFloat(lengths[2]) === 0 ? "border" : "shadow";
  }
  if (kind !== "neutral") {
    // Warning controls have an upstream red literal in light mode: the selector,
    // not its accidental color, establishes the warning semantic role.
    let role = intentFamily ?? kind;
    if (/\.cmt-(?:string|string2)\b/.test(selector)) role = "green";
    if (/\.cmt-propertyName\b/.test(selector)) role = "yellow";
    if (foreground) return disabled ? "text-disabled" : `${role}-ink`;
    if (border) return `role-${role}`;
    return opacity < 1 ? `${role}-tint` : `role-${role}`;
  }
  if (border) {
    if (/rm-bullet__inner/.test(selector)) return "page";
    return /:hover|:focus/.test(selector) ? "border-strong" : "border";
  }
  if (property === "fill" && /popover.*arrow-fill/.test(selector)) return "surface-raised";
  if (property === "fill" && /popover.*arrow-border/.test(selector)) return "border";
  if (foreground) {
    if (disabled) return "text-disabled";
    if (opacity < 1 || secondary.has(canonical(literal)) || selector.includes("::placeholder")) return "text-secondary";
    return "text";
  }
  if (background) {
    if (/rm-bullet|simple-bullet|rm-dnd-drop-bar|scrollbar-thumb/.test(selector)) return "text-secondary";
    if (disabled) return "disabled-surface";
    if (/:active|\.bp3-active|--active/.test(selector)) return "active-surface";
    if (/:hover|:focus|popover-open/.test(selector) && !/input|textarea/.test(selector)) return "hover";
    if (/^(?:\.bp3-(?:light|dark) )?(?:body|html)(?:\s*,|$)/.test(selector)
      || /roam-body-main|\.rm-topbar\s*$|#rm-canvas-container|\.rm-diagram\s*$/.test(selector)) return "page";
    if (/input|textarea|\bpre\b|\bcode\b|rm-code-block|cm-textfield/.test(selector)) return "inset";
    if (["#202b33", "rgb(245,248,250)", "#f5f8fa"].includes(canonical(literal))) return "page";
    if (["#10161a", "#182026"].includes(canonical(literal))) return "inset";
    if (opacity < 1) return "hover";
    return ["#ffffff", "#fff", "white", "#30404d"].includes(canonical(literal)) ? "surface-raised" : "surface";
  }
  throw new Error(`Unreviewed color property ${property} in ${selector}`);
}

function gateSelector(selector) {
  // Attach to the subject BEFORE its pseudo-element; :where has zero specificity.
  let position = selector.length;
  let quote = null;
  let brackets = 0;
  let parentheses = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[") brackets++;
    else if (c === "]") brackets--;
    else if (c === "(") parentheses++;
    else if (c === ")") parentheses--;
    else if (!brackets && !parentheses && (selector.startsWith("::", i) || /^:(before|after)(?![\w-])/.test(selector.slice(i)))) { position = i; break; }
  }
  return `${selector.slice(0, position).trimEnd()}${OS_GATE}${selector.slice(position)}`;
}

function tokenizedBody(node, report) {
  // User-authored highlighter spans and embedded HTML documents retain their
  // intentional content colors. Selectors with literal style fingerprints stay
  // byte-for-byte unchanged; only declaration VALUES are eligible for mapping.
  const intentional = /span\[style\*?="background-color: yellow;"\]|roamjs-workbench-html-view iframe/.test(node.prelude);
  let position = 0;
  let result = "";
  while (position < node.body.length) {
    const end = delimiter(node.body, position, ";");
    const declaration = node.body.slice(position, end);
    const match = declaration.match(/^((?:\s|\/\*[\s\S]*?\*\/)*)([\w-]+)(\s*:\s*)([\s\S]*?)(\s*)$/);
    if (!match) {
      if (declaration.replace(/\/\*[\s\S]*?\*\//g, "").trim()) throw new Error(`Unreviewed declaration: ${declaration}`);
      result += declaration;
    } else {
      const [, leading, property, colon, value, trailing] = match;
      let converted = value;
      const tokens = colorTokens(value);
      if (intentional) report.preserved += tokens.length;
      else if (property === "filter" && value.includes("invert(")) {
        converted = `var(--omarchy-content-filter, ${value})`;
        report.filters++;
      } else {
        for (const token of tokens.toReversed()) {
          const role = roleFor(property, token.literal, node.prelude, value, token.start);
          if (!role) { report.transparent++; continue; }
          const replacement = `var(--omarchy-${role}, ${token.literal})`;
          converted = converted.slice(0, token.start) + replacement + converted.slice(token.end);
          report.replacements++;
          report.roles[role] = (report.roles[role] ?? 0) + 1;
        }
      }
      result += leading + property + colon + converted + trailing;
    }
    if (end < node.body.length) result += ";";
    position = end + 1;
  }
  return result;
}

function normalizeDark(selector) {
  return split(selector, ",").map((part) => part.trim().replace(/^html:not\(\.bp3-light\)\s*/, "").replace(/^\.bp3-dark\s*/, "")).join(", ");
}

export function tokenizeBlueprint(source) {
  const hash = createHash("sha256").update(source).digest("hex");
  if (hash !== supportedHashes[0]) throw new Error("Blueprint source changed: review the color-role inventory and upstream hashes before packaging.");
  const nodes = parseStylesheet(source);
  const explicitDark = nodes.filter((node) => node.prelude?.startsWith(".bp3-dark "));
  const report = { replacements: 0, preserved: 0, transparent: 0, filters: 0, darkMedia: 0, addedDarkRules: 0, roles: {} };
  const explicit = new Set(explicitDark.map((node) => JSON.stringify([normalizeDark(node.prelude), declarations(node.body)])));
  function emit(list, osDark = false) {
    return list.map((node) => {
      if (node.raw !== undefined) return node.raw;
      if (node.children) {
        const dark = node.prelude === DARK_MEDIA;
        if (dark) {
          report.darkMedia++;
          for (const child of node.children) {
            if (!child.prelude) continue;
            const key = JSON.stringify([normalizeDark(child.prelude), declarations(child.body)]);
            if (!explicit.has(key)) {
              throw new Error(`OS-dark rule needs a reviewed explicit dark counterpart: ${child.prelude}`);
            }
          }
        }
        const children = emit(node.children, osDark || dark);
        return `${node.before}${node.prelude}${node.after}{${children}}`;
      }
      const selector = osDark ? split(node.prelude, ",").map((part) => gateSelector(part.trim())).join(", ") : node.prelude;
      return `${node.before}${selector}${node.after}{${tokenizedBody(node, report)}}`;
    }).join("");
  }
  const css = emit(nodes);
  if (report.darkMedia !== 620) throw new Error(`Expected 620 reviewed OS-dark branches, found ${report.darkMedia}`);
  return { css, report };
}
