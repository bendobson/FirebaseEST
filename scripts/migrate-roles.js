#!/usr/bin/env node
/**
 * Rewrites access-document roles as canonical tokens.
 *
 * The apps used to store the role as a *localised display string* — the role picker was built
 * from the translated names and wrote the chosen one straight to Firestore. The security rules
 * compare against the token "editor", so an English user's "Editor" never matched and no
 * editor could write to a shared event, in any language.
 *
 * The apps now write tokens and heal what they see: when an event owner opens the sharing
 * screen, any non-canonical role on that event is rewritten. This script is the other half —
 * it fixes events whose owner never opens that screen. Both are idempotent.
 *
 * Usage:
 *   node scripts/migrate-roles.js --key /path/to/serviceAccountKey.json [--confirm]
 *
 * Dry run unless --confirm is passed.
 */

const admin = require("firebase-admin");
const path = require("path");

const args = process.argv.slice(2);
const keyFlag = args.indexOf("--key");
if (keyFlag === -1 || !args[keyFlag + 1]) {
  console.error("Usage: node scripts/migrate-roles.js --key /path/to/serviceAccountKey.json [--confirm]");
  process.exit(1);
}
const confirmed = args.includes("--confirm");

admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(args[keyFlag + 1]))) });
const db = admin.firestore();

// Must stay in step with EventRole.legacyAliases on iOS (and its Android twin). English needs
// no entries — lowercasing already reduces "Owner"/"Editor"/"Viewer", as it does Spanish
// "Editor".
const CANONICAL = ["owner", "editor", "viewer"];
const ALIASES = {
  eigentümer: "owner", herausgeber: "editor", betrachter: "viewer",          // de
  propietario: "owner", visor: "viewer",                                      // es
  propriétaire: "owner", éditeur: "editor", visionneuse: "viewer",            // fr
  proprietario: "owner", editore: "editor", visualizzatore: "viewer",         // it
};

/// Returns the canonical token, or null when the value can't be recognised — in which case the
/// document is left alone and reported. Guessing would risk promoting somebody.
function canonicalise(stored) {
  if (typeof stored !== "string") return null;
  const key = stored.trim().toLowerCase();
  if (CANONICAL.includes(key)) return key;
  return ALIASES[key] || null;
}

async function main() {
  const dryRun = !confirmed;
  const snap = await db.collectionGroup("access").get();

  const already = [];
  const toFix = [];
  const unknown = [];

  for (const doc of snap.docs) {
    const stored = doc.data().role;
    const target = canonicalise(stored);
    if (target === null) unknown.push({ ref: doc.ref, stored });
    else if (stored === target) already.push(doc.ref);
    else toFix.push({ ref: doc.ref, stored, target });
  }

  console.log(`access documents:      ${snap.size}`);
  console.log(`  already canonical:   ${already.length}`);
  console.log(`  to rewrite:          ${toFix.length}`);
  console.log(`  unrecognised:        ${unknown.length}\n`);

  for (const { ref, stored, target } of toFix) {
    console.log(`  ${dryRun ? "[DRY RUN] would rewrite" : "rewrote"} ${ref.path}: "${stored}" → "${target}"`);
  }

  for (const { ref, stored } of unknown) {
    console.log(`  ⚠️  left alone, unrecognised role ${JSON.stringify(stored)} at ${ref.path}`);
  }

  if (!dryRun && toFix.length > 0) {
    // Firestore caps a batch at 500 writes.
    for (let i = 0; i < toFix.length; i += 500) {
      const batch = db.batch();
      for (const { ref, target } of toFix.slice(i, i + 500)) {
        batch.update(ref, { role: target });
      }
      await batch.commit();
    }
    console.log(`\nRewrote ${toFix.length} document(s).`);
  } else if (dryRun && toFix.length > 0) {
    console.log("\nNothing was changed. Re-run with --confirm to apply.");
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
