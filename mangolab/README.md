# MangoLab

Notebooks on your own GPU, inside MangoGPT: a Colab-style workspace (code and Markdown cells, a terminal, a file browser, GPU monitoring) with an AI assistant.
**Status: Phases 0 to 2 are done: projects, files, notebooks, and running cells on the GPU. The terminal, package installs and the AI assistant come next.** MangoLab does not implement its own Python engine: code runs in real Jupyter kernels.

## Architecture

```
Browser (Next.js /lab pages inside the MangoGPT app)
   │  HTTPS + WebSocket, the same login cookie as MangoGPT
   ▼
Gateway  scripts/https-proxy.mjs  (TLS :3443, plain loopback :3080)
   ├─ /*                  → MangoGPT app (Next.js)            :3000
   └─ /lab-api, /lab-ws   → MangoLab control plane (FastAPI)  :8200
                               │
        ┌──────────────────────┼───────────────────────────┐
        ▼                      ▼                           ▼
 PostgreSQL schema      Runtime manager (Phase 2)     AI assistant (Phase 4)
 "mangolab"             one Jupyter Kernel Gateway    Ollama + read-only tools
                        per project, in a resource-
                        limited systemd group
```

What it shares with MangoGPT: the PostgreSQL server (own schema and own database role), the user accounts and login cookie (single sign-on), the Next.js app shell and UI, Ollama, the usage/audit log (`public."UsageEvent"`), the GPU monitor, and the gateway.

