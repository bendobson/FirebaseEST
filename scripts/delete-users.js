#!/usr/bin/env node
/**
 * Deletes users completely: everything they own, everything that points at them, and the
 * accounts themselves. Written for the 13 Nov 2026 clean-up of live's test accounts (now that
 * est-develop does that job), and kept for the next one.
 *
 * For each uid given:
 *   1. every event it owns (ownerUserId == uid): the GPX file first (gpx/<eventId>.gpx, and
 *      gpxStoragePath if an event names another), then the event and all its subcollections
 *      (access, checkpoints, paces, crew, and anything added later — recursiveDelete);
 *   2. its access docs on events that survive (it loses access; the event is untouched);
 *   3. userDirectory/{uid}, then users/{uid} with any subcollections;
 *   4. its RevenueCat customer, only with --rc-key-file;
 *   5. its Firebase Auth user, last of all.
 *
 * GPX before the event because storage.rules can't reach a GPX whose event is gone (README,
 * "Also worth knowing"); the Admin SDK could, but nothing would ever find it again. Auth last,
 * so a run that stops halfway leaves every uid still recognisable. Every step treats "already
 * gone" as done, so rerunning a failed run finishes the job.
 *
 * Also, optionally:
 *   --event <id>       delete this event too, whoever owns it (GPX and subcollections first).
 *                      Its owner keeps their account. Repeatable.
 *   --orphan-access    delete access docs whose event no longer exists, for anyone. They are
 *                      harmless debris left by older apps' deletes.
 *
 * Who loses access is printed before anything happens: any user NOT being deleted who can see
 * an event that will be deleted. Read that list before passing --confirm.
 *
 * RevenueCat: deleting a Firebase user leaves their RevenueCat customer behind. With
 * --rc-key-file (a secret sk_ key for the RevenueCat project that feeds this Firebase project:
 * live RC for eventtracker-a150e, the develop RC project for est-develop) the customer is
 * deleted with DELETE /v1/subscribers/{uid}, which also removes its purchase history in RC.
 * The dry run doesn't ask RevenueCat anything, since v1 GET /subscribers creates a customer for
 * an unknown id. A real store subscription is NOT cancelled by this: the person still cancels
 * in the App Store / Play Store.
 *
 * Usage:
 *   node scripts/delete-users.js --key <key.json> (--uid <uid> ... | --uids-file <file>)
 *        [--event <id> ...] [--orphan-access] [--rc-key-file <file>] [--protect <uid> ...] [--confirm]
 *
 * --uids-file: one uid per line; anything after the first space or comma is ignored (so
 * "uid, email" lines work) and lines starting with # are comments.
 * --protect: uids that must never be deleted; the run stops if one is in the list. Use it for
 * your own account when pasting lists around.
 *
 * Dry run unless --confirm is passed.
 */

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// ── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const all = (n) => args.flatMap((a, i) => (a === n && args[i + 1] ? [args[i + 1]] : []));
const home = (p) => path.resolve(p.replace(/^~/, process.env.HOME));

const USAGE = "Usage: node scripts/delete-users.js --key <key.json> (--uid <uid> ... | --uids-file <file>) "
  + "[--event <id> ...] [--orphan-access] [--rc-key-file <file>] [--protect <uid> ...] [--confirm]";
const keyPath = arg("--key");
const uidsFile = arg("--uids-file");
const rcKeyFile = arg("--rc-key-file");
const extraEvents = all("--event");
const protectedUids = new Set(all("--protect"));
const orphanAccess = args.includes("--orphan-access");
const confirmed = args.includes("--confirm");

const uids = [...all("--uid")];
if (uidsFile) {
  for (const line of fs.readFileSync(home(uidsFile), "utf8").split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#")) uids.push(t.split(/[\s,]+/)[0]);
  }
}
const targets = [...new Set(uids)];

if (!keyPath || (!targets.length && !extraEvents.length && !orphanAccess)) {
  console.error(USAGE);
  process.exit(1);
}
const bad = targets.filter((u) => !/^[A-Za-z0-9]{20,128}$/.test(u));
if (bad.length) {
  console.error(`Not Firebase uids: ${bad.join(", ")}`);
  process.exit(1);
}
const hit = targets.filter((u) => protectedUids.has(u));
if (hit.length) {
  console.error(`Refusing: protected uid in the list: ${hit.join(", ")}`);
  process.exit(1);
}

