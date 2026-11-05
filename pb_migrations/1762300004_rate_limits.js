/// <reference path="../pb_data/types.d.ts" />

// Turn on PocketBase's request rate limits, mainly to slow down password
// guessing on the admin dashboard sign-in (/_/ or /admin). A lockout after
// repeated wrong passwords is in pb_hooks/tempotune.pb.js.
//
// Behind Cloudflare every request arrives from Cloudflare's (or the tunnel's)
// address, so the visitor's real IP is read from CF-Connecting-IP; otherwise
// all visitors would share one limit. Requests without the header use the
// connection address as before.
const RULES = [
  { label: "_superusers:auth", maxRequests: 3, duration: 10, audience: "" },
  { label: "*:auth", maxRequests: 5, duration: 10, audience: "" },
];

migrate((app) => {
  const settings = app.settings();
  const rules = settings.rateLimits.rules.filter((r) => !RULES.some((n) => n.label === r.label));
  settings.rateLimits.rules = [...RULES, ...rules];
  settings.rateLimits.enabled = true;
  if (!settings.trustedProxy.headers || settings.trustedProxy.headers.length === 0) {
    settings.trustedProxy.headers = ["CF-Connecting-IP"];
  }
  app.save(settings);
}, (app) => {
  const settings = app.settings();
  settings.rateLimits.rules = settings.rateLimits.rules.filter((r) => !RULES.some((n) => n.label === r.label));
  settings.rateLimits.enabled = false;
  app.save(settings);
});
