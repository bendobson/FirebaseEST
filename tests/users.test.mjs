import { before, after, beforeEach, describe, it } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { makeTestEnv, seed, userDoc } from './helpers.mjs';

describe('/users/{uid}', () => {
  let testEnv;

  before(async () => { testEnv = await makeTestEnv(); });
  after(async () => { await testEnv.cleanup(); });
  beforeEach(async () => { await testEnv.clearFirestore(); });

  it('denies an unauthenticated read', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc()));

    const anon = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, 'users/alice')));
  });

  it('lets a user read their own profile', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc()));

    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(getDoc(doc(alice, 'users/alice')));
  });

  it("denies reading another user's profile directly", async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/bob'), userDoc()));

    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertFails(getDoc(doc(alice, 'users/bob')));
  });

  // The invite search: AccessControlView lists candidates to share an event with.
  it('allows listing users who have opted into being visible', async () => {
    await seed(testEnv, async (db) => {
      await setDoc(doc(db, 'users/bob'), userDoc({ profileVisible: true }));
      await setDoc(doc(db, 'users/carol'), userDoc({ profileVisible: true }));
    });

    const alice = testEnv.authenticatedContext('alice').firestore();
    const visible = query(collection(alice, 'users'), where('profileVisible', '==', true));
    await assertSucceeds(getDocs(visible));
  });

  it('denies listing users who have not opted in', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/bob'), userDoc({ profileVisible: false })));

    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertFails(getDocs(collection(alice, 'users')));
  });

  it('lets a user create their own profile', async () => {
    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(alice, 'users/alice'), userDoc()));
  });

  it("denies creating someone else's profile", async () => {
    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(alice, 'users/bob'), userDoc()));
  });

  it('lets a user update their own profile', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc()));

    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(updateDoc(doc(alice, 'users/alice'), { name: 'Ben' }));
  });

  it("denies updating another user's profile", async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/bob'), userDoc()));

    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertFails(updateDoc(doc(alice, 'users/bob'), { name: 'Hacked' }));
  });

  it('lets a user delete their own profile', async () => {
    await seed(testEnv, (db) => setDoc(doc(db, 'users/alice'), userDoc()));

    const alice = testEnv.authenticatedContext('alice').firestore();
    await assertSucceeds(deleteDoc(doc(alice, 'users/alice')));
  });
});
