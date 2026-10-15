#!/usr/bin/python3
"""Read-only Chrome native host for the local Omarchy palette."""

import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import struct
import subprocess
import sys
import threading
import time


HOST_NAME = "com.harpreetchima.roam_omarchy_theme"
MAX_MESSAGE_BYTES = 64 * 1024
POLL_SECONDS = 1.0
RESOLVER_TIMEOUT = 3.0
COLOR_KEYS = frozenset(
    "background foreground accent muted selection_background selection_foreground "
    "dark_background darker_background lighter_background dark_foreground "
    "light_foreground bright_foreground red orange yellow green cyan blue magenta "
    "brown bright_red bright_yellow bright_green bright_cyan bright_blue "
    "bright_magenta".split()
)
HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}\Z")
EXTENSION_ID = re.compile(r"[a-p]{32}\Z")
UNAVAILABLE = {"version": 1, "type": "status", "status": "unavailable"}


class ProtocolError(ValueError):
    pass


class PaletteUnavailable(ValueError):
    pass


class Cancelled(Exception):
    pass


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolError("Duplicate JSON field")
        result[key] = value
    return result


def reject_constant(_value):
    raise ProtocolError("Non-finite JSON value")


def decode_json(data):
    try:
        return json.loads(
            data.decode("utf-8"),
            object_pairs_hook=unique_object,
            parse_constant=reject_constant,
        )
    except (UnicodeError, ValueError, RecursionError) as error:
        raise ProtocolError("Invalid JSON") from error


def validate_request(message):
    if (
        not isinstance(message, dict)
        or set(message) != {"version", "type"}
        or type(message["version"]) is not int
        or message["version"] != 1
        or message["type"] != "subscribe"
    ):
        raise ProtocolError("Unsupported request")


class FrameDecoder:
    """Incremental, bounded decoder; EOF in any partial frame is an error."""

    def __init__(self):
        self.header = bytearray()
        self.body = bytearray()
        self.expected = None

    def feed(self, data):
        messages = []
        position = 0
        while position < len(data):
            if self.expected is None:
                count = min(4 - len(self.header), len(data) - position)
                self.header.extend(data[position:position + count])
                position += count
                if len(self.header) != 4:
                    continue
                self.expected = struct.unpack("=I", self.header)[0]
                self.header.clear()
                if not 0 < self.expected <= MAX_MESSAGE_BYTES:
                    raise ProtocolError("Invalid message length")
            count = min(self.expected - len(self.body), len(data) - position)
            self.body.extend(data[position:position + count])
            position += count
            if len(self.body) == self.expected:
                message = decode_json(self.body)
                validate_request(message)
                messages.append(message)
                self.body.clear()
                self.expected = None
        return messages

    def finish(self):
        if self.header or self.expected is not None:
            raise ProtocolError("Incomplete message")


