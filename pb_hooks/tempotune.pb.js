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
