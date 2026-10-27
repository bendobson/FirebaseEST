//
//  GPX files in Cloud Storage.
//
//  The interesting property is that permission lives in Firestore, not on the object — these
//  rules call firestore.get() to consult the same events/{id}/access/{uid} documents the
//  Firestore rules use. So each test seeds Firestore and then acts on Storage.
//
import { before, after, beforeEach, describe, it } from 'node:test';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { ref, uploadBytes, getMetadata, deleteObject } from 'firebase/storage';
import { makeTestEnv, seed, eventDoc, accessDoc, proUsers } from './helpers.mjs';

const GPX = new Uint8Array(
  Buffer.from(`<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>
    <trkpt lat="54.9" lon="-1.6"><ele>10</ele></trkpt>
  </trkseg></trk></gpx>`)
);

describe('gpx/{eventId}.gpx', () => {
  let testEnv;

  before(async () => { testEnv = await makeTestEnv(); });
  after(async () => { await testEnv.cleanup(); });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.clearStorage();
  });

  const EVENT = 'E7B05764-15AE-439F-A8A0-7F825D5A81B7';
  const path = `gpx/${EVENT}.gpx`;

  async function seedEvent(access = {}) {
    await seed(testEnv, async (db) => {
      await setDoc(doc(db, `events/${EVENT}`), eventDoc('alice'));
      for (const [uid, role] of Object.entries(access)) {
        await setDoc(doc(db, `events/${EVENT}/access/${uid}`), accessDoc(uid, role));
      }
      await proUsers(db, 'alice', ...Object.keys(access));
    });
  }

  /// Puts a file in place without going through the rules, for the read/delete tests.
  async function seedFile() {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await uploadBytes(ref(context.storage(), path), GPX);
    });
  }

  // ─── Uploading ─────────────────────────────────────────────────────────────

  it('lets the event owner upload the route', async () => {
    await seedEvent();
    const alice = testEnv.authenticatedContext('alice').storage();
    await assertSucceeds(uploadBytes(ref(alice, path), GPX));
  });

  it('lets an editor upload the route', async () => {
    await seedEvent({ bob: 'editor' });
    const bob = testEnv.authenticatedContext('bob').storage();
    await assertSucceeds(uploadBytes(ref(bob, path), GPX));
  });

  it('denies a viewer uploading', async () => {
    await seedEvent({ bob: 'viewer' });
    const bob = testEnv.authenticatedContext('bob').storage();
    await assertFails(uploadBytes(ref(bob, path), GPX));
  });

  it('denies a stranger uploading', async () => {
    await seedEvent();
    const mallory = testEnv.authenticatedContext('mallory').storage();
    await assertFails(uploadBytes(ref(mallory, path), GPX));
  });

  it('denies an unauthenticated upload', async () => {
    await seedEvent();
    const anon = testEnv.unauthenticatedContext().storage();
    await assertFails(uploadBytes(ref(anon, path), GPX));
  });

  /// Nobody can park a file under an event id that doesn't exist — otherwise the bucket is
  /// free hosting for anyone with an account.
  it('denies uploading against an event that does not exist', async () => {
    const alice = testEnv.authenticatedContext('alice').storage();
    await assertFails(uploadBytes(ref(alice, 'gpx/00000000-0000-0000-0000-000000000000.gpx'), GPX));
  });

  // ─── Reading ───────────────────────────────────────────────────────────────

  /// The whole point of this work: a shared viewer has to be able to fetch the route, which
  /// is what GPXService.trackPoints' download fallback needs.
  it('lets a viewer read the route', async () => {
    await seedEvent({ bob: 'viewer' });
    await seedFile();
    const bob = testEnv.authenticatedContext('bob').storage();
    await assertSucceeds(getMetadata(ref(bob, path)));
  });

  it('lets the owner read the route', async () => {
    await seedEvent();
    await seedFile();
    const alice = testEnv.authenticatedContext('alice').storage();
    await assertSucceeds(getMetadata(ref(alice, path)));
  });

  it('denies a stranger reading the route', async () => {
    await seedEvent();
    await seedFile();
    const mallory = testEnv.authenticatedContext('mallory').storage();
    await assertFails(getMetadata(ref(mallory, path)));
  });

  it('denies an unauthenticated read', async () => {
    await seedEvent();
    await seedFile();
    const anon = testEnv.unauthenticatedContext().storage();
    await assertFails(getMetadata(ref(anon, path)));
  });

  // ─── Deleting ──────────────────────────────────────────────────────────────

  it('lets the owner delete the route', async () => {
    await seedEvent();
    await seedFile();
    const alice = testEnv.authenticatedContext('alice').storage();
    await assertSucceeds(deleteObject(ref(alice, path)));
  });

  it('denies a viewer deleting the route', async () => {
    await seedEvent({ bob: 'viewer' });
    await seedFile();
    const bob = testEnv.authenticatedContext('bob').storage();
    await assertFails(deleteObject(ref(bob, path)));
  });

  // ─── Everything else in the bucket ─────────────────────────────────────────

  it('denies writing outside the gpx prefix', async () => {
    await seedEvent();
    const alice = testEnv.authenticatedContext('alice').storage();
    await assertFails(uploadBytes(ref(alice, 'anything/else.bin'), GPX));
  });

  it('denies a non-.gpx name inside the gpx prefix', async () => {
    await seedEvent();
    const alice = testEnv.authenticatedContext('alice').storage();
    await assertFails(uploadBytes(ref(alice, `gpx/${EVENT}.zip`), GPX));
  });

  /// ⚠️ The same localised-role defect the Firestore rules have. Recorded here too, because
  /// uploading a corrected route is exactly what a shared editor would try to do.
  it('DOCUMENTS A BUG: the capitalised role the app writes cannot upload', async () => {
    await seedEvent({ bob: 'Editor' });
    const bob = testEnv.authenticatedContext('bob').storage();
    await assertFails(uploadBytes(ref(bob, path), GPX));
  });
});
