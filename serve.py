#!/usr/bin/env python3
"""Tiny static file server + xkcd API proxy + per-user weighted random.

Users are identified by a cookie (no login). Seen-history and settings are
stored in SQLite (data.db). Comic JSON is cached in the DB so upstream is
only called on a miss.
"""
import json
import math
import os
import random
import re
import secrets
import sqlite3
import sys
import threading
import time
import urllib.request
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

DEFAULT_PORT = 8000
XKCD_LATEST = "https://xkcd.com/info.0.json"
XKCD_COMIC = "https://xkcd.com/{num}/info.0.json"

UID_COOKIE = "xkcd-uid"
DEFAULT_SETTINGS = {
    "minuteAgoRatio": 0.01,
    "cutoffMinutes": 180 * 24 * 60,
}
UID_RE = re.compile(r"[A-Za-z0-9_-]{16,64}")

# Module-level constants that tests can patch
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.db")
DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "user-data.json")

# Pick constants (match app.js exactly)
UNSEEN_HEAD_START = 30 * 24 * 60 * 60 * 1000  # 30 days in ms
MISSING_COMIC = 404
MINUTE_MS = 60000


def now_ms():
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# Upstream fetch — ONE call site for all upstream HTTP
# ---------------------------------------------------------------------------

def fetch_upstream(url):
    """Fetch url from xkcd.com. Returns bytes. Raises on any failure."""
    print(f"[upstream] GET {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "xkcd-weighted-random"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return resp.read()


# ---------------------------------------------------------------------------
# Per-thread DB connections (C3)
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Schema + migration (C4)
# ---------------------------------------------------------------------------

def init_db():
    """Create schema and migrate legacy user-data.json if present."""
    conn = db()
    conn.executescript("""
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
    """)

    # Migration from user-data.json
    if not os.path.exists(DATA_FILE):
        return

    migrated_path = DATA_FILE + ".migrated"

    # Check if users table is non-empty
    row = conn.execute("SELECT COUNT(*) FROM users").fetchone()
    users_count = row[0]

    if users_count > 0:
        # Already migrated but file survived (crash window) — just rename
        os.rename(DATA_FILE, migrated_path)
        print(f"[migration] users table non-empty; renamed {DATA_FILE} to {migrated_path} without re-importing")
        return

    # Import
    try:
        with open(DATA_FILE) as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        print(f"[migration] failed to read {DATA_FILE}: {e}")
        return

    print(f"[migration] importing {len(data)} users from {DATA_FILE}")
    conn.execute("BEGIN")
    try:
        for uid, record in data.items():
            first_visit = record.get("firstVisit", now_ms())
            settings = record.get("settings", {})
            minute_ago_ratio = settings.get("minuteAgoRatio", DEFAULT_SETTINGS["minuteAgoRatio"])
            cutoff_minutes = settings.get("cutoffMinutes", DEFAULT_SETTINGS["cutoffMinutes"])
            conn.execute(
                "INSERT INTO users (uid, first_visit, minute_ago_ratio, cutoff_minutes) VALUES (?, ?, ?, ?)",
                (uid, first_visit, minute_ago_ratio, cutoff_minutes),
            )
            for num_str, ts in record.get("seen", {}).items():
                conn.execute(
                    "INSERT INTO seen (uid, num, ts) VALUES (?, ?, ?)",
                    (uid, int(num_str), ts),
                )
        conn.execute("COMMIT")
    except Exception as e:
        conn.execute("ROLLBACK")
        print(f"[migration] import failed, rolled back: {e}")
        return

    os.rename(DATA_FILE, migrated_path)
    print(f"[migration] done; renamed {DATA_FILE} to {migrated_path}")


# ---------------------------------------------------------------------------
# §4.1 — Server-side latest-comic cache
# ---------------------------------------------------------------------------

_latest_lock = threading.Lock()
_latest_num = None
_latest_ts = 0
_LATEST_TTL_MS = 10 * 60 * 1000  # 10 minutes


def get_latest():
    """Return the latest comic number from the server-side cache.

    Refreshes from xkcd.com when older than 10 minutes. Never called inside
    a write transaction. Falls back to MAX(num) from comics table. Returns
    None if both are unavailable.
    """
    global _latest_num, _latest_ts
    now = now_ms()
    with _latest_lock:
        if _latest_num is not None and (now - _latest_ts) < _LATEST_TTL_MS:
            return _latest_num
        # Need refresh — release lock during network call? No: we hold it to
        # avoid thundering herd. The lock is only held for the duration of one
        # upstream fetch (≤10 s), not during any DB transaction.
        try:
            body = fetch_upstream(XKCD_LATEST)
            data = json.loads(body)
            _latest_num = int(data["num"])
            _latest_ts = now
            return _latest_num
        except Exception as e:
            print(f"[latest] upstream failed: {e}")
            # Fallback: MAX(num) from comics
            try:
                row = db().execute("SELECT MAX(num) FROM comics").fetchone()
                if row and row[0]:
                    _latest_num = int(row[0])
                    # Don't update _latest_ts so next call retries upstream
                    return _latest_num
            except Exception:
                pass
            return None


# ---------------------------------------------------------------------------
# Weighted pick (ported from app.js pickWeightedRandom, formula unchanged)
# ---------------------------------------------------------------------------

def pick_weighted_random(latest_num, now, first_visit, seen_rows, ratio, cutoff_minutes):
    """Return a comic number using the same formula as app.js pickWeightedRandom.

    seen_rows: list of (num, ts) tuples for this user.
    """
    unseen_last_seen = first_visit - UNSEEN_HEAD_START
    cutoff_ms = cutoff_minutes * 60000 if cutoff_minutes > 0 else float("inf")
    U = now - unseen_last_seen  # weight of a never-seen comic

    seen_map = {num: ts for num, ts in seen_rows}

    weights = [0.0] * (latest_num + 1)
    total = 0.0
    for n in range(1, latest_num + 1):
        if n == MISSING_COMIC:
            continue
        last_seen = seen_map.get(n, unseen_last_seen)
        if now - last_seen > cutoff_ms:
            last_seen = unseen_last_seen  # forgotten
        t = now - last_seen
        w = U * (ratio + (1 - ratio) * (t - MINUTE_MS) / (U - MINUTE_MS))
        weights[n] = max(w, 1.0)
        total += weights[n]

    r = random.random() * total
    for n in range(1, latest_num + 1):
        r -= weights[n]
        if r < 0:
            return n
    return latest_num  # float rounding fallback


# ---------------------------------------------------------------------------
# Comic JSON cache helpers
# ---------------------------------------------------------------------------

def get_comic_from_db(num):
    """Return cached comic JSON bytes for num, or None on miss."""
    row = db().execute("SELECT json FROM comics WHERE num = ?", (num,)).fetchone()
    return row[0] if row else None


def store_comic_in_db(num, body_bytes):
    """Insert or replace comic JSON in the cache."""
    conn = db()
    conn.execute("BEGIN")
    try:
        conn.execute(
            "INSERT INTO comics (num, json, fetched) VALUES (?, ?, ?) "
            "ON CONFLICT(num) DO UPDATE SET json=excluded.json, fetched=excluded.fetched",
            (num, body_bytes, now_ms()),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # --- cookie / uid -------------------------------------------------------

    def _should_mint_uid(self):
        """Mint uid on nav requests and /api/* — not on static assets."""
        p = self.path.split("?")[0]
        if p == "/" or re.fullmatch(r"/\d+/?", p):
            return True
        if p.startswith("/api/"):
            return True
        return False

    def resolve_uid(self):
        """Greedy identification: take the cookie if present, mint if needed."""
        for part in self.headers.get("Cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == UID_COOKIE and UID_RE.fullmatch(value):
                self.uid = value
                self.new_uid = False
                return
        if self._should_mint_uid():
            self.uid = secrets.token_urlsafe(24)
            self.new_uid = True
        else:
            self.uid = None
            self.new_uid = False

    def end_headers(self):
        # Static files (and index.html) must revalidate: browsers heuristically
        # cache responses with no Cache-Control, so a deploy that changes the
        # API contract leaves stale app.js copies calling the new server.
        if getattr(self, "static_response", False):
            self.send_header("Cache-Control", "no-cache")
            self.static_response = False
        if getattr(self, "new_uid", False):
            self.send_header(
                "Set-Cookie",
                f"{UID_COOKIE}={self.uid}; Max-Age=315360000; Path=/; SameSite=Lax; HttpOnly",
            )
            self.new_uid = False
        super().end_headers()

    # --- routing ------------------------------------------------------------

    def do_GET(self):
        self.resolve_uid()
        p = self.path.split("?")[0]

        if p == "/api/latest":
            return self._handle_latest()
        if p == "/api/state":
            return self._handle_state()
        if p == "/api/random":
            return self._handle_random()
        m = re.fullmatch(r"/api/comic/(\d+)", p)
        if m:
            return self._handle_comic(int(m.group(1)))
        if re.fullmatch(r"/\d+/?", p):
            self.path = "/index.html"
        self.static_response = True
        return super().do_GET()

    def do_POST(self):
        self.resolve_uid()
        p = self.path.split("?")[0]
        if p == "/api/settings":
            return self._handle_settings()
        m = re.fullmatch(r"/api/seen/(\d+)", p)
        if m:
            return self._handle_mark_seen(int(m.group(1)))
        return self.send_json(404, {"error": "not found"})

    # --- /api/latest --------------------------------------------------------

    def _handle_latest(self):
        num = get_latest()
        if num is None:
            return self.send_json(502, {"error": "upstream unavailable"})
        body = json.dumps({"num": num}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "public, max-age=600")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- /api/state ---------------------------------------------------------

    def _handle_state(self):
        if self.uid is None:
            return self.send_json(400, {"error": "no uid"})
        conn = db()
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT first_visit, minute_ago_ratio, cutoff_minutes FROM users WHERE uid=?",
                (self.uid,),
            ).fetchone()
            if row is None:
                fv = now_ms()
                conn.execute(
                    "INSERT INTO users (uid, first_visit, minute_ago_ratio, cutoff_minutes) VALUES (?, ?, ?, ?)",
                    (self.uid, fv, DEFAULT_SETTINGS["minuteAgoRatio"], DEFAULT_SETTINGS["cutoffMinutes"]),
                )
                mar = DEFAULT_SETTINGS["minuteAgoRatio"]
                cm = DEFAULT_SETTINGS["cutoffMinutes"]
            else:
                fv, mar, cm = row
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

        return self.send_json(200, {
            "now": now_ms(),
            "firstVisit": fv,
            "settings": {
                "minuteAgoRatio": mar,
                "cutoffMinutes": cm,
            },
        }, extra_headers={"Cache-Control": "no-store"})

    # --- /api/random --------------------------------------------------------

    def _handle_random(self):
        if self.uid is None:
            return self.send_json(502, {"error": "no uid"})

        # Step 1: resolve latest BEFORE any transaction (§4.1)
        latest = get_latest()
        if latest is None:
            return self.send_json(502, {"error": "upstream unavailable and no comics cached"})

        now = now_ms()

        # Step 2: BEGIN IMMEDIATE — upsert user, read history+settings, pick, mark seen
        conn = db()
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT first_visit, minute_ago_ratio, cutoff_minutes FROM users WHERE uid=?",
                (self.uid,),
            ).fetchone()
            if row is None:
                fv = now
                mar = DEFAULT_SETTINGS["minuteAgoRatio"]
                cm = DEFAULT_SETTINGS["cutoffMinutes"]
                conn.execute(
                    "INSERT INTO users (uid, first_visit, minute_ago_ratio, cutoff_minutes) VALUES (?, ?, ?, ?)",
                    (self.uid, fv, mar, cm),
                )
            else:
                fv, mar, cm = row

            seen_rows = conn.execute(
                "SELECT num, ts FROM seen WHERE uid=?", (self.uid,)
            ).fetchall()

            picked = pick_weighted_random(latest, now, fv, seen_rows, mar, cm)

            # Mark seen
            conn.execute(
                "INSERT INTO seen (uid, num, ts) VALUES (?, ?, ?) "
                "ON CONFLICT(uid, num) DO UPDATE SET ts = excluded.ts",
                (self.uid, picked, now),
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

        # Step 3: resolve comic JSON — outside the transaction
        comic_bytes = self._resolve_comic(picked, latest)
        if comic_bytes is None:
            return self.send_json(502, {"error": f"failed to fetch comic {picked}"})

        # Step 4: return comic JSON
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(comic_bytes)))
        self.end_headers()
        self.wfile.write(comic_bytes)

    # --- /api/comic/<n> -----------------------------------------------------

    def _handle_comic(self, num):
        latest = get_latest()  # needed for §6.1 n==latest check
        comic_bytes = self._resolve_comic(num, latest)
        if comic_bytes is None:
            return self.send_json(502, {"error": f"failed to fetch comic {num}"})

        is_latest = (latest is not None and num == latest)
        if is_latest:
            cc = "public, max-age=600"
        else:
            cc = "public, max-age=31536000, immutable"

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", cc)
        self.send_header("Content-Length", str(len(comic_bytes)))
        self.end_headers()
        self.wfile.write(comic_bytes)

    def _resolve_comic(self, num, latest):
        """Return comic JSON bytes from DB cache, fetching upstream on miss.

        Returns None on failure. Does NOT write to DB if num == latest.
        """
        cached = get_comic_from_db(num)
        if cached is not None:
            return cached

        # Cache miss — fetch upstream (no lock held)
        url = XKCD_COMIC.format(num=num)
        try:
            body = fetch_upstream(url)
        except Exception as e:
            print(f"[comic] upstream fetch failed for {num}: {e}")
            return None

        # Only cache if it's not the current latest (§6.1)
        is_latest = (latest is not None and num == latest)
        if not is_latest:
            try:
                store_comic_in_db(num, body)
            except Exception as e:
                print(f"[comic] failed to cache comic {num}: {e}")

        return body

    # --- /api/seen/<n> ------------------------------------------------------

    def _handle_mark_seen(self, num):
        if self.uid is None:
            return self.send_json(400, {"error": "no uid"})
        conn = db()
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT first_visit FROM users WHERE uid=?", (self.uid,)
            ).fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO users (uid, first_visit, minute_ago_ratio, cutoff_minutes) VALUES (?, ?, ?, ?)",
                    (self.uid, now_ms(), DEFAULT_SETTINGS["minuteAgoRatio"], DEFAULT_SETTINGS["cutoffMinutes"]),
                )
            conn.execute(
                "INSERT INTO seen (uid, num, ts) VALUES (?, ?, ?) "
                "ON CONFLICT(uid, num) DO UPDATE SET ts = excluded.ts",
                (self.uid, num, now_ms()),
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        return self.send_json(200, {"ok": True}, extra_headers={"Cache-Control": "no-store"})

    # --- /api/settings ------------------------------------------------------

    def _handle_settings(self):
        if self.uid is None:
            return self.send_json(400, {"error": "no uid"})
        bounds = {
            "minuteAgoRatio": ("minute_ago_ratio", 1.0),
            "cutoffMinutes": ("cutoff_minutes", 36500.0 * 24 * 60),
        }
        try:
            length = int(self.headers.get("Content-Length", 0))
            incoming = json.loads(self.rfile.read(length))
            valid = {}
            for js_key, (col, upper) in bounds.items():
                if js_key in incoming:
                    value = float(incoming[js_key])
                    if not math.isfinite(value):
                        raise ValueError(js_key)
                    valid[col] = min(max(value, 0.0), upper)
        except (TypeError, ValueError):
            return self.send_json(400, {"error": "bad settings payload"})

        conn = db()
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT first_visit, minute_ago_ratio, cutoff_minutes FROM users WHERE uid=?",
                (self.uid,),
            ).fetchone()
            if row is None:
                fv = now_ms()
                mar = DEFAULT_SETTINGS["minuteAgoRatio"]
                cm = DEFAULT_SETTINGS["cutoffMinutes"]
                conn.execute(
                    "INSERT INTO users (uid, first_visit, minute_ago_ratio, cutoff_minutes) VALUES (?, ?, ?, ?)",
                    (self.uid, fv, mar, cm),
                )
            else:
                fv, mar, cm = row

            if "minute_ago_ratio" in valid:
                mar = valid["minute_ago_ratio"]
                conn.execute(
                    "UPDATE users SET minute_ago_ratio=? WHERE uid=?", (mar, self.uid)
                )
            if "cutoff_minutes" in valid:
                cm = valid["cutoff_minutes"]
                conn.execute(
                    "UPDATE users SET cutoff_minutes=? WHERE uid=?", (cm, self.uid)
                )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

        return self.send_json(200, {
            "minuteAgoRatio": mar,
            "cutoffMinutes": cm,
        }, extra_headers={"Cache-Control": "no-store"})

    # --- helpers ------------------------------------------------------------

    def send_json(self, status, obj, extra_headers=None):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # keep the console quiet


if __name__ == "__main__":
    init_db()
    port = int(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("PORT", DEFAULT_PORT))
    print(f"Serving on http://localhost:{port}")
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    server.serve_forever()
