import asyncio, json, os, subprocess, time, uuid
import httpx, websockets
PORT, TOKEN = int(os.environ["GW_PORT"]), os.environ["GW_TOKEN"]; H = {"Authorization": f"token {TOKEN}"}
def send(code, session):
    mid = uuid.uuid4().hex
    return mid, json.dumps({"header": {"msg_id": mid, "username": "lab", "session": session, "msg_type": "execute_request", "version": "5.3"}, "parent_header": {}, "metadata": {}, "content": {"code": code, "silent": False, "store_history": True, "allow_stdin": False, "stop_on_error": True}, "buffers": [], "channel": "shell"})
def gpu_procs():
    out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"], capture_output=True, text=True).stdout
    rows = []
    for line in out.strip().splitlines():
        pid, mem = [x.strip() for x in line.split(",")]
        try: cg = open(f"/proc/{pid}/cgroup").read().strip().split("/")[-1]
        except Exception: cg = "?"
        rows.append((int(pid), int(mem), cg))
    return rows
async def main():
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{PORT}", headers=H, timeout=30) as http:
        kid = (await http.post("/api/kernels", json={"name": "python3"})).json()["id"]; session = uuid.uuid4().hex
        async with websockets.connect(f"ws://127.0.0.1:{PORT}/api/kernels/{kid}/channels?token={TOKEN}") as ws:
            mid, p = send("import torch; x = torch.empty(int(1.5*2**30), dtype=torch.uint8, device='cuda'); print('allocated 1.5 GiB on GPU')", session); await ws.send(p)
            while True:
                m = json.loads(await ws.recv())
                if m.get("parent_header", {}).get("msg_id") == mid and m["header"]["msg_type"] == "status" and m["content"]["execution_state"] == "idle": break
            print("GPU memory attribution (pid, MiB, which cgroup the process belongs to):")
            for pid, mem, cg in gpu_procs(): print(f"   pid {pid:>6}  {mem:>5} MiB  {cg}")
            # blow through the 6 GiB memory limit and watch what the client sees
            mid, p = send("print('allocating 8 GiB of RAM under a 6 GiB limit...', flush=True)\nb = bytearray(8*2**30)\nprint('BAD survived')", session); await ws.send(p); t0 = time.time(); seen = []
            try:
                while time.time() - t0 < 25:
                    m = json.loads(await asyncio.wait_for(ws.recv(), 25 - (time.time() - t0)))
                    t = m["header"]["msg_type"]; c = m.get("content", {})
                    seen.append((round(time.time() - t0, 1), m.get("channel"), t, (c.get("execution_state") or c.get("text", "")[:40] or c.get("ename", ""))))
                    if len(seen) > 12: break
            except (asyncio.TimeoutError, websockets.ConnectionClosed) as e: seen.append((round(time.time() - t0, 1), "client", type(e).__name__, ""))
            print("what the browser would receive when the kernel is OOM-killed:"); [print("  ", s) for s in seen]
        kernels = (await http.get("/api/kernels")).json()
        print("kernel list after the kill:", [(k["id"][:8], k.get("execution_state"), k.get("connections")) for k in kernels])
        await http.delete(f"/api/kernels/{kid}")
asyncio.run(main())
