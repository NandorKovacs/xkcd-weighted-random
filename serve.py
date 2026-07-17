#!/usr/bin/env python3
"""Tiny static file server + xkcd API proxy + per-user seen-history storage.

Users are identified greedily by a cookie: the first response a browser gets
sets `xkcd-uid` (no login), and all seen-history is stored server-side under
that id in user-data.json.
"""
import json
import math
import os
import re
import secrets
import time
import urllib.request
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = 8000
XKCD_LATEST = "https://xkcd.com/info.0.json"
XKCD_COMIC = "https://xkcd.com/{num}/info.0.json"

UID_COOKIE = "xkcd-uid"
DEFAULT_SETTINGS = {
    "minuteAgoRatio": 0.01,          # P(comic seen a minute ago) / P(never-seen comic); 1 = uniform random
    "cutoffMinutes": 180 * 24 * 60,  # seen longer ago than this counts as unseen; 0 = never
}
UID_RE = re.compile(r"[A-Za-z0-9_-]{16,64}")
DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "user-data.json")


def now_ms():
    return int(time.time() * 1000)


def load_users():
    try:
        with open(DATA_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_users(users):
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(users, f)
    os.replace(tmp, DATA_FILE)


USERS = load_users()


class Handler(SimpleHTTPRequestHandler):
    def resolve_uid(self):
        """Greedy identification: take the cookie if present, mint one otherwise."""
        for part in self.headers.get("Cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == UID_COOKIE and UID_RE.fullmatch(value):
                self.uid = value
                self.new_uid = False
                return
        self.uid = secrets.token_urlsafe(24)
        self.new_uid = True

    def end_headers(self):
        # Piggyback the cookie onto whatever response goes out first,
        # including static files served by SimpleHTTPRequestHandler.
        if getattr(self, "new_uid", False):
            self.send_header(
                "Set-Cookie",
                f"{UID_COOKIE}={self.uid}; Max-Age=315360000; Path=/; SameSite=Lax; HttpOnly",
            )
            self.new_uid = False
        super().end_headers()

    def user(self):
        user = USERS.get(self.uid)
        if user is None:
            user = {"firstVisit": now_ms(), "seen": {}}
            USERS[self.uid] = user
            save_users(USERS)
        # fill in settings added after this record was created, drop stale keys
        stored = user.get("settings", {})
        user["settings"] = {k: stored.get(k, v) for k, v in DEFAULT_SETTINGS.items()}
        return user

    def do_GET(self):
        self.resolve_uid()
        if self.path == "/api/latest":
            return self.proxy(XKCD_LATEST)
        if self.path == "/api/state":
            # `now` comes from the server so weights are computed against the
            # same clock that stamped the seen-times.
            return self.send_json(200, {"now": now_ms(), **self.user()})
        m = re.fullmatch(r"/api/comic/(\d+)", self.path)
        if m:
            return self.proxy(XKCD_COMIC.format(num=m.group(1)))
        if re.fullmatch(r"/\d+/?", self.path):
            self.path = "/index.html"  # comic permalinks are handled client-side
        return super().do_GET()

    def do_POST(self):
        self.resolve_uid()
        if self.path == "/api/settings":
            return self.update_settings()
        m = re.fullmatch(r"/api/seen/(\d+)", self.path)
        if not m:
            return self.send_json(404, {"error": "not found"})
        user = self.user()
        user["seen"][m.group(1)] = now_ms()
        save_users(USERS)
        return self.send_json(200, {"ok": True})

    def update_settings(self):
        bounds = {"minuteAgoRatio": 1.0, "cutoffMinutes": 36500.0 * 24 * 60}
        try:
            length = int(self.headers.get("Content-Length", 0))
            incoming = json.loads(self.rfile.read(length))
            # validate everything before applying anything
            valid = {}
            for key, upper in bounds.items():
                if key in incoming:
                    value = float(incoming[key])
                    if not math.isfinite(value):  # json.loads accepts NaN/Infinity
                        raise ValueError(key)
                    valid[key] = min(max(value, 0.0), upper)
        except (TypeError, ValueError):
            return self.send_json(400, {"error": "bad settings payload"})
        settings = self.user()["settings"]
        settings.update(valid)
        save_users(USERS)
        return self.send_json(200, settings)

    def send_json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def proxy(self, url):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "xkcd-weighted-random"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_json(502, {"error": str(e)})

    def log_message(self, fmt, *args):
        pass  # keep the console quiet


if __name__ == "__main__":
    print(f"Serving on http://localhost:{PORT}")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
