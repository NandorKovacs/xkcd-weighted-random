# xkcd weighted random

A single-page xkcd viewer with a **Random** button that favors comics you
haven't seen in a while.

## Run

```sh
python3 serve.py            # default port 8000
python3 serve.py 8123       # or pass the port as an argument
PORT=8123 python3 serve.py  # or set it via the environment
```

Then open <http://localhost:8000>. (The tiny server is needed because
xkcd's JSON API doesn't send CORS headers — it serves the static files and
proxies `/api/latest` and `/api/comic/<n>` to xkcd.com.)

## How the weighting works

- Every time a comic is displayed, its timestamp is recorded on the server.
- A comic's draw weight grows linearly with the time since you last saw it,
  anchored at two points: a comic you saw one minute ago is worth the
  configured percentage of a never-seen comic, and a never-seen comic gets
  full weight.
- Comics you've never seen act as if you saw them 30 days before your first
  visit — they always outweigh anything actually seen, but only by a bounded
  margin, so old favorites still come back around.
- Comic #404 is skipped, because it famously doesn't exist.

The current comic is encoded in the URL like on xkcd.com (e.g. `/614/`), so
links are shareable and the browser's back/forward buttons work.

Two per-user settings (the **Settings** dropdown, top right) tune this:

- **Minute-ago probability** (default **1 %**) — the chance of drawing a
  comic you saw a minute ago, relative to one you have never seen. 100 % =
  time since seen is ignored (pure random); 0 % = a just-seen comic almost
  never reappears; everything in between falls on a straight line.
- **Forget after** (days/hours/minutes, default **180 days**) — a comic last
  seen longer ago than this counts as unseen again (all zero = never forget).

Exact floor: a comic's weight is never allowed below 1, i.e. one millisecond
of time-since-seen. So even at 0 % a just-seen comic keeps a relative chance
of 1 ms ÷ U versus a never-seen comic, where U is the time since 30 days
before your first visit — about 3.9 × 10⁻¹⁰ when U is 30 days, shrinking as
your history ages.

## Per-user history

Each user gets their own seen-history — no login: the server greedily
assigns an `xkcd-uid` cookie on the first response a browser receives, and
stores that user's timestamps under it in `user-data.json` (next to
`serve.py`). Clear the cookie to start fresh; delete `user-data.json` to
reset everyone.
