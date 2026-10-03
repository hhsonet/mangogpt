"""
End-to-end checks for Phase 3 against a RUNNING MangoLab API (real kernels, GPU, network for pip). Not part of `pytest`. Usage:
  LAB_COOKIE_ADMIN=... LAB_COOKIE_B=... LAB_USER_B_ID=... python tests/integration_phase3.py
For fast limit checks start the API with SAMPLE_INTERVAL_S=1. It changes user B's limits (GPU 512 MiB, disk 256 MB).
"""
import asyncio, json, os, subprocess, sys, time
import httpx, websockets

HOST = os.environ.get("LAB_HOST", "127.0.0.1:8200"); API = f"http://{HOST}/lab-api/v1"; ORIGIN = f"http://{HOST}"
A, B, B_ID = os.environ["LAB_COOKIE_ADMIN"], os.environ["LAB_COOKIE_B"], os.environ["LAB_USER_B_ID"]
DATA = os.path.expanduser(os.environ.get("MANGOLAB_DATA_DIR", "~/mangolab-data"))
fails = 0
def ok(c, m):
    global fails; fails += 0 if c else 1; print(("ok   " if c else "BAD  ") + m, flush=True)
def hdr(cookie): return {"Cookie": f"oc_session={cookie}"}
def client(cookie): return httpx.AsyncClient(base_url=API, headers=hdr(cookie), timeout=180)
def unit_names(): return set(subprocess.run("systemctl --user list-units 'mangolab*' --all --no-legend --plain | awk '{print $1}'", shell=True, capture_output=True, text=True).stdout.split())
TERMINAL = ("ok", "error", "aborted", "died")


class Sock:
    def __init__(self, cookie, pid): self.cookie, self.pid, self.log = cookie, pid, []; self.ws = None
    async def open(self):
        self.ws = await websockets.connect(f"ws://{HOST}/lab-ws/v1/projects/{self.pid}/runtime", additional_headers={**hdr(self.cookie), "Origin": ORIGIN}, max_size=2**26); return self
    async def send(self, **m): await self.ws.send(json.dumps(m))
    async def recv(self, timeout=60):
        m = json.loads(await asyncio.wait_for(self.ws.recv(), timeout)); self.log.append(m); return m
    async def until(self, pred, timeout=60):
        end = time.time() + timeout
        while True:
            m = await self.recv(max(0.1, end - time.time()))
            if pred(m): return m
    async def run(self, path, code, cell="c", timeout=120):
        await self.send(type="execute", path=path, cell_id=cell, code=code); evs = []
        while True:
            m = await self.recv(timeout)
            if m["type"] == "error": return evs + [m], "error-msg"
            if m.get("cell_id") != cell: continue
            evs.append(m)
            if m["type"] == "exec" and m["state"] in TERMINAL: return evs, m["state"]
    async def close(self):
        if self.ws: await self.ws.close()

def text_of(evs): return "".join(e["output"]["text"] for e in evs if e["type"] == "output" and e["output"]["output_type"] == "stream")
def errs_of(evs): return [e["output"] for e in evs if e["type"] == "output" and e["output"]["output_type"] == "error"]
async def start(c, s, pid):
    r = await c.post(f"/projects/{pid}/runtime"); assert r.status_code == 202, r.text
    await s.until(lambda m: m["type"] == "runtime" and m["status"] in ("running", "none"), 60); return s.log[-1]["status"] == "running"


class Term:
    def __init__(self, cookie, pid, tid): self.cookie, self.pid, self.tid, self.buf, self.ws = cookie, pid, tid, "", None; self.events = []
    async def open(self):
        self.ws = await websockets.connect(f"ws://{HOST}/lab-ws/v1/projects/{self.pid}/terminals/{self.tid}", additional_headers={**hdr(self.cookie), "Origin": ORIGIN}); return self
    async def pump(self, secs):
        end = time.time() + secs
        while time.time() < end:
            try: m = json.loads(await asyncio.wait_for(self.ws.recv(), max(0.05, end - time.time())))
            except (asyncio.TimeoutError, websockets.ConnectionClosed): return
            self.events.append(m["type"])
            if m["type"] in ("output", "replay"): self.buf += m["data"]
    async def type(self, text): await self.ws.send(json.dumps({"type": "input", "data": text}))
    async def wait_for(self, needle, timeout=15):
        end = time.time() + timeout
        while needle not in self.buf and time.time() < end: await self.pump(0.3)
        return needle in self.buf


