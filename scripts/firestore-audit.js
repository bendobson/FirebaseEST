#!/usr/bin/env node
/**
 * Firestore / Firebase Auth audit script
 *
 * Reports on all Auth users, their Firestore user docs, and their events.
 * Read-only by default — the delete flags additionally require --confirm.
 *
 * Setup:
 *   1. npm install                        (from the repo root)
 *   2. Download a service account key from Firebase Console →
 *      Project Settings → Service Accounts → Generate new private key
 *      Keep it OUTSIDE this repository.
 *   3. node scripts/firestore-audit.js --key ~/path/to/serviceAccountKey.json
 *
 * Optional flags:
 *   --delete-throwaway-guests  Delete anonymous users that were never really used
 *   --delete-orphan-events     Delete events whose ownerUserId has no Auth user
 *   --confirm                  Actually perform deletions. Without it, both delete
 *                              flags run as a dry run and only print what they would do.
 *   --csv                      Write users/events CSVs (personal data — gitignored)
 *
 * ── What counts as a throwaway guest ────────────────────────────────────────
 *
 * All three must hold:
 *   1. the Auth record is anonymous     (providerData is empty)
 *   2. it owns zero events              (nothing anyone could miss)
 *   3. it signed in exactly once        (lastSignInTime == creationTime)
 *
 * (2) is what makes this safe, and it does so by construction rather than by
 * judgement: an anonymous account owning no events holds nothing anyone could miss.
 *
 * ⚠️ (3) currently excludes NOTHING, and should not be relied on. Measured against
 * production on 2026-08-10: all 138 anonymous accounts have
 * lastSignInTime == creationTime, including ones 130 days old. The reason is that
 * the app restores an anonymous session from the Keychain — AuthManager.start()
 * reads Auth.auth().currentUser and never calls a sign-in method — so Firebase never
 * records a second sign-in however long someone uses the app. The condition is kept
 * as a cheap guard in case that ever changes, but do not mistake it for a safeguard.
 *
 * Note what is NOT in the list: "has no Firestore user document". An earlier
 * version required that, which is why almost nothing was ever caught —
 * SyncService.ensureUserProfileExists creates a users/{uid} document for every
 * guest at sign-in, so a real guest always has one.
 */

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// ── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const keyFlag = args.indexOf("--key");
if (keyFlag === -1 || !args[keyFlag + 1]) {
  console.error("Usage: node scripts/firestore-audit.js --key /path/to/serviceAccountKey.json [--delete-throwaway-guests] [--delete-orphan-events] [--confirm] [--csv]");
  process.exit(1);
}
function flagValue(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

const keyPath = path.resolve(args[keyFlag + 1]);
const deleteThrowawayGuests = args.includes("--delete-throwaway-guests");
const deleteOrphanEvents = args.includes("--delete-orphan-events");
const confirmed = args.includes("--confirm");
const exportCsv = args.includes("--csv");

// ── Init ─────────────────────────────────────────────────────────────────────

const serviceAccount = require(keyPath);

// The bucket has to be named explicitly — the Admin SDK doesn't infer it from the
// credential, and without it every storage call fails with "Bucket name not specified".
const bucketName = flagValue("--bucket") || `${serviceAccount.project_id}.firebasestorage.app`;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: bucketName,
});
const auth = admin.auth();
const db = admin.firestore();

