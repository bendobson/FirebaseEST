#!/usr/bin/env node
/**
 * Exports email + name for every registered user in EventSupportTracker.
 *
 * Sources (merged per UID, Auth takes precedence for email):
 *   - Firebase Authentication
 *   - Firestore /users collection
 *
 * Setup:
 *   1. npm install firebase-admin  (if not already)
 *   2. node export-users.js --key /path/to/serviceAccountKey.json [--out users.json]
 */

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

const keyPath = flag("--key");
if (!keyPath) {
  console.error("Usage: node export-users.js --key /path/to/serviceAccountKey.json [--out users.json]");
  process.exit(1);
}

const outPath = flag("--out") || `users-${new Date().toISOString().slice(0, 10)}.json`;

// ── Init ──────────────────────────────────────────────────────────────────────

admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(keyPath))) });
const auth = admin.auth();
const db = admin.firestore();

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function getAllAuthUsers() {
  const users = [];
  let pageToken;
  do {
    const result = await auth.listUsers(1000, pageToken);
    users.push(...result.users);
    pageToken = result.pageToken;
  } while (pageToken);
  return users;
}

async function getFirestoreUsers() {
  const snap = await db.collection("users").get();
  const map = {};
  snap.forEach(doc => { map[doc.id] = doc.data(); });
  return map;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching users from Firebase...");

  const [authUsers, firestoreUsers] = await Promise.all([
    getAllAuthUsers(),
    getFirestoreUsers(),
  ]);

  const results = [];

  for (const user of authUsers) {
    // Skip anonymous/guest accounts (no provider data)
    if (user.providerData.length === 0) continue;

    const doc = firestoreUsers[user.uid] || {};

    const email = user.email || doc.email || null;
    const name =
      user.displayName ||
      (doc.firstName && doc.lastName ? `${doc.firstName} ${doc.lastName}` : null) ||
      doc.name ||
      doc.username ||
      doc.displayName ||
      null;

    results.push({
      uid: user.uid,
      email,
      name,
    });
  }

  // Also include any Firestore-only entries (no Auth record)
  const authUids = new Set(authUsers.map(u => u.uid));
  for (const [uid, doc] of Object.entries(firestoreUsers)) {
    if (authUids.has(uid)) continue;
    const email = doc.email || null;
    const name =
      (doc.firstName && doc.lastName ? `${doc.firstName} ${doc.lastName}` : null) ||
      doc.name ||
      doc.username ||
      doc.displayName ||
      null;
    results.push({ uid, email, name });
  }

  // Drop entries with no valid email
  const validResults = results.filter(u => u.email && u.email.includes("@"));

  // Deduplicate by email (first occurrence wins)
  const seen = new Set();
  const deduped = [];
  for (const u of validResults) {
    if (!seen.has(u.email)) {
      seen.add(u.email);
      deduped.push(u);
    }
  }

  deduped.sort((a, b) => a.email.localeCompare(b.email));

  fs.writeFileSync(path.resolve(outPath), JSON.stringify(deduped, null, 2));
  console.log(`Exported ${deduped.length} user(s) → ${outPath}`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
