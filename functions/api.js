// LinQ — the whole backend, on Cloudflare Pages Functions + D1.
//
//   GET  /api?kind=stats     dashboard numbers      POST /api?kind=event
//   GET  /api?kind=jobs      published jobs         POST /api?kind=jobs
//   GET  /api?kind=leads     every lead             POST /api?kind=leads
//   GET  /api?kind=users     every profile          POST /api?kind=users
//   GET  /api?kind=domains   training domains       POST /api?kind=domains
//   POST /api?kind=reset     clear the dashboard counts
//   POST /api?kind=import    copy everything over from the old Netlify site
//
// The database is bound as DB (a D1 database).  Counting is done in SQL, so
// two visitors at the same instant can never overwrite each other's numbers.

const EVENTS = {
  visit:         "people",   // one phone opening the site ten times = 1
  share:         "hits",     // every share counts
  user_new:      "people",
  user_old:      "people",
  jobs_done:     "people",
  job_questions: "hits",     // every tap of the blue / Q&A button
  qa_page:       "hits",
  qa_next:       "hits",
  profile:       "people",
  lead_yes:      "hits",
  lead_no:       "hits",
  job_view:      "people"
};
const EVENT_NAMES = Object.keys(EVENTS);

const DEFAULT_DOMAINS = [
  "Data analyst", "Data engineer", "Networking engineer", "Testing and automation",
  "Python developer", "Tableau developer", "AI engineer", "Power BI developer",
  "Cloud engineer", "DevOps engineer"
];

const OLD_SITE = "https://linq-jobs.netlify.app";

export async function onRequest(context) {
  const { request, env } = context;
  const db = env.DB;
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") || "stats";
  const post = request.method === "POST";

  if (request.method === "OPTIONS") return json({ ok: true });
  if (!db) return json({ ok: false, error: "No database bound. Add a D1 binding named DB." }, 500);

  try {
    if (kind === "event" && post) return await event(request, db);
    if (kind === "stats")         return await stats(db);
    if (kind === "jobs")          return await jobs(request, db, post);
    if (kind === "leads")         return await leads(request, db, post);
    if (kind === "users")         return await users(request, db, post);
    if (kind === "domains")       return await domains(request, db, post);
    if (kind === "reset" && post) return await reset(db);
    if (kind === "import" && post) return await importOld(db);
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) }, 500);
  }
  return json({ ok: false, error: "unknown kind" }, 400);
}

/* ---------------- what people do ---------------- */

async function event(request, db) {
  const body = await readBody(request);
  const name = str(body.name, 40);
  if (!EVENTS[name]) return json({ ok: false, error: "unknown event" }, 400);

  const uid = str(body.uid, 60);
  if (!uid) return json({ ok: true });
  const day = today();

  const batch = [];

  if (name === "visit") {
    batch.push(db.prepare(
      "INSERT INTO devices (uid, first, last) VALUES (?1, ?2, ?2) " +
      "ON CONFLICT(uid) DO UPDATE SET last = ?2"
    ).bind(uid, day));
  }

  if (EVENTS[name] === "hits") {
    // += 1 done by the database itself, so nothing can be lost
    batch.push(db.prepare(
      "INSERT INTO ev_hits (name, day, n) VALUES (?1, ?2, 1) " +
      "ON CONFLICT(name, day) DO UPDATE SET n = n + 1"
    ).bind(name, day));
  } else {
    batch.push(db.prepare(
      "INSERT INTO ev_people (name, uid, first, last) VALUES (?1, ?2, ?3, ?3) " +
      "ON CONFLICT(name, uid) DO UPDATE SET last = ?3"
    ).bind(name, uid, day));
  }

  if (name === "job_view") {
    const job = str(body.job, 60).replace(/[^A-Za-z0-9_-]/g, "");
    if (job) batch.push(db.prepare(
      "INSERT OR IGNORE INTO job_views (job, uid) VALUES (?1, ?2)"
    ).bind(job, uid));
  }

  await db.batch(batch);
  return json({ ok: true });
}

