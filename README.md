# Event Support Tracker — Firebase

Firestore security rules and indexes for Event Support Tracker. This is **backend
configuration shared by every client** — the iOS app, the Android app, and anything added
later — which is why it lives here rather than inside one of them.

Related repositories:

| Repo | Owns |
|---|---|
| `xcode/Event Support Tracker` | iOS app |
| `Android/EventSupportTracker` | Android app |
| `ConnectIQ/EventCheckpoint` | Garmin data field, and `protocol/PROTOCOL.md` — the canonical phone↔watch wire contract |
| **this one** | Firestore rules, indexes, and the data model both phones share |

## ⚠️ Deploying

The default project is **`demo-eventsupporttracker`**, which does not exist and is not
supposed to — the `demo-` prefix is Firebase's convention for a project that only ever runs
against emulators, and it stops a stray command reaching anything real. Production
(`eventtracker-a150e`) is a named alias, so deploying to it is always deliberate:

```bash
npm run deploy:prod          # firebase deploy --only firestore:rules,firestore:indexes --project prod
```

Never `firebase deploy` without `--project prod`, and never assume the working tree matches
what is live: until this repo existed, the rules lived **only in the Firebase Console**, so
the Console is still the authority for anything not yet committed here. Check before
deploying.

## Running the tests

```bash
npm install
npm test
```

`npm test` runs `firebase emulators:exec`, which starts a Firestore emulator, runs the suite
against the **real `firestore.rules`**, and shuts the emulator down again. Nothing touches a
live project and no state persists between runs.

Requires Node ≥ 20, a JDK (the Firestore emulator is a Java process), and the Firebase CLI:

```bash
npm install -g firebase-tools
```

Tests are plain `node --test` — no Jest or Vitest. Layout:

| File | Covers |
|---|---|
| `tests/users.test.mjs` | profile privacy, and the visible-user search that powers invitations |
| `tests/events.test.mjs` | ownership, the viewer/editor split, Pro-only deletion, the free-tier limit |
| `tests/access.test.mjs` | granting and revoking, and the collection-group query for shared events |
| `tests/checkpoints.test.mjs` | checkpoints and paces inherit the event's permissions |
| `tests/storage.test.mjs` | GPX files in Cloud Storage, whose permissions come from Firestore |

`tests/helpers.mjs` holds the fixture document shapes. **Keep them in step with the DTOs** —
`UserDTO`, `EventDTO`, `AccessDTO` on iOS and their Android equivalents. A fixture that has
drifted from what the apps really write makes every test in the file a fiction.

## Known problems these tests pin

Found while writing them. All three are app-side; the rules behave as written.

### 1. Editors cannot edit anything

The rules compare `userRole(eventId) == "editor"`. The iOS app stores the role as a
**localised display string** — `AccessControlView.swift:111` writes `L10n.event_access_viewer`,
and the role picker (line 66) is built from `[event_access_viewer, event_access_editor,
event_access_owner]`. So an English user writes `"Editor"` and a German user writes
`"Bearbeiter"`. Neither equals `"editor"`, so **no editor can write to a shared event in any
language**. The model comments (`EventAccess.swift:21`, `AccessDTO.swift:13`) all say the
stored value should be lowercase, and `AccessControlView.swift:25` displays it with
`.capitalized`, so the intent was clearly a stable lowercase token.

Fix on the app side: store `"owner"` / `"editor"` / `"viewer"` and localise only at display.
Note that `SyncService.swift:757` already works around the capitalisation with `.lowercased()`
— that hides the English case but not the localised one. Existing access documents in
production will need migrating.

### 2. `eventCount` is deleted behind the rules' back

`allow create` on an event consults `userDoc().data.eventCount` to enforce the free-tier
limit. `SyncService.swift:571/580` maintains that field with `FieldValue.increment`, but
`UserDTO` has no `eventCount` property and `FirestoreService.saveUser` writes the whole
document with `setData(from:)` and no merge — so **every profile save wipes it**, and the rule
then reads a missing field as zero. A free user can reset their own allowance by editing their
profile. Fix with a merge write, or by moving the counter out of the user document.

### 3. The rules allow two free events, the app allows one

`userEventCount() <= 1` permits a create when the user already has one event.
`SubscriptionManager.canCreateEvent` is `isProUser || eventCount < 1`. The client limit is the
one users meet; the server limit is the only one an attacker has to beat. Pick one.

## Also worth knowing

- **Cloud Storage did not exist until 10 Aug 2026.** The project had no bucket at all, so
  every GPX upload the app had ever attempted failed silently — `GPXService.importGPX` treats
  the upload as best-effort and only logs a warning. None of the 41 events had a
  `gpxStoragePath` set. The bucket
  (`eventtracker-a150e.firebasestorage.app`, Standard, regional, Europe) now exists and
  `storage.rules` here governs it. GPX files therefore sync and reach shared viewers for the
  first time; `GPXService.trackPoints`' download fallback had never been able to fire.
- **Storage permissions live in Firestore.** `storage.rules` calls `firestore.get()` against
  the same `events/{id}/access/{uid}` documents, so there is one access model rather than two
  that can drift. It costs a document read per storage operation, which is the right trade for
  an operation that happens once per import and once per viewer.
- `match /events { allow list: if isSignedIn(); }` (firestore.rules:94) looks inert —
  Firestore evaluates rules against document paths, and the per-document
  `match /events/{eventId}` block below already grants `list` behind `canReadCurrentEvent()`.
  Harmless as far as the tests can tell, but it reads as though it grants something it doesn't.
- The `!exists()` in `users` create and the `exists()` in `users` update are both redundant:
  Firestore already routes a write to `create` or `update` based on whether the document is
  there. Harmless, and arguably good documentation of intent.
- Every `canWrite` costs two document reads (the event and the access doc) on top of the write.
  Worth remembering when reading the billing.

## Data model

```
users/{uid}                                  profile; uid == Firebase Auth uid
events/{eventId}                             ownerUserId is the authority for ownership
events/{eventId}/access/{uid}                id field == uid (the collection-group query needs it)
events/{eventId}/checkpoints/{detailId}
events/{eventId}/paces/{paceId}
```

Distances are canonical **metres** and paces **seconds per kilometre** as of schema v2; the
legacy display-unit fields are still written alongside them until Android ships its own v2
update. See the iOS repo's `CLAUDE.md` for the full migration story.
