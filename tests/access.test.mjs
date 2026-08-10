import { before, after, beforeEach, describe, it } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, deleteDoc, collection, collectionGroup, query, where, getDocs,
} from 'firebase/firestore';
import { makeTestEnv, seed, eventDoc, accessDoc } from './helpers.mjs';

describe('/events/{eventId}/access/{accessId}', () => {
  let testEnv;

  before(async () => { testEnv = await makeTestEnv(); });
  after(async () => { await testEnv.cleanup(); });
  beforeEach(async () => { await testEnv.clearFirestore(); });

  async function seedSharedEvent() {
    await seed(testEnv, async (db) => {
      await setDoc(doc(db, 'events/evt1'), eventDoc('alice'));
      await setDoc(doc(db, 'events/evt1/access/alice'), accessDoc('alice', 'owner'));
      await setDoc(doc(db, 'events/evt1/access/bob'), accessDoc('bob', 'viewer'));
    });
  }

  it('lets the event owner grant access', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'events/evt1'), eventDoc('alice')));

    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(
      setDoc(doc(alice, 'events/evt1/access/bob'), accessDoc('bob', 'viewer'))
    );
  });

  it('denies a non-owner granting access', async () => {
    await seedSharedEvent();

    const bob = testEnv.authenticatedContext('bob').firestore();
    await assertFails(
      setDoc(doc(bob, 'events/evt1/access/mallory'), accessDoc('mallory', 'editor'))
    );
  });

  it('denies a stranger granting themselves access', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'events/evt1'), eventDoc('alice')));

    const mallory = testEnv.authenticatedContext('mallory').firestore();
    await assertFails(
      setDoc(doc(mallory, 'events/evt1/access/mallory'), accessDoc('mallory', 'editor'))
    );
  });

  it('lets a member list the access documents', async () => {
    await seedSharedEvent();

    const bob = testEnv.authenticatedContext('bob').firestore();
    await assertSucceeds(getDocs(collection(bob, 'events/evt1/access')));
  });

  it('denies a stranger listing the access documents', async () => {
    await seedSharedEvent();

    const mallory = testEnv.authenticatedContext('mallory').firestore();
    await assertFails(getDocs(collection(mallory, 'events/evt1/access')));
  });

  it('lets a user read their own access document', async () => {
    await seedSharedEvent();

    const bob = testEnv.authenticatedContext('bob').firestore();
    await assertSucceeds(getDoc(doc(bob, 'events/evt1/access/bob')));
  });

  it('lets a user revoke their own access (leaving a shared event)', async () => {
    await seedSharedEvent();

    const bob = testEnv.authenticatedContext('bob').firestore();
    await assertSucceeds(deleteDoc(doc(bob, 'events/evt1/access/bob')));
  });

  it('lets the owner revoke somebody else', async () => {
    await seedSharedEvent();

    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(deleteDoc(doc(alice, 'events/evt1/access/bob')));
  });

  it("denies a member revoking another member's access", async () => {
    await seed(testEnv, async (db) => {
      await setDoc(doc(db, 'events/evt1'), eventDoc('alice'));
      await setDoc(doc(db, 'events/evt1/access/bob'), accessDoc('bob', 'editor'));
      await setDoc(doc(db, 'events/evt1/access/carol'), accessDoc('carol', 'viewer'));
    });

    const bob = testEnv.authenticatedContext('bob').firestore();
    await assertFails(deleteDoc(doc(bob, 'events/evt1/access/carol')));
  });

  // ─── Shared-event discovery ────────────────────────────────────────────────
  // How the app finds events shared *with* you: a collection-group query over every `access`
  // subcollection. The rule filters on resource.data.id rather than the path wildcard,
  // because a list query is evaluated against field data.

  it('lets a user find the events shared with them', async () => {
    await seedSharedEvent();

    const bob = testEnv.authenticatedContext('bob').firestore();
    const mine = query(collectionGroup(bob, 'access'), where('id', '==', 'bob'));
    await assertSucceeds(getDocs(mine));
  });

  it("denies querying somebody else's shared events", async () => {
    await seedSharedEvent();

    const mallory = testEnv.authenticatedContext('mallory').firestore();
    const notMine = query(collectionGroup(mallory, 'access'), where('id', '==', 'bob'));
    await assertFails(getDocs(notMine));
  });

  it('denies an unfiltered collection-group query over all access documents', async () => {
    await seedSharedEvent();

    const mallory = testEnv.authenticatedContext('mallory').firestore();
    await assertFails(getDocs(collectionGroup(mallory, 'access')));
  });
});
