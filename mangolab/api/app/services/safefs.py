"""
Safe access to a project workspace.

User code runs in the workspace and can create symlinks, rename directories while we work and so on, so a normal
`root / user_path` is not safe: a link inside the workspace pointing at /home/<user>/.env would be followed.
Every operation here walks the path one component at a time with directory file descriptors and O_NOFOLLOW,
so a symlink anywhere in the path (including the last component) is refused instead of followed.
"""
from __future__ import annotations

import errno
import os
import stat
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

INTERNAL_DIR = ".mangolab"  # metadata (revisions, logs); hidden from users and not addressable through the API
MAX_NAME_BYTES = 255
MAX_PATH_PARTS = 32
_BAD_NAMES = {"", ".", ".."}
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


class FsError(Exception):
    """A refused or failed operation. `code` is stable for the API layer; `message` is safe to show."""

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


@dataclass(frozen=True)
class Entry:
    name: str
    path: str  # relative to the workspace, "/"-separated
    kind: str  # "dir" | "file" | "link"
    size: int
    mtime: float


def clean_path(path: str, *, allow_empty: bool = False, allow_internal: bool = False) -> list[str]:
    """Validate a user-supplied relative path and split it into components."""
    if not isinstance(path, str) or "\x00" in path or "\\" in path:
        raise FsError("bad_path", "That path isn't valid.")
    if path.startswith("/"):
        raise FsError("bad_path", "Paths must be relative to the project.")
    parts = [p for p in path.split("/") if p != ""]
    if not parts and not allow_empty:
        raise FsError("bad_path", "A path is required.")
    if len(parts) > MAX_PATH_PARTS:
        raise FsError("bad_path", "That path is too deep.")
    for p in parts:
        if p in _BAD_NAMES or any(ord(c) < 32 or ord(c) == 127 for c in p) or len(p.encode()) > MAX_NAME_BYTES:
            raise FsError("bad_path", "That path isn't valid.")
    if parts and parts[0] == INTERNAL_DIR and not allow_internal:
        raise FsError("reserved", f"“{INTERNAL_DIR}” is reserved for MangoLab.")
    return parts


def clean_name(name: str) -> str:
    parts = clean_path(name)
    if len(parts) != 1:
        raise FsError("bad_name", "A name can't contain “/”.")
    return parts[0]


