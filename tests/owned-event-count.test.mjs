//
//  functions/counts.js: the server's count of the events each user owns (Pro migration stage 1).
//  Runs the trigger's own logic with the Admin SDK against the Firestore emulator that
//  `npm test` starts; the Functions emulator isn't needed to test what the trigger decides.
//
import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { PROJECT_ID, userDoc, eventDoc } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { ownersToRecount, recountOwnedEvents } = require('../functions/counts.js');

describe('ownersToRecount', () => {
  it('counts the owner on create and on delete', () => {
    assert.deepEqual(ownersToRecount(null, { ownerUserId: 'alice' }), ['alice']);
    assert.deepEqual(ownersToRecount({ ownerUserId: 'alice' }, null), ['alice']);
  });

  it('skips an ordinary edit, which is every app save', () => {
    assert.deepEqual(ownersToRecount({ ownerUserId: 'alice', name: 'a' }, { ownerUserId: 'alice', name: 'b' }), []);
  });

  it('counts both sides of an ownership change (the apps\' account-switch rewrite)', () => {
    assert.deepEqual(ownersToRecount({ ownerUserId: 'alice' }, { ownerUserId: 'bob' }), ['alice', 'bob']);
  });

  it('ignores a missing or empty owner', () => {
    assert.deepEqual(ownersToRecount(null, { name: 'no owner' }), []);
    assert.deepEqual(ownersToRecount({ ownerUserId: '' }, { ownerUserId: 'bob' }), ['bob']);
  });
});

describe('recountOwnedEvents', () => {
  let app;
  let db;

  before(() => {
    app = initializeApp({ projectId: PROJECT_ID }, 'owned-event-count');
    db = getFirestore(app);
  });
  after(async () => { await deleteApp(app); });
  beforeEach(async () => {
    for (const col of ['users', 'events']) {
      const snap = await db.collection(col).get();
      await Promise.all(snap.docs.map((d) => d.ref.delete()));
    }
  });

  it('stores the number of events the user owns, and leaves the apps\' eventCount alone', async () => {
    await db.doc('users/alice').set(userDoc({ eventCount: 7 }));
    await db.doc('events/e1').set(eventDoc('alice'));
    await db.doc('events/e2').set(eventDoc('alice'));
    await db.doc('events/e3').set(eventDoc('bob'));

    assert.deepEqual(await recountOwnedEvents(db, 'alice'), { uid: 'alice', count: 2, written: true });
    const user = (await db.doc('users/alice').get()).data();
    assert.equal(user.ownedEventCount, 2);
    assert.equal(user.eventCount, 7);
  });

  it('counts down to zero after the last delete', async () => {
    await db.doc('users/alice').set(userDoc({ ownedEventCount: 1 }));
    assert.deepEqual(await recountOwnedEvents(db, 'alice'), { uid: 'alice', count: 0, written: true });
    assert.equal((await db.doc('users/alice').get()).get('ownedEventCount'), 0);
  });

  it('does not write when the count is already right', async () => {
    await db.doc('users/alice').set(userDoc({ ownedEventCount: 1 }));
    await db.doc('events/e1').set(eventDoc('alice'));
    assert.equal((await recountOwnedEvents(db, 'alice')).written, false);
  });

  it('never creates a user doc (no orphan docs for deleted accounts)', async () => {
    await db.doc('events/e1').set(eventDoc('ghost'));
    assert.deepEqual(await recountOwnedEvents(db, 'ghost'), { uid: 'ghost', count: 1, written: false });
    assert.equal((await db.doc('users/ghost').get()).exists, false);
  });
});
