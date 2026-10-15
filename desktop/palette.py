"""Bounded desktop palette parsing; Omarchy alone resolves aliases and shades."""

import json

from native.host import (
    COLOR_KEYS,
    HEX_COLOR,
    MAX_MESSAGE_BYTES,
    PaletteUnavailable,
    decode_json,
    parse_palette,
)


REQUIRED_COLORS = frozenset({"background", "foreground"})


def validate_message(message, template=False):
    """Mirror the strict v1 palette envelope, with narrowly optional omissions."""
    if (
        not isinstance(message, dict)
        or set(message) != {"version", "type", "palette"}
        or type(message["version"]) is not int
        or message["version"] != 1
        or message["type"] != "palette"
    ):
        raise PaletteUnavailable("Invalid palette envelope")
    palette = message["palette"]
    if (
        not isinstance(palette, dict)
        or set(palette) != {"mode", "colors"}
        or not isinstance(palette["mode"], str)
        or palette["mode"] not in {"light", "dark"}
        or not isinstance(palette["colors"], dict)
        or not REQUIRED_COLORS <= palette["colors"].keys()
        or not palette["colors"].keys() <= COLOR_KEYS
    ):
        raise PaletteUnavailable("Invalid palette")
    colors = {}
    for key, value in palette["colors"].items():
        if template and key not in REQUIRED_COLORS and isinstance(value, str):
            if value in {"", "{{ " + key + " }}"}:
                continue
        if not isinstance(value, str) or HEX_COLOR.fullmatch(value) is None:
            raise PaletteUnavailable("Invalid palette color")
        colors[key] = value.lower()
    return {
        "version": 1,
        "type": "palette",
        "palette": {"mode": palette["mode"], "colors": colors},
    }


def read_template(data):
    """Validate renderer output, not arbitrary template expressions or CSS."""
    if not 0 < len(data) <= MAX_MESSAGE_BYTES:
        raise PaletteUnavailable("Invalid palette size")
    return validate_message(decode_json(data), template=True)


def initial_message(output):
    """Omit blank optional resolver fields before the native strict parser."""
    if len(output) > MAX_MESSAGE_BYTES:
        raise PaletteUnavailable("Resolver output too large")
    try:
        text = output.decode("utf-8")
    except UnicodeError as error:
        raise PaletteUnavailable("Invalid resolver encoding") from error
    lines = []
    seen = set()
    for line in text.splitlines():
        if not line:
            continue
        key, separator, value = line.partition("\t")
        if not separator:
            raise PaletteUnavailable("Invalid resolver line")
        if key not in COLOR_KEYS and key != "mode":
            continue  # Legacy aliases and theme-defined fields are not payload keys.
        if key in seen:
            raise PaletteUnavailable("Duplicate resolver field")
        seen.add(key)
        if key in COLOR_KEYS - REQUIRED_COLORS and not value.strip():
            continue
        lines.append(line)
    palette = parse_palette(("\n".join(lines) + "\n").encode("utf-8"))
    return validate_message({"version": 1, "type": "palette", "palette": palette})


def json_bytes(value):
    data = (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")
    if len(data) > MAX_MESSAGE_BYTES:
        raise PaletteUnavailable("JSON output too large")
    return data
