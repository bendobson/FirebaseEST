import { before, after, beforeEach, describe, it } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { makeTestEnv, seed, userDoc, eventDoc, accessDoc, proUsers } from './helpers.mjs';

describe('/events/{eventId}', () => {
  let testEnv;

  before(async () => { testEnv = await makeTestEnv(); });
  after(async () => { await testEnv.cleanup(); });
  beforeEach(async () => { await testEnv.clearFirestore(); });

  /// alice owns evt1. Any extra access docs are supplied by the caller.
  async function seedOwnedEvent({ owner = 'alice', access = {}, users = {} } = {}) {
    await seed(testEnv, async (db) => {
      await setDoc(doc(db, 'events/evt1'), eventDoc(owner));
      for (const [uid, role] of Object.entries(access)) {
        await setDoc(doc(db, `events/evt1/access/${uid}`), accessDoc(uid, role));
      }
      await proUsers(db, ...Object.keys(access).filter((uid) => !(uid in users)));
      for (const [uid, overrides] of Object.entries(users)) {
        await setDoc(doc(db, `users/${uid}`), userDoc(overrides));
      }
    });
  }

  // ─── Reading ───────────────────────────────────────────────────────────────

  it('lets the owner read their event', async () => {
    await seedOwnedEvent();
    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(getDoc(doc(alice, 'events/evt1')));
  });

  it('denies a stranger reading the event', async () => {
    await seedOwnedEvent();
    const mallory = testEnv.authenticatedContext('mallory').firestore();
    await assertFails(getDoc(doc(mallory, 'events/evt1')));
  });

  it('lets a user with an access document read the event', async () => {
    await seedOwnedEvent({ access: { bob: 'viewer' } });
    const bob = testEnv.authenticatedContext('bob').firestore();
    await assertSucceeds(getDoc(doc(bob, 'events/evt1')));
  });

  // ─── Writing ───────────────────────────────────────────────────────────────

  it('lets the owner update their event', async () => {
    await seedOwnedEvent();
    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(updateDoc(doc(alice, 'events/evt1'), { name: 'Renamed' }));
  });

  it('denies a viewer updating the event', async () => {
    await seedOwnedEvent({ access: { bob: 'viewer' } });
    const bob = testEnv.authenticatedContext('bob').firestore();
    await assertFails(updateDoc(doc(bob, 'events/evt1'), { name: 'Renamed' }));
  });

  it('lets an editor update the event', async () => {
    await seedOwnedEvent({ access: { bob: 'editor' } });
    const bob = testEnv.authenticatedContext('bob').firestore();
    await assertSucceeds(updateDoc(doc(bob, 'events/evt1'), { name: 'Renamed' }));
  });

  /// ⚠️ KNOWN MISMATCH — this test passes, and that is the bug.
  ///
  /// The rules compare `userRole(eventId) == "editor"`, lowercase. The iOS app stores the
  /// role as a *localised display string*: AccessControlView.swift:111 writes
  /// `L10n.event_access_viewer` and its picker (line 66) offers
  /// `[event_access_viewer, event_access_editor, event_access_owner]` — so an English user
  /// writes "Editor" and a German user writes "Bearbeiter". Neither ever equals "editor",
  /// so in production no editor can write to anything.
  ///
  /// Fix on the app side (store a stable lowercase token and localise only for display),
  /// then delete this test and make the one above the only editor case.
  it('DOCUMENTS A BUG: the capitalised role the app actually writes is denied', async () => {
    await seedOwnedEvent({ access: { bob: 'Editor' } });
    const bob = testEnv.authenticatedContext('bob').firestore();
    await assertFails(updateDoc(doc(bob, 'events/evt1'), { name: 'Renamed' }));
  });

  it('DOCUMENTS A BUG: a localised role is denied too', async () => {
    await seedOwnedEvent({ access: { bob: 'Bearbeiter' } });
    const bob = testEnv.authenticatedContext('bob').firestore();
    await assertFails(updateDoc(doc(bob, 'events/evt1'), { name: 'Renamed' }));
  });

  // ─── Deleting (owner + Pro only) ───────────────────────────────────────────

  it('lets a Pro owner delete their event', async () => {
    await seedOwnedEvent({ users: { alice: { isProUser: true } } });
    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(deleteDoc(doc(alice, 'events/evt1')));
  });

  it('denies a non-Pro owner deleting their event', async () => {
    await seedOwnedEvent({ users: { alice: { isProUser: false } } });
    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertFails(deleteDoc(doc(alice, 'events/evt1')));
  });

  it('denies an editor deleting the event', async () => {
    await seedOwnedEvent({ access: { bob: 'editor' }, users: { bob: { isProUser: true } } });
    const bob = testEnv.authenticatedContext('bob').firestore();
    await assertFails(deleteDoc(doc(bob, 'events/evt1')));
  });

  // ─── Creating, and the free-tier limit ─────────────────────────────────────

  it('denies creating an event owned by somebody else', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc()));
    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(alice, 'events/evt-new'), eventDoc('bob')));
  });

  // The free tier reads the server's ownedEventCount (recountOwnedEvents), not the apps'
  // eventCount (13 Nov 2026: the 1.13 apps stopped writing it; it drifted; users could reset it).

  it('lets a free user with no events create one', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc({ ownedEventCount: 0 })));
    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(alice, 'events/evt-new'), eventDoc('alice')));
  });

  /// `< 1`: a free user who owns one event is refused a second (the rule once said `<= 1`).
  it('denies a free user who owns one event creating a second', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc({ ownedEventCount: 1 })));
    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(alice, 'events/evt-new'), eventDoc('alice')));
  });

  it('denies a free user who owns several (a lapsed subscriber)', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc({ ownedEventCount: 3 })));
    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(alice, 'events/evt-new'), eventDoc('alice')));
  });

  it('lets a Pro user create regardless of how many events they own', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc({ isProUser: true, ownedEventCount: 50 })));
    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(alice, 'events/evt-new'), eventDoc('alice')));
  });

  /// The hole this closes: a 1.13 app never writes eventCount, so it stays absent (read as 0)
  /// however many events the user owns. Under the old rule this create succeeded.
  it('refuses a free user who owns an event even when eventCount is missing or 0', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc({ ownedEventCount: 1 })));
    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(alice, 'events/evt-new'), eventDoc('alice')));

    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc({ ownedEventCount: 1, eventCount: 0 })));
    await assertFails(setDoc(doc(alice, 'events/evt-new2'), eventDoc('alice')));
  });

  /// A drifted-high eventCount (1.12.x) no longer locks a free user with no events out.
  it('ignores a stale eventCount', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc({ ownedEventCount: 0, eventCount: 2 })));
    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(alice, 'events/evt-new'), eventDoc('alice')));
  });

  /// A brand-new user has no ownedEventCount until their first event: 0.
  it('treats a missing ownedEventCount as zero', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc()));
    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(alice, 'events/evt-new'), eventDoc('alice')));
  });

  /// Nobody can lower their own count to get another free event (the users rule refuses it).
  it('refuses a user resetting their own ownedEventCount', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc({ ownedEventCount: 1 })));
    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertFails(updateDoc(doc(alice, 'users/alice'), { ownedEventCount: 0 }));
  });
});
