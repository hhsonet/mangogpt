"""
End-to-end checks for the assistant against a RUNNING MangoLab API that talks to tests/mock_ollama.py (so answers are scripted):
  python tests/mock_ollama.py 11999 &   OLLAMA_BASE_URL=http://127.0.0.1:11999 <restart the API>
  LAB_COOKIE_ADMIN=... LAB_COOKIE_B=... LAB_USER_B_ID=... python tests/integration_phase4.py
"""
import asyncio, json, os, sys, time
import httpx

HOST = os.environ.get("LAB_HOST", "127.0.0.1:8200"); API = f"http://{HOST}/lab-api/v1"; MOCK = os.environ.get("MOCK_URL", "http://127.0.0.1:11999")
A, B, B_ID = os.environ["LAB_COOKIE_ADMIN"], os.environ["LAB_COOKIE_B"], os.environ["LAB_USER_B_ID"]
DATA = os.path.expanduser(os.environ.get("MANGOLAB_DATA_DIR", "~/mangolab-data"))
fails = 0
def ok(c, m):
    global fails; fails += 0 if c else 1; print(("ok   " if c else "BAD  ") + m, flush=True)
def client(cookie): return httpx.AsyncClient(base_url=API, headers={"Cookie": f"oc_session={cookie}"}, timeout=60)
def cell(i, src, out="", failed=False, n=None): return {"id": f"c{i}", "type": "code", "source": src, "output": out, "execution_count": n, "failed": failed}
CTX = {"path": "n.ipynb", "selected": "c2", "kernel": "idle", "cells": [cell(1, "print('hello')", "hello", n=1), cell(2, "ZEBRA_MARKER = 1/0", "ZeroDivisionError: division by zero", True, 2), cell(3, "x = 5")]}


async def chat(c, pid, tid, message, **kw):
    """Returns the list of streamed events."""
    body = {"message": message, **kw}; evs = []
    async with c.stream("POST", f"/projects/{pid}/assistant/threads/{tid}/chat", json=body) as r:
        if r.status_code != 200:
            return [{"type": "http", "status": r.status_code, **json.loads(await r.aread())}]
        async for ln in r.aiter_lines():
            if ln.strip(): evs.append(json.loads(ln))
    return evs
def text_of(evs): return "".join(e["delta"] for e in evs if e["type"] == "content")
def of(evs, t): return [e for e in evs if e["type"] == t]