class SafeFS:
    def __init__(self, root: Path, *, allow_internal: bool = False):
        self.root = Path(os.path.realpath(root))
        self.allow_internal = allow_internal  # True only for MangoLab's own bookkeeping, never for user-supplied paths

    def internal(self) -> "SafeFS":
        return SafeFS(self.root, allow_internal=True)

    # -- directory walking -------------------------------------------------------------------------
    def _open_dir(self, parts: list[str], *, create: bool = False) -> int:
        """Open the directory at `parts` (relative to root) without following any symlink. Caller closes the fd."""
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            for p in parts:
                try:
                    nfd = os.open(p, _DIR_FLAGS, dir_fd=fd)
                except FileNotFoundError:
                    if not create:
                        raise
                    os.mkdir(p, 0o755, dir_fd=fd)
                    nfd = os.open(p, _DIR_FLAGS, dir_fd=fd)
                os.close(fd)
                fd = nfd
            return fd
        except OSError as e:
            os.close(fd)
            raise self._translate(e) from e

    @staticmethod
    def _translate(e: OSError) -> FsError:
        if e.errno in (errno.ELOOP, errno.ENOTDIR):
            return FsError("not_allowed", "That path goes through a link or a file, which isn't allowed.", 403)
        if isinstance(e, FileNotFoundError):
            return FsError("not_found", "Not found.", 404)
        if isinstance(e, FileExistsError):
            return FsError("exists", "Something with that name already exists.", 409)
        if isinstance(e, IsADirectoryError):
            return FsError("is_dir", "That is a folder.", 400)
        if isinstance(e, PermissionError):
            return FsError("not_allowed", "Permission denied.", 403)
        if e.errno == errno.ENOTEMPTY:
            return FsError("not_empty", "That folder isn't empty.", 409)
        if e.errno == errno.ENOSPC:
            return FsError("disk_full", "The server is out of disk space.", 507)
        return FsError("fs_error", "The file operation failed.", 500)

    def _split(self, path: str) -> tuple[list[str], str]:
        parts = clean_path(path, allow_internal=self.allow_internal)
        return parts[:-1], parts[-1]

    # -- reading -----------------------------------------------------------------------------------
    def list_dir(self, path: str = "") -> list[Entry]:
        parts = clean_path(path, allow_empty=True, allow_internal=self.allow_internal)
        fd = self._open_dir(parts)
        try:
            out: list[Entry] = []
            with os.scandir(fd) as it:
                for e in it:
                    if not parts and e.name == INTERNAL_DIR and not self.allow_internal:
                        continue
                    try:
                        st = e.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    kind = "link" if stat.S_ISLNK(st.st_mode) else "dir" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else None
                    if kind is None:
                        continue  # sockets, devices, fifos: never shown
                    out.append(Entry(e.name, "/".join([*parts, e.name]), kind, 0 if kind == "dir" else st.st_size, st.st_mtime))
            return sorted(out, key=lambda x: (x.kind != "dir", x.name.lower()))
        except OSError as e:
            raise self._translate(e) from e
        finally:
            os.close(fd)

    def stat(self, path: str) -> Entry:
        parent, name = self._split(path)
        dfd = self._open_dir(parent)
        try:
            st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
        except OSError as e:
            raise self._translate(e) from e
        finally:
            os.close(dfd)
        kind = "link" if stat.S_ISLNK(st.st_mode) else "dir" if stat.S_ISDIR(st.st_mode) else "file" if stat.S_ISREG(st.st_mode) else "other"
        if kind == "other":
            raise FsError("not_allowed", "That isn't a regular file.", 403)
        return Entry(name, "/".join([*parent, name]), kind, 0 if kind == "dir" else st.st_size, st.st_mtime)

    def open_read(self, path: str) -> BinaryIO:
        """Open a regular file for reading. Symlinks (even as the last component) are refused."""
        parent, name = self._split(path)
        dfd = self._open_dir(parent)
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=dfd)
        except OSError as e:
            raise self._translate(e) from e
        finally:
            os.close(dfd)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise FsError("is_dir" if stat.S_ISDIR(os.fstat(fd).st_mode) else "not_allowed", "That isn't a regular file.", 400)
            return os.fdopen(fd, "rb")
        except BaseException:
            os.close(fd)
            raise

    def read_bytes(self, path: str, max_bytes: int) -> bytes:
        with self.open_read(path) as f:
            size = os.fstat(f.fileno()).st_size
            if size > max_bytes:
                raise FsError("too_large", f"That file is larger than {max_bytes // 1024 // 1024} MB.", 413)
            return f.read(max_bytes + 1)

    # -- writing -----------------------------------------------------------------------------------
    def write_atomic(self, path: str, chunks: Iterator[bytes] | bytes, *, create_parents: bool = False, exclusive: bool = False, max_bytes: int | None = None) -> int:
        """Write via a temp file in the same folder, fsync, then rename: readers never see a half-written file."""
        parent, name = self._split(path)
        dfd = self._open_dir(parent, create=create_parents)
        tmp = f".tmp-{uuid.uuid4().hex}"
        written = 0
        try:
            try:
                os.stat(name, dir_fd=dfd, follow_symlinks=False)
                exists = True
            except FileNotFoundError:
                exists = False
            if exists and exclusive:
                raise FsError("exists", "Something with that name already exists.", 409)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644, dir_fd=dfd)
            try:
                with os.fdopen(fd, "wb") as f:
                    for chunk in ([chunks] if isinstance(chunks, bytes) else chunks):
                        written += len(chunk)
                        if max_bytes is not None and written > max_bytes:
                            raise FsError("too_large", f"That file is larger than {max_bytes // 1024 // 1024} MB.", 413)
                        f.write(chunk)
                    f.flush()
                    os.fsync(f.fileno())
                if exists:  # replacing a directory with a file would be a surprise; renaming over a symlink replaces the link itself
                    st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
                    if stat.S_ISDIR(st.st_mode):
                        raise FsError("is_dir", "That is a folder.", 400)
                os.rename(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
            except BaseException:
                try:
                    os.unlink(tmp, dir_fd=dfd)
                except OSError:
                    pass
                raise
            return written
        except OSError as e:
            raise self._translate(e) from e
        finally:
            os.close(dfd)

    def mkdir(self, path: str) -> None:
        parent, name = self._split(path)
        dfd = self._open_dir(parent, create=True)
        try:
            os.mkdir(name, 0o755, dir_fd=dfd)
        except OSError as e:
            raise self._translate(e) from e
        finally:
            os.close(dfd)

    def rename(self, src: str, dst: str) -> None:
        sp, sn = self._split(src)
        dp, dn = self._split(dst)
        sfd = self._open_dir(sp)
        try:
            dfd = self._open_dir(dp, create=True)
            try:
                try:
                    os.stat(dn, dir_fd=dfd, follow_symlinks=False)
                    raise FsError("exists", "Something with that name already exists.", 409)
                except FileNotFoundError:
                    pass
                os.stat(sn, dir_fd=sfd, follow_symlinks=False)  # must exist (raises FileNotFoundError)
                if sp + [sn] == dp[: len(sp) + 1] and len(dp) >= len(sp) + 1:
                    raise FsError("bad_path", "A folder can't be moved into itself.")
                os.rename(sn, dn, src_dir_fd=sfd, dst_dir_fd=dfd)
            except OSError as e:
                raise self._translate(e) from e
            finally:
                os.close(dfd)
        finally:
            os.close(sfd)

    def remove(self, path: str) -> None:
        """Delete a file, a link (the link itself, never its target) or a folder tree."""
        parent, name = self._split(path)
        dfd = self._open_dir(parent)
        try:
            self._remove_at(dfd, name)
        except OSError as e:
            raise self._translate(e) from e
        finally:
            os.close(dfd)

    def _remove_at(self, dfd: int, name: str) -> None:
        st = os.stat(name, dir_fd=dfd, follow_symlinks=False)
        if not stat.S_ISDIR(st.st_mode):
            os.unlink(name, dir_fd=dfd)
            return
        sub = os.open(name, _DIR_FLAGS, dir_fd=dfd)
        try:
            for child in os.listdir(sub):
                self._remove_at(sub, child)
        finally:
            os.close(sub)
        os.rmdir(name, dir_fd=dfd)

    # -- accounting --------------------------------------------------------------------------------
    def disk_usage(self) -> int:
        """Total bytes of regular files (links are not followed or counted)."""
        total = 0
        for base, dirs, files in os.walk(self.root, followlinks=False):
            for f in files:
                try:
                    st = os.lstat(os.path.join(base, f))
                    if stat.S_ISREG(st.st_mode):
                        total += st.st_size
                except OSError:
                    pass
        return total
