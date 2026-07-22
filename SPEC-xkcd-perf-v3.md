# SPEC — xkcd-weighted-random: load a random comic at least as fast as xkcd.com

**Repo:** `github.com/NandorKovacs/xkcd-weighted-random`
**Files in scope:** `serve.py`, `app.js`, `index.html`
**Audience:** implementing agent (Claude Code)
**Status:** decisions resolved — ready to implement

> **Changelog from v2.** Review findings folded in. Two structural fixes: the
> `/api/random` transaction no longer contains the cache-miss upstream fetch
> (§4, §5.C5) — measured, the old wording serialised concurrent users behind
> the write lock for the duration of a network call — and the server-side
> source of `latest` is now specified (§4.1), which §6.1's `n == latest` check
> silently depended on. The cold page load is declared out of scope (§2, §8).
> Smaller: invariant 4 reconciled with §6.5's minting rule; the Python pick
> loop's measured cost added to the budget (§1) and test 8 relaxed; `no-store`
> on per-user endpoints (§4); acceptance test 2 split into cold and warm
> variants (§8); two migration edges closed (§5.C4).

> **Changelog from v1.** Three forks closed: the random pick moves server-side
> (§4); seen-history moves to SQLite (§5.C4); static files stay in Python (§5.C1).
> The SQLite decision rewrote more of this document than it looks — it dissolved
> the old §6.2 threading race entirely and replaced it with a different one (§6.2),
> made the global Python lock unnecessary (§5.C3), and turned the comic cache
> cold-start question into a non-issue (§5.C1), so that fourth decision is now
> folded in rather than asked. All §7 forks are closed; §7 is kept as a record.

---

## 1. Goal

Clicking **Random** on xkcd.roaringmind.net currently starts the comic image
download later than xkcd.com does, and the gap grows under concurrency. Close
it. The target is measurable:

> From the Random click to the moment the browser issues the `imgs.xkcd.com`
> request, the site must be no slower than xkcd.com's own random button, and
> must not degrade when several clicks or several users overlap.

The site cannot win by out-running xkcd.com on the network — it sits behind it.
It wins by not talking to xkcd.com at all on the common path, and by not
serialising the requests it does make.

### Measured baseline

Profiled from source plus a local harness with a 150 ms stubbed upstream:

| Symptom | Measurement |
|---|---|
| Static asset served while a proxy call is in flight | 134 ms (should be ~1 ms) |
| 3 users click Random simultaneously | 454 ms (≈3× upstream, should be ≈1×) |
| `save_users()` at 50 users × 3000 seen | 88 ms per click, on the request path |
| `save_users()` at 500 users × 3000 seen | 829 ms per click |
| Round trips before `img.src` is set | 3 (`/api/state`, `/api/comic/N`, then paint) |
| Upstream xkcd.com fetches per Random click | 1, always, uncached |

Not a factor, confirmed — do not spend effort here: the image is served from
`imgs.xkcd.com` identically to xkcd.com. (The weighted pick loop measured
0.17 ms — but that was JavaScript; see the table below for what the same loop
costs once it moves into Python, where it *is* a line item.)

### Target, measured on the proposed design

Benchmarked against the real schema at 500 users × 3000 seen — the load that
costs 829 ms today:

| Operation | Cost |
|---|---|
| `sqlite3.connect()` on an existing file | 0.027 ms |
| Load one user's full seen-history | 1.426 ms |
| Weighted pick over 3100 comics (pure Python) | 2.03 ms |
| Resolve one cached comic | 0.003 ms |
| `BEGIN IMMEDIATE` + upsert seen + `COMMIT` | 0.005 ms |

Server-side work for a complete Random click lands around **3.5 ms**, against
829 ms today, with zero upstream traffic on the warm path. The pick is the
largest single term: the formula "moves unchanged" (§2), but it moves from a
JIT-compiled JS loop into CPython, which is ~10× slower on this kind of tight
float arithmetic. 2 ms is still nothing in absolute terms — but it runs inside
the write transaction (§5.C5), so it is also the length of time the database's
write lock is held per click. Fine at this scale; worth knowing before anyone
adds work to that loop.

## 2. Non-goals

- Changing the weighting maths or its defaults. `pickWeightedRandom`'s formula
  moves to the server unchanged.
