#!/usr/bin/env node
/**
 * READ-ONLY. How unique are usernames today? (16 Nov 2026; the fix is planned for 1.13.4.)
 *
 * Nothing enforces a unique username: not the apps (iOS dropped its unused check in March
 * 2026, Android never had one) and not the rules. Invite search shows usernames only, so two
 * accounts with one name can't be told apart there. 1.13.4 adds `usernames/{lower-case name}`
 * docs, which the rules can check; this report says how much existing data that has to settle
 * first, and whether every current username can be a document id.
 *
 * Usernames are compared trimmed and lower-cased, the key the fix will use ("Bossen" and
 * "bossen" collide).
 *
 * Reports:
 *   1. Duplicate usernames: each group with, per account, guest/registered, visibility (in
 *      invite search), owned events, and the Auth user's created / last sign-in dates.
 *      "case only" marks a group whose spellings differ only in case.
 *   2. Registered accounts whose username is missing, empty, or still a guest's (guest-…).
 *   3. Usernames that can't be a Firestore document id as they stand ("/", ".", "..",
 *      __…__, over 1,500 bytes) or that have spaces at either end.
 *   4. userDirectory entries whose username differs from the profile's.
 *   5. Profiles with no Auth user, and Auth users (not anonymous) with no profile — the
 *      half-deleted accounts the 1.13.3 delete fix leaves no more of.
 *
 * Prints uids and usernames, never emails or phone numbers. Writes nothing. Usage:
 *   node scripts/check-usernames.js --key /path/to/serviceAccountKey.json
 */

const admin = require("firebase-admin");
const path = require("path");

const args = process.argv.slice(2);
const keyFlag = args.indexOf("--key");
if (keyFlag === -1 || !args[keyFlag + 1]) {
  console.error("Usage: node scripts/check-usernames.js --key /path/to/key.json");
  process.exit(1);
}
const key = require(path.resolve(args[keyFlag + 1].replace(/^~/, process.env.HOME)));
const PROJECTS = ["est-develop", "eventtracker-a150e"];
if (!PROJECTS.includes(key.project_id)) {
  console.error(`This key is for "${key.project_id}". This runs on ${PROJECTS.join(" and ")} only.`);
  process.exit(1);
}
console.log(`Project: ${key.project_id} (read-only)\n`);
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const normalise = (u) => u.trim().toLowerCase();
const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : "—");
const isGuestName = (u) => /^guest-/i.test(u);

/** Why `name` can't be a document id as it stands, or null. */
function idProblem(name) {
  if (name.includes("/")) return 'contains "/"';
  if (name === "." || name === "..") return 'is "." or ".."';
  if (/^__.*__$/.test(name)) return "is __reserved__";
  if (Buffer.byteLength(name, "utf8") > 1500) return "over 1,500 bytes";
  return null;
}

async function allAuthUsers() {
  const users = new Map();
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    page.users.forEach((u) => users.set(u.uid, u));
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

async function main() {
  const [usersSnap, dirSnap, eventsSnap, auth] = await Promise.all([
    db.collection("users").get(),
    db.collection("userDirectory").get(),
    db.collection("events").get(),
    allAuthUsers(),
  ]);

  const owned = new Map();
  eventsSnap.forEach((d) => {
    const o = d.get("ownerUserId");
    if (o) owned.set(o, (owned.get(o) ?? 0) + 1);
  });
  const directory = new Map();
  dirSnap.forEach((d) => directory.set(d.id, d.get("username")));

  const groups = new Map();
  const badRegistered = [];
  const badIds = [];
  const dirMismatch = [];
  const noAuth = [];
  let guests = 0;

  usersSnap.forEach((d) => {
    const data = d.data();
    const uid = d.id;
    const authUser = auth.get(uid);
    const guest = data.isGuest === true || authUser?.providerData.length === 0;
    if (guest) guests += 1;
    if (!authUser) noAuth.push(`${uid} (${JSON.stringify(data.username ?? null)})`);

    const username = data.username;
    if (typeof username !== "string" || username.trim() === "") {
      if (!guest) badRegistered.push(`${uid}: username ${JSON.stringify(username ?? null)}`);
      return;
    }
    if (!guest && isGuestName(username)) badRegistered.push(`${uid}: registered but still "${username}"`);
    const problem = idProblem(normalise(username));
    if (problem) badIds.push(`${uid}: ${JSON.stringify(username)} ${problem}`);
    if (username !== username.trim()) badIds.push(`${uid}: ${JSON.stringify(username)} has spaces at an end`);

    if (directory.has(uid) && directory.get(uid) !== username) {
      dirMismatch.push(`${uid}: profile "${username}", directory "${directory.get(uid)}"`);
    }

    const k = normalise(username);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({
      uid,
      username,
      guest,
      visible: directory.has(uid),
      events: owned.get(uid) ?? 0,
      created: authUser?.metadata.creationTime,
      lastIn: authUser?.metadata.lastSignInTime,
      noAuth: !authUser,
    });
  });

  const profileIds = new Set(usersSnap.docs.map((d) => d.id));
  const noProfile = [...auth.values()]
    .filter((u) => u.providerData.length > 0 && !profileIds.has(u.uid))
    .map((u) => `${u.uid} (created ${day(u.metadata.creationTime)}, last sign-in ${day(u.metadata.lastSignInTime)})`);

  const dupes = [...groups.entries()].filter(([, members]) => members.length > 1);

  console.log(`${usersSnap.size} profiles (${usersSnap.size - guests} registered, ${guests} guest), `
    + `${auth.size} Auth users, ${dirSnap.size} in userDirectory, ${eventsSnap.size} events\n`);

  console.log(`1. Duplicate usernames: ${dupes.length} group(s), `
    + `${dupes.reduce((n, [, m]) => n + m.length, 0)} account(s)`);
  for (const [k, members] of dupes) {
    const spellings = new Set(members.map((m) => m.username));
    const caseOnly = spellings.size > 1 ? "  (case only)" : "";
    const inSearch = members.filter((m) => m.visible).length;
    console.log(`  "${k}"${caseOnly}, ${inSearch} of ${members.length} in invite search`);
    members
      .sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""))
      .forEach((m) => console.log(
        `    ${m.uid}  "${m.username}"  ${m.guest ? "guest" : "registered"}`
        + `${m.visible ? ", visible" : ", hidden"}, ${m.events} event(s), `
        + (m.noAuth ? "NO AUTH USER" : `created ${day(m.created)}, last sign-in ${day(m.lastIn)}`),
      ));
  }

  const report = (title, rows) => {
    console.log(`\n${title}: ${rows.length}`);
    rows.forEach((r) => console.log(`  ${r}`));
  };
  report("2. Registered accounts without a username of their own", badRegistered);
  report("3. Usernames that can't be a document id as they stand", badIds);
  report("4. userDirectory username differs from the profile", dirMismatch);
  report("5a. Profiles with no Auth user", noAuth);
  report("5b. Registered Auth users with no profile", noProfile);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
