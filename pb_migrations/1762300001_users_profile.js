/// <reference path="../pb_data/types.d.ts" />

// Adds the optional setup-questionnaire answers to each user, so the
// personalized settings follow them to any device they sign in on.
// Users can already update their own record (default users update rule).
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.add(new JSONField({ name: "profile", maxSize: 20000 }));
  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  users.fields.removeByName("profile");
  app.save(users);
});
