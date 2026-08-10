#!/usr/bin/env node
/**
 * Sets every user's `eventCount` to the number of events they actually own.
 *
 * The field is read by the security rules to enforce the free tier, and it had drifted badly:
 *
 *   - `SyncService.uploadEvent` incremented it, and *every* edit routes through there via
 *     scheduleSync — a GPX import, a rename, a toggle. It was a tally of uploads.
 *   - `applyRemoteEventUpdate` incremented again whenever a new event document arrived, so a
 *     fresh install counted every owned event a second time, and so did each extra device.
 *   - `FirestoreService.saveUser` wrote the whole document without merge, and `UserDTO` has no
 *     eventCount — so saving a profile deleted the field entirely.
 *
 * The last of those was cancelling out the first two, which is the only reason the limit ever
 * appeared to work. The apps now increment once, on genuine creation, and merge on profile
 * save — so the stored values have to be corrected once before they mean anything.
 *
 * Run this AFTER the app fix ships, so old clients aren't still inflating counts behind it.
 *
 * Usage:
 *   node scripts/reconcile-event-counts.js --key /path/to/serviceAccountKey.json [--confirm]
 *
 * Dry run unless --confirm is passed.
 */

const admin = require("firebase-admin");
const path = require("path");

const args = process.argv.slice(2);
const keyFlag = args.indexOf("--key");
if (keyFlag === -1 || !args[keyFlag + 1]) {
  console.error("Usage: node scripts/reconcile-event-counts.js --key /path/to/key.json [--confirm]");
  process.exit(1);
}
const confirmed = args.includes("--confirm");

admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(args[keyFlag + 1]))) });
const db = admin.firestore();

async function main() {
  const dryRun = !confirmed;

  const [users, events] = await Promise.all([
    db.collection("users").get(),
    db.collection("events").get(),
  ]);

  const owned = {};
  events.forEach(d => {
    const owner = d.data().ownerUserId;
    if (owner) owned[owner] = (owned[owner] || 0) + 1;
  });

  const changes = [];
  users.forEach(d => {
    const stored = d.data().eventCount;
    const actual = owned[d.id] || 0;
    if (stored !== actual) changes.push({ ref: d.ref, uid: d.id, stored, actual });
  });

  console.log(`user documents:  ${users.size}`);
  console.log(`events:          ${events.size}`);
  console.log(`needing a fix:   ${changes.length}\n`);

  const inflated = changes.filter(c => typeof c.stored === "number" && c.stored > c.actual);
  const missing = changes.filter(c => c.stored === undefined);
  console.log(`  inflated (over-counted): ${inflated.length}`);
  console.log(`  absent (wiped by a profile save): ${missing.length}\n`);

  for (const c of changes) {
    const from = c.stored === undefined ? "absent" : c.stored;
    console.log(`  ${dryRun ? "[DRY RUN] would set" : "set"} ${c.uid}: ${from} → ${c.actual}`);
  }

  if (!dryRun && changes.length > 0) {
    for (let i = 0; i < changes.length; i += 500) {
      const batch = db.batch();
      for (const c of changes.slice(i, i + 500)) {
        batch.set(c.ref, { eventCount: c.actual }, { merge: true });
      }
      await batch.commit();
    }
    console.log(`\nCorrected ${changes.length} user(s).`);
  } else if (dryRun && changes.length > 0) {
    console.log("\nNothing was changed. Re-run with --confirm to apply.");
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