async def main():
    baseline = unit_names()
    async with client(A) as a, client(B) as b:
        await a.put(f"/admin/users/{B_ID}/access", json={"enabled": True, "mem_max_mb": 2048, "gpu_budget_mib": 512, "disk_quota_mb": 256, "max_runtimes": 1, "cpu_quota_pct": 200})
        pa = (await a.post("/projects", json={"name": "P3 admin", "template": "blank"})).json()["id"]
        pb = (await b.post("/projects", json={"name": "P3 b", "template": "blank"})).json()["id"]
        try:
            await a.post(f"/projects/{pa}/notebooks", json={"path": "n.ipynb", "template": "blank"}); N = "n.ipynb"
            ws_a = f"{DATA}/users/{(await a.get('/me')).json()['user']['id']}/projects/{pa}"

            print("== package validation and permissions")
            for bad in ("-e .", "--index-url http://evil/simple pkg", "git+https://github.com/x/y.git", "../../etc/passwd", "pkg; rm -rf ~", "pkg @ http://x/y.whl", "", "a" * 300):
                r = await a.post(f"/projects/{pa}/packages/install", json={"specs": [bad]}); ok(r.status_code == 422, f"refused: {bad[:34]!r} ({r.status_code})")
            ok((await a.post(f"/projects/{pa}/packages/install", json={"specs": ["x"] * 21})).status_code == 422, "more than 20 packages refused")
            ok((await b.post(f"/projects/{pa}/packages/install", json={"specs": ["six"]})).status_code == 404, "other user cannot install into my project")
            ok((await b.get(f"/projects/{pa}/packages")).status_code == 404, "other user cannot list my packages")

            print("== install, use, uninstall")
            s = await Sock(A, pa).open(); await s.recv()
            r = await a.post(f"/projects/{pa}/packages/install", json={"specs": ["tabulate==0.9.0"]}); ok(r.status_code == 202, "install accepted without a runtime")
            jid = r.json()["id"]; ok((await a.post(f"/projects/{pa}/packages/install", json={"specs": ["six"]})).status_code == 409, "a second job at the same time is refused")
            ok((await b.get(f"/projects/{pa}/packages/jobs/{jid}")).status_code == 404, "other user cannot read my job")
            off = 0; log = ""; t0 = time.time()
            while time.time() - t0 < 120:
                j = (await a.get(f"/projects/{pa}/packages/jobs/{jid}", params={"offset": off})).json(); log += j["log"]; off = j["next_offset"]
                if j["status"] != "running": break
                await asyncio.sleep(0.5)
            ok(j["status"] == "ok" and "tabulate" in log and log.startswith("$ pip install"), f"install finished ({j['status']}) and its log was streamed")
            pk = (await a.get(f"/projects/{pa}/packages")).json(); ok(any(p["name"] == "tabulate" and p["version"] == "0.9.0" for p in pk["installed"]), "listed as installed")
            ok(not any(p["name"] in ("torch", "numpy") for p in pk["installed"]) and any(p["name"] == "torch" for p in pk["shared"]), "PyTorch/NumPy come from the shared environment, not copied into the project")
            ok(os.path.isdir(f"{ws_a}/.mangolab/venv"), "project environment lives inside the workspace (counted in the disk quota)")
            ok(await start(a, s, pa), "runtime starts on the project's environment"); await s.send(type="attach", path=N); await s.until(lambda m: m["type"] == "snapshot", 10)
            evs, st = await s.run(N, "import sys, tabulate, torch; print(sys.executable.endswith('.mangolab/venv/bin/python'), tabulate.__version__, torch.__version__.split('+')[0])"); ok(text_of(evs).strip().startswith("True 0.9.0 2."), f"kernel sees project and shared packages ({text_of(evs).strip()})")
            evs, st = await s.run(N, "%pip install --quiet six"); ok(st == "ok", f"%pip install works inside a notebook ({st})")
            evs, st = await s.run(N, "import six; print(six.__version__)"); ok(st == "ok" and text_of(evs).strip()[0].isdigit(), "a package installed with %pip imports without restarting")
            r = await a.post(f"/projects/{pa}/packages/uninstall", json={"specs": ["tabulate"]}); jid = r.json()["id"]
            for _ in range(60):
                j = (await a.get(f"/projects/{pa}/packages/jobs/{jid}")).json()
                if j["status"] != "running": break
                await asyncio.sleep(0.5)
            ok(j["status"] == "ok" and not any(p["name"] == "tabulate" for p in (await a.get(f"/projects/{pa}/packages")).json()["installed"]), "uninstall removes it")
            r = await a.post(f"/projects/{pa}/packages/install", json={"specs": ["zzzz-no-such-package-xyz"]}); jid = r.json()["id"]
            for _ in range(60):
                j = (await a.get(f"/projects/{pa}/packages/jobs/{jid}")).json()
                if j["status"] != "running": break
                await asyncio.sleep(0.5)
            ok(j["status"] == "error" and "No matching distribution" in j["log"] + "", f"a failing install reports an error ({j['status']})")
            ok((await a.delete(f"/projects/{pa}/packages/environment")).status_code == 409, "cannot reset packages while the runtime runs")

            print("== terminals")
            ok((await b.post(f"/projects/{pb}/terminals")).status_code == 409, "terminal needs a connected runtime")
            r = await a.post(f"/projects/{pa}/terminals"); ok(r.status_code == 201, "terminal created"); tid = r.json()["id"]
            t = await Term(A, pa, tid).open(); await t.pump(1.5)
            await t.type("echo hello-$((6*7))\r"); ok(await t.wait_for("hello-42"), "typing runs commands")
            await t.type("pwd; which python; python -c 'import torch;print(\"torch-ok\")'\r"); ok(await t.wait_for("torch-ok", 30) and f"/{pa}" in t.buf and ".mangolab/venv/bin/python" in t.buf, "starts in the workspace with the project's Python and PyTorch")
            await t.ws.send(json.dumps({"type": "resize", "cols": 120, "rows": 30})); await t.type("stty size\r"); ok(await t.wait_for("30 120"), "resize reaches the shell")
            await t.type("cat /proc/self/cgroup\r"); ok(await t.wait_for("mangolabrt"), "the shell runs inside the runtime's resource group")
            await t.type("sleep 100\r"); await t.pump(0.5); await t.type("\x03"); await t.type("echo back-$((1+1))\r"); ok(await t.wait_for("back-2"), "Ctrl+C stops a running command")
            await t.type("ulimit -n; echo MARK\r"); await t.wait_for("MARK"); ok("8192" in t.buf, "open-file limit is applied")
            await t.ws.close(); await asyncio.sleep(0.3)
            t2 = await Term(A, pa, tid).open(); await t2.pump(1.0); ok("hello-42" in t2.buf and "replay" in t2.events, "reconnecting replays what was on screen")
            await t2.ws.close()
            ids = [tid]
            for i in range(2): ids.append((await a.post(f"/projects/{pa}/terminals")).json()["id"])
            ok((await a.post(f"/projects/{pa}/terminals")).status_code == 409, "at most 3 terminals per runtime")
            try:
                await websockets.connect(f"ws://{HOST}/lab-ws/v1/projects/{pa}/terminals/{tid}", additional_headers={**hdr(B), "Origin": ORIGIN}); ok(False, "other user connected to my terminal")
            except websockets.InvalidStatus as e: ok(e.response.status_code == 403, "other user cannot attach to my terminal")
            t3 = await Term(A, pa, ids[1]).open(); await t3.pump(1.0); await t3.type("exit\r"); await t3.pump(3); ok("exit" in t3.events, "exiting the shell closes the terminal")
            await asyncio.sleep(0.5); ok(len((await a.get(f"/projects/{pa}/terminals")).json()["terminals"]) == 2, "closed terminal leaves the list")
            ok((await a.delete(f"/projects/{pa}/terminals/{ids[2]}")).status_code == 200, "close from the API"); await asyncio.sleep(0.5)

            print("== monitoring")
            await asyncio.sleep(4)
            h = (await a.get(f"/projects/{pa}/runtime/history", params={"minutes": 5})).json()["samples"]; ok(len(h) >= 2 and all(x["ram_mb"] for x in h[-2:]), f"history has samples ({len(h)})")
            await asyncio.sleep(4); h2 = (await a.get(f"/projects/{pa}/runtime/history", params={"minutes": 60})).json()["samples"]; ok(len(h2) >= 1, f"longer history comes from the database ({len(h2)} rows)")
            try: u = await s.until(lambda m: m["type"] == "usage" and m.get("disk_quota_mb"), 20); ok(u["disk_quota_mb"] and u["disk_mb"] is not None, f"usage events include disk use ({u['disk_mb']} of {u['disk_quota_mb']} MB)")
            except asyncio.TimeoutError: ok(False, "usage events include the disk quota")
            ok((await b.get(f"/projects/{pa}/runtime/history")).status_code == 404, "other user cannot read my history")

            print("== runtime stop takes terminals and installs with it")
            await a.delete(f"/projects/{pa}/runtime"); await asyncio.sleep(1.5)
            ok((await a.get(f"/projects/{pa}/terminals")).json()["terminals"] == [], "terminals are closed with the runtime")
            left = unit_names() - baseline; ok(not left, f"no systemd units left behind ({sorted(left)})")
            ok((await a.delete(f"/projects/{pa}/packages/environment")).status_code == 200 and not os.path.exists(f"{ws_a}/.mangolab/venv"), "reset removes the project's packages")
            ok(not (await a.get(f"/projects/{pa}/packages")).json()["installed"], "installed list is empty after reset")
            await s.close(); s = await Sock(A, pa).open(); await s.recv(); ok(await start(a, s, pa), "runtime starts again after a reset (environment recreated)"); await s.send(type="attach", path=N); await s.until(lambda m: m["type"] == "snapshot", 10)
            evs, st = await s.run(N, "import torch; print('ok', torch.cuda.is_available())"); ok("ok True" in text_of(evs), "the fresh environment still has the shared packages")
            await a.delete(f"/projects/{pa}/runtime"); await s.close()

            print("== GPU budget is enforced (user B: 512 MiB)")
            sb = await Sock(B, pb).open(); await sb.recv(); await b.post(f"/projects/{pb}/notebooks", json={"path": "g.ipynb", "template": "blank"}); G = "g.ipynb"
            ok(await start(b, sb, pb), "user B's runtime starts"); await sb.send(type="attach", path=G); await sb.until(lambda m: m["type"] == "snapshot", 10)
            evs, st = await sb.run(G, "import torch; x = torch.zeros(1024*1024*1024//4, device='cuda'); torch.cuda.synchronize(); print('allocated 1 GiB')", timeout=60); ok("allocated 1 GiB" in text_of(evs), "allocation itself is allowed (the budget is checked by the watchdog)")
            await sb.send(type="execute", path=G, cell_id="hold", code="import time\nwhile True: time.sleep(1)"); t0 = time.time()
            lim = await sb.until(lambda m: m["type"] == "limit" and m["kind"] == "gpu" and m["level"] == "stopped", 90); ok("512 MiB" in lim["message"], f"watchdog stops the over-budget process after {time.time()-t0:.0f}s: {lim['message'][:70]}...")
            fin = await sb.until(lambda m: m.get("cell_id") in ("hold", "c") and m["type"] == "exec" and m["state"] in TERMINAL, 30); ok(fin["state"] in ("died", "aborted"), f"the running cell ends as {fin['state']}")
            died = [e for e in sb.log if e.get("type") == "output" and e.get("cell_id") == "hold" and "GPU memory" in json.dumps(e["output"])]; ok(bool(died), "the cell's output says it was the GPU limit")
            await sb.until(lambda m: m["type"] == "kernel" and m["state"] == "idle", 40) if sb.log[-1].get("state") != "idle" else None; await asyncio.sleep(1)
            evs, st = await sb.run(G, "print('still here')"); ok(text_of(evs) == "still here\n", "the kernel is restarted and usable afterwards")

            print("== disk limit is enforced while code runs (user B: 256 MB)")
            evs, st = await sb.run(G, "open('big.bin','wb').write(b'0' * (300 * 1024 * 1024)); print('written')", timeout=60); ok("written" in text_of(evs), "kernel can write past the quota (nothing prevents the write itself)")
            lim = await sb.until(lambda m: m["type"] == "limit" and m["kind"] == "disk" and m["level"] in ("blocked", "stopped"), 60); ok(lim["level"] == "blocked", f"disk guard pauses running: {lim['message'][:60]}...")
            await sb.send(type="execute", path=G, cell_id="x", code="print('should be refused')"); m = await sb.until(lambda m: m["type"] == "error", 10); ok(m["code"] == "disk_full", "new cells are refused while over quota")
            ok(not any(f.endswith("big.bin") for f in []) and (await b.delete(f"/projects/{pb}/files", params={"path": "big.bin"})).status_code in (200, 204), "deleting the file is still possible")
            lim = await sb.until(lambda m: m["type"] == "limit" and m["kind"] == "disk" and m["level"] == "ok", 60); ok(True, "running resumes by itself once there is room")
            evs, st = await sb.run(G, "print('resumed')"); ok(text_of(evs) == "resumed\n", "cells run again")
            await b.delete(f"/projects/{pb}/runtime"); await sb.close()
        finally:
            for c, p in ((a, pa), (b, pb)):
                await c.delete(f"/projects/{p}/runtime"); await c.delete(f"/projects/{p}")
        await asyncio.sleep(1); left = unit_names() - baseline; ok(not left, f"cleanup left no units ({sorted(left)})")
    print(f"\n{'ALL PASSED' if not fails else str(fails) + ' FAILED'}"); sys.exit(1 if fails else 0)

asyncio.run(main())
