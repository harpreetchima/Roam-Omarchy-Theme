import contextlib
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native"))
import host


PALETTE = b"mode\tdark\nbackground\t#112233\nforeground\t#DDEEFF\naccent\t#AABBCC\n"
SUBSCRIBE = {"version": 1, "type": "subscribe"}
TEMP_ROOT = "/tmp/opencode" if Path("/tmp/opencode").is_dir() else None


def frame(value):
    data = json.dumps(value).encode("utf-8")
    return struct.pack("=I", len(data)) + data


def messages(data):
    result = []
    while data:
        length = struct.unpack("=I", data[:4])[0]
        result.append(json.loads(data[4:4 + length]))
        data = data[4 + length:]
    return result


class FramingTests(unittest.TestCase):
    def test_partial_headers_bodies_and_multiple_frames(self):
        decoder = host.FrameDecoder()
        result = []
        for byte in frame(SUBSCRIBE) * 2:
            result.extend(decoder.feed(bytes([byte])))
        decoder.finish()
        self.assertEqual(result, [SUBSCRIBE, SUBSCRIBE])

    def test_empty_eof_and_every_incomplete_frame(self):
        host.FrameDecoder().finish()
        data = frame(SUBSCRIBE)
        for length in range(1, len(data)):
            with self.subTest(length=length):
                decoder = host.FrameDecoder()
                decoder.feed(data[:length])
                with self.assertRaises(host.ProtocolError):
                    decoder.finish()

    def test_zero_and_oversized_lengths_rejected_before_body(self):
        for length in (0, host.MAX_MESSAGE_BYTES + 1, 2**32 - 1):
            decoder = host.FrameDecoder()
            with self.assertRaises(host.ProtocolError):
                decoder.feed(struct.pack("=I", length))
            self.assertEqual(len(decoder.body), 0)

    def test_exact_size_boundary_and_invalid_encoding(self):
        body = json.dumps(SUBSCRIBE).encode()
        body += b" " * (host.MAX_MESSAGE_BYTES - len(body))
        decoder = host.FrameDecoder()
        self.assertEqual(decoder.feed(struct.pack("=I", len(body)) + body), [SUBSCRIBE])
        for body in (b"\xff", b"{", b"[NaN]", b'[[[[[[[[[[[[[[[[]'):
            with self.assertRaises(host.ProtocolError):
                host.FrameDecoder().feed(struct.pack("=I", len(body)) + body)

    def test_requests_fail_closed(self):
        invalid = [
            None, [], {}, {"version": 1}, {"version": True, "type": "subscribe"},
            {"version": 1.0, "type": "subscribe"}, {"version": 2, "type": "subscribe"},
            {"version": 1, "type": "theme"},
            {"version": 1, "type": "subscribe", "path": "/etc/passwd"},
            {"version": 1, "type": "subscribe", "command": "touch nope"},
        ]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(host.ProtocolError):
                host.FrameDecoder().feed(frame(value))
        duplicate = b'{"version":1,"type":"subscribe","type":"subscribe"}'
        with self.assertRaises(host.ProtocolError):
            host.FrameDecoder().feed(struct.pack("=I", len(duplicate)) + duplicate)

    def test_outgoing_partial_writes_and_bound(self):
        class PartialOutput(io.BytesIO):
            def write(self, data):
                return super().write(data[:2])

        output = PartialOutput()
        host.write_message(output, host.UNAVAILABLE)
        self.assertEqual(messages(output.getvalue()), [host.UNAVAILABLE])
        output = io.BytesIO()
        with self.assertRaises(host.ProtocolError):
            host.write_message(output, {"oversized": "a" * host.MAX_MESSAGE_BYTES})
        self.assertEqual(output.getvalue(), b"")

    def test_blocked_native_output_can_be_cancelled(self):
        read_fd, write_fd = os.pipe()
        self.addCleanup(os.close, read_fd)
        output = os.fdopen(write_fd, "wb", buffering=0)
        self.addCleanup(output.close)
        os.set_blocking(write_fd, False)
        while True:
            try:
                os.write(write_fd, b"x" * 4096)
            except BlockingIOError:
                break
        os.set_blocking(write_fd, True)
        stop = threading.Event()
        started = threading.Event()
        result = []

        def write():
            started.set()
            try:
                host.write_message(output, host.UNAVAILABLE, stop)
            except host.Cancelled:
                result.append("cancelled")

        writer = threading.Thread(target=write, daemon=True)
        writer.start()
        self.assertTrue(started.wait(timeout=2))
        stop.set()
        writer.join(timeout=2)
        self.assertFalse(writer.is_alive())
        self.assertEqual(result, ["cancelled"])


