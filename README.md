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
against emulators, and it stops a stray command reaching anything real. The two real projects
are named aliases, so deploying to either is always deliberate:

```bash
npm run deploy:develop       # est-develop: testers, the develop app builds and the web planner
npm run deploy:prod          # eventtracker-a150e: live
```

Both deploy Firestore rules, Firestore indexes and Storage rules. Deploy to develop first,
test with the develop builds, then live.

Never `firebase deploy` without `--project`, and never assume the working tree matches
what is live: until this repo existed, the rules lived **only in the Firebase Console**, so
the Console is still the authority for anything not yet committed here. Check before
deploying.

### `main` and live match (since 5 Nov 2026)

Live (`eventtracker-a150e`) now runs what `main` holds: the audited rules, crew (#2), and Pro
migration stage 1 (#3): rules, the `recountOwnedEvents` function, the RevenueCat extension and the
`ownedEventCount` backfill. Before the deploy, live's rules were compared with the repo: they were
exactly `118ef96` (Firestore) and `3897872` (Storage), so nothing existed only in the Console.

Checked on live, 5 Nov 2026: the Pro claim on a promotional grant; `ownedEventCount` following a
create and a delete; a shared event and a GPX route opening on the live 1.12.x app. Data first:
`reconcile-event-counts.js` (15 users, 3 free users unblocked) and `migrate-roles.js` (6 docs,
case only).

What the live go-live taught, for next time:
- Deploy rules with `firebase deploy --only firestore:rules,storage --project prod` when the
  indexes haven't been compared with live; `npm run deploy:prod` includes them.
- The first 2nd-gen functions deploy fails with the Eventarc service-agent error; retry after a
  few minutes. The deploy also offers the image clean-up policy (1 day).
- For about half an hour after the extension is installed, RevenueCat sends the old API version
  (`InvalidApiVersionError: 0.1.19 vs 0.1.18`) and its deliveries retry. They go through once
  RevenueCat catches up; nothing needs changing.
- The extension sets a claim only when RevenueCat sends an event. Subscribers from before 5 Nov
  2026 have no claim until their next renewal, so stage 3 (dropping the `isProUser` flag) waits
  for that, or for a script that sets their claims first.
- The Firebase Extensions service shuts down on 31 March 2027: move the claim to a function kit
  or our own function before then (Notion task, due 1 Feb 2027).

From now on, a change reaches live through the usual path: develop first, then live.

**12 Nov 2026: `userDirectory` (#4) on live.** Live's Firestore rules were compared with `main`
first (`850f67e`): identical apart from a trailing newline. `npm run deploy:prod` released the
rules; Storage was "already up to date" and the indexes were unchanged. Then
`backfill-user-directory.js` (dry run, then `--confirm`): 28 visible profiles listed. The `list`
rule on `/users` is still open: it closes once Android 1.13.0 searches the directory too, since
Android 1.13.0 (8) still searches `/users`.

**12 Nov 2026: Storage's two-document limit, and the Pro claim backfill.** A shared editor on
live got a 403 for a route on every app version. Storage rules may touch **at most two
Firestore documents per request**; for a shared user whose Pro was only the `users/{uid}` flag,
`gpx/` read needed three (event, access, user), so the request errored and was refused. The
emulator does not enforce the limit: `lets a viewer read the route` is exactly that case and
passes. Proven on the real server with `scripts/probe-storage-budget.js` (est-develop only):
flag only, 403; `--claim`, 200. Reading one document twice counts once.

The fix is the claim, not a rules change. With `revenueCatEntitlements` in the token, `isPro()`
never reads `users/{uid}`: an owner reads the event, a shared user the event and their access
doc. A reorder that read the access doc first was tried and dropped: 22 of 42 live events have
no access doc for their owner (Android, 1.12.x and 1.13.0, never writes one; iOS does), so
those owners would have gone over instead. `scripts/check-owner-access.js` (read-only) found
that, plus one false `owner` role (JCW D2) and three orphaned access docs, all on the
data-repair list.

`scripts/backfill-pro-claims.js` sets the claim from RevenueCat's API (a secret `sk_` key, read
from a file) for every user with the flag or a claim; only those, because RevenueCat's v1
`GET /subscribers` creates a customer for an unknown id. Run on live 12 Nov 2026: 6 asked
about, 2 set (pre-extension subscribers), 4 already right, 2 stale flags (not subscribed) left
without a claim. est-develop: nothing to change. Rerun it before Pro stage 3; it changes
nothing when everything is right. Any new Storage rule condition must stay within two
documents: check it with the probe, not the emulator.

**13 Nov 2026: live's test accounts deleted.** Testing has moved to est-develop, so the four
scratch accounts on live went with `scripts/delete-users.js` (new): 4 Auth users with their
`users` and `userDirectory` docs and RevenueCat customers, the 12 events they owned plus a
guest's test event "xx", 6 GPX files, 2 access docs on surviving events and 3 orphaned ones.
That clears the data-repair list from 12 Nov: the false `owner` role was on JCW D2 (deleted)
and the three orphaned access docs are gone. Live now holds 29 events and 1 GPX file. The run
was a dry run first, then `--confirm`, with the real account passed as `--protect`.

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
| `tests/crew.test.mjs` | crew: read with the event, write for Pro owners and editors, names only |
| `tests/pro-claim.test.mjs` | Pro from RevenueCat's claim or the doc flag; `ownedEventCount` is server-only |
| `tests/owned-event-count.test.mjs` | the server's event count (`functions/counts.js`), against the emulator |
| `tests/storage.test.mjs` | GPX files in Cloud Storage, whose permissions come from Firestore |

`tests/helpers.mjs` holds the fixture document shapes. **Keep them in step with the DTOs** —
`UserDTO`, `EventDTO`, `AccessDTO` on iOS and their Android equivalents. A fixture that has
drifted from what the apps really write makes every test in the file a fiction.

## `.mcp.json`

Configures the Firebase MCP server for anyone working in this repo. It moved here from the
iOS repo, where it had gone stale — it pins `FIRESTORE_EMULATOR_HOST`, and the emulator lives
here now, alongside the `firebase.json` the CLI needs.

The emulator pin is a **safety feature, not a leftover**: with it set the MCP server can only
ever reach the local emulator, so no amount of prompting can make it read or write production.
Anything that genuinely needs production goes through the admin scripts below, which take an
explicit `--key`.

## Admin scripts

All take `--key /path/to/serviceAccountKey.json`, and all deletions are a **dry run unless
`--confirm` is passed**. The key lives outside this repository — Admin SDK credentials bypass
the security rules entirely.

| Script | Does |
|---|---|
| `scripts/firestore-audit.js` | Reports Auth users, their documents and events, and the three kinds of debris: throwaway guests, orphan events, orphan user documents. Flags for cleaning each. |
| `scripts/migrate-roles.js` | Rewrites access-document roles as canonical tokens. See "Roles" below. |
| `scripts/reconcile-event-counts.js` | Sets each user's `eventCount` to the events they actually own. |
| `scripts/backfill-owned-event-counts.js` | Sets `ownedEventCount` for every existing user, once, after the function is deployed. |
| `scripts/export-users.js` | Email/name export of registered users. Output is personal data — gitignored. |
| `scripts/delete-users.js` | Deletes users outright: their events (GPX first, then every subcollection), their access on other events, `users`/`userDirectory`, RevenueCat customer (`--rc-key-file`) and Auth user. `--event`, `--orphan-access`, `--protect`. Prints who else loses an event before anything goes. |

Debris the audit looks for, and why each exists:

- **Throwaway guests** — anonymous, own nothing, signed in once. 126 removed on 2026-08-10.
- **Orphan events** — `ownerUserId` matches no Auth record.
- **Orphan user documents** — the mirror image, a `users/{uid}` with no Auth record. The likely
  source is a failed guest→registered migration: `AuthManager.createAccount` deletes the
  anonymous Auth account *first* (Firebase can only delete the signed-in user), and the
  Firestore cleanup happens later inside `migrateGuestUser`'s `try`, which swallows its errors.
  Only those owning no events are deleted automatically — one that still owns events would
  strand them, so it's reported for manual attention instead.

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
- **Cross-service rules need an IAM grant, and only in production.** Because `storage.rules`
  reaches into Firestore, the Firebase Rules service agent must hold
  `roles/firebaserules.firestoreServiceAgent` before any of those `firestore.get()` calls can
  run. Until it does, the Storage section of the Console shows *"Your rules make use of
  cross-service database calls, but your project is not configured to execute those calls"* and
  **every** GPX read and write is denied — which looks exactly like a rules bug and isn't one.
  Granted for `eventtracker-a150e` on 18 Aug 2026 via the Console banner's one-click fix; GPX
  files have stored correctly since.

  The emulators never check this, so `tests/storage.test.mjs` passes whether or not the grant
  exists. No test in this repo can catch its absence. If GPX suddenly stops working across the
  board, check the grant before reading the rules, and re-grant it on any new project.
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
                                             ownedEventCount: server-written (functions/), never by a client
events/{eventId}                             ownerUserId is the authority for ownership
events/{eventId}/access/{uid}                id field == uid (the collection-group query needs it)
events/{eventId}/checkpoints/{detailId}
events/{eventId}/paces/{paceId}
```

Distances are canonical **metres** and paces **seconds per kilometre** as of schema v2; the
legacy display-unit fields are still written alongside them until Android ships its own v2
update. See the iOS repo's `CLAUDE.md` for the full migration story.

## Pro migration, stage 1 (drafted 3 Nov 2026; on est-develop since 4 Nov, not live)

Notion: "Move Pro status and event count server-side, and add App Check". Today any signed-in
user can write their own `isProUser` and `eventCount`, and the rules trust both. Stage 1 adds
the server-side sources **without changing any app**; stage 2 (the 1.13.0 apps) reads them;
stage 3 removes the client-written ones.

What's in this repo:

- **Rules:** `isProUser()` (firestore.rules) and `isPro()` (storage.rules) are true for
  RevenueCat's custom claim **or** the doc flag. The claim is the extension's
  `revenueCatEntitlements` list containing the entitlement identifier
  `Event Support Tracker Pro` (as in both apps). Clients may no longer set or change
  `users/{uid}.ownedEventCount`. No app writes it, so nothing they do is refused.
- **`functions/`:** one Firestore trigger, `recountOwnedEvents`, on `events/{eventId}`. On a
  create, a delete or an `ownerUserId` change it recounts the owner's events into
  `users/{uid}.ownedEventCount`. That's a new field, so it never double-counts with the apps'
  `eventCount`. Ordinary edits cost nothing. It never creates a user doc.
- **`scripts/backfill-owned-event-counts.js`:** fills the field in for existing users.
- Tests for all of it (`npm test`; the trigger's logic runs against the Firestore emulator).

Not here: the planner reading the claim (planner repo), the apps (stage 2), stage 3's rules.

### Turning it on for est-develop (Ben; develop only)

1. **Blaze plan.** Extensions and functions need it. Check est-develop is on Blaze.
2. **Function region.** In the Console, read est-develop's Firestore location (Firestore →
   Database). Create `functions/.env.develop` with `FIRESTORE_REGION=<region>`.
   **Done for est-develop:** its database is `eur3` (multi-region Europe), so the file says
   `europe-west1`, which is inside eur3. The trigger
   must run where the database is: for a regional database use the same region; for a
   multi-region one use the region Firebase's "Cloud Firestore triggers → locations" docs
   name for it. It's a deploy-time parameter: without it the CLI stops and asks for a value.
3. **A RevenueCat project for develop.** Checked 4 Nov 2026: there is one RevenueCat project.
   It holds the Play, App Store and Web Billing apps and the debug builds' Test Store key, and
   it has no integrations. A Firebase integration covers a whole project, so develop gets a
   project of its own and the live project is left alone (it is connected to live Firebase
   when stage 1 goes live).
   - Create a new RevenueCat project, e.g. "Event Support Tracker (develop)". **Do not**
     touch the live project's apps or Web Billing config (the `rc-5f225a7f21` redemption
     scheme comes from it).
   - In it, add a **Test Store** app only. Create the entitlement with the identical
     **identifier** `Event Support Tracker Pro` (not a slug like `event_support_tracker_pro`:
     the identifier can't be renamed later, and it's what both the apps and the claim use), Test Store products for it, and a current
     offering, so the debug paywall has something to show.
   - Put the new `test_` key into the debug builds: Android `local.properties`
     `REVENUECAT_API_KEY_DEBUG` (back the file up first: it is gitignored), and the iOS
     debug configuration. Release keys don't change.
   - Develop accounts that were Pro through the old project aren't Pro in the new one.
     Re-grant them (promotional entitlement), then sign in again so the apps rewrite
     `isProUser`.
4. **RevenueCat extension.** Install "Enable In-App Purchases with RevenueCat"
   (`revenuecat/firestore-revenuecat-purchases`) on est-develop, from the Console's
   Extensions page. Settings: location `europe-west1`; custom claims **enabled**; leave the
   events collection, the customers collection and "Enable Events" **empty/off**. Only the
   claim is used, so no RevenueCat data is stored in Firestore. (If a collection is ever
   wanted, give it a name with no rule here, e.g. `revenuecat_customers`, so no client can
   read it.)
   Then, in the **develop** RevenueCat project, add the extension's URL and shared secret
   under Integrations → Firebase. Test Store purchases are sandbox events, so allow sandbox
   events if the integration offers the choice.
5. **Deploy:** `npm run deploy:develop` (rules), then `npm run deploy:develop:functions`.
   The first 2nd-gen deploy can fail with "Permission denied while using the Eventarc Service
   Agent": wait a few minutes and deploy again. Then stop old build images piling up:
   `firebase functions:artifacts:setpolicy --project develop --location europe-west1`.
6. **Backfill:** `node scripts/backfill-owned-event-counts.js --key <est-develop key>`
   (the key: Console → est-develop → Project settings → Service accounts → Generate new
   private key; keep it outside the repo; the script refuses any other project's key)
   (dry run), then again with `--confirm`.
7. **Check:**
   - Grant a develop user Pro in the develop RevenueCat project. After a token refresh, their ID token claims
     include `revenueCatEntitlements: ["Event Support Tracker Pro"]`. **Confirmed on
     est-develop, 4 Nov 2026:** the claim is a list of entitlement identifiers, set within
     seconds of the grant (plus `revenueCatEventTimestampMs`).
   - Create and delete an event. `ownedEventCount` follows, and the function logs show
     `ownedEventCount`.

A claim reaches a client only when its ID token refreshes (up to an hour, or forced). The
apps force a refresh after a purchase from stage 2. Until then the doc flag keeps them working.

## Free tier on the server's count (13 Nov 2026)

The event create rule's free-tier limit now reads `users/{uid}.ownedEventCount` (kept by
`recountOwnedEvents`; no client may write it), not the apps' `eventCount`:
`isProUser() || ownedEventCount < 1`, a missing count being 0. Why now, ahead of stage 3:
the 1.13 apps stop writing `eventCount` (Pro migration stage 2), so for their users it stayed
absent and the old rule let a free user create any number of events. It also drifted (the
5 Nov reconcile fixed 15 users, 3 of them locked out) and users could reset it themselves.

Nothing reads `eventCount` any more; 1.12.x apps still write it, harmlessly, and stage 3 can
refuse client writes of it. The count updates a moment after a create, so two creates within
that moment could both pass: accepted. A deleted account's replacement (a new uid) starts at
0, by design. Free users can't delete events (Pro), so their events outlive a deleted account
until the monthly orphan sweep (`firestore-audit.js --delete-orphan-events`).
Tests: `tests/events.test.mjs` ("Creating, and the free-tier limit"); both mutations (back to
`eventCount`, and `<= 1`) fail them.
