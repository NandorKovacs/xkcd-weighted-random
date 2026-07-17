// xkcd weighted random — comics you saw recently are unlikely to reappear;
// the longer ago you saw one (or if you never saw it), the likelier it gets drawn.
// Seen-history is kept per user: the server identifies each browser by an
// auto-assigned cookie (no login) and stores the timestamps under that id.

const UNSEEN_HEAD_START = 30 * 24 * 60 * 60 * 1000; // unseen comics act as if seen 30 days before your first visit
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

// A never-seen comic weighs U = its pseudo-age (it pretends it was last seen
// UNSEEN_HEAD_START before your first visit). The minuteAgoRatio setting pins
// the weight of a comic seen one minute ago at ratio * U, and every other
// comic falls on the straight line through those two points as a function of
// time since seen:
//   w(t) = U * (ratio + (1 - ratio) * (t - 1min) / (U - 1min))
// ratio = 1 -> every comic weighs U (pure random); ratio = 0 -> weight grows
// linearly from ~0 at one minute up to U for never-seen.
// A comic seen more than the cutoff ago counts as unseen again.
// The state (and the clock the weights are computed against) comes from the
// server, which keys it on the user's cookie.
async function pickWeightedRandom(latestNum) {
  const { now, firstVisit, seen, settings } = await fetchJson("/api/state");
  const unseenLastSeen = firstVisit - UNSEEN_HEAD_START;
  const cutoffMs = settings.cutoffMinutes > 0 ? settings.cutoffMinutes * 60000 : Infinity;
  const U = now - unseenLastSeen; // weight of a never-seen comic
  const ratio = settings.minuteAgoRatio;
  const MINUTE_MS = 60000;

  const weights = new Float64Array(latestNum + 1); // index = comic number
  let total = 0;
  for (let n = 1; n <= latestNum; n++) {
    if (n === MISSING_COMIC) continue;
    let lastSeen = seen[n] ?? unseenLastSeen;
    if (now - lastSeen > cutoffMs) lastSeen = unseenLastSeen; // forgotten
    const t = now - lastSeen;
    const w = U * (ratio + ((1 - ratio) * (t - MINUTE_MS)) / (U - MINUTE_MS));
    // Floor: 1 (= one millisecond of time-since-seen). Even at ratio 0 a
    // just-seen comic keeps a 1/U relative chance vs a never-seen one
    // (~4e-10 for U = 30 days). Also catches t < 1min extrapolating below 0.
    weights[n] = Math.max(w, 1);
    total += weights[n];
  }

  let r = Math.random() * total;
  for (let n = 1; n <= latestNum; n++) {
    r -= weights[n];
    if (r < 0) return n;
  }
  return latestNum; // float rounding fallback
}

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

function show(comic, push = true) {
  currentNum = comic.num;
  const url = `/${comic.num}/`;
  if (push && location.pathname !== url) {
    history.pushState({ num: comic.num }, "", url);
  } else {
    history.replaceState({ num: comic.num }, "", url);
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

async function goTo(pick, push = true) {
  if (busy) return;
  busy = true;
  els.status.textContent = "Loading…";
  try {
    if (latestNum === null) {
      latestNum = (await fetchJson("/api/latest")).num;
    }
    const num = await pick();
    show(await fetchJson(`/api/comic/${num}`), push);
    await markSeen(num); // before releasing `busy`, so the next pick sees it
    els.status.textContent = "";
  } catch (e) {
    els.status.textContent = `Failed to load comic: ${e.message}`;
  } finally {
    busy = false;
  }
}

const actions = {
  first: () => 1,
  prev: () => step(currentNum ?? 2, -1),
  random: () => pickWeightedRandom(latestNum),
  next: () => step(currentNum ?? latestNum - 1, +1),
  last: () => latestNum,
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

// back/forward: load the comic encoded in the URL without pushing again
window.addEventListener("popstate", () => {
  const num = numFromPath();
  if (num && num !== currentNum) goTo(() => num, false);
});

// on page load, show the comic from the URL if there is one, else draw
// randomly; replaceState either way so "/" doesn't linger in history
const startNum = numFromPath();
goTo(startNum ? () => startNum : actions.random, false);
