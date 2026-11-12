#!/usr/bin/env node
/**
 * est-develop ONLY. Asks the real Storage rules the question the emulator can't answer: can a
 * shared editor whose Pro is only the users/{uid} flag (no RevenueCat claim) read a route?
 *
 * Storage rules may touch at most two Firestore documents per request; the emulator doesn't
 * enforce that, so the emulator tests passed while live refused exactly this reader (12 Nov
 * 2026: events + access + users = 3). The fix is the claim, not a rules change
 * (backfill-pro-claims.js): with it isPro() never reads users/{uid}. Expected on the current
 * rules: flag only -> 403 (after the backfill that means RevenueCat says not subscribed);
 * --claim -> 200.
 *
 * It seeds a throwaway event (owner access doc, an editor, the editor's flag-only profile)
 * and a tiny GPX, signs in as the editor with a custom token through the Auth REST API (as
 * the apps' SDKs do), reads the object's metadata through the Storage REST API, and removes
 * everything it created, including the two Auth users.
 *
 * Usage:
 *   node scripts/probe-storage-budget.js --key <est-develop key.json> --api-key <web API key> [--claim]
 */

const admin = require("firebase-admin");
const path = require("path");
const crypto = require("crypto");

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const keyPath = arg("--key");
const apiKey = arg("--api-key");
// --claim: the editor has the RevenueCat claim and NO flag, so Pro must come from the token
// and users/{uid} is never read. Expected 200 even on the old rules (events + access = 2).
const withClaim = args.includes("--claim");
if (!keyPath || !apiKey) {
  console.error("Usage: node scripts/probe-storage-budget.js --key <est-develop key.json> --api-key <web API key> [--claim]");
  process.exit(1);
}
const key = require(path.resolve(keyPath.replace(/^~/, process.env.HOME)));
if (key.project_id !== "est-develop") {
  console.error(`This key is for "${key.project_id}". The probe writes test data, so it runs on est-develop only.`);
  process.exit(1);
}
const bucketName = `${key.project_id}.firebasestorage.app`;
admin.initializeApp({ credential: admin.credential.cert(key), storageBucket: bucketName });
const db = admin.firestore();

const run = crypto.randomUUID().slice(0, 8);
const OWNER = `probe-owner-${run}`;
const EDITOR = `probe-editor-${run}`;
const EVENT = crypto.randomUUID().toUpperCase();
const OBJECT = `gpx/${EVENT}.gpx`;

async function idTokenFor(uid) {
  const customToken = await admin.auth().createCustomToken(uid);
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }) });
  const body = await res.json();
  if (!res.ok) throw new Error(`sign-in failed: ${JSON.stringify(body.error)}`);
  return body.idToken;
}

async function main() {
  console.log(`est-develop probe ${run}: event ${EVENT}`);
  await admin.auth().createUser({ uid: OWNER });
  await admin.auth().createUser({ uid: EDITOR });
  if (withClaim) {
    await admin.auth().setCustomUserClaims(EDITOR, { revenueCatEntitlements: ["Event Support Tracker Pro"] });
  }
  const editorClaims = (await admin.auth().getUser(EDITOR)).customClaims || {};
  console.log(`editor claims: ${JSON.stringify(editorClaims)} `
    + (withClaim ? "(Pro by the claim, flag off)" : "(must be {}: Pro by the flag only)"));

  await db.doc(`events/${EVENT}`).set({ name: `probe ${run}`, ownerUserId: OWNER, dateTime: new Date() });
  await db.doc(`events/${EVENT}/access/${OWNER}`).set({ id: OWNER, role: "owner", username: OWNER });
  await db.doc(`events/${EVENT}/access/${EDITOR}`).set({ id: EDITOR, role: "editor", username: EDITOR });
  await db.doc(`users/${EDITOR}`).set({ username: EDITOR, isGuest: false, isProUser: !withClaim, profileVisible: false });
  await admin.storage().bucket().file(OBJECT).save(
    '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg><trkpt lat="54.9" lon="-1.6"/></trkseg></trk></gpx>');

  const token = await idTokenFor(EDITOR);
  const res = await fetch(
    `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(OBJECT)}`,
    { headers: { Authorization: `Firebase ${token}` } });
  console.log(`\nshared editor, ${withClaim ? "Pro by the claim" : "flag-only Pro"}, reads the route's metadata: HTTP ${res.status}`);
  console.log(res.ok ? "→ ALLOWED: the read fits the two-document limit."
                     : "→ REFUSED: the read needs more than two Firestore documents (or another rule failed).");
  return res.ok;
}

async function cleanUp() {
  await admin.storage().bucket().file(OBJECT).delete().catch(() => {});
  for (const p of [`events/${EVENT}/access/${OWNER}`, `events/${EVENT}/access/${EDITOR}`,
                   `events/${EVENT}`, `users/${EDITOR}`, `users/${OWNER}`]) {
    await db.doc(p).delete().catch(() => {});
  }
  // recountOwnedEvents may write users/{owner} after the event delete; give it a moment.
  await new Promise((r) => setTimeout(r, 5000));
  await db.doc(`users/${OWNER}`).delete().catch(() => {});
  await admin.auth().deleteUsers([OWNER, EDITOR]).catch(() => {});
  console.log("cleaned up");
}

main()
  .then(async (ok) => { await cleanUp(); process.exit(ok ? 0 : 2); })
  .catch(async (e) => { console.error(e); await cleanUp(); process.exit(1); });
