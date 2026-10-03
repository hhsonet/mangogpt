"""
End-to-end checks for runtimes and kernels against a RUNNING MangoLab API (needs the real kernel environment and GPU).
Not part of `pytest`. Usage:
  LAB_COOKIE_ADMIN=<oc_session of an admin> LAB_COOKIE_B=<oc_session of an enabled regular user> LAB_USER_B_ID=<that user's id> \
  [LAB_RESTART_CMD='script that restarts the API and waits until it is healthy'] python tests/integration_phase2.py
It changes user B's MangoLab limits (RAM 1 GiB, one runtime) and leaves them that way.
"""
import asyncio, json, os, subprocess, sys, time
import httpx, websockets

HOST = os.environ.get("LAB_HOST", "127.0.0.1:8200"); API = f"http://{HOST}/lab-api/v1"; ORIGIN = f"http://{HOST}"
A, B, B_ID = os.environ["LAB_COOKIE_ADMIN"], os.environ["LAB_COOKIE_B"], os.environ["LAB_USER_B_ID"]
fails = 0
def ok(c, m):
    global fails; fails += 0 if c else 1; print(("ok   " if c else "BAD  ") + m, flush=True)
def hdr(cookie): return {"Cookie": f"oc_session={cookie}"}
def client(cookie): return httpx.AsyncClient(base_url=API, headers=hdr(cookie), timeout=120)
TERMINAL = ("ok", "error", "aborted", "died")


class Sock:
    """A browser stand-in: one project socket, an event log, and helpers."""
    def __init__(self, cookie, pid): self.cookie, self.pid, self.log = cookie, pid, []; self.ws = None
    async def open(self, origin=ORIGIN):
        self.ws = await websockets.connect(f"ws://{HOST}/lab-ws/v1/projects/{self.pid}/runtime", additional_headers={**hdr(self.cookie), **({"Origin": origin} if origin else {})}, max_size=2**26)
        return self
    async def send(self, **m): await self.ws.send(json.dumps(m))
    async def recv(self, timeout=60):
        m = json.loads(await asyncio.wait_for(self.ws.recv(), timeout)); self.log.append(m); return m
    async def until(self, pred, timeout=60):
        end = time.time() + timeout
        while True:
            m = await self.recv(max(0.1, end - time.time()))
            if pred(m): return m
    async def attach(self, path):
        await self.send(type="attach", path=path); return await self.until(lambda m: m["type"] == "snapshot" and m["path"] == path, 10)
    async def run(self, path, code, cell="c", timeout=90):
        """Executes one cell and returns (events of that execution, final state)."""
        await self.send(type="execute", path=path, cell_id=cell, code=code); evs = []; mid = None
        while True:
            m = await self.recv(timeout)
            if m["type"] == "error": return evs + [m], "error-msg"
            if m.get("cell_id") != cell: continue
            if m["type"] == "exec": mid = m["msg_id"]
            evs.append(m)
            if m["type"] == "exec" and m["state"] in TERMINAL: return evs, m["state"]
    async def close(self):
        if self.ws: await self.ws.close()

def text_of(evs): return "".join(e["output"]["text"] for e in evs if e["type"] == "output" and e["output"]["output_type"] == "stream")
def outs(evs, kind): return [e["output"] for e in evs if e["type"] == "output" and e["output"]["output_type"] == kind]
async def wait_running(s, timeout=40): await s.until(lambda m: m["type"] == "runtime" and m["status"] in ("running", "none"), timeout); return s.log[-1]["status"] == "running"
async def start(c, s, pid):
    r = await c.post(f"/projects/{pid}/runtime"); assert r.status_code == 202, r.text
    return await wait_running(s)


def unit_names(): return set(subprocess.run("systemctl --user list-units 'mangolab*' --all --no-legend --plain | awk '{print $1}'", shell=True, capture_output=True, text=True).stdout.split())

