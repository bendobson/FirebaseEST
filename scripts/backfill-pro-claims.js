#!/usr/bin/env node
/**
 * Sets the RevenueCat Pro claim on every user RevenueCat says is subscribed (Pro migration;
 * 12 Nov 2026).
 *
 * The RevenueCat Firebase extension sets `revenueCatEntitlements` only when RevenueCat sends
 * an event, so a subscriber from before the extension (5 Nov 2026 on live) who hasn't renewed
 * since has no claim, and the rules fall back to their users/{uid}.isProUser flag. That
 * fallback costs storage.rules a third Firestore document for a shared event's route, over
 * Storage's two-document limit, so those subscribers were refused (403) on every app. With
 * the claim, isPro() never reads users/{uid}. This is also the step Pro stage 3 waits for.
 *
 * Who is asked about: users with isProUser == true, and users who already have a claim. Not
 * everyone, because RevenueCat's v1 GET /subscribers creates a customer for an unknown id.
 *
 * For each, RevenueCat's active entitlements (expiry, or grace period, in the future, or no
 * expiry) become `revenueCatEntitlements`, in the extension's format. Other claims are kept,
 * and `revenueCatEventTimestampMs` is left as it is, so the extension's next event always
 * applies. Users whose claim already matches are left alone. Running it twice changes nothing.
 *
 * Usage:
 *   node scripts/backfill-pro-claims.js --key <Firebase service-account key.json> \
 *        --rc-key-file <file holding the RevenueCat secret API key, sk_...> [--uid <uid>] [--confirm]
 *
 * Dry run unless --confirm is passed. Use the RevenueCat project that feeds the same Firebase
 * project (live RC for eventtracker-a150e, the develop RC project for est-develop).
 */

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const home = (p) => path.resolve(p.replace(/^~/, process.env.HOME));
const keyPath = arg("--key");
const rcKeyFile = arg("--rc-key-file");
const onlyUid = arg("--uid");
const confirmed = args.includes("--confirm");
if (!keyPath || !rcKeyFile) {
  console.error("Usage: node scripts/backfill-pro-claims.js --key <key.json> --rc-key-file <file> [--uid <uid>] [--confirm]");
  process.exit(1);
}

const key = require(home(keyPath));
const PROJECTS = ["est-develop", "eventtracker-a150e"];
if (!PROJECTS.includes(key.project_id)) {
  console.error(`This key is for "${key.project_id}". This runs on ${PROJECTS.join(" and ")} only.`);
  process.exit(1);
}
const rcKey = fs.readFileSync(home(rcKeyFile), "utf8").trim();
if (!rcKey.startsWith("sk_")) {
  console.error("The RevenueCat key must be a secret API key (sk_...), not a public SDK key.");
  process.exit(1);
}

const ENTITLEMENT_CLAIM = "revenueCatEntitlements";
console.log(`Project: ${key.project_id}${confirmed ? "" : " (dry run: pass --confirm to write)"}\n`);
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

/** RevenueCat's active entitlement ids for an app user id, sorted. */
async function activeEntitlements(uid) {
  const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(uid)}`, {
    headers: { Authorization: `Bearer ${rcKey}`, "Content-Type": "application/json" },
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get("Retry-After") || 2) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return activeEntitlements(uid);
  }
  if (!res.ok) throw new Error(`RevenueCat ${res.status} for ${uid}: ${await res.text()}`);
  const { subscriber } = await res.json();
  const now = Date.now();
  const until = (iso) => (iso ? Date.parse(iso) : Infinity);
  return Object.entries(subscriber?.entitlements ?? {})
    .filter(([, e]) => Math.max(until(e.expires_date), e.grace_period_expires_date
      ? Date.parse(e.grace_period_expires_date) : -Infinity) > now)
    .map(([id]) => id)
    .sort();
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

async function main() {
  // Candidates: the flag, or a claim already.
  const candidates = new Map();   // uid -> { flag }
  if (onlyUid) {
    const u = await db.doc(`users/${onlyUid}`).get();
    candidates.set(onlyUid, { flag: u.exists && u.get("isProUser") === true });
  } else {
    (await db.collection("users").where("isProUser", "==", true).get())
      .forEach((d) => candidates.set(d.id, { flag: true }));
    let page;
    do {
      page = await admin.auth().listUsers(1000, page?.pageToken);
      for (const u of page.users) {
        if (u.customClaims && ENTITLEMENT_CLAIM in u.customClaims && !candidates.has(u.uid)) {
          candidates.set(u.uid, { flag: false });
        }
      }
    } while (page.pageToken);
  }

  let set = 0, cleared = 0, unchanged = 0, stale = 0, missing = 0, failed = 0;
  for (const [uid, { flag }] of candidates) {
    let user;
    try { user = await admin.auth().getUser(uid); }
    catch { console.log(`skip    ${uid}  no Auth user (profile left behind)`); missing++; continue; }

    let active;
    try { active = await activeEntitlements(uid); }
    catch (e) { console.log(`FAILED  ${uid}  ${e.message}`); failed++; continue; }

    const claims = user.customClaims || {};
    const current = Array.isArray(claims[ENTITLEMENT_CLAIM]) ? [...claims[ENTITLEMENT_CLAIM]].sort() : null;
    const flagNote = flag ? "flag true" : "no flag";
    if (flag && active.length === 0) stale++;

    if (current && same(current, active)) { unchanged++; continue; }
    if (!current && active.length === 0) {
      console.log(`nothing ${uid}  RevenueCat: not subscribed; ${flagNote} (stale), no claim`);
      unchanged++;
      continue;
    }
    const verb = active.length ? "set   " : "clear ";
    console.log(`${verb}  ${uid}  ${JSON.stringify(current)} -> ${JSON.stringify(active)}  (${flagNote})`);
    if (confirmed) {
      await admin.auth().setCustomUserClaims(uid, { ...claims, [ENTITLEMENT_CLAIM]: active });
    }
    active.length ? set++ : cleared++;
  }

  console.log(`\n${candidates.size} asked about. ${confirmed ? "Done" : "Would do"}: ${set} set, ${cleared} cleared, `
    + `${unchanged} already right. ${stale} with a stale isProUser flag (RevenueCat: not subscribed). `
    + `${missing} without an Auth user. ${failed} failed.`);
  if (failed) process.exit(2);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