/// Whether Firebase Storage is actually provisioned. Checked once, because if it isn't
/// there is no point asking about a GPX file per event — and the answer is interesting in
/// its own right: as of 2026-08-10 this project has NO bucket at all, so every GPX upload
/// the app has ever attempted has failed silently (GPXService treats the upload as
/// best-effort and only logs it). No event has a gpxStoragePath set.
let storageAvailable = null;
async function hasStorage() {
  if (storageAvailable !== null) return storageAvailable;
  try {
    const [exists] = await admin.storage().bucket().exists();
    storageAvailable = exists;
  } catch {
    storageAvailable = false;
  }
  if (!storageAvailable) {
    console.log(`  ℹ️  Storage bucket "${bucketName}" not found — skipping GPX cleanup.\n`);
  }
  return storageAvailable;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

async function getAllFirestoreUsers() {
  const snap = await db.collection("users").get();
  const map = {};
  snap.forEach(doc => { map[doc.id] = doc.data(); });
  return map;
}

async function getAllEvents() {
  const snap = await db.collection("events").get();
  const events = [];
  snap.forEach(doc => events.push({ id: doc.id, ...doc.data() }));
  return events;
}

function isGuest(authUser) {
  // The only reliable marker: an anonymous account is linked to no provider.
  // Don't use the Firestore doc's isGuest flag for this — it's a product state a
  // real person can be in, not evidence of a throwaway account.
  return authUser.providerData.length === 0;
}

/// True when the account signed in once and never came back — the signature of a
/// test-run artefact rather than someone using the app. Compared on the millisecond
/// value because Firebase returns these as UTC strings whose formatting can differ.
function signedInOnce(authUser) {
  const created = authUser.metadata?.creationTime;
  const lastSignIn = authUser.metadata?.lastSignInTime;
  if (!created || !lastSignIn) return false;
  return new Date(created).getTime() === new Date(lastSignIn).getTime();
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const ms = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  return remMonths > 0 ? `${years}yr ${remMonths}mo ago` : `${years}yr ago`;
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsvRow(fields) {
  return fields.map(csvEscape).join(",");
}

function formatDate(epochMs) {
  if (!epochMs) return "—";
  try {
    const d = new Date(epochMs);
    if (isNaN(d.getTime())) return `invalid(${epochMs})`;
    return d.toISOString().split("T")[0];
  } catch {
    return `invalid(${epochMs})`;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching data from Firebase...\n");

  const [authUsers, firestoreUsers, events] = await Promise.all([
    getAllAuthUsers(),
    getAllFirestoreUsers(),
    getAllEvents(),
  ]);

  // Build a map: ownerUserId → [eventIds]
  const eventsByOwner = {};
  for (const event of events) {
    const owner = event.ownerUserId || "UNKNOWN";
    if (!eventsByOwner[owner]) eventsByOwner[owner] = [];
    eventsByOwner[owner].push(event);
  }

  // Build a set of all Auth UIDs for orphan event check
  const authUidSet = new Set(authUsers.map(u => u.uid));

  // ── Section 1: Auth users ─────────────────────────────────────────────────

  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  AUTH USERS  (${authUsers.length} total)`);
  console.log("═══════════════════════════════════════════════════════════\n");

  const throwawayGuests = [];

  for (const user of authUsers) {
    const guest = isGuest(user);
    const userType = guest ? "GUEST" : "REGISTERED";
    const firestoreDoc = firestoreUsers[user.uid];
    const hasFirestoreDoc = !!firestoreDoc;
    const ownedEvents = eventsByOwner[user.uid] || [];
    const username = firestoreDoc?.username || (guest ? `Guest-${user.uid.substring(0, 5)}` : "—");
    const email = user.email || firestoreDoc?.email || "—";
    const lastSignInStr = user.metadata?.lastSignInTime
      ? new Date(user.metadata.lastSignInTime).toISOString().split("T")[0]
      : null;
    const lastSignInAge = daysSince(lastSignInStr);
    const lastSignInDisplay = lastSignInStr
      ? `${lastSignInStr}  (${lastSignInAge})`
      : "—";

    console.log(`[${userType}] ${username}`);
    console.log(`  UID:            ${user.uid}`);
    console.log(`  Email:          ${email}`);
    console.log(`  Last sign-in:   ${lastSignInDisplay}`);
    console.log(`  Firestore doc:  ${hasFirestoreDoc ? "YES" : "NO ⚠️"}`);
    console.log(`  Events owned:   ${ownedEvents.length}`);

    if (ownedEvents.length > 0) {
      for (const ev of ownedEvents) {
        console.log(`    • ${ev.name || "Unnamed"} (${ev.id}) — ${formatDate(ev.dateTime)}`);
      }
    }

    if (guest && ownedEvents.length === 0 && signedInOnce(user)) {
      const age = lastSignInAge ? `, ${lastSignInAge}` : "";
      console.log(`  ⚠️  Throwaway guest — no events, signed in once only${age}`);
      throwawayGuests.push(user);
    } else if (guest && ownedEvents.length === 0) {
      console.log(`  ·  Guest with no events, but has signed in more than once — KEPT`);
    }

    console.log();
  }

  // ── Section 2: Orphan events ──────────────────────────────────────────────

  const orphanEvents = events.filter(ev => !authUidSet.has(ev.ownerUserId));

  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  EVENTS  (${events.length} total)`);
  console.log("═══════════════════════════════════════════════════════════\n");

  if (orphanEvents.length === 0) {
    console.log("  All events have a valid owner. ✓\n");
  } else {
    console.log(`  ⚠️  ${orphanEvents.length} orphan event(s) — owner no longer exists in Auth:\n`);
    for (const ev of orphanEvents) {
      console.log(`  • ${ev.name || "Unnamed"} (${ev.id})`);
      console.log(`    Owner UID: ${ev.ownerUserId}`);
      console.log(`    Date:      ${formatDate(ev.dateTime)}\n`);
    }
  }

  // ── Section 3: Summary ────────────────────────────────────────────────────

  const registeredUsers = authUsers.filter(u => !isGuest(u));
  const guestUsers = authUsers.filter(u => isGuest(u));
  const guestsWithEvents = guestUsers.filter(u => (eventsByOwner[u.uid] || []).length > 0);
  const guestsWithoutDoc = guestUsers.filter(u => !firestoreUsers[u.uid]);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Total Auth users:          ${authUsers.length}`);
  console.log(`    Registered:              ${registeredUsers.length}`);
  console.log(`    Guest (anonymous):       ${guestUsers.length}`);
  console.log(`      Guests with events:    ${guestsWithEvents.length}`);
  console.log(`      Guests no Firestore:   ${guestsWithoutDoc.length}`);
  console.log(`      Throwaway guests:      ${throwawayGuests.length}`);
  console.log(`  Total events:              ${events.length}`);
  console.log(`  Orphan events:             ${orphanEvents.length}`);
  console.log();

  // ── Section 4: CSV export ─────────────────────────────────────────────────

  if (exportCsv) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    // Users CSV
    const userHeader = toCsvRow([
      "uid", "type", "username", "email", "last_sign_in", "inactive_for",
      "firestore_doc", "events_owned", "throwaway_guest"
    ]);
    const userRows = authUsers.map(user => {
      const guest = isGuest(user);
      const firestoreDoc = firestoreUsers[user.uid];
      const ownedEvents = eventsByOwner[user.uid] || [];
      const username = firestoreDoc?.username || (guest ? `Guest-${user.uid.substring(0, 5)}` : "");
      const email = user.email || firestoreDoc?.email || "";
      const lastSignInStr = user.metadata?.lastSignInTime
        ? new Date(user.metadata.lastSignInTime).toISOString().split("T")[0]
        : "";
      const orphan = guest && ownedEvents.length === 0 && signedInOnce(user);
      return toCsvRow([
        user.uid,
        guest ? "GUEST" : "REGISTERED",
        username,
        email,
        lastSignInStr,
        daysSince(lastSignInStr) || "",
        firestoreDoc ? "YES" : "NO",
        ownedEvents.length,
        orphan ? "YES" : "NO"
      ]);
    });
    const usersFile = `firestore-users-${timestamp}.csv`;
    fs.writeFileSync(usersFile, [userHeader, ...userRows].join("\n"));
    console.log(`CSV exported: ${usersFile}`);

    // Events CSV
    const eventHeader = toCsvRow([
      "event_id", "name", "date", "owner_uid", "owner_username",
      "owner_type", "orphan_event"
    ]);
    const eventRows = events.map(ev => {
      const ownerAuth = authUsers.find(u => u.uid === ev.ownerUserId);
      const ownerDoc = firestoreUsers[ev.ownerUserId];
      const ownerUsername = ownerDoc?.username || (ownerAuth && isGuest(ownerAuth) ? `Guest-${ev.ownerUserId?.substring(0, 5)}` : "");
      const ownerType = !ownerAuth ? "NO AUTH" : (isGuest(ownerAuth) ? "GUEST" : "REGISTERED");
      const orphan = !authUidSet.has(ev.ownerUserId);
      return toCsvRow([
        ev.id,
        ev.name || "",
        formatDate(ev.dateTime),
        ev.ownerUserId || "",
        ownerUsername,
        ownerType,
        orphan ? "YES" : "NO"
      ]);
    });
    const eventsFile = `firestore-events-${timestamp}.csv`;
    fs.writeFileSync(eventsFile, [eventHeader, ...eventRows].join("\n"));
    console.log(`CSV exported: ${eventsFile}\n`);
  }

  // ── Section 5: Optional cleanup ───────────────────────────────────────────

  const dryRun = !confirmed;
  const prefix = dryRun ? "[DRY RUN] would delete" : "Deleted";

  if (deleteThrowawayGuests && throwawayGuests.length > 0) {
    console.log(`${dryRun ? "[DRY RUN] " : ""}Removing ${throwawayGuests.length} throwaway guest(s)...`);

    for (const user of throwawayGuests) {
      // Firestore FIRST, Auth last. If the run dies half way, the surviving Auth
      // record is the marker that says "this uid still needs cleaning"; doing it the
      // other way round would leave documents with no owner and no way to find them.

      // The user's own profile document.
      if (firestoreUsers[user.uid]) {
        if (!dryRun) await db.collection("users").doc(user.uid).delete();
        console.log(`  ${prefix} users/${user.uid}`);
      }

      // Access grants they hold on OTHER people's events. They own no events by
      // definition, but they may have been invited to one — and a stale access
      // document shows the owner a collaborator who no longer exists.
      const grants = await db.collectionGroup("access").where("id", "==", user.uid).get();
      for (const grant of grants.docs) {
        if (!dryRun) await grant.ref.delete();
        console.log(`  ${prefix} ${grant.ref.path}`);
      }
    }

    // Auth records last, in batches — deleteUsers takes up to 1000 per call.
    const uids = throwawayGuests.map(u => u.uid);
    for (let i = 0; i < uids.length; i += 1000) {
      const batch = uids.slice(i, i + 1000);
      if (!dryRun) {
        const result = await auth.deleteUsers(batch);
        console.log(`  ${prefix} ${result.successCount} Auth user(s), ${result.failureCount} failed`);
        for (const err of result.errors) {
          console.log(`    ⚠️  ${batch[err.index]}: ${err.error.message}`);
        }
      } else {
        console.log(`  ${prefix} ${batch.length} Auth user(s)`);
      }
    }
    console.log("Done.\n");
  }

  if (deleteOrphanEvents && orphanEvents.length > 0) {
    console.log(`${dryRun ? "[DRY RUN] " : ""}Removing ${orphanEvents.length} orphan event(s)...`);

    for (const ev of orphanEvents) {
      // Subcollections are not removed with their parent document — Firestore has
      // no cascade — so they have to go explicitly or they become unreachable.
      for (const sub of ["checkpoints", "paces", "access"]) {
        const subSnap = await db.collection("events").doc(ev.id).collection(sub).get();
        for (const doc of subSnap.docs) {
          if (!dryRun) await doc.ref.delete();
        }
        if (subSnap.size > 0) console.log(`  ${prefix} ${subSnap.size} doc(s) from ${ev.id}/${sub}`);
      }

      // The GPX file, if this event had one. Path per GPXService.importGPX.
      if (await hasStorage()) {
        try {
          const file = admin.storage().bucket().file(`gpx/${ev.id}.gpx`);
          const [exists] = await file.exists();
          if (exists) {
            if (!dryRun) await file.delete();
            console.log(`  ${prefix} gpx/${ev.id}.gpx`);
          }
        } catch (err) {
          console.log(`  ⚠️  could not check storage for ${ev.id}: ${err.message.split("\n")[0]}`);
        }
      }

      if (!dryRun) await db.collection("events").doc(ev.id).delete();
      console.log(`  ${prefix} event: ${ev.name || "Unnamed"} (${ev.id})`);
    }
    console.log("Done.\n");
  }

  if (dryRun && (deleteThrowawayGuests || deleteOrphanEvents)) {
    console.log("Nothing was changed. Re-run with --confirm to apply.\n");
  }

  if (!deleteThrowawayGuests && !deleteOrphanEvents) {
    if (throwawayGuests.length > 0) {
      console.log(`Tip: --delete-throwaway-guests would remove ${throwawayGuests.length} guest(s). Add --confirm to apply.`);
    }
    if (orphanEvents.length > 0) {
      console.log(`Tip: --delete-orphan-events would remove ${orphanEvents.length} event(s). Add --confirm to apply.`);
    }
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
