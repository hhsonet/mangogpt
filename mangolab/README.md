# MangoLab

Notebooks on your own GPU, inside MangoGPT: a Colab-style workspace (code and Markdown cells, a terminal, a file browser, GPU monitoring) with an AI assistant.
**Status: Phase 0 (foundations) is done. Notebooks arrive in Phase 1.** MangoLab does not implement its own Python engine: code runs in real Jupyter kernels.

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

## Plan
| Phase | Scope | State |
|---|---|---|
| 0 Foundations | Environments, FastAPI skeleton, single sign-on, schema, WebSocket-capable gateway, `/lab` shell, access admin page, risk spike | Done |
| 1 Notebooks and files | Projects, file browser/upload, create/open/save `.ipynb`, Monaco cells, Markdown cells | Next |
| 2 Execution | Runtime start/stop/restart, kernel bridge, streaming output, plots, Run/Run All/Interrupt, reconnect replay | |
| 3 Workspace tools | Terminal, package install, CPU/RAM/GPU monitoring, idle shutdown, limits enforcement, audit | |
| 4 Assistant | MangoLab panel with read-only inspection tools, explain/fix/generate/optimize, apply/undo | |
| 5 Hardening | uid-pool or Podman driver, revisions, sharing, systemd services, load tests | |
