"""User-local native-host registration; imported by the two repository CLIs."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import uuid

from host import EXTENSION_ID, HOST_NAME, decode_json


INSTALL_DIRECTORY = Path(".local/lib/roam-omarchy-theme")
RECORD_NAME = "install-record.json"
MANIFEST_NAME = HOST_NAME + ".json"


class InstallError(ValueError):
    pass


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked_directory(home, directory):
    """Do not write outside HOME, through symlinks, or into others' directories."""
    home = Path(os.path.abspath(home))
    directory = Path(os.path.abspath(directory))
    try:
        relative = directory.relative_to(home)
    except ValueError as error:
        raise InstallError("Destination must be inside HOME") from error
    current = home
    for component in (None, *relative.parts):
        if component is not None:
            current /= component
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise InstallError(f"Not a user-owned, non-symlink directory: {current}")
    return directory


def check_destination(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if info.st_uid != os.getuid() or stat.S_ISDIR(info.st_mode):
        raise InstallError(f"Refusing non-file or unowned destination: {path}")


def locations(home, browser_dir=None):
    home = Path(os.path.abspath(home))
    install_dir = checked_directory(home, home / INSTALL_DIRECTORY)
    browser_dir = checked_directory(
        home, browser_dir or home / ".config/google-chrome/NativeMessagingHosts"
    )
    return install_dir, browser_dir


def read_owned_file(path, maximum=1024 * 1024):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise InstallError(f"Not an owned regular file: {path}")
    if info.st_size > maximum:
        raise InstallError(f"File too large: {path}")
    with path.open("rb") as stream:
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        raise InstallError(f"File too large: {path}")
    return data


def read_record(path, browser_dir):
    raw = read_owned_file(path, 16 * 1024)
    record = decode_json(raw)
    if (
        not isinstance(record, dict)
        or set(record) != {"version", "owner", "browser_dir", "files"}
        or type(record["version"]) is not int
        or record["version"] != 1
        or record["owner"] != HOST_NAME
        or record["browser_dir"] != str(browser_dir)
        or not isinstance(record["files"], dict)
        or set(record["files"]) != {"host.py", "config.json", "manifest"}
        or any(
            not isinstance(value, str)
            or len(value) != 64
            or any(character not in "0123456789abcdef" for character in value)
            for value in record["files"].values()
        )
    ):
        raise InstallError("Invalid ownership record or different browser directory")
    return record, raw


def atomic_write(path, data, mode):
    descriptor, temporary = tempfile.mkstemp(prefix=".roam-omarchy-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
        # Publish atomically without overwriting a file created after preflight.
        os.link(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install(extension_id, home, browser_dir=None, dry_run=False,
            resolve_command=shutil.which, report=print):
    if not isinstance(extension_id, str) or EXTENSION_ID.fullmatch(extension_id) is None:
        raise InstallError("Use the actual Chrome extension ID: exactly 32 letters a-p")
    install_dir, browser_dir = locations(home, browser_dir)
    command = resolve_command("omarchy")
    if not command:
        raise InstallError("Cannot find the Omarchy executable")
    command = Path(command).resolve(strict=True)
    if not command.is_file() or not os.access(command, os.X_OK):
        raise InstallError("Omarchy must resolve to an executable file")
    host_path = install_dir / "host.py"
    config_path = install_dir / "config.json"
    record_path = install_dir / RECORD_NAME
    manifest_path = browser_dir / MANIFEST_NAME
    host = Path(__file__).with_name("host.py").read_bytes()
    config = json_bytes({"version": 1, "extension_id": extension_id, "omarchy": str(command)})
    manifest = json_bytes({
        "name": HOST_NAME,
        "description": "Read-only local Omarchy palette for Roam",
        "path": str(host_path),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{extension_id}/"],
    })
    record = json_bytes({
        "version": 1,
        "owner": HOST_NAME,
        "browser_dir": str(browser_dir),
        "files": {"host.py": digest(host), "config.json": digest(config), "manifest": digest(manifest)},
    })
    if record_path.exists() and not record_path.is_symlink():
        # One registration per installation; do not orphan a previous manifest.
        try:
            existing = decode_json(read_owned_file(record_path, 16 * 1024))
        except ValueError:
            existing = None
        if (isinstance(existing, dict) and existing.get("owner") == HOST_NAME
                and existing.get("browser_dir") != str(browser_dir)):
            raise InstallError("Uninstall the previous browser registration first")
    files = [
        (host_path, host, 0o700),
        (config_path, config, 0o600),
        (record_path, record, 0o600),
        (manifest_path, manifest, 0o600),
    ]
    for path, _data, _mode in files:
        check_destination(path)
    report(f"{'Would install' if dry_run else 'Installing'} native host for {extension_id}")
    report(f"Host: {host_path}")
    report(f"Manifest: {manifest_path}")
    report(f"Read-only resolver: {command} theme color --all")
    if dry_run:
        for path, _data, _mode in files:
            if os.path.lexists(path):
                report(f"Would preserve existing file as a sibling backup: {path}")
        return
    install_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
    browser_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
    backups = []
    written = []
    suffix = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex
    try:
        for path, data, mode in files:
            if os.path.lexists(path):
                backup = path.with_name(path.name + ".backup-" + suffix)
                os.rename(path, backup)
                backups.append((path, backup))
                report(f"Preserved: {backup}")
            atomic_write(path, data, mode)
            written.append((path, data))
    except OSError:
        # Roll back only these exact writes, preserving any concurrent edits.
        for path, data in reversed(written):
            try:
                if read_owned_file(path) == data:
                    path.unlink()
            except (OSError, InstallError):
                pass
        for path, backup in reversed(backups):
            if not os.path.lexists(path):
                os.rename(backup, path)
        raise


def uninstall(home, browser_dir=None, dry_run=False, report=print):
    install_dir, browser_dir = locations(home, browser_dir)
    record_path = install_dir / RECORD_NAME
    if not os.path.lexists(record_path):
        report("No owned native-host installation found; nothing removed")
        return
    record, raw_record = read_record(record_path, browser_dir)
    files = [
        (browser_dir / MANIFEST_NAME, "manifest"),
        (install_dir / "host.py", "host.py"),
        (install_dir / "config.json", "config.json"),
    ]
    kept = False
    for path, key in files:
        if not os.path.lexists(path):
            continue
        try:
            owned = digest(read_owned_file(path)) == record["files"][key]
        except (OSError, InstallError):
            owned = False
        if not owned:
            kept = True
            report(f"Keeping modified or unowned file: {path}")
        else:
            report(f"{'Would remove' if dry_run else 'Removing'}: {path}")
            if not dry_run:
                path.unlink()
    if kept:
        report("Kept the ownership record for preserved files; backups were not touched")
        return
    report(f"{'Would remove' if dry_run else 'Removing'}: {record_path}")
    if not dry_run and read_owned_file(record_path, 16 * 1024) == raw_record:
        record_path.unlink()
        try:
            install_dir.rmdir()  # Only an empty directory; never recurse.
        except OSError:
            pass


def main(action):
    parser = argparse.ArgumentParser(description=f"{action.title()} the user-local Roam Omarchy native host")
    if action == "install":
        parser.add_argument("--extension-id", required=True, help="Actual ID from chrome://extensions")
    parser.add_argument("--browser-dir", type=Path, help="NativeMessagingHosts directory inside HOME (default: Google Chrome)")
    parser.add_argument("--dry-run", action="store_true", help="Validate and print the plan without writing anything")
    args = parser.parse_args()
    try:
        if action == "install":
            install(args.extension_id, Path.home(), args.browser_dir, args.dry_run)
        else:
            uninstall(Path.home(), args.browser_dir, args.dry_run)
    except (OSError, ValueError) as error:
        print(f"roam-omarchy: {error}", file=sys.stderr)
        return 1
    return 0
