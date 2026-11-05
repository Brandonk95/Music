/// <reference path="../pb_data/types.d.ts" />

// Server clock for the group metronome: every device measures its offset to
// this clock (NTP-style) so they all agree on when each beat happens.
routerAdd("GET", "/api/time", (e) => {
  e.response.header().set("Cache-Control", "no-store");
  return e.json(200, { t: Date.now() });
});

// Remove group sessions that haven't been touched for a day.
cronAdd("tempotune_cleanup_parties", "17 * * * *", () => {
  const rows = arrayOf(new DynamicModel({ id: "" }));
  $app.db()
    .newQuery("SELECT id FROM parties WHERE updated < strftime('%Y-%m-%d %H:%M:%fZ', 'now', '-1 day') LIMIT 500")
    .all(rows);
  for (const row of rows) {
    try {
      $app.delete($app.findRecordById("parties", row.id)); // members cascade
    } catch (err) {
      console.log("party cleanup failed", row.id, err);
    }
  }
});

// App files: always check with the server before using a cached copy, so a
// phone never runs a new page with old scripts after an update.
routerUse((e) => {
  const path = e.request.url.path;
  if (!path.startsWith("/api/") && !path.startsWith("/_/")) {
    e.response.header().set("Cache-Control", "no-cache");
  }
  return e.next();
});

// /admin is an easy-to-remember address for the PocketBase dashboard.
routerAdd("GET", "/admin", (e) => e.redirect(302, "/_/"));
routerAdd("GET", "/admin/{path...}", (e) => e.redirect(302, "/_/"));

// Admin sign-in lockout, on top of PocketBase's request rate limits (see the
// 1762300004 migration). Wrong passwords are counted per IP and in total:
//  - 5 failures from one IP in 15 minutes locks that IP out for 15 minutes;
//  - 25 failures from everyone in 15 minutes pauses all admin sign-ins for
//    15 minutes, so changing or faking IPs doesn't allow endless guessing.
// Counts are in memory, so a restart clears them.
routerUse((e) => {
  const m = /^\/api\/collections\/([^/]+)\/auth-with-password$/.exec(e.request.url.path);
  if (e.request.method !== "POST" || !m || (m[1] !== "_superusers" && m[1] !== "pbc_3142635823")) return e.next();

  const WINDOW_MS = 15 * 60 * 1000;
  const LOCK_MS = 15 * 60 * 1000;
  const PER_IP = 5;
  const TOTAL = 25;
  const store = $app.store();
  const now = Date.now();
  const read = (key) => {
    try { return JSON.parse(store.get(key) || "") || { fails: [], until: 0 }; } catch (_) { return { fails: [], until: 0 }; }
  };
  const write = (key, v) => store.set(key, JSON.stringify(v));
  const ipKey = "tt_admin_fail_ip_" + e.realIP();
  const allKey = "tt_admin_fail_all";

  const ip = read(ipKey);
  const all = read(allKey);
  const until = Math.max(ip.until || 0, all.until || 0);
  if (until > now) {
    const mins = Math.ceil((until - now) / 60000);
    e.response.header().set("Retry-After", String(Math.ceil((until - now) / 1000)));
    return e.json(429, {
      status: 429,
      message: "Too many failed sign-ins. Try again in " + mins + " minute" + (mins === 1 ? "" : "s") + ".",
      data: {},
    });
  }

  try {
    e.next();
  } catch (err) {
    const fail = (v, limit) => {
      v.fails = (v.fails || []).filter((t) => now - t < WINDOW_MS);
      v.fails.push(now);
      if (v.fails.length >= limit) { v.until = now + LOCK_MS; v.fails = []; }
      return v;
    };
    write(ipKey, fail(ip, PER_IP));
    write(allKey, fail(all, TOTAL));
    if (ip.until > now) console.log("admin sign-in locked for IP " + e.realIP());
    if (all.until > now) console.log("admin sign-in paused for everyone after repeated failures");
    throw err;
  }
  store.remove(ipKey); // signed in: forget this IP's failures
});