def write_message(stream, message, stop=None):
    body = json.dumps(message, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if not 0 < len(body) <= MAX_MESSAGE_BYTES:
        raise ProtocolError("Invalid outgoing message length")
    frame = memoryview(struct.pack("=I", len(body)) + body)
    descriptor = None
    if stop is not None:
        try:
            descriptor = stream.fileno()
        except (AttributeError, OSError):
            pass  # In-memory output used by tests.
    if descriptor is not None:
        # A browser that stops reading must not prevent exit on its input EOF.
        blocking = os.get_blocking(descriptor)
        os.set_blocking(descriptor, False)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(descriptor, selectors.EVENT_WRITE)
                while frame:
                    if stop.is_set():
                        raise Cancelled()
                    if not selector.select(0.05):
                        continue
                    try:
                        written = os.write(descriptor, frame)
                    except BlockingIOError:
                        continue
                    if written <= 0:
                        raise BrokenPipeError("Native output closed")
                    frame = frame[written:]
        finally:
            os.set_blocking(descriptor, blocking)
        return
    while frame:
        written = stream.write(frame)
        if written is None or written <= 0:
            raise BrokenPipeError("Native output closed")
        frame = frame[written:]
    stream.flush()


def parse_palette(output):
    if len(output) > MAX_MESSAGE_BYTES:
        raise PaletteUnavailable("Resolver output too large")
    try:
        text = output.decode("utf-8")
    except UnicodeError as error:
        raise PaletteUnavailable("Invalid resolver encoding") from error
    colors = {}
    mode = None
    for line in text.splitlines():
        if not line:
            continue
        key, separator, value = line.partition("\t")
        if not separator:
            raise PaletteUnavailable("Invalid resolver line")
        if key == "mode":
            if mode is not None or value not in {"light", "dark"}:
                raise PaletteUnavailable("Invalid mode")
            mode = value
        elif key in COLOR_KEYS:
            if key in colors or HEX_COLOR.fullmatch(value) is None:
                raise PaletteUnavailable("Invalid color")
            colors[key] = value.lower()
        # Omarchy also emits aliases and theme-defined fields. Never forward them.
    if mode is None or not {"background", "foreground"} <= colors.keys():
        raise PaletteUnavailable("Incomplete palette")
    return {"mode": mode, "colors": colors}


def file_fingerprint(path, maximum):
    """Read only small regular files, without hanging on a replaced FIFO."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
            raise PaletteUnavailable("Not a small palette file")
        data = bytearray()
        while len(data) <= maximum:
            chunk = os.read(descriptor, min(8192, maximum + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        after = os.fstat(descriptor)
        if len(data) > maximum or file_identity(before) != file_identity(after):
            raise PaletteUnavailable("Palette file changed during observation")
        return file_identity(after), hashlib.sha256(data).digest()
    finally:
        os.close(descriptor)


def file_identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def directory_identity(path):
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode):
        raise PaletteUnavailable("Missing theme directory")
    return info.st_dev, info.st_ino


def palette_fingerprint(current):
    """Reopen the stable current path each time; theme is removed on a switch."""
    theme = current / "theme"
    before = directory_identity(current), directory_identity(theme)
    colors = file_fingerprint(theme / "colors.toml", MAX_MESSAGE_BYTES)
    try:
        light = file_fingerprint(theme / "light.mode", 4096)
    except FileNotFoundError:
        light = None
    after = directory_identity(current), directory_identity(theme)
    if before != after:
        raise PaletteUnavailable("Theme directory changed during observation")
    return before, colors, light


def stop_process(process):
    # Helpers may still hold stdout open after the dispatcher itself has exited.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def run_resolver(command, stop, timeout=RESOLVER_TIMEOUT):
    """Fixed argv, bounded output/runtime, and prompt browser-EOF cancellation."""
    if stop.is_set():
        raise Cancelled()
    with subprocess.Popen(
        [str(command), "theme", "color", "--all"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    ) as process:
        try:
            output = bytearray()
            deadline = time.monotonic() + timeout
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                pipe_open = True
                while True:
                    if stop.is_set():
                        raise Cancelled()
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise PaletteUnavailable("Resolver timeout")
                    delay = min(0.05, remaining)
                    if pipe_open:
                        if selector.select(delay):
                            chunk = os.read(process.stdout.fileno(), 4096)
                            if chunk:
                                output.extend(chunk)
                                if len(output) > MAX_MESSAGE_BYTES:
                                    raise PaletteUnavailable("Resolver output too large")
                            else:
                                selector.unregister(process.stdout)
                                pipe_open = False
                    else:
                        stop.wait(delay)
                    if not pipe_open and process.poll() is not None:
                        if process.returncode != 0:
                            raise PaletteUnavailable("Resolver failed")
                        return bytes(output)
        finally:
            stop_process(process)


class PaletteWatcher:
    def __init__(self, current, resolver, fingerprint=palette_fingerprint):
        self.current = current
        self.resolver = resolver
        self.fingerprint = fingerprint
        self.last_fingerprint = None
        self.last_palette = None
        self.available = None

    def poll(self, stop):
        try:
            before = self.fingerprint(self.current)
            if self.available and before == self.last_fingerprint:
                return None
            palette = parse_palette(self.resolver(stop))
            after = self.fingerprint(self.current)
            if before != after:
                raise PaletteUnavailable("Theme changed during resolution")
        except (OSError, PaletteUnavailable, subprocess.SubprocessError):
            if self.available is False:
                return None
            self.available = False
            return dict(UNAVAILABLE)
        recovered = self.available is not True
        changed = self.last_palette != palette
        self.last_fingerprint = after
        self.last_palette = palette
        self.available = True
        if recovered or changed:
            return {"version": 1, "type": "palette", "palette": palette}
        return None


def serve(input_stream, output_stream, watcher, poll_seconds=POLL_SECONDS):
    stop = threading.Event()
    subscribed = threading.Event()
    invalid = threading.Event()

    def read_input():
        decoder = FrameDecoder()
        try:
            while not stop.is_set():
                chunk = os.read(input_stream.fileno(), 4096)
                if not chunk:
                    decoder.finish()
                    return
                if decoder.feed(chunk):
                    subscribed.set()
        except (OSError, ProtocolError):
            invalid.set()
        finally:
            stop.set()
            subscribed.set()

    reader = threading.Thread(target=read_input, daemon=True)
    reader.start()
    subscribed.wait()
    try:
        while not stop.is_set():
            message = watcher.poll(stop)
            if message is not None and not stop.is_set():
                write_message(output_stream, message, stop)
            stop.wait(poll_seconds)
    except Cancelled:
        pass
    except (BrokenPipeError, OSError):
        stop.set()
    if invalid.is_set():
        print("roam-omarchy: invalid native request", file=sys.stderr)
        return 1
    return 0


def load_config(path):
    with path.open("rb") as stream:
        raw = stream.read(16 * 1024 + 1)
    if len(raw) > 16 * 1024:
        raise ProtocolError("Config too large")
    config = decode_json(raw)
    if (
        not isinstance(config, dict)
        or set(config) != {"version", "extension_id", "omarchy"}
        or type(config["version"]) is not int
        or config["version"] != 1
        or not isinstance(config["extension_id"], str)
        or EXTENSION_ID.fullmatch(config["extension_id"]) is None
        or not isinstance(config["omarchy"], str)
        or not Path(config["omarchy"]).is_absolute()
        or not Path(config["omarchy"]).is_file()
        or not os.access(config["omarchy"], os.X_OK)
    ):
        raise ProtocolError("Invalid installed config")
    return config


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        config = load_config(Path(__file__).resolve().with_name("config.json"))
        if argv != [f"chrome-extension://{config['extension_id']}/"]:
            raise ProtocolError("Unauthorized origin")
    except (OSError, ProtocolError, ValueError):
        print("roam-omarchy: invalid installation or origin", file=sys.stderr)
        return 1
    current = Path.home() / ".local/state/omarchy/current"
    watcher = PaletteWatcher(
        current, lambda stop: run_resolver(config["omarchy"], stop)
    )
    return serve(sys.stdin.buffer, sys.stdout.buffer, watcher)


if __name__ == "__main__":
    sys.exit(main())
