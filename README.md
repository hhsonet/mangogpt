# MangoGPT and MangoLab

A private, self-hosted AI workspace that runs on your own GPU. It has two parts that share one login, one database server and one GPU:

- **MangoGPT**: a ChatGPT-style chat app on [Ollama](https://ollama.com): streaming chat, attachments, image generation, accounts, an admin area.
- **MangoLab** (`/lab`): a Colab-style notebook workspace: projects and files, notebooks that run on the GPU, a terminal, package installs, live resource monitoring, and an AI assistant that can explain, fix and write notebook code.

```
Browser ──HTTPS──▶ Gateway (scripts/https-proxy.mjs, :3443)
                    ├─ /*                  → Next.js app (UI + API routes)        127.0.0.1:3000 ─▶ Ollama 127.0.0.1:11434 ─▶ GPU
                    │                                                              └▶ Image service 127.0.0.1:8100 (optional) ─▶ GPU
                    └─ /lab-api, /lab-ws   → MangoLab control plane (FastAPI)     127.0.0.1:8200
                                                 └▶ one Jupyter Kernel Gateway per project (systemd user slice, limited RAM/CPU/GPU)
                          PostgreSQL 127.0.0.1:5432 (schema `public` = MangoGPT, schema `mangolab` = MangoLab)
```
Nothing but the gateway listens on a public address; Ollama, the app, the control plane and the database stay on loopback.

## What it does

### MangoGPT (chat)
- **Chat:** streaming answers with Stop, Markdown, tables, math, highlighted code with copy, collapsible model reasoning, edit / regenerate / continue, a model picker read live from Ollama.
- **Conversations:** rename, pin, duplicate, delete, full-text search, automatic titles.
- **Attachments:** PDF, Word, text and source files (text extracted on the server) and images for vision models.
- **Image generation:** SDXL-Turbo through a small local Python service, with the shared GPU managed automatically.
- **Accounts:** username or email sign-in, self sign-up limited to a university email domain with admin approval, per-user data and settings.
- **Admin:** user management, usage and audit log with CSV export, live GPU monitor, optional Slack/Telegram alerts for sign-up requests.

### MangoLab (notebooks)
- **Projects and files:** a private workspace per project, file tree with upload (drag and drop), rename, move, delete, download; text and image preview; Monaco editor.
- **Notebooks:** real `.ipynb` files (lossless round trip), code and Markdown cells, Colab-style shortcuts, autosave, conflict detection, version history with restore, undo of cell edits.
- **Running code:** one Jupyter kernel per notebook on the GPU with CUDA PyTorch ready; streaming output, plots, tracebacks, rich HTML (sandboxed), Run all, Stop, restart; output keeps arriving if you reload or close the tab.
- **Runtimes and limits:** one resource-limited runtime per project (RAM, CPU, processes through systemd; GPU memory and disk enforced by a watchdog), per-user caps set by admins, idle shutdown, live usage panel with history.
- **Terminal and packages:** xterm.js terminals inside the runtime; per-project Python environment with its own `pip` that reuses the shared PyTorch stack (`%pip install` works), install/uninstall with a live log.
- **AI assistant:** a side panel on your local Ollama models. It sees the open notebook (including unsaved edits), can read cells, files and runtime status with read-only tools, and **only proposes** changes (edit, insert, run, install) that you apply with a button and can undo. Quick actions: Fix error, Explain cell, Make it faster, Write code.
- **Safety model:** notebook code and terminals run as the server's Linux user, so **enable MangoLab only for people you trust** (it is off by default and granted per user by an admin). See `mangolab/README.md` for details and the plan for real isolation.

## Status

| Area | State |
|---|---|
| MangoGPT: chat, history, search, settings, accounts, admin, attachments, image generation, usage log, GPU monitor | Done |
| MangoLab phases 0 to 4: foundations, projects/files/notebooks, running code, terminal/packages/limits/monitoring, AI assistant | Done |
| MangoLab phase 5: stronger isolation (per-user Linux accounts or rootless containers), sharing, always-on services | Planned |
| Services that survive a reboot (everything is currently started by hand) and scheduled backups | Planned |
| MangoGPT projects (named workspaces with instructions), document search with embeddings, conversation import/export | Planned |
| Docker deployment (MangoGPT only) | Files provided, not tested end to end |

## Requirements
- Linux with an NVIDIA GPU, Node.js 20+ (developed on 24), PostgreSQL 14+ (developed on 16)
- [Ollama](https://ollama.com) with at least one chat model; for the assistant a model that supports tools (for example `qwen3.5:9b` or `gemma4:12b`)
- For MangoLab: Python 3.12, [`uv`](https://docs.astral.sh/uv/), systemd with user services (`systemd-run --user`), cgroup v2
- Optional: Python and a GPU for image generation; Docker for the chat app only
- No root is needed for anything here. (Per-user isolation in MangoLab phase 5 will need one-time root setup.)

## Run it (development and single-server production, no Docker)
Start order matters: **PostgreSQL → Ollama → image service (optional) → app → MangoLab API → gateway.**
```bash
# 1. chat app
cp .env.example .env                     # set DATABASE_URL, AUTH_SECRET (openssl rand -hex 32)
npm install
npm run db:migrate
APP_USER=admin APP_PASS='a-long-passphrase' APP_ROLE=admin node scripts/create-user.mjs     # first admin
scripts/start-ollama.sh                  # Ollama on loopback with parallel slots
npm run build && npm run start           # 127.0.0.1:3000   (or: npm run dev)

# 2. MangoLab (optional)
mangolab/scripts/setup-envs.sh           # once: Python environments in ~/.venvs (API + the notebook kernel environment with CUDA PyTorch)
# create mangolab/.env (see mangolab/README.md: MANGOLAB_DATABASE_URL, AUTH_SECRET equal to the app's), then:
(cd mangolab/api && ~/.venvs/mangolab-api/bin/alembic upgrade head)
mangolab/scripts/start-api.sh            # 127.0.0.1:8200

# 3. public front door (TLS) and routing of /lab-api and /lab-ws
node scripts/https-proxy.mjs             # https://<server-ip>:3443
```
Login is enforced when `AUTH_SECRET` is set. Without it the app is single-user, only suitable behind an SSH tunnel on a trusted machine. Restart services by process id (`ss -ltnp`), not with `pkill -f`. MangoLab runtimes live in their own systemd units, so restarting the API does not stop anyone's kernels.

### Docker (chat app only)
```bash
cp .env.example .env && docker compose up -d
```
Host networking so the container reaches Ollama on loopback; binds to `127.0.0.1`; starts its own PostgreSQL 16 (`POSTGRES_PASSWORD`). The Docker files could not be test-built on the development VM. MangoLab is not part of the Docker setup.

### Access
- **SSH tunnel (recommended):** `ssh -L 3000:localhost:3000 user@server`, then open <http://localhost:3000>. MangoLab needs the gateway for its WebSockets, so tunnel `-L 3080:localhost:3080` (the gateway's plain loopback port) instead.
- **HTTPS on the public IP:** `scripts/https-proxy.mjs` listens on `0.0.0.0:3443` with a self-signed certificate in `certs/`; forward TCP 3443 on your router. Accept the certificate warning once, or trust `certs/server.crt`. Regenerate with `openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout certs/server.key -out certs/server.crt -subj "/CN=ollama-chat" -addext "subjectAltName=IP:<ip>"`.
- **Cloudflare quick tunnel:** `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3000` gives a temporary https URL (chat only; the gateway is needed for MangoLab). Enable login first.

## Users, sign-ups and the admin area
Accounts live in the database with scrypt-hashed passwords; sessions are a signed HttpOnly cookie (7 days), shared by the chat app and MangoLab; failed logins are rate-limited per IP and username. Create or reset a user (credentials via environment, out of shell history):
```bash
APP_USER=name APP_PASS='…' APP_ROLE=user node scripts/create-user.mjs
```
**Admin → Sign-ups:** *Closed* (admin adds users), *Approval required* (default) or *Open*. Self sign-up needs an email under `@<subdomain>.uiu.ac.bd` (change with `SIGNUP_EMAIL_DOMAIN`); the email is not verified, admin approval is the real gate. Admins approve, add, disable, change roles, reset passwords and delete users; at least one active admin is always kept; disabling a user locks them out immediately (and stops their MangoLab runtime). Rename the product with `NEXT_PUBLIC_APP_NAME` (rebuild).

**Admin tabs:** *Users*, *Usage & logs* (per-user totals, charts, searchable event log with CSV export), *GPU monitor* (live memory, per-process memory, loaded models, history), *MangoLab* (who may use notebooks and their limits, plus a "Running now" table with a stop button per runtime). Only metadata is logged, never message text, prompts, notebook code or file contents; events are deleted after 90 days (`LOG_RETENTION_DAYS`).

## Chat details
- **Attachments:** up to 5 per message (also drag and drop, paste for images). Documents are extracted server-side and given to the model in `<attached_file>` tags; half the context window is reserved for them. Images (PNG, JPEG, WebP, GIF, ≤ 10 MB) go to vision models. Type is checked from the bytes; SVG, executables and archives are rejected; files are stored under server-generated names (mode 600), downloadable only by the owner, and treated as untrusted data. Limits: `MAX_UPLOAD_MB` (25), 500 MB per user, 60 uploads per hour.
- **Image generation** (`imagesvc/`, FastAPI + diffusers, SDXL-Turbo ≈ 7 GB, `127.0.0.1:8100`): `./imagesvc/setup.sh` once, then `./imagesvc/run.sh`. About 0.5 s per 512×512 image once loaded. The chat and image models do not both fit the GPU, so the app evicts one before using the other. 20 images per hour per user (100 for admins), prompts ≤ 500 characters, a keyword blocklist (a basic filter, not a guarantee; keep sign-ups on *Approval required*). SDXL-Turbo is non-commercial; set `IMAGE_MODEL` for another model.
- **Performance:** load-tested (`docs/load-testing.md`): the web app and database handle hundreds of users; the GPU is the limit. Run Ollama with parallel slots (`scripts/start-ollama.sh`, `OLLAMA_NUM_PARALLEL=4`); each person may have `MAX_CONCURRENT_PER_USER` (2) answers or images generating at once; search uses PostgreSQL trigram indexes; the app's database role has a 10 s query limit (`ALTER ROLE mangogpt IN DATABASE mangogpt SET statement_timeout = '10s';`).

### Keyboard shortcuts (chat)
`Ctrl/⌘ K` search · `Ctrl/⌘ N` or `Ctrl/⌘ Shift O` new chat · `Ctrl/⌘ /` focus prompt · `Esc` stop / close · `Enter` send · `Shift+Enter` new line.
In notebooks: `Shift+Enter` run and move on · `Ctrl+Enter` run · `Alt+Enter` run and add a cell · `Esc` command mode · `a`/`b` insert above/below · `dd` delete · `m`/`y` text/code · `z` undo · `I I` interrupt · `Ctrl+S` save.

## Configuration
Chat app (`.env`):

| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama API (server side only; also used by MangoLab) |
| `DATABASE_URL` | `postgresql://…@127.0.0.1:5432/mangogpt` | PostgreSQL connection |
| `APP_PORT` | `3000` | App port (always on 127.0.0.1) |
| `AUTH_SECRET` | empty (login off) | Enables login and signs session cookies. **MangoLab must use the same value.** |
| `SIGNUP_EMAIL_DOMAIN` | `uiu.ac.bd` | Allowed sign-up email domain |
| `UPLOAD_DIR`, `MAX_UPLOAD_MB` | `./uploads`, `25` | Attachment storage and size |
| `MAX_CONCURRENT_PER_USER` | `2` | Simultaneous generations per person |
| `LOG_RETENTION_DAYS` | `90` | Usage log retention |
| `SLACK_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `APP_PUBLIC_URL` | empty | Optional sign-up alerts |
| `IMAGE_SERVICE_URL`, `IMAGE_MODEL` | `http://127.0.0.1:8100`, SDXL-Turbo | Image generation |
| `POSTGRES_PASSWORD` | | Docker Compose only |

MangoLab (`mangolab/.env`, not committed; full list in `mangolab/README.md`):

| Variable | Default | Meaning |
|---|---|---|
| `MANGOLAB_DATABASE_URL` | required | PostgreSQL URL for the `mangolab` role (schema `mangolab`) |
| `AUTH_SECRET` | required | Same as the app's |
| `MANGOLAB_DATA_DIR` | `~/mangolab-data` | Workspaces, runtime state, package job logs |
| `MANGOLAB_MAX_RUNTIMES` | `6` | Runtimes running at once, all users |
| `MANGOLAB_ASSISTANT`, `MANGOLAB_ASSISTANT_MODEL`, `MANGOLAB_ASSISTANT_NUM_CTX`, `MANGOLAB_ASSISTANT_CONCURRENCY` | on, first tool-capable model, `8192`, `3` | The AI assistant |
| `SAMPLE_INTERVAL_S`, `MANGOLAB_SWEEP_S` | `5`, `30` | Resource sampling and idle checks (lower only for tests) |

Per-user limits (GPU memory, CPU, RAM, disk, runtimes, idle timeout) are set in **Admin → MangoLab**.

## Project layout
```
src/app/              routes and API (api/chat streams NDJSON); /lab pages
src/components/       chat/, sidebar/, settings/, admin/, ui/, lab/ (LabHome, workspace/: notebook editor, file tree, terminal, packages, assistant)
src/hooks, src/stores client hooks; the notebook store (zustand)
src/lib/ollama/       the only chat-app code that talks to Ollama
src/lib/lab/          MangoLab client: API calls, runtime socket, notebook model, outputs, diff
src/services/         business logic (conversations, settings, usage)
prisma/               PostgreSQL schema and migrations (chat app)
imagesvc/             image generation service
mangolab/api/         FastAPI control plane: routers, services (safefs, runtime manager, kernel bridge, terminals, packages, assistant), Alembic migrations, tests
mangolab/scripts/     environment setup and API start scripts
scripts/              gateway, Ollama and PostgreSQL helpers, backups, user creation, Monaco copy
docs/                 load-testing results
```

## Database and backups
PostgreSQL holds everything for both apps (the chat app owns schema `public` through Prisma; MangoLab owns schema `mangolab` through Alembic, with its own role). Chat migrations: `npm run db:migrate` (apply), `npm run db:dev` (create one). Start PostgreSQL **before** the app and keep it on `127.0.0.1`. Search needs `pg_trgm` (the migration creates it).

On this server PostgreSQL 16 runs in user space (binaries `~/.local/pg16`, data `~/pgdata`):
```bash
scripts/postgres.sh start|stop|status
scripts/backup-db.sh                                   # dumps the chat database to ~/backups/mangogpt-db/ (newest 14 kept)
pg_restore -h 127.0.0.1 -U mangogpt -d mangogpt --clean --if-exists <dump>
```
Back up regularly and copy dumps off the machine. Also back up `uploads/` (chat files), `~/mangolab-data/users/` (notebooks and project files) and the `mangolab` schema. Moving from the old SQLite version: `npm run db:import-sqlite -- /path/to/database.db`.

## Checks and tests
```bash
npm run typecheck && npm run lint && npm run build           # chat app + MangoLab front end
~/.venvs/mangolab-api/bin/python -m pytest mangolab/api/tests # unit tests (safe file layer, output merging, assistant context)
```
Integration suites need a running stack and test accounts (see the header of each file): `mangolab/api/tests/integration_phase1.py` (projects, files, notebooks), `integration_phase2.py` (runtimes, kernels), `integration_phase3.py` (packages, terminals, limits), `integration_phase4.py` (assistant, against `mock_ollama.py`), and `live_assistant_smoke.py` for a manual run against the real model. Browser flows were checked with Playwright. Do not run them with a real user's account: they start and stop runtimes.

## Troubleshooting
- **"Cannot reach Ollama":** start Ollama (`scripts/start-ollama.sh`), check `OLLAMA_BASE_URL`. Keep it on localhost and never open port 11434.
- **First reply (or first assistant answer) is slow:** the model is loading onto the GPU.
- **Out of GPU memory:** lower *Context length* in Settings, pick a smaller model, or free GPU memory in a notebook. Notebooks, chat models and the image model share one GPU.
- **MangoLab says "isn't responding":** the control plane is stopped; run `mangolab/scripts/start-api.sh`. Running kernels are unaffected and are picked up again.
- **"Connect" fails with a one-runtime limit message:** each account has a runtime limit; stop the other runtime (the dialog offers to) or raise the limit in Admin → MangoLab.
- **Everything stopped after a reboot:** services are started by hand and do not survive a reboot yet; start them in the order above.

## Licence and third-party terms
No open-source licence has been granted for this code: all rights are reserved by the author unless a licence file is added. Models and components keep their own licences: **SDXL-Turbo** is non-commercial, and each Ollama model (Qwen, Gemma, DeepSeek, …) has its own terms. Check them before any commercial use.
