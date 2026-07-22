// xkcd weighted random — comics you saw recently are unlikely to reappear;
// the longer ago you saw one (or if you never saw it), the likelier it gets drawn.
// Seen-history is kept per user: the server identifies each browser by an
// auto-assigned cookie (no login) and stores the timestamps under that id.

const MISSING_COMIC = 404;           // xkcd 404 famously does not exist

const els = {
  title: document.getElementById("ctitle"),
  img: document.getElementById("comic-img"),
  link: document.getElementById("comic-link"),
  alt: document.getElementById("comic-alt"),
  status: document.getElementById("status"),
  settings: document.getElementById("settings"),
  settingsToggle: document.getElementById("settings-toggle"),
  settingsPanel: document.getElementById("settings-panel"),
  minuteProb: document.getElementById("set-minute-prob"),
  cutoffDays: document.getElementById("set-cutoff-days"),
  cutoffHours: document.getElementById("set-cutoff-hours"),
  cutoffMins: document.getElementById("set-cutoff-mins"),
};

function markSeen(num) {
  return fetch(`/api/seen/${num}`, { method: "POST" });
}

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url} -> HTTP ${resp.status}`);
  return resp.json();
}

let latestNum = null;
let currentNum = null;

function numFromPath() {
  const m = location.pathname.match(/^\/(\d+)\/?$/);
  return m ? Number(m[1]) : null;
}

function show(comic, updateUrl = true) {
  currentNum = comic.num;
  const url = `/${comic.num}/`;
  if (updateUrl && location.pathname !== url) {
    history.pushState({ num: comic.num }, "", url);
  }
  els.title.textContent = comic.safe_title || comic.title;
  els.img.src = comic.img;
  els.img.alt = comic.safe_title || comic.title;
  els.img.title = comic.alt; // hover for the alt text, like the original
  els.alt.textContent = comic.alt;
  els.link.href = `https://xkcd.com/${comic.num}/`;
  els.link.textContent = `https://xkcd.com/${comic.num}/`;
  document.title = `xkcd: ${comic.safe_title || comic.title}`;
}

// Step from `num` in `dir` (+1/-1), skipping the nonexistent 404 and
// clamping to [1, latestNum].
function step(num, dir) {
  let n = num + dir;
  if (n === MISSING_COMIC) n += dir;
  return Math.min(Math.max(n, 1), latestNum);
}

let busy = false;
// Outstanding markSeen promise from the previous navigation; awaited at the
// start of the next pick so invariant 6 holds without blocking the UI.
let pendingMark = null;

// goTo accepts one of two pick shapes:
//
//   (A) Random: pick() returns a Promise<comic-object>.
//       The server picked, marked seen, and resolved the image URL in one call.
//       latestNum is NOT bootstrapped on this path (§6.4) — it may remain null.
//
//   (B) Number: pick() is a sync thunk returning a number.
//       latestNum is bootstrapped first when null; then pick() is called so
//       that step() inside the thunk can clamp to the real latest.
//       After the comic is shown, markSeen is fired without awaiting (C6);
//       the next goTo call awaits it before picking (invariant 6).
//
// Shape detection: call pick() once.  If the result is a Promise → random
// path (A).  Otherwise → number path (B); if latestNum was null, bootstrap
// it and call pick() again so step()-based thunks clamp correctly.
async function goTo(pick, updateUrl = true) {
  if (busy) return;
  busy = true;
  els.status.textContent = "Loading…";
  try {
    // Await any outstanding markSeen from the previous navigation before
    // picking, so the next pick always sees the previous mark (invariant 6).
    // Clear it first: a failed mark must not brick every later navigation.
    if (pendingMark) {
      const mark = pendingMark;
      pendingMark = null;
      await mark.catch(() => {});
    }

    const probe = pick();

    if (probe instanceof Promise) {
      // Random path (§6.4): /api/random returns the full comic object.
      // No latestNum needed; no client-side markSeen call.
      show(await probe, updateUrl);
    } else {
      // Number path (first/prev/next/last/popstate/page-load).
      // Bootstrap latestNum when absent so step() can clamp correctly.
      // If latestNum was null when pick() ran above, the thunk may have
      // received a wrong value from step() (Math.min clamps to 0), so
      // call pick() again with latestNum now set.
      if (latestNum === null) {
        latestNum = (await fetchJson("/api/latest")).num;
        // Re-evaluate: busy=true so currentNum/latestNum are stable.
        const num = pick() ?? latestNum;
        show(await fetchJson(`/api/comic/${num}`), updateUrl);
      } else {
        const num = probe ?? latestNum;
        show(await fetchJson(`/api/comic/${num}`), updateUrl);
      }
      // Fire markSeen without awaiting (C6); store the promise so the next
      // pick can await it before reading seen-history (invariant 6).
      pendingMark = markSeen(currentNum);
    }

    els.status.textContent = "";
  } catch (e) {
    els.status.textContent = `Failed to load comic: ${e.message}`;
  } finally {
    busy = false;
  }
}

const actions = {
  first:  () => 1,
  prev:   () => step(currentNum ?? 2, -1),
  random: () => fetchJson("/api/random"),   // returns a Promise<comic-object>
  next:   () => step(currentNum ?? (latestNum !== null ? latestNum - 1 : 1), +1),
  last:   () => latestNum,  // null before bootstrap; goTo re-evaluates after fetching
};

document.querySelectorAll("[data-nav]").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    goTo(actions[a.dataset.nav]);
  });
});

// --- settings dropdown ---

function renderSettings(s) {
  els.minuteProb.value = Math.round(s.minuteAgoRatio * 1000) / 10; // percent, 1 decimal
  const total = Math.round(s.cutoffMinutes);
  els.cutoffDays.value = Math.floor(total / (24 * 60));
  els.cutoffHours.value = Math.floor(total / 60) % 24;
  els.cutoffMins.value = total % 60;
}

async function saveSettings() {
  const cutoffMinutes =
    (Number(els.cutoffDays.value) || 0) * 24 * 60 +
    (Number(els.cutoffHours.value) || 0) * 60 +
    (Number(els.cutoffMins.value) || 0);
  const resp = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      minuteAgoRatio: (Number(els.minuteProb.value) || 0) / 100,
      cutoffMinutes,
    }),
  });
  // reflect server-side clamping and re-normalize e.g. 90 min -> 1 h 30 min
  if (resp.ok) renderSettings(await resp.json());
}

els.settingsToggle.addEventListener("click", () => {
  els.settingsPanel.hidden = !els.settingsPanel.hidden;
});
document.addEventListener("click", (e) => {
  if (!els.settingsPanel.hidden && !els.settings.contains(e.target)) {
    els.settingsPanel.hidden = true;
  }
});
[els.minuteProb, els.cutoffDays, els.cutoffHours, els.cutoffMins].forEach((el) =>
  el.addEventListener("change", saveSettings)
);

fetchJson("/api/state")
  .then((state) => renderSettings(state.settings))
  .catch(() => {}); // controls keep their markup defaults

// back/forward: load the comic encoded in the URL ("/" = the newest one)
// without touching the history again.
// latestNum may be null here if the user's first action was a Random click
// (which doesn't bootstrap latestNum); goTo() will fetch /api/latest on the
// number path, which popstate always uses.
window.addEventListener("popstate", () => {
  const num = numFromPath() ?? latestNum;
  if (num && num !== currentNum) goTo(() => num, false);
});

// on page load, show the comic from the URL if there is one, else the
// newest comic — like xkcd.com, where "/" is the latest comic
const startNum = numFromPath();
goTo(startNum ? () => startNum : actions.last, false);
