/// <reference path="../pb_data/types.d.ts" />

// Group section tuning: each user's tuner reports how far it is from the
// host's drone note, so the host can see who is sharp or flat.
migrate((app) => {
  const members = app.findCollectionByNameOrId("party_members");
  members.fields.add(new NumberField({ name: "tuneCents" }));
  members.fields.add(new NumberField({ name: "tuneAt" }));
  app.save(members);
}, (app) => {
  const members = app.findCollectionByNameOrId("party_members");
  members.fields.removeByName("tuneCents");
  members.fields.removeByName("tuneAt");
  app.save(members);
});
