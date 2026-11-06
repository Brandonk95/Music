/// <reference path="../pb_data/types.d.ts" />

// Section tuning: the id of the session in which this user held the note in tune.
migrate((app) => {
  const members = app.findCollectionByNameOrId("party_members");
  members.fields.add(new NumberField({ name: "tunedId" }));
  app.save(members);
}, (app) => {
  const members = app.findCollectionByNameOrId("party_members");
  members.fields.removeByName("tunedId");
  app.save(members);
});
