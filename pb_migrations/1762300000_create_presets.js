/// <reference path="../pb_data/types.d.ts" />

// Stores everything a user saves: metronome presets, setlists and custom tunings.
// Each record belongs to one user and is only visible to that user.
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");

  const ownerOnly = "@request.auth.id != '' && owner = @request.auth.id";

  const collection = new Collection({
    type: "base",
    name: "presets",
    listRule: ownerOnly,
    viewRule: ownerOnly,
    createRule: "@request.auth.id != '' && @request.body.owner = @request.auth.id",
    updateRule: ownerOnly + " && (@request.body.owner:isset = false || @request.body.owner = @request.auth.id)",
    deleteRule: ownerOnly,
    fields: [
      {
        type: "relation",
        name: "owner",
        required: true,
        collectionId: users.id,
        maxSelect: 1,
        cascadeDelete: true,
      },
      {
        type: "select",
        name: "kind",
        required: true,
        maxSelect: 1,
        values: ["metronome", "setlist", "tuning"],
      },
      { type: "text", name: "name", required: true, max: 120 },
      { type: "json", name: "data", maxSize: 500000 },
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE INDEX idx_presets_owner_kind ON presets (owner, kind)"],
  });

  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("presets");
  app.delete(collection);
});
