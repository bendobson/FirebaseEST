#!/usr/bin/env node
/**
 * Fills userDirectory/{uid} = { id, username } from the existing users (1.13.0 apps).
 *
 * Invite search in the 1.13.0 apps reads the directory instead of every visible user's whole
 * profile (Bug Tracker, High). The apps keep their own entry from their next profile save, so
 * this is for everyone who doesn't save one: run it once after deploying the directory rule.
 * Until it has run, the apps fall back to the old query, so the order is safe.
 *
 * Listed: profileVisible == true, not a guest, a non-empty username. Entries for anyone else
 * (hidden since, deleted, a guest) are removed. Running it twice changes nothing.
 *
 * Usage:
 *   node scripts/backfill-user-directory.js --key /path/to/serviceAccountKey.json [--confirm]
 *
 * Dry run unless --confirm is passed.
 */

const admin = require("firebase-admin");
const path = require("path");

const args = process.argv.slice(2);
const keyFlag = args.indexOf("--key");
if (keyFlag === -1 || !args[keyFlag + 1]) {
  console.error("Usage: node scripts/backfill-user-directory.js --key /path/to/key.json [--confirm]");
  process.exit(1);
}
const confirmed = args.includes("--confirm");

const key = require(path.resolve(args[keyFlag + 1]));
const PROJECTS = ["est-develop", "eventtracker-a150e"];
if (!PROJECTS.includes(key.project_id)) {
  console.error(`This key is for "${key.project_id}". This runs on ${PROJECTS.join(" and ")} only.`);
  process.exit(1);
}
console.log(`Project: ${key.project_id}${confirmed ? "" : " (dry run: pass --confirm to write)"}`);
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

function entryFor(user) {
  const username = typeof user.username === "string" ? user.username.trim() : "";
  if (user.profileVisible !== true || user.isGuest === true || username === "" || username.length > 80) {
    return null;
  }
  return { username };
}

async function main() {
  const users = await db.collection("users").get();
  const directory = await db.collection("userDirectory").get();
  const existing = new Map(directory.docs.map((d) => [d.id, d.data()]));

  let listed = 0, unchanged = 0, removed = 0;
  let batch = db.batch(), pending = 0;
  const flush = async () => { if (confirmed && pending) await batch.commit(); batch = db.batch(); pending = 0; };

  const wanted = new Set();
  for (const u of users.docs) {
    const entry = entryFor(u.data());
    if (!entry) continue;
    wanted.add(u.id);
    const current = existing.get(u.id);
    if (current && current.id === u.id && current.username === entry.username && Object.keys(current).length === 2) {
      unchanged++;
      continue;
    }
    console.log(`list    ${u.id}  ${entry.username}`);
    batch.set(db.doc(`userDirectory/${u.id}`), { id: u.id, username: entry.username });
    listed++;
    if (++pending === 400) await flush();
  }
  for (const id of existing.keys()) {
    if (wanted.has(id)) continue;
    console.log(`remove  ${id}`);
    batch.delete(db.doc(`userDirectory/${id}`));
    removed++;
    if (++pending === 400) await flush();
  }
  await flush();
  console.log(`${confirmed ? "Done" : "Would do"}: ${listed} listed, ${removed} removed, ${unchanged} already right.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