// ── Init ─────────────────────────────────────────────────────────────────────

const key = require(home(keyPath));
// demo-* is the emulator project (tests); it can only ever reach the emulators.
const PROJECTS = ["est-develop", "eventtracker-a150e"];
if (!PROJECTS.includes(key.project_id) && !key.project_id.startsWith("demo-")) {
  console.error(`This key is for "${key.project_id}". This runs on ${PROJECTS.join(" and ")} only.`);
  process.exit(1);
}
let rcKey = null;
if (rcKeyFile) {
  rcKey = fs.readFileSync(home(rcKeyFile), "utf8").trim();
  if (!rcKey.startsWith("sk_")) {
    console.error("The RevenueCat key must be a secret API key (sk_...), not a public SDK key.");
    process.exit(1);
  }
}

const bucketName = arg("--bucket") || `${key.project_id}.firebasestorage.app`;
admin.initializeApp({
  // A demo-* "key" is just { project_id } and needs no credential: the emulators don't check.
  ...(key.private_key ? { credential: admin.credential.cert(key) } : {}),
  projectId: key.project_id,
  storageBucket: bucketName,
});
const auth = admin.auth();
const db = admin.firestore();
const bucket = admin.storage().bucket();

// ── Helpers ──────────────────────────────────────────────────────────────────

const day = (t) => (t ? (t.toDate ? t.toDate() : new Date(t)).toISOString().slice(0, 10) : "—");
const gpxPaths = (ev) => [...new Set([`gpx/${ev.id}.gpx`, ev.get("gpxStoragePath")].filter(Boolean))];

async function authUser(uid) {
  try { return await auth.getUser(uid); }
  catch (e) { if (e.code === "auth/user-not-found") return null; throw e; }
}

async function existingGpx(ev) {
  const found = [];
  for (const p of gpxPaths(ev)) {
    const [exists] = await bucket.file(p).exists();
    if (exists) found.push(p);
  }
  return found;
}

async function subcollectionCounts(ref) {
  const counts = {};
  for (const sub of await ref.listCollections()) counts[sub.id] = (await sub.count().get()).data().count;
  return counts;
}

