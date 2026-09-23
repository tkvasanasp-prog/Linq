// One endpoint for the admin panel and the site.
//
//   GET  /.netlify/functions/api?kind=stats            -> dashboard counters
//   POST /.netlify/functions/api?kind=event            -> {name:"share"} bump a counter
//   GET  /.netlify/functions/api?kind=jobs             -> published jobs
//   POST /.netlify/functions/api?kind=jobs             -> {jobs:[...]} replace published jobs
//   GET  /.netlify/functions/api?kind=leads            -> every lead
//   POST /.netlify/functions/api?kind=leads            -> one lead {...}
//   GET  /.netlify/functions/api?kind=users            -> every saved profile
//   POST /.netlify/functions/api?kind=users            -> one profile {...}
//
// Everything is kept in Netlify Blobs (free plan).

import { getStore } from "@netlify/blobs";

const STORE = "placify-stats";

export default async (req) => {
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") || "stats";
  const store = getStore(STORE);

  if (req.method === "OPTIONS") return json({ ok: true });

  try {
    if (kind === "event") return await event(req, store);
    if (kind === "stats") return await stats(store);
    if (kind === "jobs") return await jobs(req, store);
    if (kind === "leads") return await leads(req, store);
    if (kind === "users") return await users(req, store);
    if (kind === "domains") return await domains(req, store);
    if (kind === "reset" && req.method === "POST") return await reset(store);
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
  return json({ ok: false, error: "unknown kind" }, 400);
};

/* ---------------- counters ---------------- */

// how each dashboard number is counted:
//   "people" -> how many different phones did it (repeats do not add)
//   "hits"   -> how many times it was done (repeats DO add)
const EVENTS = {
  visit:          "people",   // one phone opening the site 10 times = 1 visitor
  share:          "hits",     // every share counts, same phone or not
  user_new:       "people",
  user_old:       "people",
  jobs_done:      "people",   // people waiting for new jobs
  job_questions:  "hits",     // every tap of the blue button / Q&A button
  qa_page:        "hits",     // every opening of the Interview Q&A page
  qa_next:        "hits",     // every Next, on both pages
  profile:        "people",
  lead_yes:       "hits",
  lead_no:        "hits",
  job_view:       "people"    // per-job views stay one per phone
};
const EVENT_NAMES = Object.keys(EVENTS);

async function readJSON(store, key, fallback) {
  try {
    const saved = await store.get(key, { type: "json" });
    if (saved && typeof saved === "object") return saved;
  } catch { /* nothing yet */ }
  return fallback;
}

async function event(req, store) {
  let body = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const name = String(body.name || "").slice(0, 40);
  if (!EVENTS[name]) return json({ ok: false, error: "unknown event" }, 400);

  const day = today();

  // Real people, not page loads: every device keeps one row, written only on
  // the "visit" event.  first = the day we first saw it, last = the latest day.
  const uid = str(body.uid).slice(0, 60);
  if (uid && name === "visit") await remember(store, "devices", uid, day);

  // Every box on the dashboard counts PEOPLE, not taps: each event keeps a
  // list of the devices that did it, with the first and last day seen.
  // Each event gets its OWN store key.  A visitor fires several events at
  // once when the page opens; if they all wrote one shared file, the last
  // write would wipe the others and the boxes would disagree.
  if (uid) {
    if (EVENTS[name] === "hits") {
      const tap = str(body.tap).slice(0, 40).replace(/[^A-Za-z0-9_-]/g, "")
               || (uid + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8));
      await bump(store, "hc_" + name, tap, day);
    }
    else await remember(store, "eu_" + name, uid, day);
  }

  // per-job view counts for the panel's "Uploaded jobs" list
  if (name === "job_view" && uid) {
    const job = str(body.job).slice(0, 60).replace(/[^A-Za-z0-9_-]/g, "");
    if (job) await remember(store, "jv_" + job, uid, day);
  }

  return json({ ok: true });
}

