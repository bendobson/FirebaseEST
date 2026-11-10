//
//  userDirectory/{uid} (1.13.0 apps): what invite search may see of another user, the username
//  and nothing else. Bug Tracker, High: "Invite search exposes every visible user's email and
//  phone to any signed-in user".
//
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';
import { makeTestEnv, seed, userDoc } from './helpers.mjs';

describe('/userDirectory/{uid}', () => {
  let testEnv;

  before(async () => { testEnv = await makeTestEnv(); });
  after(async () => { await testEnv.cleanup(); });
  beforeEach(async () => { await testEnv.clearFirestore(); });

  async function seedUsers({ aliceVisible = true } = {}) {
    await seed(testEnv, async (db) => {
      await setDoc(doc(db, 'users/alice'), userDoc({ username: 'alice', profileVisible: aliceVisible }));
      await setDoc(doc(db, 'users/bob'), userDoc({ username: 'bob', profileVisible: true }));
      await setDoc(doc(db, 'userDirectory/bob'), { id: 'bob', username: 'bob' });
    });
  }

  const alice = () => testEnv.authenticatedContext('alice').firestore();

  it('lets a visible user list themselves by their own username', async () => {
    await seedUsers();
    await assertSucceeds(setDoc(doc(alice(), 'userDirectory/alice'), { id: 'alice', username: 'alice' }));
  });

  it('refuses an entry for anyone else', async () => {
    await seedUsers();
    await assertFails(setDoc(doc(alice(), 'userDirectory/bob'), { id: 'bob', username: 'bob' }));
    await assertFails(updateDoc(doc(alice(), 'userDirectory/bob'), { username: 'bob' }));
    await assertFails(deleteDoc(doc(alice(), 'userDirectory/bob')));
  });

  it('refuses contact details or any other field', async () => {
    await seedUsers();
    await assertFails(setDoc(doc(alice(), 'userDirectory/alice'),
      { id: 'alice', username: 'alice', email: 'test@example.com' }));
    await assertFails(setDoc(doc(alice(), 'userDirectory/alice'),
      { id: 'alice', username: 'alice', phone: '0191' }));
  });

  it("refuses a username that isn't the profile's (no listing as someone else)", async () => {
    await seedUsers();
    await assertFails(setDoc(doc(alice(), 'userDirectory/alice'), { id: 'alice', username: 'bob' }));
  });

  it('refuses an entry while the profile is hidden', async () => {
    await seedUsers({ aliceVisible: false });
    await assertFails(setDoc(doc(alice(), 'userDirectory/alice'), { id: 'alice', username: 'alice' }));
  });

  it('refuses a mismatched id or an empty username', async () => {
    await seedUsers();
    await assertFails(setDoc(doc(alice(), 'userDirectory/alice'), { id: 'bob', username: 'alice' }));
    await seed(testEnv, async (db) => {
      await setDoc(doc(db, 'users/alice'), userDoc({ username: '', profileVisible: true }));
    });
    await assertFails(setDoc(doc(alice(), 'userDirectory/alice'), { id: 'alice', username: '' }));
  });

  it('lets a user remove their own entry (profile hidden, account deleted)', async () => {
    await seedUsers();
    const bob = testEnv.authenticatedContext('bob').firestore();
    await assertSucceeds(deleteDoc(doc(bob, 'userDirectory/bob')));
  });

  it('lets any signed-in user search it, and nobody signed out', async () => {
    await seedUsers();
    await assertSucceeds(getDocs(collection(alice(), 'userDirectory')));
    await assertSucceeds(getDoc(doc(alice(), 'userDirectory/bob')));
    const anon = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDocs(collection(anon, 'userDirectory')));
  });
});
