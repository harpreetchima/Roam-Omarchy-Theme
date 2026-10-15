"""One-shot user template/seed installation; no server, hook, or app retinting."""

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid

from native.host import MAX_MESSAGE_BYTES, decode_json
from desktop.palette import initial_message, json_bytes


OWNER = "com.harpreetchima.roam_omarchy_desktop_palette"
TEMPLATE = Path(".config/omarchy/themed/roam-omarchy-palette.json.tpl")
SEED = Path(".local/state/omarchy/current/theme/roam-omarchy-palette.json")
RECORD = Path(".local/state/roam-omarchy-desktop-palette/install-record.json")
SEED_BACKUPS = RECORD.parent / "backups"
COLORS = SEED.with_name("colors.toml")
LIGHT_MODE = SEED.with_name("light.mode")
DEFAULT_COMMAND = Path("/usr/share/omarchy/bin/omarchy")
RESOLVER_TIMEOUT = 3.0
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC


class InstallError(ValueError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def backup_path(path, suffix):
    parent = SEED_BACKUPS if path == SEED else path.parent
    return parent / (path.name + ".backup-" + suffix)


@dataclass(frozen=True)
class Snapshot:
    data: bytes
    identity: tuple
    parent: tuple
    mode: int


class Home:
    """Anchor all I/O to owned directory descriptors, never following symlinks."""

    def __init__(self, path):
        self.path = Path(os.path.abspath(path))
        descriptor = os.open("/", DIRECTORY_FLAGS)
        try:
            for part in self.path.parts[1:]:
                child = os.open(part, DIRECTORY_FLAGS, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
            self.check_owner(descriptor, self.path)
        except BaseException:
            os.close(descriptor)
            raise
        self.descriptor = descriptor

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        os.close(self.descriptor)

    @staticmethod
    def check_owner(descriptor, path):
        info = os.fstat(descriptor)
        if info.st_uid != os.getuid():
            raise InstallError(f"Not a user-owned directory: {path}")
        return info.st_dev, info.st_ino

    @contextmanager
    def parent(self, path, create=False):
        if path.is_absolute() or ".." in path.parts:
            raise InstallError("Expected a fixed path inside HOME")
        descriptor = os.dup(self.descriptor)
        current = self.path
        try:
            for part in path.parent.parts:
                current /= part
                try:
                    child = os.open(part, DIRECTORY_FLAGS, dir_fd=descriptor)
                except FileNotFoundError:
                    if not create:
                        yield None
                        return
                    try:
                        os.mkdir(part, 0o700, dir_fd=descriptor)
                    except FileExistsError:
                        pass
                    child = os.open(part, DIRECTORY_FLAGS, dir_fd=descriptor)
                try:
                    self.check_owner(child, current)
                except BaseException:
                    os.close(child)
                    raise
                os.close(descriptor)
                descriptor = child
            yield descriptor
        finally:
            os.close(descriptor)

    def check_parent(self, path, create=False):
        with self.parent(path, create) as descriptor:
            return None if descriptor is None else self.check_owner(descriptor, self.path / path.parent)

    def read(self, path, maximum=MAX_MESSAGE_BYTES):
        with self.parent(path) as parent:
            if parent is None:
                return None
            return self.read_at(parent, path, maximum)

    def read_at(self, parent, path, maximum=MAX_MESSAGE_BYTES):
        try:
            descriptor = os.open(path.name, FILE_FLAGS, dir_fd=parent)
        except FileNotFoundError:
            return None
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid():
                raise InstallError(f"Not a user-owned regular file: {self.path / path}")
            if before.st_size > maximum:
                raise InstallError(f"File too large: {self.path / path}")
            with os.fdopen(descriptor, "rb", closefd=False) as stream:
                data = stream.read(maximum + 1)
            if len(data) > maximum or identity(before) != identity(os.fstat(descriptor)):
                raise InstallError(f"File changed or too large: {self.path / path}")
            info = os.fstat(parent)
            return Snapshot(data, identity(before), (info.st_dev, info.st_ino), stat.S_IMODE(before.st_mode))
        finally:
            os.close(descriptor)

    def write(self, path, data, expected_parent, mode=0o600):
        """Publish atomically without clobbering; preserve modes only for backups."""
        with self.parent(path) as parent:
            if parent is None or self.check_owner(parent, path.parent) != expected_parent:
                raise InstallError(f"Directory changed: {self.path / path.parent}")
            temporary = ".roam-desktop-palette-" + uuid.uuid4().hex
            descriptor = os.open(
                temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600, dir_fd=parent,
            )
            try:
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fchmod(stream.fileno(), mode)
                    os.fsync(stream.fileno())
                os.link(temporary, path.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            finally:
                os.unlink(temporary, dir_fd=parent)
            snapshot = self.read_at(parent, path)
            if snapshot is None or snapshot.data != data or snapshot.mode != mode:
                raise InstallError(f"File changed during publication: {self.path / path}")
            return snapshot

    def backup(self, path, expected, suffix):
        backup = backup_path(path, suffix)
        if self.read(path) != expected:
            raise InstallError(f"File changed before backup: {self.path / path}")
        parent = self.check_parent(backup, create=True)
        # A bounded, independent copy also works across filesystems. In particular,
        # seed backups must outlive Omarchy deleting the whole current/theme tree.
        snapshot = self.write(backup, expected.data, parent, mode=expected.mode)
        if not self.remove(path, expected):
            raise InstallError(f"File changed during backup; preserved backup: {self.path / backup}")
        return backup, snapshot

    def remove(self, path, expected):
        with self.parent(path) as parent:
            if parent is None:
                return False
            if self.read_at(parent, path) != expected:
                return False
            os.unlink(path.name, dir_fd=parent)
            return True

    def restore(self, backup, path, expected, original):
        if self.read(backup) != expected:
            raise InstallError("Backup changed; leaving it for manual recovery")
        # Reopen both paths independently: the backup's parent is not authority to
        # restore into a replacement theme directory or over a concurrent edit.
        self.write(path, expected.data, original.parent, mode=original.mode)
        if not self.remove(backup, expected):
            raise InstallError("Backup changed after restore; leaving it for manual recovery")


def run_resolver(command, timeout=RESOLVER_TIMEOUT):
    """Fixed absolute argv, 64 KiB stdout, timeout, and whole-process cleanup."""
    with subprocess.Popen(
        [str(command), "theme", "color", "--all"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        start_new_session=True,
    ) as process:
        try:
            output = bytearray()
            deadline = time.monotonic() + timeout
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise InstallError("Resolver timed out")
                    if not selector.select(remaining):
                        raise InstallError("Resolver timed out")
                    chunk = os.read(process.stdout.fileno(), 4096)
                    if not chunk:
                        try:
                            returncode = process.wait(timeout=max(0, deadline - time.monotonic()))
                        except subprocess.TimeoutExpired as error:
                            raise InstallError("Resolver timed out") from error
                        if returncode:
                            raise InstallError("Resolver failed")
                        return bytes(output)
                    output.extend(chunk)
                    if len(output) > MAX_MESSAGE_BYTES:
                        raise InstallError("Resolver output too large")
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


def checked_command(command):
    if not command.is_absolute():
        raise InstallError("--omarchy must be an absolute executable path, not a command string")
    command = command.resolve(strict=True)
    if not command.is_file() or not os.access(command, os.X_OK):
        raise InstallError("Omarchy must be an executable file")
    return command


def install(home, command=DEFAULT_COMMAND, dry_run=False, report=print):
    command = checked_command(command)
    template = Path(__file__).with_name(TEMPLATE.name).read_bytes()
    with Home(home) as files:
        paths = (TEMPLATE, SEED, RECORD)
        existing = {path: files.read(path) for path in paths}
        if existing[SEED] is not None:
            files.check_parent(backup_path(SEED, "preview"))
        report(f"{'Would install' if dry_run else 'Installing'} desktop palette template and one initial seed")
        for path in paths:
            report(str(files.path / path))
            if existing[path] is not None:
                report(f"  Preserve existing file as: {files.path / backup_path(path, '<UTC>-<random>')}")
        report(f"Read-only resolver: {command} theme color --all (3 s, 64 KiB)")
        if dry_run:
            report("Preview only: no resolver execution, file writes, or theme application")
            return
        theme_parent = files.check_parent(SEED)
        before = files.read(COLORS), files.read(LIGHT_MODE)
        if theme_parent is None or before[0] is None:
            raise InstallError("An existing current theme/colors.toml is required; no theme will be applied")
        seed = json_bytes(initial_message(run_resolver(command)))
        if (files.check_parent(SEED) != theme_parent
                or (files.read(COLORS), files.read(LIGHT_MODE)) != before):
            raise InstallError("Current theme changed during resolution; retry without switching themes")
        record = json_bytes({
            "version": 1,
            "owner": OWNER,
            "files": {str(TEMPLATE): digest(template), str(SEED): digest(seed)},
        })
        parents = {
            TEMPLATE: files.check_parent(TEMPLATE, create=True),
            SEED: theme_parent,
            RECORD: files.check_parent(RECORD, create=True),
        }
        backups = []
        written = []
        suffix = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex
        try:
            for path, data in ((TEMPLATE, template), (SEED, seed), (RECORD, record)):
                if existing[path] is not None:
                    backup, snapshot = files.backup(path, existing[path], suffix)
                    backups.append((path, backup, snapshot, existing[path]))
                    report(f"Preserved: {files.path / backup}")
                written.append((path, files.write(path, data, parents[path])))
        except (OSError, ValueError):
            for path, snapshot in reversed(written):
                try:
                    files.remove(path, snapshot)
                except (OSError, ValueError):
                    pass  # A concurrent edit is never rollback's property.
            for path, backup, snapshot, original in reversed(backups):
                try:
                    files.restore(backup, path, snapshot, original)
                except (OSError, ValueError):
                    report(f"Kept backup for manual recovery: {files.path / backup}")
            raise
        report("Installed without reapplying the theme; future switches use Omarchy's built-in renderer")


def read_record(snapshot):
    record = decode_json(snapshot.data)
    if (
        not isinstance(record, dict)
        or set(record) != {"version", "owner", "files"}
        or type(record["version"]) is not int or record["version"] != 1
        or record["owner"] != OWNER
        or not isinstance(record["files"], dict)
        or set(record["files"]) != {str(TEMPLATE), str(SEED)}
        or any(
            not isinstance(value, str) or len(value) != 64
            or any(character not in "0123456789abcdef" for character in value)
            for value in record["files"].values()
        )
    ):
        raise InstallError("Invalid desktop ownership record; nothing removed")
    return record


def uninstall(home, dry_run=False, report=print):
    with Home(home) as files:
        # Check all ancestors before deleting anything, including in a preview.
        for path in (RECORD, TEMPLATE, SEED):
            files.check_parent(path)
        snapshot = files.read(RECORD, 16 * 1024)
        if snapshot is None:
            report("No desktop ownership record; nothing removed")
            return
        record = read_record(snapshot)
        kept = False
        for path in (TEMPLATE, SEED):
            try:
                current = files.read(path)
                owned = current is None or digest(current.data) == record["files"][str(path)]
            except (OSError, ValueError):
                current, owned = None, False
            if not owned:
                kept = True
                report(f"Keeping modified or unowned file: {files.path / path}")
            elif current is not None:
                report(f"{'Would remove' if dry_run else 'Removing'}: {files.path / path}")
                if not dry_run and not files.remove(path, current):
                    kept = True
                    report("Kept a file that changed during uninstall")
        if kept:
            report("Kept the desktop ownership record; changed snapshots and all backups remain")
        else:
            report(f"{'Would remove' if dry_run else 'Removing'}: {files.path / RECORD}")
            if not dry_run and not files.remove(RECORD, snapshot):
                report("Kept a desktop ownership record that changed during uninstall")


def main(action):
    parser = argparse.ArgumentParser(description=f"{action.title()} the user-local Omarchy desktop palette")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writes or resolver execution")
    if action == "install":
        parser.add_argument("--omarchy", type=Path, default=DEFAULT_COMMAND, help="Absolute Omarchy CLI path (default: %(default)s)")
    args = parser.parse_args()
    try:
        if action == "install":
            install(Path.home(), args.omarchy, args.dry_run)
        else:
            uninstall(Path.home(), args.dry_run)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"roam-omarchy-desktop: {error}", file=sys.stderr)
        return 1
    return 0