async function stats(store) {
  const day = today();
  const within = (d, n) => {
    if (!d) return false;
    const ms = Date.parse(d + "T00:00:00Z");
    return !isNaN(ms) && Date.now() - ms < n * 86400000;
  };

  const out = {};
  const keys = EVENT_NAMES.map(n => (EVENTS[n] === "hits" ? "hc_" : "eu_") + n);
  const maps = await Promise.all(keys.map(k => readJSON(store, k, {})));

  EVENT_NAMES.forEach((name, i) => {
    const map = maps[i];
    const box = { today: 0, week: 0, month: 0, total: 0 };

    if (EVENTS[name] === "hits") {
      // { "2026-09-23": { tapId: 1, ... } }  -> every tap counts
      for (const d of Object.keys(map)) {
        const n = countDay(map[d]);
        box.total += n;
        if (d === day) box.today += n;
        if (within(d, 7)) box.week += n;
        if (within(d, 30)) box.month += n;
      }
    } else {
      // { uid: [firstDay, lastDay] }  -> count each phone once
      for (const id of Object.keys(map)) {
        const last = (map[id] || [])[1];
        box.total++;
        if (last === day) box.today++;
        if (within(last, 7)) box.week++;
        if (within(last, 30)) box.month++;
      }
    }
    out[name] = box;
  });

  // New  = phones seen here for the very first time in that stretch.
  // Back = phones that have come again on a later day.
  const devices = await readJSON(store, "devices", {});
  const fresh = { today: 0, week: 0, month: 0, total: 0 };
  const back = { today: 0, week: 0, month: 0, total: 0 };
  for (const id of Object.keys(devices)) {
    const r = devices[id] || [];
    const first = r[0], last = r[1];
    fresh.total++;
    if (first === day) fresh.today++;
    if (within(first, 7)) fresh.week++;
    if (within(first, 30)) fresh.month++;
    if (first && last && last !== first) {
      back.total++;
      if (last === day) back.today++;
      if (within(last, 7)) back.week++;
      if (within(last, 30)) back.month++;
    }
  }
  out.user_new = fresh;
  out.user_old = back;

  return json({ ok: true, stats: out });
}

/* Record one tap.
   Counting with "+1" loses taps when two writes cross, so instead every tap
   arrives with its own id and we store the id.  Storing the same id twice
   changes nothing, and we can check afterwards whether ours really is in
   there — if it is not, we write again.  Nothing is ever lost or doubled. */
const DAY_CAP = 4000;              // ids kept per day before they are rolled up

async function bump(store, key, tap, day) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const map = await readJSON(store, key, {});
    const box = map[day] || (map[day] = {});
    if (box[tap]) return;                       // already counted
    box[tap] = 1;

    // roll older ids into a plain number so one busy day cannot grow forever
    const ids = Object.keys(box).filter(k => k !== "#");
    if (ids.length > DAY_CAP) {
      const drop = ids.slice(0, ids.length - DAY_CAP);
      if (drop.indexOf(tap) === -1) {
        box["#"] = (box["#"] || 0) + drop.length;
        for (const k of drop) delete box[k];
      }
    }
    const days = Object.keys(map).sort();
    if (days.length > 40) for (const d of days.slice(0, days.length - 40)) delete map[d];

    await store.setJSON(key, map);

    const check = await readJSON(store, key, {});
    if ((check[day] || {})[tap]) return;
    await new Promise(r => setTimeout(r, 20 + Math.floor(Math.random() * 140)));
  }
}

function countDay(box) {
  if (!box) return 0;
  let n = box["#"] || 0;
  for (const k of Object.keys(box)) if (k !== "#") n++;
  return n;
}

/* Add one device to an event's list.
   Two visitors can hit the same list in the same instant, and the second
   write would otherwise erase the first.  So after writing we read back and
   check we are really in there; if not, we try again. */
async function remember(store, key, uid, day) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const map = await readJSON(store, key, {});
    if (map[uid] && map[uid][1] === day) return;      // already recorded
    map[uid] = [map[uid] ? map[uid][0] : day, day];
    const ids = Object.keys(map);
    if (ids.length > 20000) {
      ids.sort((a, b) => (map[a][1] < map[b][1] ? -1 : 1));
      for (const k of ids.slice(0, ids.length - 20000)) delete map[k];
    }
    await store.setJSON(key, map);
    await new Promise(r => setTimeout(r, 25 + Math.floor(Math.random() * 120)));
  }
}

/* ---------------- reset the dashboard counts ---------------- */

async function reset(store) {
  let jobIds = [];
  try {
    const saved = await readJSON(store, "jobs", { jobs: [] });
    jobIds = (saved.jobs || []).map(j => "jv_" + String(j.id || "").replace(/[^A-Za-z0-9_-]/g, ""));
  } catch { /* no jobs yet */ }
  const keys = ["counters", "devices", "euids", "jobviews"]
    .concat(EVENT_NAMES.map(n => "eu_" + n))
    .concat(EVENT_NAMES.map(n => "hc_" + n))
    .concat(jobIds);
  for (const key of keys) {
    try { await store.setJSON(key, {}); } catch { /* nothing there */ }
  }
  return json({ ok: true });
}

/* ---------------- jobs ---------------- */

/* A job disappears from the website the day after its last date, stays in
   the Expired list for 3 more days, then is deleted for good — here. */