async function stats(db) {
  const day = today();
  const w7 = ago(7), w30 = ago(30);
  const out = {};
  for (const n of EVENT_NAMES) out[n] = { today: 0, week: 0, month: 0, total: 0 };

  const hits = await db.prepare(
    "SELECT name, " +
    " SUM(CASE WHEN day =  ?1 THEN n ELSE 0 END) AS d," +
    " SUM(CASE WHEN day >= ?2 THEN n ELSE 0 END) AS w," +
    " SUM(CASE WHEN day >= ?3 THEN n ELSE 0 END) AS m," +
    " SUM(n) AS t FROM ev_hits GROUP BY name"
  ).bind(day, w7, w30).all();
  for (const r of (hits.results || [])) {
    if (out[r.name]) out[r.name] = { today: r.d|0, week: r.w|0, month: r.m|0, total: r.t|0 };
  }

  const people = await db.prepare(
    "SELECT name," +
    " SUM(CASE WHEN last =  ?1 THEN 1 ELSE 0 END) AS d," +
    " SUM(CASE WHEN last >= ?2 THEN 1 ELSE 0 END) AS w," +
    " SUM(CASE WHEN last >= ?3 THEN 1 ELSE 0 END) AS m," +
    " COUNT(*) AS t FROM ev_people GROUP BY name"
  ).bind(day, w7, w30).all();
  for (const r of (people.results || [])) {
    if (out[r.name]) out[r.name] = { today: r.d|0, week: r.w|0, month: r.m|0, total: r.t|0 };
  }

  // new = first seen in that stretch;  returning = came back on a later day
  const fresh = await db.prepare(
    "SELECT SUM(CASE WHEN first =  ?1 THEN 1 ELSE 0 END) AS d," +
    " SUM(CASE WHEN first >= ?2 THEN 1 ELSE 0 END) AS w," +
    " SUM(CASE WHEN first >= ?3 THEN 1 ELSE 0 END) AS m," +
    " COUNT(*) AS t FROM devices"
  ).bind(day, w7, w30).first();
  const back = await db.prepare(
    "SELECT SUM(CASE WHEN last =  ?1 THEN 1 ELSE 0 END) AS d," +
    " SUM(CASE WHEN last >= ?2 THEN 1 ELSE 0 END) AS w," +
    " SUM(CASE WHEN last >= ?3 THEN 1 ELSE 0 END) AS m," +
    " COUNT(*) AS t FROM devices WHERE last > first"
  ).bind(day, w7, w30).first();

  out.user_new = box(fresh);
  out.user_old = box(back);

  return json({ ok: true, stats: out });
}

function box(r) {
  return r ? { today: r.d|0, week: r.w|0, month: r.m|0, total: r.t|0 }
           : { today: 0, week: 0, month: 0, total: 0 };
}

/* ---------------- jobs ---------------- */

// live for the whole of its last date, in the Expired list for 3 more days,
// then deleted for good
function cutoff(closes, nodate, at) {
  let d;
  if (nodate || !closes) {
    const posted = at ? new Date(at) : new Date();
    d = new Date(posted.getTime());
    d.setMonth(d.getMonth() + 1);
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(closes));
    d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date(closes);
  }
  if (isNaN(d)) return null;
  return new Date(d.getTime() + 3 * 86400000).toISOString().slice(0, 10);
}

