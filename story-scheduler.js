// Standalone script, NOT part of the running server process. Meant to be
// invoked by cron once a day (unlike nudge-scheduler.js's 30-minute cadence
// - the story only needs to move at most once per day).
//
// Advances the Dino-Day story arc state machine if it's due (see
// story-arc.js). Doesn't talk to Claude or send any messages itself -
// persona.js reads the resulting arc state fresh on every chat turn/nudge
// and weaves it into the system prompt, so the *conversation* is what
// actually narrates the story; this script just moves the clock forward.
//
// Usage: node story-scheduler.js   (run from the project root, e.g. via cron, once daily)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { MongoClient } = require('mongodb');
const storyArc = require('./story-arc');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'petchat';

async function main() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(DB_NAME);
  const storyArcCollection = db.collection('storyArc');

  try {
    const before = await storyArc.getArcState(storyArcCollection);
    const after = await storyArc.advanceArcIfDue(storyArcCollection);
    if (before.phase !== after.phase) {
      console.log(`[story] arc advanced: "${before.phase}" -> "${after.phase}"`, after);
    } else {
      console.log(`[story] no phase change (still "${after.phase}").`);
    }
  } finally {
    await client.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[story] fatal error:', err);
    process.exit(1);
  });
