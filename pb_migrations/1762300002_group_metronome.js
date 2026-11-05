/// <reference path="../pb_data/types.d.ts" />

// Group metronome ("parties"): one host, many members, a shared beat grid.
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");

  const parties = new Collection({
    type: "base",
    name: "parties",
    // Only the host can list their parties; anyone else must know the code
    // (passed as ?code=XXXXXX), so codes can't be discovered by listing.
    listRule: "@request.auth.id != '' && (host = @request.auth.id || code = @request.query.code)",
    // Viewing needs the record id, which members only get by joining with the code.
    viewRule: "@request.auth.id != ''",
    createRule: "@request.auth.id != '' && @request.body.host = @request.auth.id",
    updateRule: "host = @request.auth.id && (@request.body.host:isset = false || @request.body.host = @request.auth.id)",
    deleteRule: "host = @request.auth.id",
    fields: [
      { type: "relation", name: "host", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true },
      { type: "text", name: "code", required: true, min: 6, max: 6, pattern: "^[A-Z0-9]{6}$" },
      { type: "json", name: "state", maxSize: 100000 },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_parties_code ON parties (code)"],
  });
  app.save(parties);

  const memberAccess = "@request.auth.id != '' && (user = @request.auth.id || party.host = @request.auth.id)";
  const members = new Collection({
    type: "base",
    name: "party_members",
    listRule: memberAccess,
    viewRule: memberAccess,
    createRule: "@request.auth.id != '' && @request.body.user = @request.auth.id",
    updateRule: "user = @request.auth.id && (@request.body.user:isset = false || @request.body.user = @request.auth.id)"
      + " && (@request.body.party:isset = false || @request.body.party = party)",
    deleteRule: memberAccess,
    fields: [
      { type: "relation", name: "party", required: true, collectionId: parties.id, maxSelect: 1, cascadeDelete: true },
      { type: "relation", name: "user", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true },
      { type: "text", name: "name", max: 60 },
      { type: "text", name: "status", max: 20 },
      { type: "number", name: "syncMs" },
      { type: "number", name: "seen" },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_party_members_party_user ON party_members (party, user)"],
  });
  app.save(members);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("party_members"));
  app.delete(app.findCollectionByNameOrId("parties"));
});
