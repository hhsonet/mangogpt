# MangoGPT

A private, self-hosted AI chat workspace (in the spirit of ChatGPT and Claude) that runs entirely on your own GPU through [Ollama](https://ollama.com).
The browser only talks to this app; the app talks to Ollama on `127.0.0.1`. Ollama is never exposed.

```
Browser → Next.js (UI + API routes) → Ollama (127.0.0.1:11434) → GPU
                    ├→ PostgreSQL (Prisma)
                    └→ Image service (127.0.0.1:8100, optional) → GPU
```

## Features
- **Chat:** streaming answers with Stop, Markdown, tables, math, highlighted code with copy, collapsible model reasoning, edit / regenerate / continue, model picker (read live from Ollama).
- **Conversations:** rename, pin, duplicate, delete, full-text search, auto titles.
- **Attachments:** PDF, Word, text and source files (text extracted server-side) and images for vision models.
- **Image generation:** SDXL-Turbo through a small local Python service, shared GPU managed automatically.
- **Accounts:** username or email sign-in, self sign-up with a restricted email domain and admin approval, per-user data and settings.
- **Admin:** user management, usage and audit log with CSV export, live GPU monitor, optional Slack/Telegram sign-up alerts.
- **UI:** dark/light/system themes, responsive layout, keyboard shortcuts.

## Status

| Area | State |
|---|---|
| Chat, history, search, settings, accounts, admin, attachments, image generation, usage log, GPU monitor | Done |
| Projects (named workspaces with their own instructions) | Planned (database tables exist, no UI yet) |
| Document search with embeddings (RAG) | Planned (`src/lib/rag` is reserved; attachments are currently placed in the prompt) |
| Conversation import / export | Planned |
| Docker deployment | Files provided, not yet tested end to end |

## Requirements
- Node.js 20+ (developed on 24)
- PostgreSQL 14+ (developed on 16)
- [Ollama](https://ollama.com) running locally with at least one chat model, e.g. `ollama pull qwen3.5:9b`
- Optional: Python 3.10+ and an NVIDIA GPU for image generation (see *Image generation*)
- Docker is optional

## Run (development, no Docker)
```bash
cp .env.example .env          # then edit DATABASE_URL (and set AUTH_SECRET, see below)
npm install
npm run db:migrate            # applies the database migrations to PostgreSQL
APP_USER=admin APP_PASS='a-long-passphrase' APP_ROLE=admin node scripts/create-user.mjs   # first admin
npm run dev                   # http://127.0.0.1:3000
```
Login is enforced when `AUTH_SECRET` is set (`openssl rand -hex 32`). Without it the app runs in single-user mode, which is only suitable behind an SSH tunnel on a trusted machine.

## Run (production, no Docker)
```bash
npm install && npm run db:migrate && npm run build
npm run start        # binds to 127.0.0.1:$APP_PORT
```

## Run (Docker)
```bash
cp .env.example .env
docker compose up -d
```
The container uses host networking so it can reach Ollama on the host's loopback, and it binds to `127.0.0.1` only.
Docker Compose starts its own PostgreSQL 16 (set `POSTGRES_PASSWORD` in `.env`). Data lives in the `chat-db` and `chat-uploads` volumes. *(The Docker files were written but could not be test-built on the development VM, which has no Docker.)*

## Access over SSH (recommended)
The server does not need a public web port. From your own computer:

```bash
ssh -L 3000:localhost:3000 username@server-ip
```
Then open <http://localhost:3000>. If port 3000 is busy locally, use `-L 8080:localhost:3000` and open `http://localhost:8080`.
Clipboard copy works because `localhost` counts as a secure context.

## Login and users
Login is enforced whenever `AUTH_SECRET` is set in `.env` (`openssl rand -hex 32`). Accounts live in the database with
scrypt-hashed passwords; sessions use a signed HttpOnly cookie (7 days) and failed logins are rate-limited per IP and per username.
Create or reset a user (credentials via environment so they stay out of shell history):
```bash
APP_USER=admin APP_PASS='a-long-passphrase' APP_ROLE=admin node scripts/create-user.mjs
```

### Sign-ups and the admin page
The sign-in page has a *Create account* tab. The admin controls who can use it at **Admin → Sign-ups**:
**Closed** (admin adds users), **Approval required** (default; new accounts wait for approval), or **Open**.
Admins (Admin link in the sidebar) can approve or reject requests, add users, disable or re-enable, change roles, reset passwords and delete users.
Self sign-up requires a university email under `@<subdomain>.uiu.ac.bd` (e.g. `name@cse.uiu.ac.bd`; set `SIGNUP_EMAIL_DOMAIN` to change the domain). The email is **not verified**; admin approval is what actually gates access. People can sign in with their username or email.
Each user has private conversations and settings; at least one active admin is always kept. Disabling a user locks them out immediately.
Rename the product with `NEXT_PUBLIC_APP_NAME="Another Name"` in `.env` (rebuild after changing it).

## MangoLab (notebooks, beta)
A Colab-style notebook workspace on the same GPU is being added at `/lab` (see `mangolab/README.md`). Phase 0 is in place: a FastAPI control plane (`mangolab/`), single sign-on with this app, a per-user access switch under **Admin -> MangoLab**, a WebSocket-capable gateway (`scripts/https-proxy.mjs`) and a verified Jupyter + CUDA runtime. **Notebook code runs as the server's Linux user, so only enable it for people you trust.**

## Performance and fair use
Load-tested on a 10-core VM with a 16 GiB GPU slice (full results in `docs/load-testing.md`). The web app and database comfortably handle hundreds of simultaneous users; **the GPU is the limit**, so:
- **Run Ollama with parallel slots.** `scripts/start-ollama.sh` starts Ollama on `127.0.0.1` with `OLLAMA_NUM_PARALLEL=4` (override with the variable). Compared with the default of 1, four people asking at once waited 0.5 s instead of 3.1 s for the first word and finished in 2.7 s instead of 8 s; total throughput rose about 2.7x for about 2.5 GiB more GPU memory. Memory grows with *slots × context length*, so reduce the slots if you raise *Context length* in Settings.
- **Per-user limit.** Each person can have at most `MAX_CONCURRENT_PER_USER` (default 2) answers or images being generated at once, so one user can't queue enough requests to starve everyone else. Extra requests get a clear message.
- **Search** uses PostgreSQL trigram indexes (`pg_trgm`, created by a migration). Words of 3+ characters search titles and message text; 1-2 character searches match titles only. `%` and `_` are searched literally.
- **Query time limit.** The app's database user is capped at 10 seconds per query so one runaway query can't hog the database: `ALTER ROLE mangogpt IN DATABASE mangogpt SET statement_timeout = '10s';`
- **Admin usage page** is computed inside PostgreSQL and cached for 15 seconds, so many admins refreshing is cheap.

## Admin: usage, logs and GPU monitor
Admins get three tabs under **Admin**: *Users*, *Usage & logs* and *GPU monitor*.
- **Usage & logs** (`/admin/usage`): per-user totals (chats, images, uploads, tokens read/generated, GPU time, errors, last active) over 24 hours, 7 or 30 days, requests and token charts, and a searchable, filterable event log (chat, image, upload, sign-in, failed sign-in, sign-up, admin actions) with CSV export. Click a username to filter the log to that person.
- **Privacy:** only metadata is recorded (who, when, model, token counts, duration, status, a short note). Message text, prompts and file contents are never stored in the log. IP addresses are kept for sign-ins, sign-ups and admin actions only. Events are deleted after 90 days (`LOG_RETENTION_DAYS`).
- **GPU monitor** (`/admin/gpu`): a live view (server-sent events, every 2 s) of GPU memory, GPU memory per process, which chat models are loaded and when they unload, image-service state, generations in progress, last token speed, CPU, RAM and disk, with an hour of history. It warns when GPU memory is nearly full or two chat models are loaded at once, and has an **Unload models** button. This virtual GPU does not expose utilisation, temperature or power, so those are not shown rather than guessed. Ollama sometimes under-reports a model's size; the per-process panel is the accurate one.

## Attachments
The paperclip in the composer (also drag-and-drop, and paste for images) attaches up to 5 files per message.
- **Documents** (PDF, Word `.docx`, text, Markdown, CSV/JSON, source code): the text is extracted on the server and given to the model inside `<attached_file>` tags. Half of the context window is reserved for attached text; if a file is longer, only the start is used and the chat shows a notice. Raise *Context length* in Settings to fit more. Scanned PDFs have no text; attach their pages as images instead.
- **Images** (PNG, JPEG, WebP, GIF, up to 10 MB): sent to vision models (marked "vision" in the model picker, e.g. `gemma4:12b`, `qwen3.5:9b`). Images from the last 3 image messages stay in context.
- **Security:** type is checked from the file's bytes, not its name; SVG, executables and archives are rejected; filenames are sanitized and files are stored under server-generated names in `uploads/files/<user>/` (mode 600); only the owner can download them (documents are always forced to download, never rendered); text inside files is treated as untrusted data, not instructions. Limits: `MAX_UPLOAD_MB` (default 25), 500 MB per user, 60 uploads/hour.
- Attachments are deleted with their message, conversation or user. Unsent uploads are removed after 24 hours.

## Image generation
MangoGPT can create images in chat (the **Image** button in the composer; admins can switch it off under Admin → Image generation).
It uses a separate local service, `imagesvc/` (FastAPI + diffusers, model **SDXL-Turbo**, ~7 GB), bound to `127.0.0.1:8100`:
```bash
./imagesvc/setup.sh   # once: creates the venv in ~/.venvs/mangogpt-imagesvc and downloads the model
./imagesvc/run.sh     # start the service
```
- **Speed:** about 0.5 s per 512×512 image once loaded; the first image takes about 10–15 s while the model loads.
- **GPU sharing:** the chat model and image model can't both fit in ~15.5 GiB, so the app evicts one before using the other (switching costs a few seconds).
- **Privacy and limits:** images are stored under `uploads/images/<user>/`, served only to their owner, and deleted with the conversation or user. 20 images per hour per user (100 for admins), one generation at a time, prompts up to 500 characters.
- **Safety:** SDXL-Turbo has no built-in safety checker, so the service refuses prompts matching a keyword blocklist (explicit or gory content). This is a basic filter, not a guarantee; keep sign-ups on *Approval required*.
- **Licence:** SDXL-Turbo is released for non-commercial use under Stability AI's licence. Check it before any commercial use, or set `IMAGE_MODEL` to a different diffusers model.
- The Next.js app finds the service via `IMAGE_SERVICE_URL` (default `http://127.0.0.1:8100`).

## Public link (Cloudflare quick tunnel)
For a temporary public https link without opening any firewall port, use a Cloudflare quick tunnel
([`cloudflared`](https://github.com/cloudflare/cloudflared/releases)):
```bash
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3000
```
It prints a random `https://….trycloudflare.com` URL that changes on every restart. **Make sure login is enabled first.**
Stop sharing by stopping the `cloudflared` process. For a permanent URL use a named Cloudflare tunnel with your own domain.

## Public IP access over HTTPS
`scripts/https-proxy.mjs` is a small TLS front door: it listens on `0.0.0.0:3443` and forwards to the app on `127.0.0.1:3000`,
so the app itself is never bound to a public interface. It uses a self-signed certificate in `certs/` (SAN includes the server IPs).
```bash
node scripts/https-proxy.mjs          # then open https://<server-ip>:3443
```
The browser will warn about the self-signed certificate; accept it once (or import `certs/server.crt` as trusted).
For access from the internet, forward **TCP 3443 → <server-private-ip>:3443** on the router/firewall. Make sure login is enabled first.
Regenerate the certificate with `openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout certs/server.key -out certs/server.crt -subj "/CN=ollama-chat" -addext "subjectAltName=IP:<ip>"`.

## Configuration (`.env`)
| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama API (server-side only) |
| `DATABASE_URL` | `postgresql://…@127.0.0.1:5432/mangogpt` | PostgreSQL connection string |
| `APP_PORT` | `3000` | Port the app listens on (always on 127.0.0.1). Docker Compose reads it from `.env`; for npm scripts set it in the shell: `APP_PORT=3001 npm run dev` |
| `AUTH_SECRET` | empty (login off) | Enables login; signs session cookies |
| `UPLOAD_DIR`, `MAX_UPLOAD_MB` | `./uploads`, `25` | Used from Phase 2 |

Keep Ollama bound to localhost: `OLLAMA_HOST=127.0.0.1:11434 ollama serve` (the default). Never open port 11434 in a firewall.

## Features (Phase 1)
- Streaming chat with Stop (button or `Esc`); stopping cancels generation on the GPU and keeps the partial answer
- Models read dynamically from Ollama (`/api/tags`), with size and description; default model remembered
- Reasoning models (Qwen 3.5, DeepSeek-R1): the model's thinking shows in a collapsible *Reasoning* block; the brain button turns reasoning off for faster answers
- Markdown, GFM tables, KaTeX math, highlighted code with language label, copy and wrap toggle
- Edit a user message (truncates later messages and regenerates), regenerate, continue, retry, copy
- Conversations in PostgreSQL: rename, pin, duplicate, delete, search titles and message text, auto-generated titles
- Dark (default) / light / system theme, font size, compact mode, responsive layout with a mobile drawer
- Ollama status indicator, friendly errors for: Ollama offline, model missing, out of GPU memory, context too large, connection lost

## Keyboard shortcuts
| Keys | Action |
|---|---|
| `Ctrl/⌘ K` | Search conversations |
| `Ctrl/⌘ N` or `Ctrl/⌘ Shift O` | New chat (browsers often reserve `Ctrl+N`; use the Shift+O alternative then) |
| `Ctrl/⌘ /` | Focus prompt |
| `Esc` | Stop generation / close dialogs |
| `Enter` / `Shift+Enter` | Send / new line |

## Project layout
```
src/app/            routes + API (api/chat streams NDJSON)
src/components/     chat/, sidebar/, settings/, ui/
src/hooks/          client hooks (useChat = streaming state machine)
src/lib/ollama/     the only code that talks to Ollama
src/lib/db/         Prisma client
src/services/       business logic (conversations, settings)
src/lib/rag/        reserved for Phase 3
prisma/schema.prisma  PostgreSQL schema + versioned migrations
```

## Database (PostgreSQL)
MangoGPT stores everything (users, chats, settings, usage log) in PostgreSQL through Prisma. Schema changes are versioned migrations in `prisma/migrations/`:
```bash
npm run db:migrate    # production: apply pending migrations
npm run db:dev        # development: create a new migration after editing prisma/schema.prisma
```
**Set up a database** (any PostgreSQL 14+): create a role and database, then put the URL in `.env`:
```sql
CREATE ROLE mangogpt LOGIN PASSWORD '…';
CREATE DATABASE mangogpt OWNER mangogpt ENCODING 'UTF8';
```
```
DATABASE_URL=postgresql://mangogpt:…@127.0.0.1:5432/mangogpt?schema=public&connection_limit=10
```
Keep PostgreSQL bound to `127.0.0.1` and start it **before** the app. Search needs the `pg_trgm` extension; the migration creates it (PostgreSQL 13+ lets a database owner do that).

**This server** runs PostgreSQL 16 in user space (no root needed): binaries in `~/.local/pg16`, data in `~/pgdata`, listening on `127.0.0.1:5432`.
```bash
scripts/postgres.sh start|stop|status   # manage the server
scripts/backup-db.sh                    # dump to ~/backups/mangogpt-db/ (keeps the newest 14)
pg_restore -h 127.0.0.1 -U mangogpt -d mangogpt --clean --if-exists <dump file>   # restore
```
Back up regularly (cron or `/schedule`) and copy the dumps off the machine. Uploaded files live in `uploads/`, not in the database, so back that folder up too.

**Moving from the old SQLite version:** stop the app, run `npm run db:migrate`, then `npm run db:import-sqlite -- /path/to/database.db`. The tool refuses to run against a database that already has data, copies every table in dependency order and prints a per-table count comparison.

## Checks
```bash
npm run typecheck && npm run lint && npm run build
```

## Troubleshooting
- **"Cannot reach Ollama"**: run `ollama serve`, check `OLLAMA_BASE_URL`.
- **First reply is slow**: the model is loading into GPU memory; the UI shows "Loading model…".
- **Out of GPU memory**: lower *Context length* in Settings or pick a smaller model.

## Licence and third-party terms
No open-source licence has been granted for this code: all rights are reserved by the author unless a licence file is added.
Models and components you download keep their own licences. In particular **SDXL-Turbo** (image generation) is released for non-commercial use, and each Ollama model (Qwen, Gemma, DeepSeek, …) has its own terms. Check them before any commercial use.
