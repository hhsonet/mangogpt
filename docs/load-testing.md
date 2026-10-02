# Load testing

Tested 2026-10-02 on a 10-core VM (the load generator ran on the same machine, over loopback) with a PostgreSQL 16 database
holding 31 users, ~1,200 conversations, 114,000 messages and 150,000 log events. App-tier tests used a fake instant model;
GPU tests used the real model (gemma4:12b on a 16 GiB GPU slice). One run per scenario, so treat differences of a few percent as noise.

## Results after the fixes

| Area | Result |
|---|---|
| Page loads | ~1,900 req/s at 200 simultaneous users, none failed |
| Conversation list / detail | ~1,250 / ~1,100 req/s, slowest 1% under 230 ms at 200 users |
| Streaming chat (fake model, 40 tok/s) | 800 simultaneous streams: 179 answers/s, 0 failures, every answer saved; 1,500 streams also 0 failures |
| Browsing while 200 users stream | slowest 1% 126 ms -> ~230 ms |
| Memory | flat across five heavy rounds (no leak); ~530 MB under 200 streams |
| Sign-in | ~150/s ceiling (password hashing), by design |

## Problems the test found, and the fixes

| Problem | Before | After |
|---|---|---|
| Admin usage page loaded up to 200k log rows into app memory per request | 10 admins at once: 3.7 s (worst 6.9 s), **4.2 GB** RAM | 8 ms, 487 MB (computed in SQL, 15 s cache; verified identical to a slow reference calculation for 24h/7d/30d) |
| First-time settings creation raced on a unique key | 2.7% HTTP 500 under a burst | 0 failures (read first, `INSERT ... ON CONFLICT DO NOTHING`) |
| Search that matches nothing scanned every message the user owns | 219 ms (45 req/s at 430 ms with 20 users) for 3,800 messages, growing with history | 8 ms; common words 8 ms; rare words 4 ms (trigram index + a fallback plan for very common words) |
| Search treated `%` and `_` as wildcards | `%%%` matched everything | literal |
| Prepared-statement "generic plan" made the common-word search scan every message | 210 ms inside the app vs 7 ms by hand | `plan_cache_mode = force_custom_plan` for that query |
| No fairness: one user could queue many generations | unbounded | at most 2 at a time per user, released on errors and on Stop (tested) |
| Deleting a user left their settings row behind | orphan rows | removed with the user |

## Real GPU (gemma4:12b)

| People asking at once | 1 slot (default): first word / total | 4 parallel slots: first word / total |
|---|---|---|
| 1 | 0.2 s / 1.9 s | 0.3 s / 2.0 s |
| 2 | 1.3 s / 3.8 s | 0.4 s / 3.0 s |
| 4 | 3.1 s / 8.0 s | **0.5 s / 2.7 s** |
| 8 | 7.0 s / 15.3 s | 2.1 s / 6.6 s |

Overall throughput ~27 -> ~75 chunks/s; GPU memory ~9.1 -> ~11.6 GiB. Re-verified on the live system after the change.
Rough capacity: about 5-8 people actively chatting at once with 1 slot, about 15-20 with 4 (reasoning answers are longer, so fewer).

## Not covered
Real internet latency, the HTTPS proxy and the Cloudflare tunnel; image generation under load; file uploads under load;
multi-hour soak; more than ~1M messages.