- Adding accounts or login.
- Redesigning the UI.
- Adding third-party runtime dependencies. `sqlite3` is stdlib; nothing else joins it.
- **Making the cold page load beat xkcd.com.** *(Decided: out of scope.)* The
  initial page load still runs HTML → `app.js` → `/api/latest` →
  `/api/comic/N` → img: two sequential API round trips where xkcd.com has zero,
  because its `<img>` is in the HTML and the preload scanner fires as the
  markup streams. Keep-alive (C7) and preconnect (C8) shave that path; they do
  not close it. This spec's target is the Random click; the page-load gap is
  noted as follow-up work, and §8's final measurement is scoped accordingly.

## 3. Invariants — must not regress

Verify each of these still holds after the work:

1. Permalinks: `/614/` serves the app and loads comic 614; `/` loads the newest.
2. Browser back/forward moves between comics without a history loop.
3. Comic **404** is never selected or navigated into.
4. A first-time browser is assigned an `xkcd-uid` cookie on the first
   **navigation or API** response it receives. *(Amended: was "including a
   static file" — static assets no longer mint, per §6.5.)*
5. Seen-history and settings survive a server restart.
6. A comic marked seen is reflected in the *next* pick, with no race.
7. Settings are clamped server-side; the client re-renders the clamped values.
8. Prev/next/first/last still work and still skip 404.
9. Every existing user's history in `user-data.json` survives migration.

## 4. Architecture — the load-bearing change

**The random pick moves to the server.** *(Decided: accept.)*

The server already holds the seen-history, the settings, and the clock the
weights are computed against. Having the client fetch all three, pick, then ask
for the result costs two extra round trips and ships an unbounded history to the
browser on every click.

Replace the client-side chain with a single endpoint:

```
GET /api/random
  -> 200 {"num": 614, "img": "...", "title": "...", "safe_title": "...", "alt": "..."}
```

The handler's pipeline, in order — and the order is load-bearing:

1. Resolve `latest` from the server-side cache (§4.1). **No network inside a
   transaction, ever.**
2. `BEGIN IMMEDIATE` → upsert the user row if the uid is fresh → read the
   user's history and settings → compute weights → pick → mark the pick as
   seen → `COMMIT`.
3. Resolve the picked comic's JSON from the `comics` table. On a miss, fetch
   upstream *now* — after the commit, holding no lock — and insert the result
   in its own short transaction.
4. Return the comic JSON. `app.js` sets `img.src` from this first and only
   response.

The transaction wraps only local work: read → pick → mark. It must **not**
contain step 3's miss path. `proxy()` is a network fetch with a 10-second
timeout, and SQLite has exactly one write lock for the whole database — a fetch
inside `BEGIN IMMEDIATE` makes every other user's Random click queue behind one
user's cache miss, and past `busy_timeout` (§5.C3) they stop queuing and fail
with `SQLITE_BUSY`. Measured with a 150 ms stubbed upstream: three concurrent
cache-miss picks complete in 155 / 336 / 585 ms — the baseline's 3×
serialisation, reintroduced by the fix, this time across *different* users. On
a fresh deploy the `comics` table is empty, so the miss path is the common path
for days, not a corner.

The commit-then-fetch ordering has one honest tradeoff: if the upstream fetch
fails, the comic is already marked seen but the client gets a 502 — one comic
slightly downweighted per upstream outage. That is acceptable. Do not "fix" it
by moving the fetch back inside the transaction, and do not add a compensating
delete; the cure is worse than the disease either way.

This design subsumes three separate problems: the round-trip chain, the
`/api/state` history transfer, and the `await markSeen()` stall. It also makes
invariant 6 stronger than it is today — pick-and-mark becomes atomic in the
database instead of relying on the client awaiting a POST before releasing its
`busy` flag.

`/api/random` and `/api/state` are per-user responses and must send
`Cache-Control: no-store` — without it they are fair game for the browser's
heuristic cache, the back/forward cache, and any intermediary the deployment
grows later, and the symptom would be "Random returns the same comic" with
marks that never happen, intermittently, per browser. One acknowledged smell:
`/api/random` is a GET with a side effect (the mark). That is tolerable because
only `fetch()` calls it — no prefetcher or link scanner will — and the
simplicity is worth it; do not RESTify it into a POST mid-implementation.

`/api/state` stays, used only by the settings panel on page load, and no longer
returns `seen`. `/api/seen/<n>` stays, used by prev/next/first/last navigation.

### 4.1 — Where the server learns `latest`

The pick iterates `1..latest`, so `/api/random` cannot run without the number —
and nothing else in this spec provides it server-side. (§6.1's `Cache-Control`
headers govern the *browser's* cache; they do nothing for the server's own
knowledge.)

Keep one server-side cached value: the latest comic number (memory is fine; a
row in the DB also works), refreshed from `xkcd.com/info.0.json` when it is
older than **10 minutes**. Three consumers share it:

- `/api/random`, for the weight range;
- `/api/latest`, for its response body;
- the `n == latest` check in §6.1, which is unimplementable without it.

The refresh is itself an upstream fetch, so per §4 it must never run inside
anyone's write transaction. Fallback when the cache is cold and xkcd.com is
unreachable: `SELECT MAX(num) FROM comics` — stale but usable. If that is also
empty (fresh deploy, upstream down), `/api/random` returns 502; there is
nothing sensible to pick from.

## 5. Changes

Ordered by payoff.

### C1 (Critical) — Cache comic JSON; never re-fetch a comic

**Change.** Comic JSON is served from the `comics` table (§5.C4 schema).
`/api/comic/<n>` and `/api/random` resolve from it and only call `proxy()` on a
miss, writing the result back on the way out. Send `Cache-Control: public,
max-age=31536000, immutable` on comic responses so the browser stops asking too.

**Why.** `proxy()` currently opens a fresh `urllib.request` connection — new TCP,
new TLS, no pooling, no cache — to `xkcd.com/{n}/info.0.json` on *every* hit, for
data that is constant. Comic 614 will never change. This single fact is why the
site cannot currently beat xkcd.com: every click pays xkcd.com's latency plus
your own hop, to fetch a value you already had.

**Storing it in SQLite rather than a Python dict is what closes the cold-start
question.** An in-memory cache is empty after every deploy, so the first clicks
following a restart are as slow as today. Since SQLite is now in the stack, a
`comics` table makes the cache survive restarts for free — no second on-disk
format, no boot-time warming, no thousands of rude requests to xkcd.com. Measured
lookup cost is 0.003 ms, so the table is not meaningfully slower than a dict.
Total footprint for every comic ever published is ~3 MB.

*(If you later want the dict back as an L1 in front of the table, that's fine —
but measure first; 0.003 ms is unlikely to be your bottleneck.)*

**Not cacheable the same way:** `/api/latest`, and the per-user endpoints,
which must carry `no-store` per §4.  See §6.1 for the former.

**Acceptance.** Log every upstream fetch. Click Random until a comic repeats: the
repeat issues zero upstream fetches. Restart the server; a previously-seen comic
still issues zero upstream fetches. `/api/random` and `/api/state` responses
carry `Cache-Control: no-store`.

### C2 (Critical) — `ThreadingHTTPServer`

**Change.** `serve.py` line 163: `HTTPServer` → `ThreadingHTTPServer` (already
imported from `http.server`). Set `daemon_threads = True` so shutdown isn't
blocked by in-flight requests.

**Why.** One request at a time, process-wide. While a proxy call sits in its
10-second-timeout upstream fetch, the server cannot serve `app.js`, `style.css`,
the logo, or another user's anything. Measured: a static asset takes 134 ms
instead of 0.9 ms when a proxy call is in flight; three concurrent Randoms take
454 ms instead of 152 ms.

This matters *more* given the decision to keep static files in Python (§7.1) —
the reverse proxy is not there to absorb the blocked requests.

**This change has a footgun. Read §6.2 before shipping it.**

**Acceptance.** With a stubbed 150 ms upstream: static asset served in <5 ms
while a proxy call is pending; concurrent Randoms per §8 test 2, cold and warm
variants.

### C3 (Critical) — Per-thread database connections

**Change.** No global Python lock. Instead:

```python
_local = threading.local()

def db():
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(DB_PATH, isolation_level=None)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
        _local.conn = conn
    return conn
```

Each pragma is load-bearing:

- **`journal_mode=WAL`** — the default rollback journal makes a writer block all
  readers. Every Random click writes. Without WAL, one person clicking Random
  stalls everyone else's reads, which reintroduces by another route exactly the
  serialisation C2 exists to remove.
- **`synchronous=NORMAL`** — the default `FULL` fsyncs on every commit. Combined
  with WAL, `NORMAL` risks losing only the last few transactions on an OS-level
  crash, never on a process crash. Seen-history is not worth an fsync per click.
- **`busy_timeout=5000`** — WAL still permits only one writer. Without a timeout,
  a concurrent writer gets an immediate `SQLITE_BUSY` error instead of waiting.
- **`isolation_level=None`** — turns off the sqlite3 module's implicit transaction
  management so the explicit `BEGIN IMMEDIATE` in C5 means what it says.

**Note on the `threading.local()` cache.** `ThreadingHTTPServer` spawns a thread
per request, so in practice this yields a fresh connection per request and the
caching is nearly illusory. That is acceptable: `sqlite3.connect()` on an existing
file measures **0.027 ms**. Do not build a connection pool up front. If profiling
later shows connect cost mattering, a `queue.Queue`-based pool is the fix.

### C4 (Critical) — Seen-history in SQLite

**Change.** *(Decided: SQLite.)* Replace `user-data.json` and the in-memory
`USERS` dict.

```sql
CREATE TABLE IF NOT EXISTS users (
  uid              TEXT PRIMARY KEY,
  first_visit      INTEGER NOT NULL,
  minute_ago_ratio REAL NOT NULL DEFAULT 0.01,
  cutoff_minutes   REAL NOT NULL DEFAULT 259200
);

CREATE TABLE IF NOT EXISTS seen (
  uid TEXT    NOT NULL,
  num INTEGER NOT NULL,
  ts  INTEGER NOT NULL,
  PRIMARY KEY (uid, num)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS comics (
  num     INTEGER PRIMARY KEY,
  json    BLOB NOT NULL,
  fetched INTEGER NOT NULL
);
```

The composite primary key on `seen` is deliberate: it provides the `uid` lookup
index and makes marking-seen a natural upsert, with no second index to maintain.
`WITHOUT ROWID` suits the access pattern and shrinks the table.

Marking seen:

```sql
INSERT INTO seen (uid, num, ts) VALUES (?, ?, ?)
ON CONFLICT(uid, num) DO UPDATE SET ts = excluded.ts
```

**Why.** `save_users(USERS)` currently serialises *every user's entire history*
to disk inside the request path, on every click. Measured: 1.83 ms at one user
with 3000 comics seen, 88 ms at 50 users, **829 ms at 500**. It scales with the
whole user base, not with the user making the request. The same operation in
SQLite measures 0.005 ms.

**Migration.** On boot, if `user-data.json` exists and `users` is empty, import
it in one transaction: each record's `firstVisit`, its settings, and every
`seen[num] = ts` pair. Then rename the file to `user-data.json.migrated` — do not
delete it. Two edges, closed here so idempotence is true and not just claimed:

- Records may lack a `settings` key entirely — the current `user()` adds it
  lazily on first touch, so old records on disk won't have one. The importer
  must fall back to the column defaults, not `KeyError`.
- Crash window: if the process dies between `COMMIT` and the rename, the next
  boot finds `user-data.json` present but `users` non-empty. In that case skip
  the import **and still perform the rename**, logging that it happened —
  otherwise the file survives forever and every boot re-evaluates it, one
  future code change away from a double import.

**Acceptance.** Median `/api/random` server time stays flat as the user count
grows from 1 to 500. Migration of a synthetic 500-user file loses no rows,
including records with no `settings` key.

### C5 (Important) — Collapse the round-trip chain

**Change.** Implement `GET /api/random` per §4, with the pipeline and
transaction boundaries specified there: `latest` resolved first from the §4.1
cache, then a single transaction opened with **`BEGIN IMMEDIATE`** (not a bare
`BEGIN`) wrapping read → pick → mark only, then comic resolution outside it.
In `app.js`, `actions.random` becomes a single `fetchJson("/api/random")` whose
result goes straight to `show()`; delete the client-side `pickWeightedRandom`
and the `await markSeen(num)` on that path.

**Why the chain.** Three sequential round trips before `img.src` exists. The image
URL is not known to the browser until trip two returns — whereas on xkcd.com the
`<img>` is in the HTML and the preload scanner starts fetching it as the markup
streams.

**Why `BEGIN IMMEDIATE` specifically.** SQLite's default deferred transaction takes
its write lock late, so two concurrent picks for the same user can both read the
history *before* either writes, and the second pick won't see the first's mark —
silently violating invariant 6. `BEGIN IMMEDIATE` takes the write lock upfront and
makes the second wait. This matters more after this work, not less: the `busy`
flag in `app.js` only guards one tab, and the client is about to get fast enough
that double-clicks and two-tab use are realistic.

**Acceptance.** DevTools shows exactly one origin request per Random click before
the `imgs.xkcd.com` request begins.

### C6 (Important) — Don't let the seen-POST gate the next click

**Change.** For the prev/next/first/last paths that still call `markSeen()`, do
not `await` it before clearing `busy`. Fire it and let it settle; if ordering
against the next pick matters, await the outstanding promise at the *start* of
the next pick instead of the end of the previous one.

**Why.** `goTo()` line 120 awaits a POST that performs a disk write, while the
comic is already painted. The user stares at a dead Random button for the
duration of a write they cannot see. Under C5 the random path stops doing this
entirely; this covers the remaining navigation paths.

### C7 (Minor) — Enable keep-alive

**Change.** Set `protocol_version = "HTTP/1.1"` on the handler class.

**Why.** `BaseHTTPRequestHandler` defaults to HTTP/1.0 (confirmed), so every
request gets a fresh connection from the reverse proxy to the origin.

**Precondition.** HTTP/1.1 keep-alive requires an accurate `Content-Length` (or
chunked encoding) on *every* response, or the connection hangs until timeout.
`send_json()`, `proxy()`, and `SimpleHTTPRequestHandler`'s static path all set it
today. Any new response path added by this work must too — including error paths.
Add a test asserting a 404 and a 502 both carry `Content-Length`.

### C8 (Minor) — Preconnect to the image host

**Change.** In `index.html` `<head>`:
`<link rel="preconnect" href="https://imgs.xkcd.com" crossorigin>`

**Why.** The browser cannot resolve DNS, open TCP, or negotiate TLS for the image
host until the comic JSON lands. A preconnect overlaps that setup with the round
trip you can't remove. One line; worth most on mobile.

## 6. Interactions and required ordering

These are the places where two changes collide. They are the reason this is a
spec and not a bug list.

### 6.1 — C1 must not cache `/api/latest` the way it caches comics

If `/api/latest` is cached with the same immutable policy as `/api/comic/<n>`,
new comics never appear and the site silently freezes at whatever the newest
comic was when the row was written — and with the cache now *persistent* (C1),
that freeze survives restarts, so it will not self-heal on deploy. `/api/latest`
serves from the §4.1 server-side cache (10-minute TTL — ample for a
thrice-weekly comic) and sends `Cache-Control: public, max-age=600` rather than
`immutable`, so the browser's cache expires on the same schedule as the
server's.

Related trap: `/api/comic/<n>` where `n == latest` is the one comic that might
still be in flux shortly after publication. Cache `n < latest` immutably; give
`n == latest` the same short TTL, and don't write it to the `comics` table until
it is no longer the latest. The comparison against `latest` uses the §4.1
cached value — it exists precisely so this check costs nothing.

### 6.2 — C2 + SQLite: the race changed shape, it didn't go away

In v1 of this spec, threading was dangerous because `save_users()` iterated the
shared `USERS` dict while other requests mutated it, producing an intermittent
`RuntimeError: dictionary changed size during iteration` (reproduced locally).
**Choosing SQLite dissolves that**: there is no shared Python dict to serialise,
and no global lock is needed.

It replaces it with a different, equally load-dependent failure. `sqlite3`
connections cannot cross threads — sharing one raises, verbatim:

```
ProgrammingError: SQLite objects created in a thread can only be used in
that same thread.
```

(Also reproduced, not theoretical.) So a module-level `conn = sqlite3.connect(...)`
plus `ThreadingHTTPServer` fails on **every** request after the first thread —
which, unlike the v1 race, at least fails loudly and immediately rather than
under load. **C3 is the fix and is not optional.** Resist the temptation to reach
for `check_same_thread=False`: it silences the guard without making concurrent
use safe, and reintroduces the need for the global lock C3 exists to avoid.

### 6.3 — Ordering

C4 (schema + migration) and C3 (connections) land together or C4 first; nothing
else works without a database. C1's `comics` table is part of C4's schema, so
C4 precedes C1. C2 must not land before C3. C5 depends on C4 and on the §4.1
latest cache. C6, C7, C8 are independent and can land any time.

### 6.4 — C5 changes the client/server contract

`/api/random` returning the comic directly means `app.js` no longer needs
`latestNum` before a random pick, and no longer needs `/api/state` except for the
settings panel. Make sure the `latestNum === null` bootstrap in `goTo()` is still
reached for the prev/next/last paths, which do depend on it.

### 6.5 — Cookie minting under threading

`resolve_uid()` mints a uid for any request without the cookie. A fresh browser
opening the page fires several requests in parallel, all cookie-less, so several
uids get minted and several `Set-Cookie` headers race; the browser keeps one and
the others become orphan rows. Cheaper to avoid than to clean up — but the v2
rule ("only mint on the navigation request") had a hole: a returning browser
with `index.html` cached, or with the cookie cleared, issues no navigation
request at all, so every API call would arrive cookie-less forever with
undefined behaviour.

The rule is therefore: **mint on navigation requests (`/`, `/\d+/`) and on any
`/api/*` request; skip only static assets.** A handler that touches user state
(`/api/random`, `/api/state`, `/api/seen/<n>`, `/api/settings`) upserts the
user row for a freshly minted uid inside its transaction — §4's pipeline shows
where. The orphan-row race this leaves open is confined to the first page
load's parallel API calls, and in the normal case the cookie set by the HTML
response already covers those. Invariant 4 is amended to match (§3.4): first
*navigation or API* response, not "including a static file".

## 7. Decisions taken

Kept as a record of why the design looks like this.

| # | Question | Decision | Consequence |
|---|---|---|---|
| 7.1 | Static files in Python or reverse proxy? | **Keep in Python** | Repo still runs standalone via `python3 serve.py`; makes C2 more important, since nothing else absorbs blocked requests |
| 7.2 | Seen-history persistence | **SQLite** | 829 ms → 0.005 ms per write; dissolved the v1 threading race, introduced the §6.2 one; adds a migration |
| 7.3 | Comic cache cold start | **Folded in: SQLite `comics` table** | Cache survives restarts at no extra cost, since the DB already exists; no second format, no boot warming |
| §4 | Where does the random pick happen? | **Server-side** | Collapses 3 round trips to 1; makes invariant 6 atomic; changes the client/server contract |
| 7.4 | Is the cold page load in scope? | **Out of scope** | Page load keeps its two-API-round-trip chain and will trail xkcd.com's inline-`<img>` first paint; §8's final measurement covers the warm Random click only; noted as follow-up work |

## 8. Acceptance

Build the harness first — it's how every claim above gets checked. Stub the
upstream (`Handler.proxy` monkeypatched to `time.sleep(0.15)`) so results are
deterministic and no traffic hits xkcd.com.

| # | Test | Pass |
|---|---|---|
| 1 | Static asset fetched while a proxy call is in flight | < 5 ms |
| 2a | **Cold cache:** empty `comics` table, 3 concurrent `/api/random` picking distinct comics | ≈1× upstream, not 3× — passes only if the miss fetch is outside the write transaction (§4) |
| 2b | **Warm cache:** 3 concurrent `/api/random`, all picks cached | 0 upstream fetches, single-digit ms each |
| 3 | Same comic requested twice | 0 upstream fetches on the second |
| 4 | Comic requested after a server restart | 0 upstream fetches |
| 5 | Origin requests per Random click, before the image request | exactly 1 |
| 6 | 20 threads × 50 concurrent Randoms | no `ProgrammingError`, no lost marks |
| 7 | Two concurrent picks for one uid | second sees the first's mark (invariant 6) |
| 8 | Median `/api/random` at 1 vs 500 users | within 2×, < 10 ms (~3.5 ms expected; the pick loop is 2 ms of it, §1) |
| 9 | Migration of a synthetic 500-user `user-data.json` | zero rows lost, including records without a `settings` key |
| 10 | 404 and 502 responses | carry `Content-Length` |
| 11 | New comic appears within 10 min of publication | §4.1 server TTL and §6.1 headers honoured |
| 12 | `/api/random` and `/api/state` | carry `Cache-Control: no-store` |
| 13 | Invariants §3.1–§3.9 | all hold |

Then measure the real thing: DevTools, disable cache, compare *request start* of
`imgs.xkcd.com` on both sites **from a warm Random click**. (The cold page load
is out of scope per §2 — do not benchmark it and call the project failed; the
spec deliberately doesn't improve that path.) That number is the goal in §1;
everything above is instrumentation for it.
