//
//  Crew (decided 28 Oct 2026): one doc per person at a checkpoint. Read for anyone who can
//  read the event; write for the owner or an editor, and Pro for both. Names only, so the
//  field list is closed.
//
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } from 'firebase/firestore';
import { makeTestEnv, seed, eventDoc, accessDoc, crewDoc, proUsers, userDoc } from './helpers.mjs';

describe('/events/{eventId}/crew', () => {
  let testEnv;

  before(async () => { testEnv = await makeTestEnv(); });
  after(async () => { await testEnv.cleanup(); });
  beforeEach(async () => { await testEnv.clearFirestore(); });

  async function seedEvent(access = {}, { ownerPro = true } = {}) {
    await seed(testEnv, async (db) => {
      await setDoc(doc(db, 'events/evt1'), eventDoc('alice'));
      await setDoc(doc(db, 'events/evt1/crew/crew1'), crewDoc('crew1'));
      for (const [uid, role] of Object.entries(access)) {
        await setDoc(doc(db, `events/evt1/access/${uid}`), accessDoc(uid, role));
      }
      await proUsers(db, ...Object.keys(access));
      await setDoc(doc(db, 'users/alice'), userDoc({ isProUser: ownerPro, username: 'alice' }));
    });
  }

  it('lets a Pro owner add, change and remove crew', async () => {
    await seedEvent();
    const alice = testEnv.authenticatedContext('alice').firestore();

    await assertSucceeds(setDoc(doc(alice, 'events/evt1/crew/crew2'), crewDoc('crew2')));
    await assertSucceeds(updateDoc(doc(alice, 'events/evt1/crew/crew1'), { name: 'Sam B', checkpointId: 'cp2' }));
    await assertSucceeds(deleteDoc(doc(alice, 'events/evt1/crew/crew1')));
  });

  it('lets a free owner see their crew but not change them', async () => {
    await seedEvent({}, { ownerPro: false });
    const alice = testEnv.authenticatedContext('alice').firestore();

    await assertSucceeds(getDocs(collection(alice, 'events/evt1/crew')));
    await assertFails(setDoc(doc(alice, 'events/evt1/crew/crew2'), crewDoc('crew2')));
    await assertFails(updateDoc(doc(alice, 'events/evt1/crew/crew1'), { name: 'Sam B' }));
    await assertFails(deleteDoc(doc(alice, 'events/evt1/crew/crew1')));
  });

  it('lets a Pro editor add and remove crew', async () => {
    await seedEvent({ bob: 'editor' });
    const bob = testEnv.authenticatedContext('bob').firestore();

    await assertSucceeds(setDoc(doc(bob, 'events/evt1/crew/crew2'), crewDoc('crew2')));
    await assertSucceeds(deleteDoc(doc(bob, 'events/evt1/crew/crew1')));
  });

  it('lets a viewer see crew but not change them, including checking in', async () => {
    await seedEvent({ carol: 'viewer' });
    const carol = testEnv.authenticatedContext('carol').firestore();

    await assertSucceeds(getDoc(doc(carol, 'events/evt1/crew/crew1')));
    await assertFails(updateDoc(doc(carol, 'events/evt1/crew/crew1'), { onLocation: true }));
    await assertFails(setDoc(doc(carol, 'events/evt1/crew/crew2'), crewDoc('crew2')));
  });

  it('denies a stranger reading crew', async () => {
    await seedEvent();
    const mallory = testEnv.authenticatedContext('mallory').firestore();

    await assertFails(getDocs(collection(mallory, 'events/evt1/crew')));
  });

  it('accepts the on-location fields the apps set', async () => {
    await seedEvent();
    const alice = testEnv.authenticatedContext('alice').firestore();

    await assertSucceeds(
      updateDoc(doc(alice, 'events/evt1/crew/crew1'), { onLocation: true, onLocationAt: new Date() }),
    );
    await assertSucceeds(updateDoc(doc(alice, 'events/evt1/crew/crew1'), { checkpointId: null }));
  });

  it('refuses contact details or any other field (names only)', async () => {
    await seedEvent();
    const alice = testEnv.authenticatedContext('alice').firestore();

    await assertFails(setDoc(doc(alice, 'events/evt1/crew/crew2'), crewDoc('crew2', { phone: '07700 900000' })));
    await assertFails(updateDoc(doc(alice, 'events/evt1/crew/crew1'), { notes: 'call me' }));
  });

  it('refuses an empty or overlong name, a missing personId, or a mismatched id', async () => {
    await seedEvent();
    const alice = testEnv.authenticatedContext('alice').firestore();

    await assertFails(setDoc(doc(alice, 'events/evt1/crew/crew2'), crewDoc('crew2', { name: '' })));
    await assertFails(setDoc(doc(alice, 'events/evt1/crew/crew2'), crewDoc('crew2', { name: 'x'.repeat(81) })));
    const { personId: _, ...noPerson } = crewDoc('crew2');
    await assertFails(setDoc(doc(alice, 'events/evt1/crew/crew2'), noPerson));
    await assertFails(setDoc(doc(alice, 'events/evt1/crew/crew2'), crewDoc('crew3')));
    await assertFails(updateDoc(doc(alice, 'events/evt1/crew/crew1'), { onLocationAt: 'now' }));
  });
});