async function deleteRevenueCatCustomer(uid) {
  const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(uid)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${rcKey}`, "Content-Type": "application/json" },
  });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, Number(res.headers.get("Retry-After") || 2) * 1000));
    return deleteRevenueCatCustomer(uid);
  }
  if (res.status === 404) return "not in RevenueCat";
  if (!res.ok) throw new Error(`RevenueCat ${res.status}: ${await res.text()}`);
  return "deleted";
}

// ── Plan (read-only) ─────────────────────────────────────────────────────────

async function plan() {
  const targetSet = new Set(targets);
  const users = [];
  for (const uid of targets) {
    const [a, doc, dir, owned] = await Promise.all([
      authUser(uid),
      db.doc(`users/${uid}`).get(),
      db.doc(`userDirectory/${uid}`).get(),
      db.collection("events").where("ownerUserId", "==", uid).get(),
    ]);
    users.push({ uid, auth: a, doc, dir, owned: owned.docs });
  }

  const doomed = new Map();   // eventId -> { snap, reason }
  for (const u of users) for (const ev of u.owned) doomed.set(ev.id, { snap: ev, reason: `owned by ${u.uid}` });
  const missingEvents = [];
  for (const id of extraEvents) {
    if (doomed.has(id)) continue;
    const ev = await db.doc(`events/${id}`).get();
    if (ev.exists) doomed.set(id, { snap: ev, reason: "--event" });
    else missingEvents.push(id);
  }

  // The whole collection group, once: the targets' access docs are found by document id, which
  // is the uid by convention, rather than trusting the `id` field alone.
  const access = (await db.collectionGroup("access").get()).docs;
  const eventIds = new Set((await db.collection("events").select().get()).docs.map((d) => d.id));

  const losingAccess = [];   // non-targets who can see a doomed event
  const targetAccess = [];   // targets' access docs on surviving events
  const orphans = [];        // access docs under a missing event
  for (const a of access) {
    const eventId = a.ref.parent.parent.id;
    const uid = a.id;
    if (!eventIds.has(eventId)) {
      if (orphanAccess || targetSet.has(uid)) orphans.push(a);
    } else if (doomed.has(eventId)) {
      const owner = doomed.get(eventId).snap.get("ownerUserId");
      if (!targetSet.has(uid) && uid !== owner) losingAccess.push({ a, ev: doomed.get(eventId).snap });
    } else if (targetSet.has(uid)) {
      targetAccess.push(a);
    }
  }
  return { users, doomed, missingEvents, losingAccess, targetAccess, orphans };
}

async function report(p) {
  const name = new Map();
  for (const u of p.users) name.set(u.uid, u.auth?.email || u.doc.get?.("username") || u.uid);

  for (const u of p.users) {
    const a = u.auth;
    console.log(`\n■ ${u.uid}  ${a ? `${a.email || "(anonymous)"}, created ${day(a.metadata.creationTime)}` : "no Auth user"}`);
    console.log(`  users doc: ${u.doc.exists ? `@${u.doc.get("username")}` : "none"}   userDirectory: ${u.dir.exists ? "yes" : "none"}`
      + `   RevenueCat: ${rcKey ? "customer will be deleted" : "left alone (no --rc-key-file)"}`);
    const claims = a?.customClaims?.revenueCatEntitlements;
    if (claims?.length && !rcKey) console.log(`  ⚠️  has a Pro claim (${claims.join(", ")}); its RevenueCat customer stays`);
    console.log(`  owns ${u.owned.length} event(s)`);
  }

  console.log(`\nEvents to delete (${p.doomed.size}):`);
  for (const { snap, reason } of [...p.doomed.values()].sort((x, y) => x.snap.createTime.toMillis() - y.snap.createTime.toMillis())) {
    const subs = await subcollectionCounts(snap.ref);
    const gpx = await existingGpx(snap);
    console.log(`  - "${snap.get("name")}"  created ${day(snap.createTime)}  ${snap.id}  [${reason}]`);
    console.log(`      ${Object.entries(subs).map(([k, v]) => `${v} ${k}`).join(", ") || "no subcollections"}; GPX: ${gpx.join(", ") || "none"}`);
  }
  for (const id of p.missingEvents) console.log(`  - ${id}  [--event] not found, nothing to do`);

  console.log(`\nAccess docs removed from surviving events (${p.targetAccess.length}):`);
  for (const a of p.targetAccess) console.log(`  - ${a.ref.path}  (${name.get(a.id)}, ${a.get("role")})`);

  console.log(`\nOrphaned access docs, event already gone (${p.orphans.length}):`);
  for (const a of p.orphans) console.log(`  - ${a.ref.path}  (${a.get("role")})`);

  console.log(`\n⚠️  Users being KEPT who lose an event (${p.losingAccess.length}):`);
  for (const { a, ev } of p.losingAccess) console.log(`  - ${a.id} (@${a.get("username") ?? "?"}, ${a.get("role")}) loses "${ev.get("name")}"`);
}

// ── Execute ──────────────────────────────────────────────────────────────────

async function execute(p) {
  const step = (s) => console.log(`  ✓ ${s}`);
  console.log("\nDeleting…");
  for (const { snap } of p.doomed.values()) {
    for (const g of gpxPaths(snap)) await bucket.file(g).delete({ ignoreNotFound: true });
    await db.recursiveDelete(snap.ref);
    step(`event "${snap.get("name")}" ${snap.id} (GPX, subcollections, doc)`);
  }
  for (const a of [...p.targetAccess, ...p.orphans]) {
    await a.ref.delete();
    step(a.ref.path);
  }
  for (const u of p.users) {
    await db.doc(`userDirectory/${u.uid}`).delete();
    await db.recursiveDelete(db.doc(`users/${u.uid}`));
    step(`userDirectory/${u.uid}, users/${u.uid}`);
    if (rcKey) step(`RevenueCat ${u.uid}: ${await deleteRevenueCatCustomer(u.uid)}`);
    if (u.auth) {
      await auth.deleteUser(u.uid).catch((e) => { if (e.code !== "auth/user-not-found") throw e; });
      step(`Auth user ${u.uid}`);
    }
  }
}

async function main() {
  console.log(`Project: ${key.project_id}${confirmed ? "" : " (dry run: pass --confirm to delete)"}`);
  const p = await plan();
  await report(p);
  if (!confirmed) {
    console.log("\nDry run: nothing deleted.");
    return;
  }
  await execute(p);
  console.log(`\nDone: ${p.users.length} user(s), ${p.doomed.size} event(s), `
    + `${p.targetAccess.length + p.orphans.length} access doc(s).`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
