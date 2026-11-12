#!/usr/bin/env node
/**
 * READ-ONLY. Checks the data storage.rules relies on since the two-document fix (12 Nov 2026).
 *
 * Storage rules may touch at most two Firestore documents per request, so the gpx/ rules now
 * look at the caller's own events/{id}/access/{uid} doc first and trust its role, falling
 * back to the event doc only when there is no access doc. That is safe only if the data
 * agrees with it. This lists anything that doesn't:
 *
 *   1. An access doc with role "owner" whose id isn't the event's ownerUserId. The new rules
 *      would let that person upload, replace and delete the route (firestore.rules has
 *      refused to create such a doc since the October audit; older ones could exist).
 *   2. An event whose owner has no access doc. Its owner falls back to the event doc, which
 *      fits the budget only with the Pro claim: without one, uploading or reading the route
 *      is refused. Fix by creating the owner's access doc.
 *   3. Access docs whose event no longer exists (orphans). Their holders could read, or with
 *      Pro upload, gpx/<that id>.gpx. Harmless (no event, no route), but worth clearing.
 *   4. Access docs whose `id` field differs from the doc id (shared-event discovery filters
 *      on the field, the rules on the doc id).
 *
 * Writes nothing. Usage:
 *   node scripts/check-owner-access.js --key /path/to/serviceAccountKey.json
 */

const admin = require("firebase-admin");
const path = require("path");

const args = process.argv.slice(2);
const keyFlag = args.indexOf("--key");
if (keyFlag === -1 || !args[keyFlag + 1]) {
  console.error("Usage: node scripts/check-owner-access.js --key /path/to/key.json");
  process.exit(1);
}
const key = require(path.resolve(args[keyFlag + 1].replace(/^~/, process.env.HOME)));
const PROJECTS = ["est-develop", "eventtracker-a150e"];
if (!PROJECTS.includes(key.project_id)) {
  console.error(`This key is for "${key.project_id}". This runs on ${PROJECTS.join(" and ")} only.`);
  process.exit(1);
}
console.log(`Project: ${key.project_id} (read-only)\n`);
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

async function main() {
  const events = new Map();
  (await db.collection("events").get()).forEach((d) => events.set(d.id, d.data()));

  const accessByEvent = new Map();
  const falseOwners = [];
  const orphans = [];
  const idMismatch = [];
  (await db.collectionGroup("access").get()).forEach((d) => {
    const eventId = d.ref.parent.parent.id;
    const data = d.data();
    if (!accessByEvent.has(eventId)) accessByEvent.set(eventId, new Set());
    accessByEvent.get(eventId).add(d.id);

    const event = events.get(eventId);
    if (!event) { orphans.push(`${eventId}/access/${d.id}`); return; }
    const role = typeof data.role === "string" ? data.role.trim().toLowerCase() : data.role;
    if (role === "owner" && d.id !== event.ownerUserId) {
      falseOwners.push(`${eventId}/access/${d.id} role "${data.role}" (owner is ${event.ownerUserId})`);
    }
    if (data.id !== d.id) idMismatch.push(`${eventId}/access/${d.id} has id field ${JSON.stringify(data.id)}`);
  });

  const ownerless = [];
  for (const [eventId, event] of events) {
    if (!event.ownerUserId) { ownerless.push(`${eventId} has no ownerUserId`); continue; }
    if (!accessByEvent.get(eventId)?.has(event.ownerUserId)) {
      ownerless.push(`${eventId} (${event.name ?? "?"}): owner ${event.ownerUserId} has no access doc`
        + (event.gpxStoragePath ? "  [has a route]" : ""));
    }
  }

  const report = (title, rows) => {
    console.log(`${title}: ${rows.length}`);
    rows.forEach((r) => console.log(`  ${r}`));
  };
  console.log(`${events.size} events, ${[...accessByEvent.values()].reduce((n, s) => n + s.size, 0)} access docs\n`);
  report("1. role \"owner\" for someone who isn't the owner", falseOwners);
  report("2. events whose owner has no access doc", ownerless);
  report("3. access docs on events that no longer exist", orphans);
  report("4. access docs whose id field isn't the doc id", idMismatch);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
