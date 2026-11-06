/// <reference path="../pb_data/types.d.ts" />

// Host hand-off: the group's creator (host) can let another user lead, for a
// few minutes or for good. That user's member record is stored as `deputy` and
// gets the same rights over the group as the host, except changing the owner
// or the code. The host keeps their rights, so they can always take it back.
const DEPUTY = "(deputy != '' && ((@request.auth.id != '' && deputy.user = @request.auth.id)"
  + " || (deputy.user = '' && deputy.guestKey != '' && deputy.guestKey = @request.headers.x_guest_key)))";
const M_DEPUTY = "(party.deputy != '' && ((@request.auth.id != '' && party.deputy.user = @request.auth.id)"
  + " || (party.deputy.user = '' && party.deputy.guestKey != '' && party.deputy.guestKey = @request.headers.x_guest_key)))";
const HOST_UPDATE = "host = @request.auth.id && (@request.body.host:isset = false || @request.body.host = @request.auth.id)";

migrate((app) => {
  const parties = app.findCollectionByNameOrId("parties");
  const members = app.findCollectionByNameOrId("party_members");
  parties.fields.add(new RelationField({ name: "deputy", collectionId: members.id, maxSelect: 1, cascadeDelete: false }));
  app.save(parties);
  parties.updateRule = `(${HOST_UPDATE}) || (${DEPUTY} && @request.body.host:isset = false && @request.body.code:isset = false)`;
  parties.deleteRule = `host = @request.auth.id || ${DEPUTY}`;
  app.save(parties);

  members.listRule = `(${members.listRule}) || ${M_DEPUTY}`;
  members.viewRule = `(${members.viewRule}) || ${M_DEPUTY}`;
  members.deleteRule = `(${members.deleteRule}) || ${M_DEPUTY}`;
  app.save(members);
}, (app) => {
  const parties = app.findCollectionByNameOrId("parties");
  const members = app.findCollectionByNameOrId("party_members");
  const strip = (rule) => rule.endsWith(` || ${M_DEPUTY}`) ? rule.slice(1, -(` || ${M_DEPUTY}`.length + 1)) : rule;
  members.listRule = strip(members.listRule);
  members.viewRule = strip(members.viewRule);
  members.deleteRule = strip(members.deleteRule);
  app.save(members);
  parties.updateRule = HOST_UPDATE;
  parties.deleteRule = "host = @request.auth.id";
  parties.fields.removeByName("deputy");
  app.save(parties);
});
