'use strict';
/**
 * Cloud Functions for Event Support Tracker. Pro migration stage 1: the server keeps
 * users/{uid}.ownedEventCount (see counts.js). Pro itself comes from the RevenueCat Firebase
 * extension's custom claim, which is installed separately (README, "Pro migration").
 *
 * Deploy only with an explicit project: `npm run deploy:develop:functions`.
 */
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineString } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { ownersToRecount, recountOwnedEvents } = require('./counts');

initializeApp();

// A Firestore trigger has to run where the database is. That differs per project, so it is a
// deploy-time parameter read from functions/.env.<alias> (FIRESTORE_REGION=...). It has no
// default: if the file doesn't set it, the CLI stops and asks rather than guessing. (A plain
// process.env read doesn't work here: .env values aren't loaded while the CLI analyses the code.)
const firestoreRegion = defineString('FIRESTORE_REGION', {
  description: "Region for the Firestore trigger: the database's region, or for a multi-region " +
    'database a region inside it (eur3 → europe-west1).',
});

exports.recountOwnedEvents = onDocumentWritten(
  { document: 'events/{eventId}', region: firestoreRegion },
  async (event) => {
    const before = event.data && event.data.before.exists ? event.data.before.data() : null;
    const after = event.data && event.data.after.exists ? event.data.after.data() : null;
    for (const uid of ownersToRecount(before, after)) {
      const result = await recountOwnedEvents(getFirestore(), uid);
      logger.info('ownedEventCount', { eventId: event.params.eventId, ...result });
    }
  }
);
