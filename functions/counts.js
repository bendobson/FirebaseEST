'use strict';
/**
 * users/{uid}.ownedEventCount: how many events a user owns, counted by the server.
 *
 * Pro migration stage 1 (Notion: "Move Pro status and event count server-side"). The apps keep
 * their own `eventCount`, which drifts (see scripts/reconcile-event-counts.js) and which any user
 * can write. This is a separate field, so the two never double-count. Stage 3 points the
 * free-tier rule at it and stops the apps writing `eventCount`. The rules already refuse client
 * writes to it.
 *
 * Plain functions over an Admin Firestore handle, with no Cloud Functions types, so the tests can
 * run them against the emulator directly (tests/owned-event-count.test.mjs) and the backfill
 * script can share them.
 */

/** The owners whose count a write to events/{eventId} can change. */
function ownersToRecount(before, after) {
  // An ordinary edit (the apps save the event doc on every change) doesn't change who owns
  // what, so it costs nothing. Only create, delete and an ownerUserId change are counted.
  if (before && after && before.ownerUserId === after.ownerUserId) return [];
  const owners = new Set();
  for (const data of [before, after]) {
    const owner = data && data.ownerUserId;
    if (typeof owner === 'string' && owner !== '') owners.add(owner);
  }
  return [...owners];
}

/**
 * Recounts the events `uid` owns and stores the result on users/{uid}, in one transaction so two
 * triggers running at once can't leave a stale count.
 *
 * Never creates the user doc: an event deleted with its owner's account would otherwise bring
 * back a users/{uid} with no Auth user behind it (the "orphan user documents" the audit hunts).
 * A user without a doc gets their count from the next event change after the doc exists, or from
 * scripts/backfill-owned-event-counts.js.
 *
 * @returns {Promise<{uid: string, count: number, written: boolean}>} written is false when there
 *   is no user doc or the stored count was already right.
 */
async function recountOwnedEvents(db, uid) {
  const userRef = db.doc(`users/${uid}`);
  const owned = db.collection('events').where('ownerUserId', '==', uid).count();
  return db.runTransaction(async (tx) => {
    const [user, counted] = await Promise.all([tx.get(userRef), tx.get(owned)]);
    const count = counted.data().count;
    if (!user.exists || user.get('ownedEventCount') === count) return { uid, count, written: false };
    tx.update(userRef, { ownedEventCount: count });
    return { uid, count, written: true };
  });
}

module.exports = { ownersToRecount, recountOwnedEvents };
