"""
End-to-end checks for projects, files and notebooks against a RUNNING MangoLab API.
Not part of `pytest` (it needs a live server and two real sessions). Usage:
  LAB_URL=http://127.0.0.1:8200/lab-api/v1 LAB_COOKIE_ADMIN=<oc_session value of an admin> LAB_COOKIE_B=<oc_session of an enabled regular user> \
  LAB_USER_B_ID=<that user's id> python tests/integration_phase1.py
Needs read access to the data dir for the symlink attack test (it creates links inside the test project's workspace).
"""
import asyncio, io, json, os, sys, time
import httpx

URL = os.environ.get("LAB_URL", "http://127.0.0.1:8200/lab-api/v1")
A, B, B_ID = os.environ["LAB_COOKIE_ADMIN"], os.environ["LAB_COOKIE_B"], os.environ["LAB_USER_B_ID"]
DATA = os.path.expanduser(os.environ.get("MANGOLAB_DATA_DIR", "~/mangolab-data"))
fails = 0
def ok(c, m):
    global fails; fails += 0 if c else 1; print(("ok   " if c else "BAD  ") + m)
def client(cookie): return httpx.AsyncClient(base_url=URL, headers={"Cookie": f"oc_session={cookie}"}, timeout=120)

NB_WITH_OUTPUTS = {"nbformat": 4, "nbformat_minor": 4, "metadata": {"kernelspec": {"name": "python3", "display_name": "P3", "language": "python"}, "custom": {"keep": ["me", 1]}, "widgets": {"x": 1}},
    "cells": [
        {"cell_type": "markdown", "metadata": {"tags": ["intro"]}, "source": ["# Title\n", "text"]},
        {"cell_type": "code", "metadata": {"collapsed": True}, "execution_count": 3, "source": "print('hi')\n1/0",
         "outputs": [{"output_type": "stream", "name": "stdout", "text": ["hi\n"]},
                     {"output_type": "display_data", "metadata": {}, "data": {"image/png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "text/plain": ["<Figure>"]}},
                     {"output_type": "error", "ename": "ZeroDivisionError", "evalue": "division by zero", "traceback": ["\u001b[0;31mZeroDivisionError\u001b[0m"]}]},
        {"cell_type": "code", "metadata": {}, "execution_count": None, "source": "x = 1", "outputs": []}]}

async def main():
    async with client(A) as a, client(B) as b:
        print("== access")
        ok((await httpx.AsyncClient(base_url=URL).get("/projects")).status_code == 401, "no cookie -> 401")
        r = await a.post("/projects", json={"name": "Phase 1 test", "template": "welcome"}); ok(r.status_code == 201, f"create project -> {r.status_code}")
        P = r.json(); pid = P["id"]; ws = f"{DATA}/users/{(await a.get('/me')).json()['user']['id']}/projects/{pid}"
        r2 = await a.post("/projects", json={"name": "Phase 1 test", "template": "blank"}); ok(r2.status_code == 201 and r2.json()["slug"] == "phase-1-test-2", f"same name gets a unique slug ({r2.json().get('slug')})"); pid2 = r2.json()["id"]
        ok(oct(os.stat(ws).st_mode & 0o777) == "0o700", "workspace folder is private (700)")
        lst = (await a.get("/projects")).json(); ok(any(p["id"] == pid for p in lst["projects"]) and "limits" in lst, "listed with limits")
        print("== isolation between users (admins get no special access)")
        for who, c in (("other user", b),):
            ok((await c.get(f"/projects/{pid}")).status_code == 404, f"{who}: project looks nonexistent (404)")
            ok((await c.get(f"/projects/{pid}/files")).status_code == 404, f"{who}: cannot list files")
            ok((await c.get(f"/projects/{pid}/files/content", params={"path": "README.md"})).status_code == 404, f"{who}: cannot read a file")
            ok((await c.delete(f"/projects/{pid}")).status_code == 404, f"{who}: cannot delete the project")
        rb = await b.post("/projects", json={"name": "B's private", "template": "welcome"}); bpid = rb.json()["id"]
        ok((await a.get(f"/projects/{bpid}")).status_code == 404 and (await a.get(f"/projects/{bpid}/files")).status_code == 404, "the ADMIN cannot open another user's project either")
        ok(all(p["id"] != bpid for p in (await a.get("/projects")).json()["projects"]), "projects of others never appear in a list")

        print("== files")
        e = (await a.get(f"/projects/{pid}/files")).json()["entries"]; names = [x["name"] for x in e]
        ok(names == ["README.md", "welcome.ipynb"] and ".mangolab" not in names, f"root listing: {names} (internal folder hidden)")
        ok([x for x in e if x["name"] == "welcome.ipynb"][0]["is_notebook"], "notebooks are flagged")
        c = (await a.get(f"/projects/{pid}/files/content", params={"path": "README.md"})).json(); ok(c["content"].startswith("# Phase 1 test"), "read a text file")
        w = await a.put(f"/projects/{pid}/files/content", json={"path": "notes/a.txt", "content": "hello", "create_only": True}); ok(w.status_code == 200, "create a file (parents made)")
        w2 = await a.put(f"/projects/{pid}/files/content", json={"path": "notes/a.txt", "content": "hello 2", "base_etag": w.json()["etag"]}); ok(w2.status_code == 200, "edit with the current etag")
        w3 = await a.put(f"/projects/{pid}/files/content", json={"path": "notes/a.txt", "content": "stale", "base_etag": w.json()["etag"]}); ok(w3.status_code == 409 and w3.json()["code"] == "conflict", "edit with a stale etag -> 409 conflict, nothing overwritten")
        ok((await a.get(f"/projects/{pid}/files/content", params={"path": "notes/a.txt"})).json()["content"] == "hello 2", "stale save did not overwrite")
        ok((await a.post(f"/projects/{pid}/files/mkdir", json={"path": "data/raw"})).status_code == 201, "mkdir (nested)")
        up = await a.post(f"/projects/{pid}/files/upload", data={"dir": "data"}, files=[("files", ("x.csv", b"a,b\n1,2\n")), ("files", ("x.csv", b"a,b\n3,4\n")), ("files", ("пример файл.txt", b"unicode")), ("files", ("../../evil.txt", b"x"))])
        s = up.json()["saved"]; ok(up.status_code == 201 and [x["name"] for x in s] == ["x.csv", "x (1).csv", "пример файл.txt", "evil.txt"], f"upload: collisions renamed, path parts stripped: {[x['name'] for x in s]}")
        ok(not os.path.exists(f"{ws}/../evil.txt") and not os.path.exists(f"{DATA}/evil.txt"), "an upload name like ../../evil.txt cannot escape the folder")
        ok((await a.post(f"/projects/{pid}/files/upload", data={"dir": ".mangolab"}, files=[("files", ("a.txt", b"x"))])).status_code == 400, "cannot upload into the reserved internal folder")
        ok((await a.post(f"/projects/{pid}/files/upload", data={"dir": ""}, files=[("files", (f"f{i}.txt", b"x")) for i in range(51)])).status_code == 400, "more than 50 files in one upload refused")
        d = await a.get(f"/projects/{pid}/files/download", params={"path": "data/x.csv"}); ok(d.status_code == 200 and d.content == b"a,b\n1,2\n" and "attachment" in d.headers["content-disposition"] and d.headers["x-content-type-options"] == "nosniff" and "sandbox" in d.headers["content-security-policy"], "download: attachment + nosniff + sandbox CSP")
        await a.post(f"/projects/{pid}/files/upload", data={"dir": ""}, files=[("files", ("pic.png", b"\x89PNG..")), ("files", ("page.html", b"<script>alert(1)</script>")), ("files", ("v.svg", b"<svg onload=alert(1)/>"))])
        ok("inline" in (await a.get(f"/projects/{pid}/files/download", params={"path": "pic.png", "inline": "true"})).headers["content-disposition"], "png can be previewed inline")
        ok("attachment" in (await a.get(f"/projects/{pid}/files/download", params={"path": "page.html", "inline": "true"})).headers["content-disposition"] and "attachment" in (await a.get(f"/projects/{pid}/files/download", params={"path": "v.svg", "inline": "true"})).headers["content-disposition"], "html and svg are NEVER shown inline (forced download)")
        rn = await a.post(f"/projects/{pid}/files/rename", json={"from": "notes", "to": "docs/notes"}); ok(rn.status_code == 200 and (await a.get(f"/projects/{pid}/files", params={"path": "docs/notes"})).json()["entries"][0]["name"] == "a.txt", "rename/move a folder")
        ok((await a.post(f"/projects/{pid}/files/rename", json={"from": "pic.png", "to": "README.md"})).status_code == 409, "rename never overwrites an existing file")
        ok((await a.post(f"/projects/{pid}/files/rename", json={"from": "docs", "to": "docs/inner/deeper"})).status_code == 400, "cannot move a folder into itself")
        ok((await a.delete(f"/projects/{pid}/files", params={"path": "data/raw"})).status_code == 204, "delete a folder")

        print("== path attacks")
        for bad in ["../../../etc/passwd", "/etc/passwd", "a/../../b", "..", ".mangolab/revisions", "a\\b", "x" * 300, "a/\x00b"]:
            r = await a.get(f"/projects/{pid}/files/content", params={"path": bad}); ok(r.status_code in (400, 404, 422) and "root:" not in r.text, f"path {bad[:24]!r:30} -> {r.status_code}")
        decoy = "/tmp/claude-1000/decoy-secret.txt"; outside = "/tmp/claude-1000/outside-dir"; os.makedirs(outside, exist_ok=True); open(decoy, "w").write("SECRET-DECOY"); open(f"{outside}/loot.txt", "w").write("LOOT")
        os.symlink(decoy, f"{ws}/trojan.txt"); os.symlink(outside, f"{ws}/portal")   # what a malicious notebook could do
        ok(any(x["name"] == "trojan.txt" and x["kind"] == "link" for x in (await a.get(f"/projects/{pid}/files")).json()["entries"]), "links are listed as links")
        for label, r in (("read through a file link", await a.get(f"/projects/{pid}/files/content", params={"path": "trojan.txt"})),
                         ("download through a file link", await a.get(f"/projects/{pid}/files/download", params={"path": "trojan.txt"})),
                         ("list through a folder link", await a.get(f"/projects/{pid}/files", params={"path": "portal"})),
                         ("read through a folder link", await a.get(f"/projects/{pid}/files/content", params={"path": "portal/loot.txt"})),
                         ("write through a folder link", await a.put(f"/projects/{pid}/files/content", json={"path": "portal/new.txt", "content": "x"})),
                         ("upload through a folder link", await a.post(f"/projects/{pid}/files/upload", data={"dir": "portal"}, files=[("files", ("u.txt", b"x"))]))):
            ok(r.status_code in (403, 404) and "SECRET-DECOY" not in r.text and "LOOT" not in r.text, f"{label} refused ({r.status_code})")
        ok(not os.path.exists(f"{outside}/new.txt") and not os.path.exists(f"{outside}/u.txt"), "nothing was written outside the workspace")

        print("== notebooks")
        n = await a.post(f"/projects/{pid}/notebooks", json={"path": "work/model.ipynb", "template": "blank"}); ok(n.status_code == 201 and n.json()["notebook"]["nbformat_minor"] >= 5, "create notebook (parents made, nbformat 4.5)")
        ok((await a.post(f"/projects/{pid}/notebooks", json={"path": "work/model.ipynb"})).status_code == 409, "creating over an existing notebook is refused")
        ok((await a.post(f"/projects/{pid}/notebooks", json={"path": "work/model.txt"})).status_code == 422, "name must end in .ipynb")
        o = (await a.get(f"/projects/{pid}/notebooks", params={"path": "work/model.ipynb"})).json(); nb = o["notebook"]; et = o["etag"]
        nb["cells"][0]["source"] = "print('edited')"; s1 = await a.put(f"/projects/{pid}/notebooks", json={"path": "work/model.ipynb", "notebook": nb, "base_etag": et}); ok(s1.status_code == 200 and s1.json()["etag"] != et and s1.json()["version"] > o["version"], "save with the current etag")
        s2 = await a.put(f"/projects/{pid}/notebooks", json={"path": "work/model.ipynb", "notebook": nb, "base_etag": et}); ok(s2.status_code == 409 and s2.json()["code"] == "conflict", "save with a stale etag -> 409")
        s3 = await a.put(f"/projects/{pid}/notebooks", json={"path": "work/model.ipynb", "notebook": nb, "base_etag": et, "force": True}); ok(s3.status_code == 200, "force overwrite is possible when the user chooses it")
        ok((await a.put(f"/projects/{pid}/notebooks", json={"path": "work/model.ipynb", "notebook": {"cells": "nope"}, "force": True})).status_code == 422, "malformed notebook rejected (422), file untouched")
        ok((await a.put(f"/projects/{pid}/notebooks", json={"path": "work/model.ipynb", "notebook": {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [{"cell_type": "wizard", "source": ""}]}, "force": True})).status_code == 422, "invalid cell type rejected")
        print("== round trip fidelity (a notebook with outputs and custom metadata)")
        up = await a.post(f"/projects/{pid}/files/upload", data={"dir": "work"}, files=[("files", ("rich.ipynb", json.dumps(NB_WITH_OUTPUTS).encode()))]); ok(up.status_code == 201, "upload an existing .ipynb")
        o = (await a.get(f"/projects/{pid}/notebooks", params={"path": "work/rich.ipynb"})).json(); nb = o["notebook"]
        ok(all(c.get("id") for c in nb["cells"]) and len({c["id"] for c in nb["cells"]}) == 3, "missing cell ids were generated, all unique")
        sv = await a.put(f"/projects/{pid}/notebooks", json={"path": "work/rich.ipynb", "notebook": nb, "base_etag": o["etag"]}); o2 = (await a.get(f"/projects/{pid}/notebooks", params={"path": "work/rich.ipynb"})).json()["notebook"]
        ok(o2 == nb, "open -> save unchanged -> open gives an identical notebook")
        ok(o2["metadata"]["custom"] == {"keep": ["me", 1]} and o2["metadata"]["widgets"] == {"x": 1}, "unknown notebook metadata preserved")
        c1 = o2["cells"][1]; ok(c1["outputs"][1]["data"]["image/png"].startswith("iVBOR") and c1["outputs"][2]["ename"] == "ZeroDivisionError" and c1["execution_count"] == 3 and c1["metadata"] == {"collapsed": True}, "outputs, images, errors, counts and cell metadata preserved")
        dup = json.loads(json.dumps(nb)); dup["cells"][1]["id"] = dup["cells"][0]["id"]; await a.put(f"/projects/{pid}/notebooks", json={"path": "work/rich.ipynb", "notebook": dup, "force": True})
        o3 = (await a.get(f"/projects/{pid}/notebooks", params={"path": "work/rich.ipynb"})).json()["notebook"]; ok(len({c["id"] for c in o3["cells"]}) == 3, "duplicate cell ids repaired on save")
        v3 = {"nbformat": 3, "nbformat_minor": 0, "metadata": {}, "worksheets": [{"cells": [{"cell_type": "code", "input": "1+1", "outputs": [], "language": "python", "collapsed": False}]}]}
        await a.post(f"/projects/{pid}/files/upload", data={"dir": "work"}, files=[("files", ("old.ipynb", json.dumps(v3).encode()))]); r = await a.get(f"/projects/{pid}/notebooks", params={"path": "work/old.ipynb"}); ok(r.status_code == 200 and r.json()["notebook"]["nbformat"] == 4, "an old v3 notebook is upgraded to v4 on open")
        await a.post(f"/projects/{pid}/files/upload", data={"dir": "work"}, files=[("files", ("junk.ipynb", b"{not json"))]); r = await a.get(f"/projects/{pid}/notebooks", params={"path": "work/junk.ipynb"}); ok(r.status_code == 422 and "valid notebook" in r.json()["message"], "a corrupt .ipynb gives a clear 422, not a crash")
        print("== concurrent saves of the same notebook (exactly one may win)")
        o = (await a.get(f"/projects/{pid}/notebooks", params={"path": "work/model.ipynb"})).json(); nbx = o["notebook"]
        rs = await asyncio.gather(*[a.put(f"/projects/{pid}/notebooks", json={"path": "work/model.ipynb", "notebook": {**nbx, "metadata": {**nbx["metadata"], "n": i}}, "base_etag": o["etag"]}) for i in range(20)])
        codes = sorted(r.status_code for r in rs); ok(codes.count(200) == 1 and codes.count(409) == 19, f"20 simultaneous saves with the same base -> {codes.count(200)} saved, {codes.count(409)} conflicts")
        print("== revisions")
        # revisions are throttled to one per 5 minutes: the first save of the notebook above created one
        rv = (await a.get(f"/projects/{pid}/notebooks/revisions", params={"path": "work/model.ipynb"})).json()["revisions"]; ok(len(rv) == 1, f"a revision was kept ({len(rv)}), not one per save")
        cur = (await a.get(f"/projects/{pid}/notebooks", params={"path": "work/model.ipynb"})).json(); cur["notebook"]["cells"][0]["source"] = "x = 'newer'"
        await a.put(f"/projects/{pid}/notebooks", json={"path": "work/model.ipynb", "notebook": cur["notebook"], "base_etag": cur["etag"]})
        rs = await a.post(f"/projects/{pid}/notebooks/revisions/restore", json={"path": "work/model.ipynb", "revision_id": rv[0]["id"]}); ok(rs.status_code == 200 and rs.json()["notebook"]["cells"][0]["source"] != "x = 'newer'", "restore an older version")
        ok(len((await a.get(f"/projects/{pid}/notebooks/revisions", params={"path": "work/model.ipynb"})).json()["revisions"]) == 2, "restoring first keeps the current version, so it can be undone")
        ok((await b.post(f"/projects/{bpid}/notebooks/revisions/restore", json={"path": "work/model.ipynb", "revision_id": rv[0]["id"]})).status_code in (404,), "a revision id from someone else's notebook is useless")
        print("== notebook rows follow renames and deletes")
        await a.post(f"/projects/{pid}/files/rename", json={"from": "work", "to": "experiments"}); r = await a.get(f"/projects/{pid}/notebooks", params={"path": "experiments/model.ipynb"}); ok(r.status_code == 200 and r.json()["version"] > 1, "after renaming the folder the notebook keeps its identity and history")
        ok(len((await a.get(f"/projects/{pid}/notebooks/revisions", params={"path": "experiments/model.ipynb"})).json()["revisions"]) == 2, "revision history followed the rename")
        print("== quota")
        r = await a.put(f"/admin/users/{(await a.get('/me')).json()['user']['id']}/access", json={"disk_quota_mb": 256}); ok(r.status_code == 200, "admin sets own quota to 256 MB for the test")
        big = os.urandom(100 * 1024 * 1024)
        r1 = await a.post(f"/projects/{pid}/files/upload", data={"dir": "big"}, files=[("files", ("b1.bin", big))]); r2 = await a.post(f"/projects/{pid}/files/upload", data={"dir": "big"}, files=[("files", ("b2.bin", big))]); r3 = await a.post(f"/projects/{pid}/files/upload", data={"dir": "big"}, files=[("files", ("b3.bin", big))])
        ok(r1.status_code == 201 and r2.status_code == 201 and r3.status_code == 413 and r3.json()["code"] == "quota_exceeded", f"quota: 100 MB x3 against 256 MB -> {r1.status_code}, {r2.status_code}, {r3.status_code} quota_exceeded")
        ok(not any(n.startswith(".tmp-") for n in os.listdir(f"{ws}/big")), "a refused upload leaves no temp files")
        await a.delete(f"/projects/{pid}/files", params={"path": "big"}); r = await a.post(f"/projects/{pid}/files/upload", data={"dir": ""}, files=[("files", ("after.bin", big[:1000]))]); ok(r.status_code == 201, "space is available again after deleting")
        await a.put(f"/admin/users/{(await a.get('/me')).json()['user']['id']}/access", json={"disk_quota_mb": 20480})
        print("== deleting a project with links inside never touches their targets")
        pr = await a.get(f"/projects/{pid}"); ok(pr.json()["used_bytes"] > 0, "usage is reported")
        dl = await a.delete(f"/projects/{pid}"); ok(dl.status_code == 204 and not os.path.exists(ws), "project folder removed from disk")
        ok(open(decoy).read() == "SECRET-DECOY" and open(f"{outside}/loot.txt").read() == "LOOT", "files that links pointed at are untouched")
        ok((await a.get(f"/projects/{pid}")).status_code == 404 and (await a.get(f"/projects/{pid}/notebooks", params={"path": "experiments/model.ipynb"})).status_code == 404, "project and notebooks are gone")
        await a.delete(f"/projects/{pid2}"); await b.delete(f"/projects/{bpid}")
    print(f"\n{'ALL CHECKS PASSED' if not fails else str(fails) + ' CHECK(S) FAILED'}"); sys.exit(1 if fails else 0)

asyncio.run(main())
