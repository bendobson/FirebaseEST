#!/usr/bin/env node
/**
 * Sets users/{uid}.ownedEventCount for every existing user doc (Pro migration stage 1).
 *
 * The trigger in functions/ keeps the field right from the moment it is deployed, but only for
 * users whose events change after that. Run this once, after deploying the function, to fill in
 * everyone else. It uses the trigger's own recount (functions/counts.js), one user at a time in a
 * transaction, so running it while the trigger is live is safe. Running it twice changes nothing.
 *
 * Usage:
 *   node scripts/backfill-owned-event-counts.js --key /path/to/serviceAccountKey.json [--confirm]
 *
 * Dry run unless --confirm is passed. Leaves the apps' own `eventCount` alone.
 */

const admin = require("firebase-admin");
const path = require("path");
const { recountOwnedEvents } = require("../functions/counts");

const args = process.argv.slice(2);
const keyFlag = args.indexOf("--key");
if (keyFlag === -1 || !args[keyFlag + 1]) {
  console.error("Usage: node scripts/backfill-owned-event-counts.js --key /path/to/key.json [--confirm]");
  process.exit(1);
}
const confirmed = args.includes("--confirm");

const key = require(path.resolve(args[keyFlag + 1]));
// Stage 1 is on est-develop only. Live gets its backfill when stage 1 goes live, and this guard
// comes out then, deliberately.
if (key.project_id !== "est-develop") {
  console.error(`This key is for "${key.project_id}". Stage 1 is develop-only: use an est-develop key.`);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

async function main() {
  const [users, events] = await Promise.all([db.collection("users").get(), db.collection("events").get()]);
  const owned = {};
  events.forEach(d => {
    const owner = d.data().ownerUserId;
    if (owner) owned[owner] = (owned[owner] || 0) + 1;
  });

  const changes = [];
  users.forEach(d => {
    const stored = d.data().ownedEventCount;
    const actual = owned[d.id] || 0;
    if (stored !== actual) changes.push({ uid: d.id, stored, actual });
  });

  console.log(`project:         ${key.project_id}`);
  console.log(`user documents:  ${users.size}`);
  console.log(`events:          ${events.size}`);
  console.log(`needing a value: ${changes.length}\n`);
  for (const c of changes) {
    const from = c.stored === undefined ? "absent" : c.stored;
    console.log(`  ${confirmed ? "set" : "[DRY RUN] would set"} ${c.uid}: ${from} → ${c.actual}`);
  }

  if (!confirmed) {
    if (changes.length > 0) console.log("\nNothing was changed. Re-run with --confirm to apply.");
    return;
  }
  let written = 0;
  for (const c of changes) {
    if ((await recountOwnedEvents(db, c.uid)).written) written++;
  }
  console.log(`\nSet ownedEventCount on ${written} user(s).`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