async function jobs(request, db, post) {
  if (post) {
    const body = await readBody(request);
    const list = Array.isArray(body.jobs) ? body.jobs.slice(0, 200) : [];
    const batch = [db.prepare("DELETE FROM jobs")];
    for (const j of list) {
      if (!j || !j.id) continue;
      batch.push(db.prepare(
        "INSERT OR REPLACE INTO jobs (id, data, closes, nodate, at) VALUES (?1,?2,?3,?4,?5)"
      ).bind(String(j.id), JSON.stringify(j), str(j.closes, 20), j.noDate ? 1 : 0, str(j.at, 40)));
    }
    await db.batch(batch);
    return json({ ok: true, count: list.length });
  }

  const rows = (await db.prepare("SELECT * FROM jobs").all()).results || [];
  const day = today();
  const keep = [], drop = [];
  for (const r of rows) {
    const end = cutoff(r.closes, r.nodate, r.at);
    if (end && end < day) drop.push(r.id); else keep.push(r);
  }
  if (drop.length) {
    await db.batch(drop.map(id => db.prepare("DELETE FROM jobs WHERE id = ?1").bind(id)));
  }

  const views = {};
  const vr = (await db.prepare(
    "SELECT job, COUNT(*) AS n FROM job_views GROUP BY job"
  ).all()).results || [];
  for (const r of vr) views[r.job] = r.n | 0;

  const out = [];
  for (const r of keep) {
    try { out.push(JSON.parse(r.data)); } catch (e) { /* skip a broken row */ }
  }
  return json({ ok: true, jobs: out, views });
}

/* ---------------- leads ---------------- */

const LEAD_COLS = ["kind","name","whatsapp","email","marks","education",
                   "location","language","domain","program","company","at"];

async function leads(request, db, post) {
  if (post) {
    const body = await readBody(request);
    const row = {
      kind: body.kind === "quality" ? "quality" : "basic",
      name: str(body.name), whatsapp: str(body.whatsapp), email: str(body.email),
      marks: str(body.marks), education: str(body.education),
      location: str(body.location), language: str(body.language) || "Tamil",
      domain: str(body.domain), program: str(body.program),
      company: str(body.company), at: new Date().toISOString()
    };
    if (!row.name && !row.whatsapp) return json({ ok: false, error: "empty" }, 400);
    await db.prepare(
      "INSERT INTO leads (kind,name,whatsapp,email,marks,education,location,language,domain,program,company,at)" +
      " VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)"
    ).bind(...LEAD_COLS.map(c => row[c])).run();
    return json({ ok: true });
  }
  const rows = (await db.prepare(
    "SELECT * FROM leads ORDER BY id ASC LIMIT 5000"
  ).all()).results || [];
  return json({ ok: true, leads: rows });
}

/* ---------------- user profiles ---------------- */

async function users(request, db, post) {
  if (post) {
    const body = await readBody(request);
    const u = {
      uid: str(body.uid, 60), name: str(body.name), email: str(body.email),
      phone: str(body.phone), education: str(body.education),
      photo: typeof body.photo === "string" && body.photo.length < 400000 ? body.photo : "",
      at: new Date().toISOString()
    };
    if (!u.uid) u.uid = "u" + Date.now() + Math.random().toString(36).slice(2, 7);
    if (!u.name && !u.phone) return json({ ok: false, error: "empty" }, 400);
    await db.prepare(
      "INSERT INTO users (uid,name,email,phone,education,photo,at) VALUES (?1,?2,?3,?4,?5,?6,?7)" +
      " ON CONFLICT(uid) DO UPDATE SET name=?2,email=?3,phone=?4,education=?5,photo=?6,at=?7"
    ).bind(u.uid, u.name, u.email, u.phone, u.education, u.photo, u.at).run();
    return json({ ok: true });
  }
  const rows = (await db.prepare(
    "SELECT * FROM users ORDER BY at ASC LIMIT 5000"
  ).all()).results || [];
  return json({ ok: true, users: rows });
}

/* ---------------- training domains ---------------- */

async function domains(request, db, post) {
  if (post) {
    const body = await readBody(request);
    const list = Array.isArray(body.domains)
      ? body.domains.map(v => str(v)).filter(Boolean).slice(0, 60) : [];
    await db.prepare(
      "INSERT INTO settings (k,v) VALUES ('domains', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1"
    ).bind(JSON.stringify(list)).run();
    return json({ ok: true, domains: list });
  }
  const row = await db.prepare("SELECT v FROM settings WHERE k = 'domains'").first();
  let list = null;
  if (row && row.v) { try { list = JSON.parse(row.v); } catch (e) { list = null; } }
  return json({ ok: true, domains: (list && list.length) ? list : DEFAULT_DOMAINS });
}

