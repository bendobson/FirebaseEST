//
//  Security rules audit, October 2026 (Notion task "Security rules audit: move app-only
//  access checks into Firestore/Storage rules"). Done for the web planner: a browser client
//  can send any write it likes, so the rules have to hold every line the apps hold.
//
//  Two kinds of test here:
//  - Rules added by the audit, proved both ways.
//  - "DOCUMENTS A GAP": things the rules don't (or can't yet) enforce. These pass today; each
//    names the Notion item that closes it. When it's closed, flip the assertion.
//
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { makeTestEnv, seed, userDoc, eventDoc, accessDoc, checkpointDoc } from './helpers.mjs';

describe('rules audit (Oct 2026)', () => {
  let testEnv;

  before(async () => { testEnv = await makeTestEnv(); });
  after(async () => { await testEnv.cleanup(); });
  beforeEach(async () => { await testEnv.clearFirestore(); });

  /// alice owns evt1; bob is an editor, carol a viewer.
  async function seedShared(users = {}) {
    await seed(testEnv, async (db) => {
      await setDoc(doc(db, 'events/evt1'), eventDoc('alice'));
      await setDoc(doc(db, 'events/evt1/access/alice'), accessDoc('alice', 'owner'));
      await setDoc(doc(db, 'events/evt1/access/bob'), accessDoc('bob', 'editor'));
      await setDoc(doc(db, 'events/evt1/access/carol'), accessDoc('carol', 'viewer'));
      await setDoc(doc(db, 'events/evt1/checkpoints/cp1'), checkpointDoc({ createdBy: 'alice' }));
      for (const [uid, overrides] of Object.entries(users)) {
        await setDoc(doc(db, `users/${uid}`), userDoc(overrides));
      }
    });
  }

  const as = (uid) => testEnv.authenticatedContext(uid).firestore();

  // ─── ownerUserId is fixed after create ─────────────────────────────────────

  describe('ownerUserId never changes', () => {
    it('denies an editor taking ownership (the Android migrateStaleOwnerUserId bug, JCW D2)', async () => {
      await seedShared();
      await assertFails(updateDoc(doc(as('bob'), 'events/evt1'), { ownerUserId: 'bob' }));
    });

    it("denies an editor's whole-doc save that carries a different owner", async () => {
      await seedShared();
      await assertFails(setDoc(doc(as('bob'), 'events/evt1'), eventDoc('bob', { name: 'Mine now' })));
    });

    it('denies the owner giving the event away by editing the field', async () => {
      await seedShared();
      await assertFails(updateDoc(doc(as('alice'), 'events/evt1'), { ownerUserId: 'bob' }));
    });

    it("still lets an editor save the whole doc, as the apps do, when the owner is unchanged", async () => {
      await seedShared();
      await assertSucceeds(setDoc(doc(as('bob'), 'events/evt1'), eventDoc('alice', { name: 'Renamed' })));
    });

    it('still lets an editor change other fields', async () => {
      await seedShared();
      await assertSucceeds(updateDoc(doc(as('bob'), 'events/evt1'), { name: 'Renamed', stops: 6 }));
    });
  });

  // ─── Access docs must be well formed ───────────────────────────────────────

  describe('access docs', () => {
    it('lets the owner invite an editor or a viewer', async () => {
      await seedShared();
      await assertSucceeds(setDoc(doc(as('alice'), 'events/evt1/access/dave'), accessDoc('dave', 'editor')));
      await assertSucceeds(setDoc(doc(as('alice'), 'events/evt1/access/erin'), accessDoc('erin', 'viewer')));
    });

    it("lets the owner write their own owner doc (event create, as the apps do)", async () => {
      await seedShared();
      await assertSucceeds(setDoc(doc(as('alice'), 'events/evt1/access/alice'), accessDoc('alice', 'owner')));
    });

    it('denies giving anyone else the owner role (iOS offers it; the rules would make them read-only)', async () => {
      await seedShared();
      await assertFails(updateDoc(doc(as('alice'), 'events/evt1/access/bob'), { role: 'owner' }));
      await assertFails(setDoc(doc(as('alice'), 'events/evt1/access/dave'), accessDoc('dave', 'owner')));
    });

    it('denies an unknown or translated role', async () => {
      await seedShared();
      await assertFails(setDoc(doc(as('alice'), 'events/evt1/access/dave'), accessDoc('dave', 'Editor')));
      await assertFails(setDoc(doc(as('alice'), 'events/evt1/access/dave'), accessDoc('dave', 'herausgeber')));
      await assertFails(setDoc(doc(as('alice'), 'events/evt1/access/dave'), accessDoc('dave', 'admin')));
    });

    it("denies an id field that doesn't match the doc (shared-event discovery filters on it)", async () => {
      await seedShared();
      await assertFails(
        setDoc(doc(as('alice'), 'events/evt1/access/dave'), accessDoc('dave', 'viewer', { id: 'mallory' })),
      );
    });

    it('still denies an editor inviting anyone', async () => {
      await seedShared();
      await assertFails(setDoc(doc(as('bob'), 'events/evt1/access/dave'), accessDoc('dave', 'viewer')));
    });
  });

  // ─── Signed out: nothing at all ────────────────────────────────────────────

  describe('signed out', () => {
    it('can read or write nothing under an event', async () => {
      await seedShared();
      const anon = testEnv.unauthenticatedContext().firestore();
      await assertFails(getDoc(doc(anon, 'events/evt1')));
      await assertFails(getDoc(doc(anon, 'events/evt1/checkpoints/cp1')));
      await assertFails(getDocs(collection(anon, 'events/evt1/access')));
      await assertFails(getDocs(collection(anon, 'events/evt1/paces')));
      await assertFails(setDoc(doc(anon, 'events/evt1/checkpoints/cp2'), checkpointDoc()));
    });
  });

  // ─── Gaps: passing today, each has a fix elsewhere ─────────────────────────

  describe('DOCUMENTS A GAP', () => {
    /// iOS SyncService.migrateGuestUser creates a NEW account, then tries to move the guest's
    /// events across. As the new user it can't list the guest's events or rewrite their owner,
    /// so registering silently loses a guest's events. Android avoids this with
    /// linkWithCredential (same uid). Fix: iOS uses link(with:) too (Bug Tracker).
    it("iOS guest upgrade: the new account can't reach the guest's events", async () => {
      await seed(testEnv, async (db) => {
        await setDoc(doc(db, 'events/guestEvt'), eventDoc('guest-uid'));
        await setDoc(doc(db, 'events/guestEvt/access/guest-uid'), accessDoc('guest-uid', 'owner'));
      });
      const registered = as('new-uid');
      await assertFails(getDocs(query(collection(registered, 'events'), where('ownerUserId', '==', 'guest-uid'))));
      await assertFails(updateDoc(doc(registered, 'events/guestEvt'), { ownerUserId: 'new-uid' }));
      await assertFails(deleteDoc(doc(registered, 'users/guest-uid')));
    });

    /// Invite search lists every visible user's whole profile, email and phone included, to
    /// any signed-in user (iOS FirestoreService.fetchVisibleUsers, Android
    /// AccessControlViewModel). Fix: a username-only directory collection (Bug Tracker).
    it("any signed-in user can list visible users' email and phone", async () => {
      await seed(testEnv, async (db) => {
        await setDoc(doc(db, 'users/zoe'), userDoc({ profileVisible: true, email: 'zoe@example.com', phone: '07700 900123' }));
      });
      const snap = await assertSucceeds(
        getDocs(query(collection(as('mallory'), 'users'), where('profileVisible', '==', true))),
      );
      const zoe = snap.docs[0]?.data();
      if (zoe?.email !== 'zoe@example.com' || zoe?.phone !== '07700 900123') {
        throw new Error('expected the full profile to be readable');
      }
    });

    /// Pro status and the free-tier counter are client-written, so a user can grant
    /// themselves Pro. Fix: Notion task "Move Pro status and event count server-side…"
    /// (stage 3 locks these fields).
    it('a user can make themselves Pro, or reset their event count', async () => {
      await seedShared({ mallory: { isProUser: false, eventCount: 1 } });
      await assertSucceeds(updateDoc(doc(as('mallory'), 'users/mallory'), { isProUser: true }));
      await assertSucceeds(updateDoc(doc(as('mallory'), 'users/mallory'), { eventCount: 0 }));
    });

    /// Sharing is Pro in both apps (canShareEvents), but the rules let any owner share.
    /// Decision needed: enforce Pro in the rules, or accept it as a UI-only gate.
    it('a free owner can share an event', async () => {
      await seedShared({ alice: { isProUser: false } });
      await assertSucceeds(setDoc(doc(as('alice'), 'events/evt1/access/dave'), accessDoc('dave', 'viewer')));
    });
  });
});
