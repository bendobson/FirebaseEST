'use strict';
/**
 * Cloud Functions for Event Support Tracker. Pro migration stage 1: the server keeps
 * users/{uid}.ownedEventCount (see counts.js). Pro itself comes from the RevenueCat Firebase
 * extension's custom claim, which is installed separately (README, "Pro migration").
 *
 * Deploy only with an explicit project: `npm run deploy:develop:functions`.
 */
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { ownersToRecount, recountOwnedEvents } = require('./counts');

initializeApp();

// A Firestore trigger has to run in the database's own location. That isn't recorded anywhere
// in these repos, so it is set per project in functions/.env.<alias> (FIRESTORE_REGION=...),
// read from the Console (Firestore → Database → Location). No default: guessing wrong fails the
// deploy at best.
const region = process.env.FIRESTORE_REGION;
if (!region && process.env.FUNCTIONS_EMULATOR !== 'true') {
  throw new Error('FIRESTORE_REGION is not set: add it to functions/.env.<project alias>');
}

exports.recountOwnedEvents = onDocumentWritten(
  { document: 'events/{eventId}', region: region || 'europe-west2' },
  async (event) => {
    const before = event.data && event.data.before.exists ? event.data.before.data() : null;
    const after = event.data && event.data.after.exists ? event.data.after.data() : null;
    for (const uid of ownersToRecount(before, after)) {
      const result = await recountOwnedEvents(getFirestore(), uid);
      logger.info('ownedEventCount', { eventId: event.params.eventId, ...result });
    }
  }
);
