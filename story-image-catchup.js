// Standalone script, NOT part of the running server process. Meant to be
// invoked by cron several times a day, well after story-scheduler.js (3:00,
// generates the day's image) and story-beat-scheduler.js (3:15, sends the
// day's message with that image attached if one exists).
//
// Why this exists: image generation (a Codex CLI call on NPN-Yoga, see
// dev-workflow-and-infra-notes.md) fails now and then - a codex exec that
// hangs past its time limit, the host asleep, etc. - and story-scheduler.js
// only ever tries once at 3am (plus one quick retry). When that happens the
// day's message goes out text-only. This script is the safety net: if any of
// today's story-beat messages is still missing its image, it tries again,
// and once an image exists it attaches it to those SAME messages in place
// (no second message), updating any open chat live via /internal/attach-media
// (see notify-live.js's attachMediaLive).
//
// Cheap when there's nothing to do (one Mongo query, no bridge call), so it
// is safe to run often. Only reaches out to the image host when a message is
// actually missing its image.
//
// Usage: node story-image-catchup.js   (run from the project root via cron)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { MongoClient } = require('mongodb');

const storyArc = require('./story-arc');
const storyImage = require('./story-image');
const { attachMediaLive } = require('./notify-live');
const { todayKey } = require('./special-dates');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'petchat';

async function main() {
  const now = new Date();
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(DB_NAME);
  const messagesCollection = db.collection('messages');

  try {
    const today = todayKey(now);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // media: null matches both "field missing" and "stored as null" (the
    // driver writes an undefined media as null), i.e. sent text-only.
    const missing = await messagesCollection
      .find({ storyBeat: true, createdAt: { $gte: startOfToday }, media: null })
      .toArray();

    if (!missing.length) {
      console.log(`[image-catchup] ${today}: every story-beat message already has its image (or none were sent) - nothing to do.`);
      return;
    }

    console.log(`[image-catchup] ${today}: ${missing.length} story-beat message(s) still missing today's image.`);

    const arcState = await storyArc.getArcState(db.collection('storyArc'));
    let restingBeatText = null;
    if (arcState.phase === 'resting') {
      const restingBeatDoc = await db.collection('dailyRestingBeat').findOne({ dateKey: today });
      if (!restingBeatDoc) {
        console.log('[image-catchup] arc is resting but no beat is cached for today - cannot generate an image for it.');
        return;
      }
      restingBeatText = restingBeatDoc.text;
    }

    // Idempotent: returns the existing dailyStoryImage doc if one is already
    // there, otherwise asks the bridge (with its built-in retry) and caches
    // the result for everyone.
    const imageDoc = await storyImage.getOrGenerateTodaysStoryImage(db, arcState, now, { restingBeatText });
    if (!imageDoc) {
      console.log('[image-catchup] still no image - will try again on the next run.');
      return;
    }

    const media = { type: 'image', url: imageDoc.url };
    let attached = 0;
    for (const message of missing) {
      try {
        const result = await messagesCollection.updateOne({ _id: message._id, media: null }, { $set: { media } });
        if (!result.modifiedCount) continue; // someone else filled it in meanwhile
        await attachMediaLive({ userId: message.userId, messageId: message._id.toString(), media });
        attached += 1;
      } catch (err) {
        console.error(`[image-catchup] failed for message ${message._id}:`, err.message);
      }
    }
    console.log(`[image-catchup] attached ${imageDoc.url} to ${attached} message(s).`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('[image-catchup] fatal error:', err);
  process.exit(1);
});