/* ---------------- reset the dashboard ---------------- */

async function reset(db) {
  await db.batch([
    db.prepare("DELETE FROM ev_hits"),
    db.prepare("DELETE FROM ev_people"),
    db.prepare("DELETE FROM devices"),
    db.prepare("DELETE FROM job_views")
  ]);
  return json({ ok: true });
}

/* ---------------- bring everything over from the old site ---------------- */

async function importOld(db) {
  const grab = async kind => {
    try {
      const r = await fetch(OLD_SITE + "/api?kind=" + kind, { cf: { cacheTtl: 0 } });
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  };

  const done = { jobs: 0, leads: 0, users: 0, domains: 0 };

  const j = await grab("jobs");
  if (j && Array.isArray(j.jobs) && j.jobs.length) {
    const batch = [];
    for (const job of j.jobs) {
      if (!job || !job.id) continue;
      batch.push(db.prepare(
        "INSERT OR REPLACE INTO jobs (id, data, closes, nodate, at) VALUES (?1,?2,?3,?4,?5)"
      ).bind(String(job.id), JSON.stringify(job), str(job.closes, 20),
             job.noDate ? 1 : 0, str(job.at, 40)));
    }
    if (batch.length) { await db.batch(batch); done.jobs = batch.length; }
  }

  const l = await grab("leads");
  if (l && Array.isArray(l.leads) && l.leads.length) {
    const have = await db.prepare("SELECT COUNT(*) AS n FROM leads").first();
    if (!(have && have.n)) {                       // only into an empty table
      const batch = l.leads.slice(0, 5000).map(x => db.prepare(
        "INSERT INTO leads (kind,name,whatsapp,email,marks,education,location,language,domain,program,company,at)" +
        " VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)"
      ).bind(x.kind === "quality" ? "quality" : "basic", str(x.name), str(x.whatsapp),
             str(x.email), str(x.marks), str(x.education), str(x.location),
             str(x.language) || "Tamil", str(x.domain), str(x.program),
             str(x.company), str(x.at, 40)));
      if (batch.length) { await db.batch(batch); done.leads = batch.length; }
    }
  }

  const u = await grab("users");
  if (u && Array.isArray(u.users) && u.users.length) {
    const batch = u.users.slice(0, 5000).map(x => db.prepare(
      "INSERT INTO users (uid,name,email,phone,education,photo,at) VALUES (?1,?2,?3,?4,?5,?6,?7)" +
      " ON CONFLICT(uid) DO UPDATE SET name=?2,email=?3,phone=?4,education=?5,photo=?6,at=?7"
    ).bind(str(x.uid, 60) || ("u" + Math.random().toString(36).slice(2, 10)),
           str(x.name), str(x.email), str(x.phone), str(x.education),
           typeof x.photo === "string" ? x.photo.slice(0, 400000) : "", str(x.at, 40)));
    if (batch.length) { await db.batch(batch); done.users = batch.length; }
  }

  const d = await grab("domains");
  if (d && Array.isArray(d.domains) && d.domains.length) {
    await db.prepare(
      "INSERT INTO settings (k,v) VALUES ('domains', ?1) ON CONFLICT(k) DO UPDATE SET v = ?1"
    ).bind(JSON.stringify(d.domains)).run();
    done.domains = d.domains.length;
  }

  return json({ ok: true, imported: done });
}

/* ---------------- helpers ---------------- */

async function readBody(request) {
  try { return await request.json(); } catch (e) { return {}; }
}
function str(v, n) { return typeof v === "string" ? v.slice(0, n || 400) : ""; }
function today() { return new Date().toISOString().slice(0, 10); }
function ago(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS"
    }
  });
}
