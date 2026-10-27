//
//  Shared setup for the rules tests.
//
//  Every test runs against the Firestore emulator with the real firestore.rules loaded, so
//  these are genuine rule evaluations — not a model of them. `npm test` starts and stops the
//  emulator around the run via `firebase emulators:exec`.
//
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';

const here = dirname(fileURLToPath(import.meta.url));

/// Must match .firebaserc's default. The `demo-` prefix is what tells the Firebase SDKs never
/// to reach for real credentials, so a misconfigured test can't touch production.
export const PROJECT_ID = 'demo-eventsupporttracker';

export async function makeTestEnv() {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(join(here, '..', 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
    // Loaded for every test env, not just the storage tests: storage.rules calls
    // firestore.get(), so the two emulators have to be able to see each other.
    storage: {
      rules: readFileSync(join(here, '..', 'storage.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 9199,
    },
  });
}

/// Writes fixture data with the rules switched off. Seeding through the rules would mean the
/// setup is doing half the assertion, and a rule change would break tests for the wrong reason.
export async function seed(testEnv, fn) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await fn(context.firestore());
  });
}

// ─── Document shapes ─────────────────────────────────────────────────────────
// These mirror the DTOs the apps actually write. Keep them in step with
// UserDTO / EventDTO / AccessDTO on iOS (and their Android equivalents).

export function userDoc(overrides = {}) {
  return {
    name: 'Test User',
    email: 'test@example.com',
    phone: '',
    username: 'testuser',
    isGuest: false,
    isProUser: false,
    profileVisible: false,
    ...overrides,
  };
}

export function eventDoc(ownerUserId, overrides = {}) {
  return {
    name: 'Test Event',
    dateTime: new Date('2026-06-01T08:00:00Z'),
    location: 'Sunderland',
    ownerUserId,
    category: 'running',
    ...overrides,
  };
}

/// `id` must equal the uid — the collection-group rule at the bottom of firestore.rules
/// filters on `resource.data.id`, because a list query can't see the path wildcard.
export function accessDoc(uid, role, overrides = {}) {
  return {
    id: uid,
    username: `user-${uid}`,
    role,
    ...overrides,
  };
}

export function checkpointDoc(overrides = {}) {
  return {
    stopName: 'CP 1',
    stopNumber: 1,
    createdBy: 'someone',
    ...overrides,
  };
}

/// Pro user docs for each uid. Shared events, sharing and GPX are Pro in the rules (as in the
/// apps), so tests about roles make their members Pro; the free cases have their own tests
/// in audit.test.mjs.
export async function proUsers(db, ...uids) {
  for (const uid of uids) {
    await setDoc(doc(db, `users/${uid}`), userDoc({ isProUser: true, username: uid }));
  }
}
