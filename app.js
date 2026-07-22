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
  syncCode: document.getElementById("sync-code"),
  syncCopy: document.getElementById("sync-copy"),
  syncPaste: document.getElementById("sync-paste"),
  syncLink: document.getElementById("sync-link"),
  syncStatus: document.getElementById("sync-status"),
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

// Comics since ~#1084 have a double-resolution variant next to the 1x file,
// but the JSON API only carries the 1x URL — xkcd.com's own pages hardcode
// the 2x in srcset. The server scrapes which comics have one and ships the
// verdict as `img2x` (URL, or null for definitely-none), so normally the
// srcset is known up front and exactly one file is fetched, like xkcd.com.
// For comics the scrape hasn't reached yet the key is absent and existence
// is discovered with a trial request — which must not run on the visible
// img: a 404ing srcset candidate poisons the element's density state in
// Chromium (the 1x fallback then paints at half size), and any retry paints
// twice. So the trial runs on a detached Image, and the visible img only
// ever receives a settled, fully-loaded result — one paint, straight from
// cache, already at its final size.
let imgLoadToken = 0;
function setComicImage(comic) {
  const url = comic.img;
  const url2x = url.replace(/\.(png|jpe?g|gif)$/i, "_2x.$1");
  const token = ++imgLoadToken;
  // The settled result goes into a brand-new <img> swapped in atomically:
  // Chromium keeps an element's srcset density even after the attribute is
  // removed, so reusing the node renders the next 1x-only comic at half
  // size whenever the previous comic had a 2x (measured: 785 after 1332,
  // naturalWidth 370 not 740). A fresh element has no such history.
  const apply = (srcset) => {
    if (token !== imgLoadToken) return; // user already navigated elsewhere
    const fresh = document.createElement("img");
    fresh.id = els.img.id;
    fresh.className = els.img.className;
    fresh.alt = els.img.alt;     // show() already stamped these on the old
    fresh.title = els.img.title; // element; carry them over
    if (srcset) fresh.srcset = srcset;
    fresh.src = url;
    const swap = () => {
      if (token !== imgLoadToken) return;
      els.img.replaceWith(fresh);
      els.img = fresh;
    };
    // decode() first so the swap never shows a blank frame; on failure swap
    // anyway so the broken-image state is visible rather than a stale comic
    fresh.decode().then(swap, swap);
  };
  if ("img2x" in comic) {
    return apply(comic.img2x ? `${comic.img2x} 2x` : null); // scraped verdict
  }
  if (url2x === url) return apply(null);
  const probe = new Image();
  probe.onload = () => {
    // Attach the srcset only if this screen actually selected the 2x file;
    // a 1x screen never validated it, so it must not be left on the element
    // (moving the window to a hi-DPI monitor would fetch it cold and 404).
    apply(probe.currentSrc.includes("_2x.") ? `${url2x} 2x` : null);
  };
  probe.onerror = () => {
    // 2x candidate failed: retry on a fresh element (fresh density state)
    const retry = new Image();
    retry.onload = () => apply(null);
    retry.onerror = () => apply(null); // let the visible img surface the failure
    retry.src = url;
  };
  probe.srcset = `${url2x} 2x`;
  probe.src = url;
}

function show(comic, updateUrl = true) {
  currentNum = comic.num;
  const url = `/${comic.num}/`;
  if (updateUrl && location.pathname !== url) {
    history.pushState({ num: comic.num }, "", url);
  }
  els.title.textContent = comic.safe_title || comic.title;
  setComicImage(comic);
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
  .then((state) => {
    renderSettings(state.settings);
    els.syncCode.value = state.uid; // the sync code IS the uid (cookie is HttpOnly)
  })
  .catch(() => {}); // controls keep their markup defaults

// --- device sync ---

els.syncCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(els.syncCode.value);
  } catch {
    els.syncCode.select(); // clipboard API needs a secure context; fall back
    document.execCommand("copy");
  }
  els.syncStatus.textContent = "copied ✓ — paste it on the other device";
});

els.syncLink.addEventListener("click", async () => {
  const code = els.syncPaste.value.trim();
  if (!code) return;
  els.syncStatus.textContent = "linking…";
  try {
    const resp = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    renderSettings(data.settings); // the linked account's settings win
    els.syncCode.value = data.uid;
    els.syncPaste.value = "";
    els.syncStatus.textContent = "linked ✓ — this device now shares that history";
  } catch (e) {
    els.syncStatus.textContent = `link failed: ${e.message}`;
  }
});

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
