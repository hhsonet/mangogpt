import os
from pathlib import Path

import pytest

from app.services.safefs import FsError, SafeFS, clean_path


@pytest.fixture()
def ws(tmp_path: Path):
    root = tmp_path / "ws"
    root.mkdir()
    (tmp_path / "secret.txt").write_text("TOP-SECRET")
    return SafeFS(root), root, tmp_path


def test_basic_write_read_list(ws):
    fs, root, _ = ws
    fs.write_atomic("a/b/hello.txt", b"hi", create_parents=True)
    assert fs.read_bytes("a/b/hello.txt", 100) == b"hi"
    assert [e.name for e in fs.list_dir("a")] == ["b"] and fs.list_dir("a/b")[0].size == 2
    assert not [p for p in (root / "a" / "b").iterdir() if p.name.startswith(".tmp-")]  # no temp leftovers


@pytest.mark.parametrize("bad", ["../x", "a/../../x", "/etc/passwd", "a\\b", "a/\x00b", "..", "a/./..", ".mangolab/x", "x" * 300, "a/" * 40 + "b"])
def test_rejects_hostile_paths(bad):
    with pytest.raises(FsError):
        clean_path(bad)


def test_symlinked_file_is_not_followed(ws):
    fs, root, tmp = ws
    os.symlink(tmp / "secret.txt", root / "innocent.txt")
    with pytest.raises(FsError) as e:
        fs.read_bytes("innocent.txt", 100)
    assert e.value.status in (403, 404) and "TOP-SECRET" not in str(e.value)
    assert fs.list_dir("")[0].kind == "link"  # shown as a link, never opened


def test_symlinked_directory_is_not_followed(ws):
    fs, root, tmp = ws
    (tmp / "outside").mkdir()
    (tmp / "outside" / "loot.txt").write_text("LOOT")
    os.symlink(tmp / "outside", root / "portal")
    for op in (lambda: fs.list_dir("portal"), lambda: fs.read_bytes("portal/loot.txt", 100), lambda: fs.write_atomic("portal/new.txt", b"x"),
               lambda: fs.mkdir("portal/sub"), lambda: fs.remove("portal/loot.txt"), lambda: fs.rename("portal/loot.txt", "stolen.txt")):
        with pytest.raises(FsError):
            op()
    assert (tmp / "outside" / "loot.txt").read_text() == "LOOT" and not (tmp / "outside" / "new.txt").exists()


def test_write_over_a_symlink_replaces_the_link_not_its_target(ws):
    fs, root, tmp = ws
    os.symlink(tmp / "secret.txt", root / "link.txt")
    fs.write_atomic("link.txt", b"mine")
    assert (tmp / "secret.txt").read_text() == "TOP-SECRET"  # target untouched
    assert not os.path.islink(root / "link.txt") and (root / "link.txt").read_bytes() == b"mine"


def test_removing_a_link_or_tree_never_touches_targets(ws):
    fs, root, tmp = ws
    (tmp / "outside").mkdir()
    (tmp / "outside" / "keep.txt").write_text("KEEP")
    (root / "dir").mkdir()
    os.symlink(tmp / "outside", root / "dir" / "portal")
    fs.remove("dir")
    assert not (root / "dir").exists() and (tmp / "outside" / "keep.txt").read_text() == "KEEP"


def test_internal_dir_is_hidden_and_unaddressable(ws):
    fs, root, _ = ws
    (root / ".mangolab").mkdir()
    (root / "visible.txt").write_text("x")
    assert [e.name for e in fs.list_dir("")] == ["visible.txt"]
    with pytest.raises(FsError):
        fs.read_bytes(".mangolab/anything", 10)


def test_exclusive_create_rename_and_conflicts(ws):
    fs, root, _ = ws
    fs.write_atomic("one.txt", b"1")
    with pytest.raises(FsError) as e:
        fs.write_atomic("one.txt", b"2", exclusive=True)
    assert e.value.code == "exists"
    fs.write_atomic("two.txt", b"2")
    with pytest.raises(FsError):
        fs.rename("one.txt", "two.txt")  # never silently overwrite
    fs.rename("one.txt", "sub/moved.txt")
    assert fs.read_bytes("sub/moved.txt", 10) == b"1"
    (root / "d").mkdir()
    with pytest.raises(FsError):
        fs.rename("d", "d/inner")  # into itself


def test_size_limit_aborts_and_cleans_up(ws):
    fs, root, _ = ws
    with pytest.raises(FsError) as e:
        fs.write_atomic("big.bin", iter([b"x" * 600_000, b"x" * 600_000]), max_bytes=1_000_000)
    assert e.value.code == "too_large" and not any(root.iterdir())


def test_disk_usage_ignores_links(ws):
    fs, root, tmp = ws
    fs.write_atomic("f.txt", b"12345")
    os.symlink(tmp / "secret.txt", root / "l.txt")
    assert fs.disk_usage() == 5