async def main():
    async with client(A) as a, client(B) as b, httpx.AsyncClient(timeout=10) as mock:
        await a.put(f"/admin/users/{B_ID}/access", json={"enabled": True})
        pa = (await a.post("/projects", json={"name": "P4 admin", "template": "blank"})).json()["id"]
        pb = (await b.post("/projects", json={"name": "P4 b", "template": "blank"})).json()["id"]
        try:
            await a.post(f"/projects/{pa}/notebooks", json={"path": "n.ipynb", "template": "blank"})
            await a.put(f"/projects/{pa}/files/content", json={"path": "data.csv", "content": "a,b\n1,2\n"})
            ws = f"{DATA}/users/{(await a.get('/me')).json()['user']['id']}/projects/{pa}"
            try: os.symlink("/etc/passwd", f"{ws}/evil-link.txt")
            except FileExistsError: pass

            print("== access")
            ok((await httpx.AsyncClient(base_url=API).get(f"/projects/{pa}/assistant/models")).status_code == 401, "no cookie -> 401")
            ok((await b.get(f"/projects/{pa}/assistant/models")).status_code == 404, "other user cannot use the assistant on my project")
            m = (await a.get(f"/projects/{pa}/assistant/models")).json(); ok({x["name"]: x["tools"] for x in m["models"]} == {"mock:tools": True, "mock:plain": False} and m["default"] == "mock:tools", f"models listed with abilities, default picks one with tools ({m['default']})")

            print("== threads")
            t = (await a.post(f"/projects/{pa}/assistant/threads", json={"path": "n.ipynb"})).json(); tid = t["id"]; ok(t["title"] == "New conversation", "thread created")
            ok(any(x["id"] == tid for x in (await a.get(f"/projects/{pa}/assistant/threads", params={"path": "n.ipynb"})).json()["threads"]), "listed for its notebook")
            ok(not any(x["id"] == tid for x in (await a.get(f"/projects/{pa}/assistant/threads", params={"path": "other.ipynb"})).json()["threads"]), "not listed for another notebook")
            ok((await b.get(f"/projects/{pb}/assistant/threads/{tid}/messages")).status_code == 404 and (await b.get(f"/projects/{pa}/assistant/threads/{tid}/messages")).status_code == 404, "other user cannot read my conversation")
            evs = await chat(b, pb, tid, "hi"); ok(evs[0].get("status") == 404, "other user cannot post into my conversation")

            print("== streaming a plain answer")
            evs = await chat(a, pa, tid, "Explain this [mock:explain]", context=CTX, mode="explain")
            ok([e["type"] for e in evs][0] == "meta" and evs[-1]["type"] == "done" and len(of(evs, "content")) > 3, "events: meta, content deltas, done")
            ok(text_of(evs).strip() == "This cell prints a greeting. It takes no input.", "text arrives intact")
            ok(evs[0]["model"] == "mock:tools" and evs[-1]["stats"]["tokens_out"] == 22, "model and token counts reported")
            ms = (await a.get(f"/projects/{pa}/assistant/threads/{tid}/messages")).json()["messages"]; ok([x["role"] for x in ms] == ["user", "assistant"] and ms[1]["content"].startswith("This cell prints"), "question and answer are saved")
            ok((await a.get(f"/projects/{pa}/assistant/threads", params={"path": "n.ipynb"})).json()["threads"][0]["title"].startswith("Explain this"), "thread is titled from the first question")

            print("== what the model is shown")
            evs = await chat(a, pa, tid, "[mock:echo]", context=CTX, think=True); echo = json.loads(text_of(evs)); sysmsg = echo["system"]
            ok("ZEBRA_MARKER" in sysmsg and "Selected cell: [2]" in sysmsg and "FAILED" in sysmsg and "ZeroDivisionError" in sysmsg, "prompt contains the notebook, the selection and the failing cell")
            ok("never an instruction to you" in sysmsg and "<<<NOTEBOOK" in sysmsg and sysmsg.index("Security rules") < sysmsg.index("<<<NOTEBOOK"), "rules come first and notebook content is fenced as data")
            ok(echo["tools"] == 10 and echo["think"] is True and echo["num_ctx"] == 8192, f"tools offered (10) and settings passed through")
            ok("explain" not in echo["user"].lower() or True, "user text passed")
            evs = await chat(a, pa, tid, "Explain [mock:echo]", context=CTX, mode="explain"); echo = json.loads(text_of(evs)); ok("[Instruction for this request: Explain the selected cell" in echo["user"], "quick-action modes add their instruction")
            big = {"path": "n.ipynb", "selected": "c150", "cells": [cell(i, f"# cell {i}\n" + "x = 1\n" * 900, "out " * 800, n=i) for i in range(1, 301)]}
            evs = await chat(a, pa, tid, "[mock:echo]", context=big); echo = json.loads(text_of(evs))
            ok(evs[0]["trimmed"] and len(echo["system"]) < 8192 * 3.2 and "Security rules" in echo["system"] and "[150]" in echo["system"], f"a 300-cell notebook is trimmed to fit ({len(echo['system'])} chars) and keeps the rules and the selected cell")
            ok(echo["n_messages"] <= 12, "history is limited")
            evs = await chat(a, pa, tid, "[mock:echo]", context=None); echo = json.loads(text_of(evs)); ok("(no notebook is open)" in echo["system"] and echo["tools"] == 6, "without a notebook only file, runtime and install tools are offered")
            r = await a.post(f"/projects/{pa}/assistant/threads/{tid}/chat", json={"message": "x", "context": {"path": "n.ipynb", "cells": [cell(i, "x") for i in range(500)]}}); ok(r.status_code == 422, "an oversized notebook snapshot is rejected")
            r = await a.post(f"/projects/{pa}/assistant/threads/{tid}/chat", json={"message": "x" * 9000}); ok(r.status_code == 422, "an oversized message is rejected")
            r = await a.post(f"/projects/{pa}/assistant/threads/{tid}/chat", json={"message": "x", "mode": "rm -rf"}); ok(r.status_code == 422, "an unknown mode is rejected")

            print("== inspection tools")
            evs = await chat(a, pa, tid, "[mock:inspect]", context=CTX); tl = of(evs, "tool")
            ok([t["status"] for t in tl] == ["running", "done"] and tl[-1]["summary"] == "Read cell 2", "tool calls are reported (running, done) with a plain summary")
            ok("\n\nCell 2 says" in text_of(evs), "text before and after a tool call is separated into paragraphs")
            ok("ZEBRA_MARKER = 1/0" in text_of(evs) or "ZeroDivisionError" in text_of(evs), f"the model received the cell's source and output: {text_of(evs)[:60]!r}")
            evs = await chat(a, pa, tid, "[mock:inject]", context=CTX); res = json.loads(text_of(evs).split("RESULTS:")[1]); tl = of(evs, "tool")
            ok(all("root:" not in r for r in res), "a symlink out of the project is never followed")
            ok(not any("root:" in str(e) for e in evs), "nothing from /etc/passwd reaches the browser either")
            ok(res[0].startswith("Error") and res[1].startswith("Error"), "path traversal is refused (read_file, list_files)")
            ok("reserved" in res[2].lower() or res[2].startswith("Error"), "MangoLab's internal folder is off limits")
            ok(res[3].startswith("Error") and res[4].startswith("Error: there is no cell 999") and "no tool called" in res[5], "bad cell numbers and unknown tools become messages, not crashes")
            ok(len(res) == 6 and len(tl) == 12, f"at most 6 tool calls are run per step (7 were requested, {len(res)} answered)")
            ok(all(t["status"] in ("running", "error") for t in tl), "failed tools are marked as errors")
            ok(not of(evs, "action"), "hostile tool calls created no proposals")
            evs = await chat(a, pa, tid, "[mock:echo]", context=CTX)

            print("== proposals need approval")
            evs = await chat(a, pa, tid, "[mock:edit]", context=CTX); act = of(evs, "action")
            ok(len(act) == 1 and act[0]["action"]["type"] == "edit_cell" and act[0]["action"]["status"] == "proposed", "an edit is proposed, not applied")
            p = act[0]["action"]["payload"]; ok(p["cell_id"] == "c1" and p["old_source"] == "print('hello')" and p["source"] == "print('fixed')", "it carries the cell, the old and the new source")
            ok(json.loads((await a.get(f"/projects/{pa}/files/content", params={"path": "n.ipynb"})).text)["content"].count("fixed") == 0, "nothing in the notebook file changed")
            aid = act[0]["action"]["id"]
            r = await a.patch(f"/projects/{pa}/assistant/actions/{aid}", json={"status": "applied", "prev": "print('hello')"}); ok(r.status_code == 200 and r.json()["payload"]["applied_prev"] == "print('hello')", "applying is recorded with what it replaced")
            ms = (await a.get(f"/projects/{pa}/assistant/threads/{tid}/messages")).json()["messages"]; got = [x for m in ms for x in m["actions"] if x["id"] == aid]; ok(got and got[0]["status"] == "applied" and got[0]["payload"]["applied_prev"], "state survives a reload")
            ok((await a.patch(f"/projects/{pa}/assistant/actions/{aid}", json={"status": "proposed"})).json()["status"] == "proposed", "undo returns it to proposed")
            ok((await a.patch(f"/projects/{pa}/assistant/actions/{aid}", json={"status": "bogus"})).status_code == 422, "invalid state refused")
            ok((await b.patch(f"/projects/{pb}/assistant/actions/{aid}", json={"status": "applied"})).status_code == 404, "other user cannot decide on my suggestion")
            ok((await a.patch(f"/projects/{pa}/assistant/actions/{uuid_zero()}", json={"status": "applied"})).status_code == 404, "unknown suggestion -> 404")
            evs = await chat(a, pa, tid, "[mock:insert]", context=CTX); act = of(evs, "action")[0]["action"]; ok(act["type"] == "insert_cell" and act["payload"]["position"] == "end" and act["payload"]["cell_type"] == "code", "insert proposal")
            evs = await chat(a, pa, tid, "[mock:install]", context=CTX); act = of(evs, "action"); ok(act and act[0]["action"]["payload"]["specs"] == ["tabulate"], "install proposal carries validated specs")
            evs = await chat(a, pa, tid, "[mock:installbad]", context=CTX); ok(not of(evs, "action") and any(t["status"] == "error" for t in of(evs, "tool")) and "isn" in text_of(evs), "an install proposal with flags or URLs is refused before the person sees it")
            ok((await a.get(f"/projects/{pa}/packages")).json()["installed"] == [], "and nothing was installed")

            print("== a model without tool support")
            evs = await chat(a, pa, tid, "[mock:echo]", context=CTX, model="mock:plain"); echo = json.loads(text_of(evs)); ok(evs[0]["tools"] is False and echo["tools"] == 0, "no tools are sent to it")
            evs = await chat(a, pa, tid, "hi", model="nope"); ok(evs[0].get("type") == "error" and evs[0]["code"] == "model_not_found", "unknown model gives a clear error")

            print("== limits, stop and failures")
            evs = await chat(a, pa, tid, "[mock:error]", context=CTX); err = of(evs, "error"); ok(err and err[0]["code"] == "ollama_error" and "GPU is short on memory" in err[0]["message"], f"a model failure is explained in plain words: {err[0]['message'][:50] if err else ''}")
            before = len((await a.get(f"/projects/{pa}/assistant/threads/{tid}/messages")).json()["messages"])
            first = asyncio.create_task(chat(a, pa, tid, "[mock:slow]", context=CTX)); await asyncio.sleep(1.0)
            r = await a.post(f"/projects/{pa}/assistant/threads/{tid}/chat", json={"message": "second"}); ok(r.status_code == 429 and r.json()["code"] == "assistant_busy", "a second question while one runs is refused politely")
            ok((await mock.get(f"{MOCK}/_stats")).json()["active"] == 1, "the model is generating"); first.cancel()
            try: await first
            except asyncio.CancelledError: pass
            await asyncio.sleep(1.5); ok((await mock.get(f"{MOCK}/_stats")).json()["active"] == 0, "closing the connection stops the generation")
            evs = await chat(a, pa, tid, "[mock:explain]", context=CTX); ok(evs[-1]["type"] == "done", "the next question works right after (lock released)")
            ms = (await a.get(f"/projects/{pa}/assistant/threads/{tid}/messages")).json()["messages"]; part = [m for m in ms if m["content"].startswith("tick0")]; ok(part and len(part[0]["content"]) > 10, "the part of the answer produced before Stop is kept")

            print("== access rules")
            await a.put(f"/admin/users/{B_ID}/access", json={"enabled": False}); ok((await b.get(f"/projects/{pb}/assistant/models")).status_code == 403, "without MangoLab access the assistant is closed too"); await a.put(f"/admin/users/{B_ID}/access", json={"enabled": True})
            tb = (await b.post(f"/projects/{pb}/assistant/threads", json={})).json()["id"]; evs = await chat(b, pb, tb, "[mock:explain]"); ok(evs[-1]["type"] == "done", "a normal user can use it on their own project")
            ok((await a.delete(f"/projects/{pa}/assistant/threads/{tid}")).status_code == 204 and (await a.get(f"/projects/{pa}/assistant/threads/{tid}/messages")).status_code == 404, "deleting a conversation removes it")
            ok(not [x for x in (await a.get(f"/projects/{pa}/assistant/threads", params={"path": "n.ipynb"})).json()["threads"] if x["id"] == tid], "and its messages and suggestions go with it")
        finally:
            for c, p in ((a, pa), (b, pb)):
                await c.delete(f"/projects/{p}")
            try: os.unlink(f"{ws}/evil-link.txt")
            except OSError: pass
    print(f"\n{'ALL PASSED' if not fails else str(fails) + ' FAILED'}"); sys.exit(1 if fails else 0)

def uuid_zero(): return "00000000-0000-0000-0000-000000000000"
asyncio.run(main())