function stillKeep(j) {
  let closes;
  if (j.noDate || !j.closes) {
    const posted = j.at ? new Date(j.at) : new Date();
    closes = new Date(posted.getTime());
    closes.setMonth(closes.getMonth() + 1);
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(j.closes));
    closes = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(j.closes);
  }
  if (isNaN(closes)) return true;                 // unreadable date: keep it
  closes.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const days = Math.round((closes - now) / 86400000);
  return days >= -3;
}

async function jobs(req, store) {
  if (req.method === "POST") {
    let body = {};
    try { body = await req.json(); } catch { return json({ ok: false, error: "bad body" }, 400); }
    const list = Array.isArray(body.jobs) ? body.jobs.slice(0, 200) : [];
    await store.setJSON("jobs", { jobs: list, at: new Date().toISOString() });
    return json({ ok: true, count: list.length });
  }
  const saved = await readJSON(store, "jobs", { jobs: [] });
  const all = saved.jobs || [];
  const list = all.filter(stillKeep);
  if (list.length !== all.length) {
    await store.setJSON("jobs", { jobs: list, at: new Date().toISOString() });
  }
  const ids = list.map(j => String(j.id || "").replace(/[^A-Za-z0-9_-]/g, ""));
  const maps = await Promise.all(ids.map(id => id ? readJSON(store, "jv_" + id, {}) : {}));
  const views = {};
  ids.forEach((id, i) => { if (id) views[id] = Object.keys(maps[i]).length; });
  return json({ ok: true, jobs: list, views });
}

/* ---------------- leads ---------------- */

async function leads(req, store) {
  const saved = await readJSON(store, "leads2", { leads: [] });
  const list = saved.leads || [];

  if (req.method === "POST") {
    let body = {};
    try { body = await req.json(); } catch { return json({ ok: false, error: "bad body" }, 400); }
    const lead = {
      kind: body.kind === "quality" ? "quality" : "basic",
      name: str(body.name),
      whatsapp: str(body.whatsapp),
      email: str(body.email),
      marks: str(body.marks),
      education: str(body.education),
      location: str(body.location),
      language: str(body.language) || "Tamil",
      domain: str(body.domain),
      program: str(body.program),
      company: str(body.company),
      at: new Date().toISOString()
    };
    if (!lead.name && !lead.whatsapp) return json({ ok: false, error: "empty" }, 400);
    list.push(lead);
    if (list.length > 5000) list.splice(0, list.length - 5000);
    await store.setJSON("leads2", { leads: list });
    return json({ ok: true });
  }
  return json({ ok: true, leads: list });
}

/* ---------------- users ---------------- */

async function users(req, store) {
  const saved = await readJSON(store, "users", { users: [] });
  const list = saved.users || [];

  if (req.method === "POST") {
    let body = {};
    try { body = await req.json(); } catch { return json({ ok: false, error: "bad body" }, 400); }
    const user = {
      uid: str(body.uid),
      name: str(body.name),
      email: str(body.email),
      phone: str(body.phone),
      education: str(body.education),
      photo: typeof body.photo === "string" && body.photo.length < 200000 ? body.photo : "",
      at: new Date().toISOString()
    };
    if (!user.name && !user.phone) return json({ ok: false, error: "empty" }, 400);
    const at = list.findIndex(u => u.uid && u.uid === user.uid);
    if (at > -1) list[at] = user; else list.push(user);
    if (list.length > 5000) list.splice(0, list.length - 5000);
    await store.setJSON("users", { users: list });
    return json({ ok: true });
  }
  return json({ ok: true, users: list });
}

/* ---------------- domains ---------------- */

const DEFAULT_DOMAINS = [
  "Data analyst", "Data engineer", "Networking engineer", "Testing and automation",
  "Python developer", "Tableau developer", "AI engineer", "Power BI developer",
  "Cloud engineer", "DevOps engineer"
];

async function domains(req, store) {
  if (req.method === "POST") {
    let body = {};
    try { body = await req.json(); } catch { return json({ ok: false, error: "bad body" }, 400); }
    const list = Array.isArray(body.domains)
      ? body.domains.map(str).filter(Boolean).slice(0, 60)
      : [];
    await store.setJSON("domains", { domains: list });
    return json({ ok: true, domains: list });
  }
  const saved = await readJSON(store, "domains", null);
  const list = saved && Array.isArray(saved.domains) && saved.domains.length
    ? saved.domains
    : DEFAULT_DOMAINS;
  return json({ ok: true, domains: list });
}

/* ---------------- helpers ---------------- */

function str(v) { return typeof v === "string" ? v.slice(0, 400) : ""; }
function stamp(d) { return d.toISOString().slice(0, 10); }
function today() { return stamp(new Date()); }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS"
    }
  });
}
