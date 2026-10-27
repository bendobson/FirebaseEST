//
//  Checkpoints and paces share one rule shape — read for anyone with access, write for the
//  owner or an editor — so they're covered together.
//
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';
import { makeTestEnv, seed, eventDoc, accessDoc, checkpointDoc, proUsers } from './helpers.mjs';

describe('/events/{eventId}/checkpoints and /paces', () => {
  let testEnv;

  before(async () => { testEnv = await makeTestEnv(); });
  after(async () => { await testEnv.cleanup(); });
  beforeEach(async () => { await testEnv.clearFirestore(); });

  async function seedEvent(access = {}) {
    await seed(testEnv, async (db) => {
      await setDoc(doc(db, 'events/evt1'), eventDoc('alice'));
      await setDoc(doc(db, 'events/evt1/checkpoints/cp1'), checkpointDoc());
      await setDoc(doc(db, 'events/evt1/paces/pace1'), { fastPaceSecPerKm: 300 });
      for (const [uid, role] of Object.entries(access)) {
        await setDoc(doc(db, `events/evt1/access/${uid}`), accessDoc(uid, role));
      }
      await proUsers(db, 'alice', ...Object.keys(access));
    });
  }

  it('lets the owner read and write checkpoints', async () => {
    await seedEvent();
    const alice = testEnv.authenticatedContext('alice').firestore();

    await assertSucceeds(getDoc(doc(alice, 'events/evt1/checkpoints/cp1')));
    await assertSucceeds(setDoc(doc(alice, 'events/evt1/checkpoints/cp2'), checkpointDoc({ stopNumber: 2 })));
    await assertSucceeds(deleteDoc(doc(alice, 'events/evt1/checkpoints/cp1')));
  });

  it('lets a viewer read checkpoints but not change them', async () => {
    await seedEvent({ bob: 'viewer' });
    const bob = testEnv.authenticatedContext('bob').firestore();

    await assertSucceeds(getDocs(collection(bob, 'events/evt1/checkpoints')));
    await assertFails(setDoc(doc(bob, 'events/evt1/checkpoints/cp2'), checkpointDoc({ stopNumber: 2 })));
    await assertFails(deleteDoc(doc(bob, 'events/evt1/checkpoints/cp1')));
  });

  it('lets an editor write checkpoints', async () => {
    await seedEvent({ bob: 'editor' });
    const bob = testEnv.authenticatedContext('bob').firestore();

    await assertSucceeds(setDoc(doc(bob, 'events/evt1/checkpoints/cp2'), checkpointDoc({ stopNumber: 2 })));
  });

  it('denies a stranger reading checkpoints', async () => {
    await seedEvent();
    const mallory = testEnv.authenticatedContext('mallory').firestore();

    await assertFails(getDocs(collection(mallory, 'events/evt1/checkpoints')));
  });

  it('lets a viewer read paces but not change them', async () => {
    await seedEvent({ bob: 'viewer' });
    const bob = testEnv.authenticatedContext('bob').firestore();

    await assertSucceeds(getDoc(doc(bob, 'events/evt1/paces/pace1')));
    await assertFails(setDoc(doc(bob, 'events/evt1/paces/pace1'), { fastPaceSecPerKm: 1 }));
  });

  it('lets an editor change paces', async () => {
    await seedEvent({ bob: 'editor' });
    const bob = testEnv.authenticatedContext('bob').firestore();

    await assertSucceeds(setDoc(doc(bob, 'events/evt1/paces/pace1'), { fastPaceSecPerKm: 280 }));
  });

  /// The same localisation problem as on the event document itself — recorded here because
  /// checkpoint editing is the thing a shared editor is actually there to do.
  it('DOCUMENTS A BUG: the capitalised role the app writes cannot edit checkpoints', async () => {
    await seedEvent({ bob: 'Editor' });
    const bob = testEnv.authenticatedContext('bob').firestore();

    await assertFails(setDoc(doc(bob, 'events/evt1/checkpoints/cp2'), checkpointDoc({ stopNumber: 2 })));
  });
});
