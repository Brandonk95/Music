/// <reference path="../pb_data/types.d.ts" />

// Group metronome guests: anyone with the code can join with just a name.
// Starting a group still needs an account.
//
// A guest member record has no user; instead the guest's device keeps a random
// guestKey and sends it as the X-Guest-Key header to update or leave.
migrate((app) => {
  const parties = app.findCollectionByNameOrId("parties");
  // Still not listable without the code; viewing by id is open (ids only come from the code lookup).
  parties.listRule = "(@request.auth.id != '' && host = @request.auth.id) || code = @request.query.code";
  parties.viewRule = "";
  app.save(parties);

  const members = app.findCollectionByNameOrId("party_members");
  members.fields.getByName("user").required = false;
  members.fields.add(new TextField({ name: "guestKey", min: 16, max: 64, pattern: "^[A-Za-z0-9]*$" }));

  const owner = "((@request.auth.id != '' && user = @request.auth.id)"
    + " || (user = '' && guestKey != '' && guestKey = @request.headers.x_guest_key))";
  const access = `(${owner} || (@request.auth.id != '' && party.host = @request.auth.id))`;
  members.listRule = access;
  members.viewRule = access;
  members.createRule = "party.id != '' && ("
    + "(@request.auth.id != '' && @request.body.user = @request.auth.id)"
    + " || (@request.body.user:isset = false && @request.body.guestKey != ''))";
  members.updateRule = owner
    + " && @request.body.user:isset = false && @request.body.guestKey:isset = false"
    + " && (@request.body.party:isset = false || @request.body.party = party)";
  members.deleteRule = access;
  // One record per signed-in user per party; guests are separate records.
  members.indexes = ["CREATE UNIQUE INDEX idx_party_members_party_user ON party_members (party, user) WHERE user != ''"];
  app.save(members);
}, (app) => {
  const parties = app.findCollectionByNameOrId("parties");
  parties.listRule = "@request.auth.id != '' && (host = @request.auth.id || code = @request.query.code)";
  parties.viewRule = "@request.auth.id != ''";
  app.save(parties);

  const members = app.findCollectionByNameOrId("party_members");
  app.db().newQuery("DELETE FROM party_members WHERE user = ''").execute();
  members.fields.removeByName("guestKey");
  members.fields.getByName("user").required = true;
  const memberAccess = "@request.auth.id != '' && (user = @request.auth.id || party.host = @request.auth.id)";
  members.listRule = memberAccess;
  members.viewRule = memberAccess;
  members.createRule = "@request.auth.id != '' && @request.body.user = @request.auth.id";
  members.updateRule = "user = @request.auth.id && (@request.body.user:isset = false || @request.body.user = @request.auth.id)"
    + " && (@request.body.party:isset = false || @request.body.party = party)";
  members.deleteRule = memberAccess;
  members.indexes = ["CREATE UNIQUE INDEX idx_party_members_party_user ON party_members (party, user)"];
  app.save(members);
});