async def main():
    baseline = unit_names()  # other people's runtimes may be running; only compare what this test adds
    async with client(A) as a, client(B) as b:
        # user B gets small limits so the memory-limit test is cheap
        r = await a.put(f"/admin/users/{B_ID}/access", json={"enabled": True, "mem_max_mb": 1024, "cpu_quota_pct": 200, "max_runtimes": 1, "gpu_budget_mib": 2048}); ok(r.status_code == 200, "admin set user B limits")
        pa = (await a.post("/projects", json={"name": "P2 admin", "template": "blank"})).json()["id"]
        pb = (await b.post("/projects", json={"name": "P2 b one", "template": "blank"})).json()["id"]
        pb2 = (await b.post("/projects", json={"name": "P2 b two", "template": "blank"})).json()["id"]
        try:
            await a.post(f"/projects/{pa}/notebooks", json={"path": "n.ipynb", "template": "blank"}); await a.post(f"/projects/{pa}/files/mkdir", json={"path": "sub"})
            await a.post(f"/projects/{pa}/notebooks", json={"path": "sub/m.ipynb", "template": "blank"})
            N = "n.ipynb"

            print("== socket security")
            for label, cookie, origin in (("no cookie", "", ORIGIN), ("wrong origin", A, "https://evil.example"), ("other user's project", B, ORIGIN)):
                try:
                    ws = await websockets.connect(f"ws://{HOST}/lab-ws/v1/projects/{pa}/runtime", additional_headers={**({"Cookie": f"oc_session={cookie}"} if cookie else {}), "Origin": origin})
                    await ws.close(); ok(False, f"{label}: was accepted")
                except websockets.InvalidStatus as e: ok(e.response.status_code == 403, f"{label}: handshake refused (HTTP {e.response.status_code})")
            ok((await b.get(f"/projects/{pa}/runtime")).status_code == 404, "other user cannot read a project's runtime status")
            ok((await b.post(f"/projects/{pa}/runtime")).status_code == 404, "other user cannot start someone else's runtime")
            ok((await b.delete(f"/projects/{pa}/runtime")).status_code == 404, "other user cannot stop someone else's runtime")
            ok((await b.get("/admin/runtimes")).status_code == 403, "regular user cannot list all runtimes")

            print("== start, run, stream")
            s = await Sock(A, pa).open(); hello = await s.recv(); ok(hello["type"] == "hello" and hello["runtime"]["status"] == "none", "hello says no runtime yet")
            r1 = await a.post(f"/projects/{pa}/runtime"); ok(r1.status_code == 202, "start -> 202")
            r2 = await a.post(f"/projects/{pa}/runtime"); ok(r2.json()["runtime_id"] == r1.json()["runtime_id"], "starting twice is idempotent")
            t0 = time.time(); ok(await wait_running(s), f"runtime running after {time.time()-t0:.1f}s")
            ok(len((await a.get("/admin/runtimes")).json()["runtimes"]) >= 1, "admin sees the runtime")
            snap = await s.attach(N); ok(snap["kernel"] == "none" and snap["executions"] == [], "attach: empty snapshot before any run")
            evs, st = await s.run(N, "print(1+1)\n2*21"); ok(st == "ok" and text_of(evs) == "2\n" and outs(evs, "execute_result")[0]["data"]["text/plain"] == "42", "stdout and execute_result")
            ok([e["state"] for e in evs if e["type"] == "exec"][0] == "queued" and any(e.get("execution_count") == 1 for e in evs if e["type"] == "exec"), "states queued -> running -> ok with execution_count 1")
            evs, st = await s.run(N, "x = 41"); evs, st = await s.run(N, "print(x + 1)"); ok(text_of(evs) == "42\n", "variables persist between cells")
            evs, st = await s.run(N, "import os; print(os.getcwd())"); ok(text_of(evs).strip().endswith(f"/{pa}"), "notebook runs in its project workspace")
            evs, st = await s.run(N, "import torch; print(torch.cuda.is_available(), torch.zeros(1, device='cuda').device)"); ok("True cuda:0" in text_of(evs), "CUDA PyTorch works")
            t_first = None; t_start = time.time(); await s.send(type="execute", path=N, cell_id="stream", code="import time\nfor i in range(4):\n    print('tick', i, flush=True); time.sleep(0.5)")
            stamps = []
            while True:
                m = await s.recv()
                if m.get("cell_id") == "stream" and m["type"] == "output": stamps.append(time.time() - t_start)
                if m.get("cell_id") == "stream" and m["type"] == "exec" and m["state"] in TERMINAL: break
            ok(len(stamps) >= 3 and stamps[0] < 1.0 and stamps[-1] - stamps[0] > 1.0, f"output streams while the cell runs (first at {stamps[0]:.2f}s, last at {stamps[-1]:.2f}s)")
            evs, st = await s.run(N, "import matplotlib.pyplot as plt, numpy as np\nplt.plot(np.sin(np.linspace(0,6,50)))\nplt.show()"); png = [o for o in outs(evs, "display_data") if "image/png" in o["data"]]; ok(st == "ok" and len(png) == 1 and len(png[0]["data"]["image/png"]) > 1000, "matplotlib plot arrives as image/png")
            evs, st = await s.run(N, "1/0"); err = outs(evs, "error"); ok(st == "error" and err and err[0]["ename"] == "ZeroDivisionError" and err[0]["traceback"], "errors carry name and traceback")
            evs, st = await s.run(N, "import sys; print('to stderr', file=sys.stderr)"); ok(outs(evs, "stream")[0]["name"] == "stderr", "stderr is a separate stream")
            evs, st = await s.run(N, "import time\nfor i in range(60):\n    print(f'\\r{i:3d}%', end='', flush=True)"); ok(text_of(evs).endswith("59%") and st == "ok", "carriage-return progress output")
            snap_text = None
            evs, st = await s.run(N, "from IPython.display import display, clear_output\nh = display('first', display_id='d1')\nh.update('second')\nprint('a'); clear_output(wait=False); print('b')")
            ok(any(e["type"] == "update_display" and e["data"]["text/plain"] == "'second'" for e in evs) and any(e["type"] == "clear_output" for e in evs), "update_display and clear_output events")
            evs, st = await s.run(N, "x" * 10, cell="c") ; evs, st = await s.run(N, "print('€ ünï')"); ok(text_of(evs) == "€ ünï\n", "unicode output")
            await s.send(type="execute", path=N, cell_id="big", code="y" * 1_200_000); m = await s.until(lambda m: m["type"] == "error"); ok(m["code"] == "code_too_large", "oversized cell refused")
            await s.send(type="execute", path="../evil.ipynb", cell_id="x", code="1"); m = await s.until(lambda m: m["type"] == "error"); ok(m["code"] == "bad_request", "path traversal in the socket is refused")
            await s.send(type="execute", path="notes.txt", cell_id="x", code="1"); m = await s.until(lambda m: m["type"] == "error"); ok(m["code"] == "bad_request", "only notebooks can run code")

            print("== queue, stop on error, interrupt, restart")
            for i, code in enumerate(["raise ValueError('boom')", "print('should not run')", "print('nor this')"]):
                await s.send(type="execute", path=N, cell_id=f"q{i}", code=code)
            final = {}
            while len(final) < 3:
                m = await s.recv()
                if m["type"] == "exec" and m["state"] in TERMINAL: final[m["cell_id"]] = m["state"]
            ok(final == {"q0": "error", "q1": "aborted", "q2": "aborted"}, f"after an error the queued cells are aborted ({final})")
            evs, st = await s.run(N, "print('still alive')"); ok(text_of(evs) == "still alive\n", "kernel is usable after an aborted queue")
            await s.send(type="execute", path=N, cell_id="long", code="import time\ntime.sleep(60)"); await s.until(lambda m: m["type"] == "exec" and m["cell_id"] == "long" and m["state"] == "running")
            t = time.time(); await s.send(type="interrupt", path=N); m = await s.until(lambda m: m["type"] == "exec" and m["cell_id"] == "long" and m["state"] in TERMINAL, 20)
            ok(m["state"] == "error" and time.time() - t < 5, f"interrupt stops a 60 s sleep in {time.time()-t:.1f}s")
            evs, st = await s.run(N, "z = 5"); await s.send(type="restart", path=N); await s.until(lambda m: m["type"] == "kernel" and m["state"] == "restarting", 10); await s.until(lambda m: m["type"] == "kernel" and m["state"] == "idle", 30)
            evs, st = await s.run(N, "print(z)"); ok(st == "error" and outs(evs, "error")[0]["ename"] == "NameError", "restart clears the kernel's variables")
            ok(any(e.get("execution_count") == 1 for e in evs if e["type"] == "exec"), "execution counter starts over after restart")
            evs, st = await s.run(N, "import os; print(os.getcwd().endswith('" + pa + "'))"); ok("True" in text_of(evs), "working folder is restored after a restart")

            print("== notebooks in sub-folders, rename and delete")
            M = "sub/m.ipynb"; await s.attach(M)
            evs, st = await s.run(M, "import os; print(os.getcwd().endswith('/sub')); open('made.txt','w').write('hi'); mvar = 9"); ok("True" in text_of(evs), "notebook in a folder runs in that folder")
            ok(any(e["name"] == "made.txt" for e in (await a.get(f"/projects/{pa}/files", params={"path": "sub"})).json()["entries"]), "file written by the kernel shows in the file API")
            await a.post(f"/projects/{pa}/files/rename", json={"from": "sub/m.ipynb", "to": "sub/renamed.ipynb"}); m = await s.until(lambda m: m["type"] == "renamed", 5); ok(m["to"] == "sub/renamed.ipynb", "rename is announced")
            evs, st = await s.run("sub/renamed.ipynb", "print(mvar)"); ok(text_of(evs) == "9\n", "renamed notebook keeps its kernel and variables")
            ok(any(k["path"] == "sub/renamed.ipynb" for k in (await a.get(f"/projects/{pa}/runtime")).json()["kernels"]), "status lists the kernel under the new name")
            await a.delete(f"/projects/{pa}/files", params={"path": "sub/renamed.ipynb"}); await asyncio.sleep(0.5)
            ok(not any(k["path"].startswith("sub/") for k in (await a.get(f"/projects/{pa}/runtime")).json()["kernels"]), "deleting a notebook ends its kernel")

            print("== reconnecting browsers get what they missed")
            await s.run(N, "print('warm')"); await s.send(type="execute", path=N, cell_id="bg", code="import time\nfor i in range(6):\n    print('step', i, flush=True); time.sleep(0.5)")
            first = await s.until(lambda m: m["type"] == "output" and m["cell_id"] == "bg"); await s.close()
            await asyncio.sleep(1.2)  # the browser is away while the cell keeps running
            s2 = await Sock(A, pa).open(); await s2.recv(); snap = await s2.attach(N)
            bg = [e for e in snap["executions"] if e["cell_id"] == "bg"]; ok(len(bg) == 1 and "step 0" in "".join(o.get("text", "") for o in bg[0]["outputs"]), "snapshot holds the output produced while away")
            await s2.until(lambda m: m["type"] == "exec" and m["cell_id"] == "bg" and m["state"] in TERMINAL, 20)
            await s2.send(type="ack", path=N, msg_id=bg[0]["msg_id"]); await asyncio.sleep(0.3); await s2.close()
            s3 = await Sock(A, pa).open(); await s3.recv(); snap = await s3.attach(N); ok(not any(e["cell_id"] == "bg" for e in snap["executions"]), "acknowledged results are not sent again")
            await s3.send(type="execute", path=N, cell_id="done-away", code="print('finished while away')"); await s3.until(lambda m: m["type"] == "exec" and m["cell_id"] == "done-away" and m["state"] == "ok"); await s3.close()
            s4 = await Sock(A, pa).open(); await s4.recv(); snap = await s4.attach(N); da = [e for e in snap["executions"] if e["cell_id"] == "done-away"]
            ok(len(da) == 1 and da[0]["state"] == "ok" and "finished while away" in da[0]["outputs"][0]["text"], "a result nobody acknowledged is delivered on the next attach")
            s = s4

            print("== heavy output")
            evs, st = await s.run(N, "for i in range(200000):\n    print(i)", timeout=120); ok(st == "ok" and text_of(evs).rstrip().endswith("199999") and len(evs) < 3000, f"200k print calls: {len(evs)} events (coalesced), all text arrives")
            evs, st = await s.run(N, "print('A' * 30_000_000)", timeout=120); ok(st == "ok" and any("truncated" in o.get("text", "") or len(o.get("text", "")) <= 8_000_000 for o in outs(evs, "stream")), "a 30 MB print is cut down, not forwarded")
            evs, st = await s.run(N, "print('after flood')"); ok(text_of(evs) == "after flood\n", "socket and kernel still fine after the flood")

            print("== resource sampling")
            await s.run(N, "import torch; g = torch.zeros(256*1024*1024//4, device='cuda'); torch.cuda.synchronize()")
            u = await s.until(lambda m: m["type"] == "usage" and m["gpu_mib"], 20); ok(u["ram_mb"] and u["ram_mb"] > 100 and u["gpu_mib"] >= 200, f"usage event: {u['ram_mb']} MB RAM, {u['gpu_mib']} MiB GPU")

            print("== kernel crash")
            evs, st = await s.run(N, "import os; os._exit(1)", timeout=60); ok(st == "died" and any(o["ename"] == "KernelDied" for o in outs(evs, "error")), f"a crashed kernel marks the cell died ({st})")
            await s.until(lambda m: m["type"] == "kernel" and m["state"] == "idle", 30) if not any(m["type"] == "kernel" and m["state"] == "idle" for m in s.log[-5:]) else None
            await asyncio.sleep(2); evs, st = await s.run(N, "print('back')"); ok(text_of(evs) == "back\n", "the kernel comes back after a crash")

            print("== API restart keeps runtimes and kernels")
            await s.run(N, "keep = 77")
            if os.environ.get("LAB_RESTART_CMD"):
                await s.close(); subprocess.run(os.environ["LAB_RESTART_CMD"], shell=True, check=True, capture_output=True); await asyncio.sleep(1)
                st_ = (await a.get(f"/projects/{pa}/runtime")).json(); ok(st_["status"] == "running", "runtime re-adopted after the API restarted")
                s = await Sock(A, pa).open(); await s.recv(); snap = await s.attach(N); ok(snap["kernel"] in ("idle", "busy"), "kernel session re-adopted")
                evs, st = await s.run(N, "print(keep)"); ok(text_of(evs) == "77\n", "variables survived the API restart")
            else: print("skip (set LAB_RESTART_CMD)")

            print("== limits")
            await s.close()
            sb = await Sock(B, pb).open(); await sb.recv(); ok(await start(b, sb, pb), "user B starts a runtime")
            r = await b.post(f"/projects/{pb2}/runtime"); ok(r.status_code == 409 and r.json()["code"] == "runtime_limit" and "P2 b one" in r.json()["message"], f"second runtime refused with a message naming the first ({r.status_code})")
            ok(len((await b.get("/runtimes")).json()["runtimes"]) == 1, "GET /runtimes lists the caller's runtimes")
            await b.post(f"/projects/{pb}/notebooks", json={"path": "m.ipynb", "template": "blank"}); await sb.attach("m.ipynb")
            evs, st = await sb.run("m.ipynb", "import numpy as np\nbig = np.ones(400 * 1024 * 1024 // 8 * 4)\nprint(big.sum())", timeout=90)  # ~1.6 GB against a 1 GiB limit
            ok(st == "died", f"exceeding the RAM limit kills the kernel ({st})")
            await asyncio.sleep(2); evs, st = await sb.run("m.ipynb", "print('gateway survived')", timeout=60); ok(text_of(evs) == "gateway survived\n", "only the kernel died; the runtime lives on")
            r = await a.get("/admin/runtimes"); ok(any(x["owner_id"] == B_ID for x in r.json()["runtimes"]), "admin sees user B's runtime")

            print("== access removed, project deleted, stop")
            await a.put(f"/admin/users/{B_ID}/access", json={"enabled": False}); await sb.until(lambda m: m["type"] == "runtime" and m["status"] == "none", 20); ok(True, "revoking access stops the user's runtime")
            await a.put(f"/admin/users/{B_ID}/access", json={"enabled": True})
            await sb.close(); sb = await Sock(B, pb2).open(); await sb.recv(); ok(await start(b, sb, pb2), "after the stop B can start another runtime")
            await b.delete(f"/projects/{pb2}"); await sb.until(lambda m: m["type"] == "runtime" and m["status"] == "none", 20); ok(not (await b.get("/runtimes")).json()["runtimes"], "deleting a project stops its runtime"); await sb.close()
            r = await a.delete(f"/admin/runtimes/{pa}"); ok(r.status_code == 200, "admin can stop any runtime"); await asyncio.sleep(1)
            ok((await a.get(f"/projects/{pa}/runtime")).json()["status"] == "none", "runtime is gone")
            left = unit_names() - baseline; ok(not left, f"no systemd units left behind ({sorted(left)})")
            ok((await a.delete(f"/projects/{pa}/runtime")).status_code == 200, "stopping when nothing runs is harmless")
        finally:
            for c, p in ((a, pa), (b, pb), (b, pb2)):
                await c.delete(f"/projects/{p}/runtime"); await c.delete(f"/projects/{p}")
    print(f"\n{'ALL PASSED' if not fails else str(fails) + ' FAILED'}"); sys.exit(1 if fails else 0)

asyncio.run(main())
