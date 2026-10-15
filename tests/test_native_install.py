import json
import os
from pathlib import Path
import selectors
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "native"))
import host
import install


EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop"
TEMP_ROOT = "/tmp/opencode" if Path("/tmp/opencode").is_dir() else None


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="roam-native-install-", dir=TEMP_ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name) / "home"
        self.home.mkdir()
        self.browser = self.home / "fake-browser/NativeMessagingHosts"
        self.command = self.home / "bin/omarchy"
        self.command.parent.mkdir()
        self.command.write_text(
            "#!/usr/bin/python3\nimport sys\n"
            "assert sys.argv[1:] == ['theme', 'color', '--all']\n"
            "print('mode\\tdark\\nbackground\\t#112233\\nforeground\\t#ddeeff')\n"
        )
        self.command.chmod(0o700)
        self.resolver = mock.Mock(return_value=str(self.command))
        self.directory = self.home / install.INSTALL_DIRECTORY
        self.manifest = self.browser / install.MANIFEST_NAME

    def do_install(self, **kwargs):
        install.install(EXTENSION_ID, self.home, self.browser,
                        resolve_command=self.resolver, report=lambda _line: None, **kwargs)

    def do_uninstall(self, **kwargs):
        install.uninstall(self.home, self.browser, report=lambda _line: None, **kwargs)

    def inventory(self):
        return sorted(str(path.relative_to(self.home)) for path in self.home.rglob("*"))

    def test_dry_run_does_not_create_directories_files_or_registration(self):
        before = self.inventory()
        self.do_install(dry_run=True)
        self.assertEqual(self.inventory(), before)
        self.assertFalse(self.directory.exists())
        self.assertFalse(self.manifest.exists())
        self.resolver.assert_called_once_with("omarchy")

    def test_actual_extension_id_and_resolver_required(self):
        for extension_id in ("", "a" * 31, "a" * 33, "q" * 32, "A" * 32, "*", "<extension-id>"):
            with self.subTest(extension_id=extension_id), self.assertRaises(install.InstallError):
                install.install(extension_id, self.home, self.browser,
                                resolve_command=self.resolver, report=lambda _line: None)
        with self.assertRaises(install.InstallError):
            install.install(EXTENSION_ID, self.home, self.browser,
                            resolve_command=lambda _name: None, report=lambda _line: None)
        self.assertFalse(self.directory.exists())

    def test_exact_manifest_minimal_config_and_owned_removal(self):
        self.do_install()
        manifest = json.loads(self.manifest.read_text())
        self.assertEqual(manifest, {
            "name": host.HOST_NAME,
            "description": "Read-only local Omarchy palette for Roam",
            "path": str(self.directory / "host.py"),
            "type": "stdio",
            "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"],
        })
        self.assertEqual(json.loads((self.directory / "config.json").read_text()), {
            "version": 1, "extension_id": EXTENSION_ID, "omarchy": str(self.command.resolve()),
        })
        self.assertTrue(os.access(self.directory / "host.py", os.X_OK))
        self.assertEqual((self.directory / "host.py").read_text().splitlines()[0], "#!/usr/bin/python3")
        before = self.inventory()
        self.do_uninstall(dry_run=True)
        self.assertEqual(self.inventory(), before)
        self.do_uninstall()
        self.assertFalse(self.manifest.exists())
        self.assertFalse(self.directory.exists())
        self.assertTrue(self.command.exists())
        self.assertTrue(self.browser.exists())  # Do not remove unrelated browser directories.

    def test_collisions_backed_up_modified_files_and_backups_preserved(self):
        self.directory.mkdir(parents=True)
        self.browser.mkdir(parents=True)
        (self.directory / "host.py").write_text("user script\n")
        self.manifest.write_text("user manifest\n")
        self.do_install()
        host_backups = list(self.directory.glob("host.py.backup-*"))
        manifest_backups = list(self.browser.glob(install.MANIFEST_NAME + ".backup-*"))
        self.assertEqual([path.read_text() for path in host_backups], ["user script\n"])
        self.assertEqual([path.read_text() for path in manifest_backups], ["user manifest\n"])
        (self.directory / "host.py").write_text("user edited installed script\n")
        self.do_uninstall()
        self.assertEqual((self.directory / "host.py").read_text(), "user edited installed script\n")
        self.assertTrue((self.directory / install.RECORD_NAME).exists())
        self.assertFalse(self.manifest.exists())
        self.assertEqual(host_backups[0].read_text(), "user script\n")
        self.assertEqual(manifest_backups[0].read_text(), "user manifest\n")

    def test_symlink_collision_backed_up_without_modifying_target(self):
        target = self.home / "user-file"
        target.write_text("private user file\n")
        self.browser.mkdir(parents=True)
        self.manifest.symlink_to(target)
        self.do_install()
        backups = list(self.browser.glob(install.MANIFEST_NAME + ".backup-*"))
        self.assertEqual(len(backups), 1)
        self.assertTrue(backups[0].is_symlink())
        self.assertEqual(target.read_text(), "private user file\n")
        self.do_uninstall()
        self.assertTrue(backups[0].is_symlink())

    def test_concurrent_destination_creation_does_not_overwrite_user_file(self):
        self.directory.mkdir(parents=True)
        destination = self.directory / "host.py"
        original_link = os.link

        def colliding_link(source, target):
            Path(target).write_text("concurrent user edit")
            return original_link(source, target)

        with mock.patch.object(install.os, "link", side_effect=colliding_link):
            with self.assertRaises(FileExistsError):
                self.do_install()
        self.assertEqual(destination.read_text(), "concurrent user edit")
        self.assertFalse(self.manifest.exists())

    def test_unowned_manifest_never_removed_without_record(self):
        self.browser.mkdir(parents=True)
        self.manifest.write_text("not ours")
        self.do_uninstall()
        self.assertEqual(self.manifest.read_text(), "not ours")

    def test_changed_manifest_or_symlink_never_unregistered(self):
        for symlink in (False, True):
            with self.subTest(symlink=symlink):
                self.do_install()
                self.manifest.unlink()
                if symlink:
                    self.manifest.symlink_to(self.command)
                else:
                    self.manifest.write_text("a different owner's manifest")
                self.do_uninstall()
                self.assertTrue(os.path.lexists(self.manifest))
                self.assertTrue((self.directory / install.RECORD_NAME).exists())

    def test_outside_home_symlink_directory_and_wrong_browser_rejected(self):
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        with self.assertRaises(install.InstallError):
            install.install(EXTENSION_ID, self.home, outside, resolve_command=self.resolver)
        linked = self.home / "linked"
        linked.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(install.InstallError):
            install.install(EXTENSION_ID, self.home, linked / "NativeMessagingHosts",
                            resolve_command=self.resolver)
        self.do_install()
        with self.assertRaises(install.InstallError):
            install.install(EXTENSION_ID, self.home, self.home / "another-browser",
                            resolve_command=self.resolver)
        with self.assertRaises(install.InstallError):
            install.uninstall(self.home, self.home / "another-browser")
        self.assertTrue(self.manifest.exists())

    def test_script_cli_dry_run_uses_fake_home_and_fake_path(self):
        environment = {**os.environ, "HOME": str(self.home), "PATH": str(self.command.parent)}
        before = self.inventory()
        result = subprocess.run([
            "/usr/bin/python3", str(ROOT / "scripts/install-native-host"),
            "--extension-id", EXTENSION_ID, "--browser-dir", str(self.browser), "--dry-run",
        ], env=environment, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Would install", result.stdout)
        self.assertEqual(self.inventory(), before)
        result = subprocess.run([
            "/usr/bin/python3", str(ROOT / "scripts/uninstall-native-host"),
            "--browser-dir", str(self.browser), "--dry-run",
        ], env=environment, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.inventory(), before)

    def test_installed_process_origin_subscription_and_browser_eof(self):
        self.do_install()
        current = self.home / ".local/state/omarchy/current/theme"
        current.mkdir(parents=True)
        (current / "colors.toml").write_text('background = "#112233"\nforeground = "#ddeeff"\n')
        environment = {**os.environ, "HOME": str(self.home)}
        for arguments in ([], [f"chrome-extension://{'a' * 32}/"],
                          [f"chrome-extension://{EXTENSION_ID}/extra"],
                          [f"chrome-extension://{EXTENSION_ID}/", "extra"]):
            result = subprocess.run([str(self.directory / "host.py"), *arguments],
                                    env=environment, input=b"", capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b"")
        with subprocess.Popen([
            str(self.directory / "host.py"), f"chrome-extension://{EXTENSION_ID}/",
        ], env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE) as process:
            try:
                request = b'{"version":1,"type":"subscribe"}'
                process.stdin.write(struct.pack("=I", len(request)) + request)
                process.stdin.flush()
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    self.assertTrue(selector.select(timeout=5), "No initial native response")
                header = process.stdout.read(4)
                self.assertEqual(len(header), 4)
                size = struct.unpack("=I", header)[0]
                self.assertLessEqual(size, host.MAX_MESSAGE_BYTES)
                message = json.loads(process.stdout.read(size))
                self.assertEqual(message, {
                    "version": 1, "type": "palette", "palette": {
                        "mode": "dark", "colors": {"background": "#112233", "foreground": "#ddeeff"},
                    },
                })
                process.stdin.close()
                self.assertEqual(process.wait(timeout=2), 0)
                self.assertEqual(process.stderr.read(), b"")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    unittest.main()