## Security model (read this)
- **Notebook code is arbitrary code.** Without containers or separate Linux users it runs as the same OS user as the rest of the server, so it could read other users' workspaces and the server's secrets. **Enable MangoLab only for people you trust.** Access is off by default and granted per user by an admin (Admin -> MangoLab).
- Hard CPU, RAM and process limits per runtime work without root (systemd user groups, cgroup v2). GPU memory is limited cooperatively inside the kernel and enforced by watching per-process GPU memory.
- Real per-user isolation needs one-time root setup. Planned drivers behind one interface: `systemd-user` (today), `uid-pool` (a pool of Linux users and a sudo wrapper), `podman` (rootless containers with the NVIDIA container toolkit).
- The control plane only has rights it needs: its database role can read each user's id, username, role and status (no emails, hashes or chats), and can write only its own schema plus insert into the shared usage log.
- WebSockets check the cookie **and** the Origin (browsers don't apply CORS to them); writes are same-origin only; the gateway only upgrades `/lab-ws/*`.

## Run it
```bash
mangolab/scripts/setup-envs.sh        # once: Python environments in ~/.venvs (outside the repo)
cd mangolab/api && ~/.venvs/mangolab-api/bin/alembic upgrade head   # database schema
mangolab/scripts/start-api.sh         # control plane on 127.0.0.1:8200
node scripts/https-proxy.mjs          # gateway (replaces the old proxy)
```
Configuration is in `mangolab/.env` (not committed): `MANGOLAB_DATABASE_URL`, `AUTH_SECRET` (must equal the app's), `MANGOLAB_DATA_DIR`. Create the database role and schema as in the migration notes below.

## Phase 0 findings (tested on the target server)
| Question | Result |
|---|---|
| Docker / Podman / bubblewrap? | None installed; unprivileged user namespaces are blocked (AppArmor) |
| Per-runtime CPU / RAM limits without root? | Yes: `systemd-run --user` with `MemoryMax`, `CPUQuota`, `TasksMax` (an over-limit allocation was killed; a 25% quota gave 0.77 s of 3 s) |
| Jupyter + CUDA PyTorch under those limits? | Yes: kernel gateway, torch 2.11+cu128 sees the H200 MIG slice, matmul on GPU, matplotlib plots arrive as `image/png`, errors, incremental streaming (first output after 0.05 s), interrupt, restart |
| GPU memory per runtime? | `nvidia-smi` lists per-process memory; the process's cgroup (`/proc/<pid>/cgroup`) identifies the runtime |
| Memory-limit kills | With the default `OOMPolicy=stop` systemd stops the **whole** runtime; use `OOMPolicy=continue` so only the offending kernel dies. Jupyter's restarter then restarts it and clients see `status: restarting`, so the control plane must mark the interrupted cell as failed ("kernel died") |
| Runtimes outliving logout | Needs `sudo loginctl enable-linger <user>` (not yet enabled) |

The spike scripts are in `mangolab/scripts/spike_*.py`.

## Database
Schema `mangolab`, managed by Alembic (`mangolab/api/alembic`). MangoGPT's Prisma owns `public` and never sees `mangolab`. Tables: `lab_access`, `projects`, `project_members`, `notebooks`, `notebook_revisions`, `runtimes`, `kernel_sessions`, `executions`, `terminals`, `package_jobs`, `resource_samples`, `ai_threads`, `ai_messages`, `ai_actions`. Foreign keys to `public."User"` cascade, so deleting a user in MangoGPT removes their MangoLab rows (workspace files on disk need a cleanup job, planned).

## Phase 1: what exists
- **Projects**: up to 50 per user, each a folder under `~/mangolab-data/users/<user-id>/projects/<id>/workspace` (mode 700) with a README and an optional welcome notebook. Open `/lab`, then a project (`/lab/p/<id>`).
- **Files**: tree, create/rename/move/delete, drag-and-drop upload (50 files, 200 MB each), text editing in Monaco (up to 2 MB), image preview, download. All paths go through `app/services/safefs.py` (descriptor-based traversal, no symlink following, atomic writes, quota). `.mangolab/` is reserved for internal data.
- **Notebooks**: standard nbformat 4.5 `.ipynb` files, lossless round trip (unknown fields are preserved). Code and Markdown cells, Colab-style shortcuts (Esc/Enter, `a`/`b`, `dd`, `m`/`y`, `z`, Shift+Enter, Ctrl+S), undo of structural edits, autosave after 2 s, a conflict banner when the file changed elsewhere (ETag + `If-Match`, 409), a revision snapshot at most every 5 minutes (30 kept) with restore.
- **Safety**: notebook HTML outputs render in a sandboxed iframe without `allow-same-origin`; SVG/HTML downloads are forced to attachment with a sandbox CSP; external images in Markdown are blocked.
- **Not yet**: Run buttons, the runtime pill and the AI button are visible but disabled.
- **Tests**: `pytest mangolab/api/tests/test_safefs.py` (23 tests), `mangolab/api/tests/integration_phase1.py` (about 85 checks against a running API; needs `LAB_COOKIE_ADMIN`, `LAB_COOKIE_B`, `LAB_USER_B_ID`), plus a Playwright flow for the UI.
- **Known gap**: deleting a user removes their MangoLab database rows but not their workspace folder (cleanup job planned).

## Phase 2: running code
**Using it.** Press Run on a cell, or Shift+Enter. The first run connects a *runtime* (about 1 s) and starts the notebook's *kernel* (about 0.5 s). Header: status pill with live RAM/GPU use, Connect / Disconnect. Notebook toolbar: Run all, Stop, a Runtime menu (run above/below, interrupt, restart, restart and run all). Shortcuts: Shift+Enter run and move on, Ctrl+Enter run and stay, Alt+Enter run and add a cell, Esc then I I interrupt. After an error, the cells queued behind it are skipped (shown as "skipped"), like Jupyter.

**How it works.**
```
browser ──ws /lab-ws/v1/projects/<id>/runtime──▶ FastAPI ──http+ws, loopback, token──▶ Kernel Gateway (one per project,
 (one socket per open project)                    RuntimeManager + NotebookSession       systemd user unit, own cgroup) ──▶ one kernel per notebook
```
- `drivers/systemd_user.py` starts the gateway with `systemd-run --user`: `MemoryMax`, `MemorySwapMax=0`, `CPUQuota`, `TasksMax`, `OOMPolicy=continue` (an over-limit kernel is killed alone). BLAS/OpenMP thread counts follow the CPU quota. Each runtime gets a private state dir (mode 700) with its connection file.
- `services/runtime_manager.py` owns all runtimes: start/stop, one runtime per project, per-user limit (`max_runtimes`, default 1, a clear message names the runtime in the way) and a server-wide cap (`MANGOLAB_MAX_RUNTIMES`, default 6), resource sampling every 5 s (cgroup memory/CPU, per-runtime GPU memory via `nvidia-smi` and `/proc/<pid>/cgroup`), idle shutdown (no cell run for `idle_timeout_min`, default 60; checked every `MANGOLAB_SWEEP_S`=30 s), and a check that the owner is still active and still has access (revoking access or disabling the user stops their runtime within one sweep, or at once when done from the admin page).
- `services/kernel_bridge.py` speaks the Jupyter protocol, turns messages into events, merges stream output (progress bars fold like a terminal), coalesces print-heavy loops into ~30 ms batches, caps output (8 MB per item, 20 MB per run, 64 MB held per notebook), and records one `mangolab.executions` row per run (cell id, outcome, duration; never code or output).
- **Delivery.** Events go to browsers that have attached to the notebook. Results nobody was attached for are kept in memory and sent as a snapshot when a browser attaches; a browser acknowledges what it applied and the server then forgets it. So closing the tab mid-training and coming back later works (as long as the API process stays up); the browser saves outputs into the `.ipynb` through the normal autosave.
- **Survives API restarts.** Runtimes and kernels are separate processes. On startup the API re-adopts runtimes recorded in the database whose unit is still active (connection file in the runtime's state dir) and stops orphan units. A cell that was running during the restart loses its output stream (its kernel may still be busy; use Stop).
- **Protocol** (JSON over the project socket). Client: `attach`/`detach {path}`, `execute {path, cell_id, code}`, `interrupt`/`restart {path}`, `ack {path, msg_id}`, `ping`. Server: `hello`, `runtime`, `usage`, `kernel`, `snapshot`, `exec` (queued/running/ok/error/aborted/died), `output`, `clear_output`, `update_display`, `renamed`, `error`. REST: `GET/POST/DELETE /projects/<id>/runtime`, `GET /runtimes`, admin `GET /admin/runtimes`, `DELETE /admin/runtimes/<project>`.
- Notebooks run in their own folder. Renaming a notebook keeps its kernel; deleting one ends it; deleting a project stops its runtime.
- Admin → MangoLab shows "Running now" (RAM, GPU, kernels) with a stop button per runtime.

**Known gaps (planned for Phase 3 unless noted).**
- The GPU budget is a setting and is *measured* per runtime, but not yet enforced; one user can use the whole MIG slice.
- Disk writes from a kernel are not capped while it runs (the quota is checked on uploads and shown in the header).
- No terminal or package installer yet. The kernel environment is shared by every project (`~/.venvs/mangolab-base`); it is a `uv` environment without `pip`, so `!pip install` does not work yet.
- No `input()` (stdin is disabled), no Jupyter widgets (`ipywidgets`); `tqdm` works as text.
- The same notebook open in two browser tabs shows the "changed elsewhere" banner on the second save, as for any concurrent edit.
- Notebook code is arbitrary code running as the server's Linux user (see Security model). Phase 5 adds real isolation.

**Tests.** `pytest mangolab/api/tests` (31 unit tests: output merging, safe file layer). `mangolab/api/tests/integration_phase2.py` (about 70 checks against a running API with the real kernel environment: streaming, plots, errors, stop-on-error queue, interrupt, restart, reconnect and replay, flood of output, crash and recovery, RAM-limit kill, per-user limit, isolation, access revocation, API restart; needs `LAB_COOKIE_ADMIN`, `LAB_COOKIE_B`, `LAB_USER_B_ID`, optionally `LAB_RESTART_CMD`). The browser flows were checked with Playwright (connect, run, plot, error, stream, stop, run all, reload during a run, tab switch, restart, limit dialog, disconnect, mobile).

## Plan
| Phase | Scope | State |
|---|---|---|
| 0 Foundations | Environments, FastAPI skeleton, single sign-on, schema, WebSocket-capable gateway, `/lab` shell, access admin page, risk spike | Done |
| 1 Notebooks and files | Projects, file browser/upload, create/open/save `.ipynb`, Monaco cells, Markdown cells | Done |
| 2 Execution | Runtime start/stop/restart, kernel bridge, streaming output, plots, Run/Run All/Interrupt, reconnect replay | Done |
| 3 Workspace tools | Terminal, package install, CPU/RAM/GPU monitoring, idle shutdown, limits enforcement, audit | |
| 4 Assistant | MangoLab panel with read-only inspection tools, explain/fix/generate/optimize, apply/undo | |
| 5 Hardening | uid-pool or Podman driver, revisions, sharing, systemd services, load tests | |