class PaletteTests(unittest.TestCase):
    def test_known_fields_normalized_unknown_fields_filtered(self):
        palette = host.parse_palette(
            PALETTE + b"bg\t#000000\ncolor0\t#000000\ntheme_name\tprivate-name\n"
            b"arbitrary\turl(https://example.invalid/secret)\n"
        )
        self.assertEqual(palette, {
            "mode": "dark",
            "colors": {"background": "#112233", "foreground": "#ddeeff", "accent": "#aabbcc"},
        })

    def test_invalid_values_missing_fields_and_duplicates_rejected(self):
        invalid = [
            b"", b"mode\tdark\nbackground\t#112233\n", PALETTE.replace(b"dark", b"auto"),
            PALETTE.replace(b"#AABBCC", b"red"), PALETTE.replace(b"#AABBCC", b"#abc"),
            PALETTE.replace(b"#AABBCC", b"#aabbccdd"),
            PALETTE.replace(b"#AABBCC", b"url(javascript:alert(1))"),
            PALETTE.replace(b"#AABBCC", b"#aabbcc; background: red"),
            PALETTE.replace(b"#AABBCC", b""), PALETTE + b"accent\t#123456\n",
            PALETTE + b"mode\tlight\n", PALETTE + b"not-tab-separated\n",
            PALETTE + b"\xff\tvalue\n", b"x" * (host.MAX_MESSAGE_BYTES + 1),
        ]
        for output in invalid:
            with self.subTest(output=output[:100]), self.assertRaises(host.PaletteUnavailable):
                host.parse_palette(output)


class WatcherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="roam-native-", dir=TEMP_ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.current = Path(self.temporary.name) / "current"
        self.theme = self.current / "theme"
        self.theme.mkdir(parents=True)
        self.colors = self.theme / "colors.toml"
        self.colors.write_text('background = "#112233"\nforeground = "#ddeeff"\n')
        self.stop = threading.Event()

    def test_changes_deduplicated_and_same_palette_recovery_clears_status(self):
        resolver = mock.Mock(return_value=PALETTE)
        watcher = host.PaletteWatcher(self.current, resolver)
        expected = {"version": 1, "type": "palette", "palette": host.parse_palette(PALETTE)}
        self.assertEqual(watcher.poll(self.stop), expected)
        self.assertIsNone(watcher.poll(self.stop))
        self.assertEqual(resolver.call_count, 1)
        self.colors.unlink()
        self.assertEqual(watcher.poll(self.stop), host.UNAVAILABLE)
        self.assertIsNone(watcher.poll(self.stop))
        self.colors.write_text('background = "#112233"\nforeground = "#ddeeff"\n')
        self.assertEqual(watcher.poll(self.stop), expected)
        self.assertEqual(resolver.call_count, 2)

    def test_swap_during_resolver_rejected_then_retried(self):
        def resolve(_stop):
            if not (self.current / "old-theme").exists():
                self.theme.rename(self.current / "old-theme")
                self.theme.mkdir()
                self.colors.write_text('background = "#445566"\nforeground = "#ddeeff"\n')
            return PALETTE

        watcher = host.PaletteWatcher(self.current, resolve)
        self.assertEqual(watcher.poll(self.stop), host.UNAVAILABLE)
        self.assertEqual(watcher.poll(self.stop)["type"], "palette")

    def test_light_mode_marker_and_same_size_file_changes_are_observed(self):
        def resolve(_stop):
            return PALETTE.replace(b"dark", b"light") if (self.theme / "light.mode").exists() else PALETTE

        resolver = mock.Mock(side_effect=resolve)
        watcher = host.PaletteWatcher(self.current, resolver)
        self.assertEqual(watcher.poll(self.stop)["palette"]["mode"], "dark")
        (self.theme / "light.mode").write_bytes(b"")
        self.assertEqual(watcher.poll(self.stop)["palette"]["mode"], "light")
        before = self.colors.stat()
        self.colors.write_text(self.colors.read_text().replace("112233", "445566"))
        os.utime(self.colors, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertIsNone(watcher.poll(self.stop))  # Same resolved output, but re-resolved.
        self.assertEqual(resolver.call_count, 3)

    def test_initial_missing_invalid_then_recovery_without_fingerprint_change(self):
        resolver = mock.Mock(side_effect=[b"mode\tdark\n", PALETTE])
        watcher = host.PaletteWatcher(self.current, resolver)
        self.assertEqual(watcher.poll(self.stop), host.UNAVAILABLE)
        self.assertEqual(watcher.poll(self.stop)["type"], "palette")
        self.assertEqual(resolver.call_count, 2)

    def test_replaced_directory_reobserved_even_with_identical_files(self):
        resolver = mock.Mock(return_value=PALETTE)
        watcher = host.PaletteWatcher(self.current, resolver)
        watcher.poll(self.stop)
        self.theme.rename(self.current / "old-theme")
        self.theme.mkdir()
        self.colors.write_bytes((self.current / "old-theme/colors.toml").read_bytes())
        self.assertIsNone(watcher.poll(self.stop))
        self.assertEqual(resolver.call_count, 2)

    def test_large_or_nonregular_palette_files_fail_without_resolving(self):
        resolver = mock.Mock(return_value=PALETTE)
        watcher = host.PaletteWatcher(self.current, resolver)
        self.colors.write_bytes(b"x" * (host.MAX_MESSAGE_BYTES + 1))
        self.assertEqual(watcher.poll(self.stop), host.UNAVAILABLE)
        self.colors.unlink()
        os.mkfifo(self.colors)
        self.assertIsNone(watcher.poll(self.stop))
        resolver.assert_not_called()


class ResolverTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="roam-native-", dir=TEMP_ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.command = Path(self.temporary.name) / "fake omarchy; not a shell"

    def executable(self, body):
        self.command.write_text("#!/usr/bin/python3\n" + body)
        self.command.chmod(0o700)

    def test_fixed_argv_no_shell_and_bounded_output(self):
        self.executable("import sys\nassert sys.argv[1:] == ['theme', 'color', '--all']\n"
                        f"sys.stdout.buffer.write({PALETTE!r})\n")
        self.assertEqual(host.run_resolver(self.command, threading.Event()), PALETTE)
        self.executable(f"print('x' * {host.MAX_MESSAGE_BYTES + 1})\n")
        with self.assertRaises(host.PaletteUnavailable):
            host.run_resolver(self.command, threading.Event())

    def test_timeout_nonzero_and_cancellation(self):
        self.executable("import time\ntime.sleep(30)\n")
        with self.assertRaises(host.PaletteUnavailable):
            host.run_resolver(self.command, threading.Event(), timeout=0.05)
        self.executable("raise SystemExit(1)\n")
        with self.assertRaises(host.PaletteUnavailable):
            host.run_resolver(self.command, threading.Event())
        stop = threading.Event()
        stop.set()
        with mock.patch.object(host.subprocess, "Popen") as popen:
            with self.assertRaises(host.Cancelled):
                host.run_resolver(self.command, stop)
        popen.assert_not_called()

    def test_cancellation_after_process_start(self):
        self.executable("import time\ntime.sleep(30)\n")
        stop = threading.Event()
        original_popen = host.subprocess.Popen

        def started(*args, **kwargs):
            process = original_popen(*args, **kwargs)
            stop.set()
            return process

        with mock.patch.object(host.subprocess, "Popen", side_effect=started):
            with self.assertRaises(host.Cancelled):
                host.run_resolver(self.command, stop)


class ConnectionTests(unittest.TestCase):
    def connection(self, watcher):
        read_fd, self.write_fd = os.pipe()
        self.input = os.fdopen(read_fd, "rb", buffering=0)
        self.addCleanup(self.input.close)
        self.flushed = threading.Event()
        flushed = self.flushed

        class Output(io.BytesIO):
            def flush(self):
                flushed.set()

        self.output = Output()
        self.result = []
        self.thread = threading.Thread(target=lambda: self.result.append(
            host.serve(self.input, self.output, watcher, poll_seconds=0.01)
        ), daemon=True)
        self.thread.start()
        self.addCleanup(lambda: os.close(self.write_fd) if self.write_fd is not None else None)

    def close_input(self):
        os.close(self.write_fd)
        self.write_fd = None
        self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive(), "Host did not stop on browser EOF")

    def test_eof_without_subscription_never_reads_palette(self):
        watcher = mock.Mock()
        self.connection(watcher)
        self.close_input()
        self.assertEqual(self.result, [0])
        watcher.poll.assert_not_called()
        self.assertEqual(self.output.getvalue(), b"")

    def test_unavailable_host_still_stops_on_eof(self):
        watcher = mock.Mock()
        watcher.poll.side_effect = [dict(host.UNAVAILABLE)] + [None] * 1000
        self.connection(watcher)
        os.write(self.write_fd, frame(SUBSCRIBE))
        self.assertTrue(self.flushed.wait(timeout=2))
        self.close_input()
        self.assertEqual(self.result, [0])
        self.assertEqual(messages(self.output.getvalue()), [host.UNAVAILABLE])

    def test_eof_cancels_pending_palette_resolution(self):
        started = threading.Event()

        def resolve(stop):
            started.set()
            stop.wait(timeout=5)
            raise host.Cancelled()

        watcher = mock.Mock()
        watcher.poll.side_effect = resolve
        self.connection(watcher)
        os.write(self.write_fd, frame(SUBSCRIBE))
        self.assertTrue(started.wait(timeout=2))
        self.close_input()
        self.assertEqual(self.result, [0])
        self.assertEqual(self.output.getvalue(), b"")

    def test_partial_eof_and_unknown_request_fail_closed(self):
        for data in (b"\x10\x00", frame({**SUBSCRIBE, "path": "/private"})):
            with self.subTest(data=data), contextlib.redirect_stderr(io.StringIO()) as errors:
                watcher = mock.Mock()
                self.connection(watcher)
                os.write(self.write_fd, data)
                self.close_input()
                self.assertEqual(self.result, [1])
                self.assertNotIn("/private", errors.getvalue())
                self.assertEqual(self.output.getvalue(), b"")
                watcher.poll.assert_not_called()


if __name__ == "__main__":
    unittest.main()
