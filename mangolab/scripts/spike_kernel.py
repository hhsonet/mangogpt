"""Phase 0 risk spike: drive a real Jupyter kernel through Kernel Gateway's WebSocket protocol.
Not part of the app. Run with the API environment's python while a gateway listens on PORT with TOKEN."""
import asyncio, json, os, subprocess, sys, time, uuid
import httpx, websockets

PORT, TOKEN = int(os.environ["GW_PORT"]), os.environ["GW_TOKEN"]
BASE = f"http://127.0.0.1:{PORT}"; H = {"Authorization": f"token {TOKEN}"}

def msg(code, session):
    mid = uuid.uuid4().hex
    return mid, json.dumps({"header": {"msg_id": mid, "username": "lab", "session": session, "msg_type": "execute_request", "version": "5.3"},
                            "parent_header": {}, "metadata": {}, "content": {"code": code, "silent": False, "store_history": True, "allow_stdin": False, "stop_on_error": True},
                            "buffers": [], "channel": "shell"})

async def run(ws, code, session, timeout=60, on_event=None):
    mid, payload = msg(code, session); await ws.send(payload); out = {"stream": "", "images": 0, "error": None, "result": None, "status": [], "events": 0}
    t0 = time.time()
    while time.time() - t0 < timeout:
        m = json.loads(await asyncio.wait_for(ws.recv(), timeout))
        if m.get("parent_header", {}).get("msg_id") != mid: continue
        t, c = m["header"]["msg_type"], m["content"]; out["events"] += 1
        if on_event: on_event(t, c)
        if t == "stream": out["stream"] += c["text"]
        elif t in ("display_data", "execute_result"):
            if "image/png" in c["data"]: out["images"] += 1
            if t == "execute_result": out["result"] = c["data"].get("text/plain")
        elif t == "error": out["error"] = f'{c["ename"]}: {c["evalue"]}'
        elif t == "status":
            out["status"].append(c["execution_state"])
            if c["execution_state"] == "idle": return out
    raise TimeoutError("no idle status")

async def main():
    async with httpx.AsyncClient(base_url=BASE, headers=H, timeout=30) as http:
        r = await http.post("/api/kernels", json={"name": "python3"}); r.raise_for_status(); kid = r.json()["id"]; print("kernel started:", kid[:8])
        session = uuid.uuid4().hex
        async with websockets.connect(f"ws://127.0.0.1:{PORT}/api/kernels/{kid}/channels?token={TOKEN}", max_size=64 * 2**20) as ws:
            o = await run(ws, "import torch,sys;print(sys.version.split()[0], 'torch', torch.__version__, 'cuda', torch.cuda.is_available(), torch.cuda.get_device_name(0))", session); print("1 env  :", o["stream"].strip())
            o = await run(ws, "import matplotlib.pyplot as plt, numpy as np\nplt.plot(np.sin(np.linspace(0,6,50)))\nplt.show()", session); print("2 plot : image/png outputs =", o["images"], "| states", o["status"])
            o = await run(ws, "1/0", session); print("3 error:", o["error"])
            o = await run(ws, "x = torch.randn(4096,4096,device='cuda'); y = (x@x).sum().item(); print('matmul on GPU ok', round(y)%10 >= 0); torch.cuda.memory_allocated()//2**20", session); print("4 gpu  :", o["stream"].strip(), "| allocated MiB:", o["result"])
            pid = int(json.loads(subprocess.run(["bash", "-c", "pgrep -f ipykernel_launcher | head -1"], capture_output=True, text=True).stdout.strip() or 0) or 0) if False else None
            # streaming: output must arrive incrementally, not all at the end
            first = {}; t0 = time.time()
            def ev(t, c):
                if t == "stream" and "first" not in first: first["first"] = time.time() - t0
            o = await run(ws, "import time\nfor i in range(3):\n    print('tick', i, flush=True); time.sleep(1)", session, on_event=ev)
            print(f"5 stream: {o['stream'].split()!r} first output after {first['first']:.2f}s of a 3s cell (incremental if < 1s)")
            # interrupt a long cell
            mid, payload = msg("import time\ntime.sleep(60)", session); await ws.send(payload); await asyncio.sleep(1.5)
            await http.post(f"/api/kernels/{kid}/interrupt"); got = None; t1 = time.time()
            while time.time() - t1 < 15:
                m = json.loads(await asyncio.wait_for(ws.recv(), 15))
                if m.get("parent_header", {}).get("msg_id") == mid and m["header"]["msg_type"] == "error": got = m["content"]["ename"]
                if m.get("parent_header", {}).get("msg_id") == mid and m["header"]["msg_type"] == "status" and m["content"]["execution_state"] == "idle": break
            print(f"6 interrupt: stopped a 60s sleep in {time.time()-t1:.1f}s with {got}")
            kpid = (await http.get(f"/api/kernels/{kid}")).json()
            r2 = await http.post(f"/api/kernels/{kid}/restart"); print("7 restart:", r2.status_code)
        await http.delete(f"/api/kernels/{kid}"); print("kernel deleted")

asyncio.run(main())
