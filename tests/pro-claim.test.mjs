//
//  Pro migration stage 1: Pro is RevenueCat's custom claim (set by the RevenueCat Firebase
//  extension) OR the users/{uid}.isProUser flag the apps still write. Both must work during the
//  transition; stage 3 drops the flag. Also pins that clients can't write ownedEventCount, which
//  only the server sets (functions/counts.js).
//
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { ref, uploadBytes } from 'firebase/storage';
import { makeTestEnv, seed, userDoc, eventDoc, accessDoc } from './helpers.mjs';

const PRO = 'Event Support Tracker Pro';
const proClaim = { revenueCatEntitlements: [PRO] };

describe('Pro from the RevenueCat claim, or the doc flag', () => {
  let testEnv;

  before(async () => { testEnv = await makeTestEnv(); });
  after(async () => { await testEnv.cleanup(); });
  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.clearStorage();
  });

  /// alice owns evt1, and her user doc says she is free. bob has viewer access.
  async function seedEvent({ aliceFlag = false, bobDoc = false } = {}) {
    await seed(testEnv, async (db) => {
      await setDoc(doc(db, 'users/alice'), userDoc({ isProUser: aliceFlag, username: 'alice' }));
      if (bobDoc) await setDoc(doc(db, 'users/bob'), userDoc({ username: 'bob' }));
      await setDoc(doc(db, 'events/evt1'), eventDoc('alice'));
      await setDoc(doc(db, 'events/evt1/access/bob'), accessDoc('bob', 'viewer'));
    });
  }

  const as = (uid, claims) => testEnv.authenticatedContext(uid, claims).firestore();

  // ─── Deleting an event (owner + Pro) ───────────────────────────────────────

  it('the claim alone makes the owner Pro, even though the doc flag says free', async () => {
    await seedEvent();
    await assertSucceeds(deleteDoc(doc(as('alice', proClaim), 'events/evt1')));
  });

  it('the doc flag alone still makes the owner Pro (transition)', async () => {
    await seedEvent({ aliceFlag: true });
    await assertSucceeds(deleteDoc(doc(as('alice'), 'events/evt1')));
  });

  it('neither claim nor flag: not Pro', async () => {
    await seedEvent();
    await assertFails(deleteDoc(doc(as('alice'), 'events/evt1')));
  });

  it('a claim with only other entitlements is not Pro', async () => {
    await seedEvent();
    await assertFails(deleteDoc(doc(as('alice', { revenueCatEntitlements: ['something else'] }), 'events/evt1')));
  });

  it('an empty entitlement list is not Pro', async () => {
    await seedEvent();
    await assertFails(deleteDoc(doc(as('alice', { revenueCatEntitlements: [] }), 'events/evt1')));
  });

  it('a malformed claim (a string, not a list) is not Pro, and does not error the rule', async () => {
    await seedEvent();
    await assertFails(deleteDoc(doc(as('alice', { revenueCatEntitlements: PRO }), 'events/evt1')));
    await assertSucceeds(updateDoc(doc(as('alice', { revenueCatEntitlements: PRO }), 'events/evt1'), { name: 'Renamed' }));
  });

  // ─── Shared events (anyone but the owner needs Pro to read) ────────────────

  it('a viewer with the claim and no user doc at all reads the shared event', async () => {
    await seedEvent();
    await assertSucceeds(getDoc(doc(as('bob', proClaim), 'events/evt1')));
  });

  it('a viewer without the claim or the flag cannot', async () => {
    await seedEvent({ bobDoc: true });
    await assertFails(getDoc(doc(as('bob'), 'events/evt1')));
  });

  // ─── The free-tier create limit ─────────────────────────────────────────────

  it('the claim lifts the one-event limit', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc({ eventCount: 1 })));
    await assertSucceeds(setDoc(doc(as('alice', proClaim), 'events/evt2'), eventDoc('alice')));
    await assertFails(setDoc(doc(as('alice'), 'events/evt3'), eventDoc('alice')));
  });

  // ─── Storage uses the same Pro (storage.rules isPro) ────────────────────────

  it('the claim lets the owner upload a GPX route', async () => {
    const EVENT = 'E7B05764-15AE-439F-A8A0-7F825D5A81B7';
    await seed(testEnv, async (db) => {
      await setDoc(doc(db, 'users/alice'), userDoc({ username: 'alice' }));
      await setDoc(doc(db, `events/${EVENT}`), eventDoc('alice'));
    });
    const gpx = new Uint8Array(Buffer.from('<?xml version="1.0"?><gpx version="1.1"></gpx>'));
    const path = `gpx/${EVENT}.gpx`;
    await assertFails(uploadBytes(ref(testEnv.authenticatedContext('alice').storage(), path), gpx));
    await assertSucceeds(uploadBytes(ref(testEnv.authenticatedContext('alice', proClaim).storage(), path), gpx));
  });
});

describe('users/{uid}.ownedEventCount is server-only', () => {
  let testEnv;

  before(async () => { testEnv = await makeTestEnv(); });
  after(async () => { await testEnv.cleanup(); });
  beforeEach(async () => { await testEnv.clearFirestore(); });

  const alice = () => testEnv.authenticatedContext('alice').firestore();

  it('a client cannot create its user doc with ownedEventCount', async () => {
    await assertFails(setDoc(doc(alice(), 'users/alice'), userDoc({ ownedEventCount: 0 })));
    await assertSucceeds(setDoc(doc(alice(), 'users/alice'), userDoc()));
  });

  it('a client cannot set or change it', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc({ ownedEventCount: 3 })));
    await assertFails(updateDoc(doc(alice(), 'users/alice'), { ownedEventCount: 0 }));
    await assertFails(setDoc(doc(alice(), 'users/alice'), { ownedEventCount: 0 }, { merge: true }));
  });

  it('a client cannot delete it by overwriting the whole doc', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc({ ownedEventCount: 3 })));
    await assertFails(setDoc(doc(alice(), 'users/alice'), userDoc()));
  });

  it('the apps\' own saves still work: a merged profile save and the eventCount / isProUser writes', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc({ ownedEventCount: 3 })));
    await assertSucceeds(setDoc(doc(alice(), 'users/alice'), { name: 'Alice B', profileVisible: true }, { merge: true }));
    await assertSucceeds(updateDoc(doc(alice(), 'users/alice'), { eventCount: 1, isProUser: true }));
  });
});
