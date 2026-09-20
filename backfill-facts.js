// One-off / occasional recovery tool: rebuilds a user's persistent facts
// list (see claude-bridge.js's extractFacts and server.js's
// extractAndSaveUserFacts) from their message history in MongoDB, instead
// of only what a live chat picks up going forward from here.
//
// Use this:
//   - once, for any existing user, right after this feature ships (nothing
//     was extracted retroactively - their history sits in MongoDB but
//     hasn't been scanned yet)
//   - any time a user's facts look thin or wrong compared to what they've
//     actually told the pet (e.g. the Claude CLI session compacted or
//     reset before this feature existed to catch what was said, or a
//     background extraction call failed - see extractAndSaveUserFacts's
//     fail-open behavior in server.js)
//
// By default this rescans a user's ENTIRE history, which gets slower (and
// pricier, though still cheap - see FACTS_BUDGET_USD) the longer someone's
// been chatting, even though most of it was already scanned before and
// will just come back "nothing new". Pass --days N to only rescan messages
// from the last N days instead - e.g. to recover a specific recent gap
// without re-walking months of already-processed history. Either way, the
// existing facts/selfFacts/storyBeats on file are kept as the starting
// point and only added to/corrected, never wiped and rebuilt from zero.
//
// Usage:
//   node backfill-facts.js <username> [--days N]
//   node backfill-facts.js --all [--days N]

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const { MongoClient } = require('mongodb');
const { extractFacts, mergeFacts } = require('./claude-bridge');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'petchat';

// Same idea as server.js/admin.js: give the claude CLI its own empty
// scratch directory so it never picks up this repo's own files as context.
const CLAUDE_CWD = path.join(__dirname, '.claude-cwd');
if (!fs.existsSync(CLAUDE_CWD)) fs.mkdirSync(CLAUDE_CWD, { recursive: true });

// Keeps each extraction call's transcript to a manageable size for the
// model (and its own per-call budget) - a long history is processed in
// chronological chunks of this many messages rather than all at once, with
// facts found in earlier chunks fed forward so later chunks don't re-report
// them.
const CHUNK_SIZE = 40;

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

// Same idea as server.js's STORY_BEATS_CAP - keep this tighter than
// facts/selfFacts since it's meant to reflect what's recent, not pile up
// forever across a user's whole history.
const STORY_BEATS_CAP = 20;

async function backfillOneUser(usersCollection, messagesCollection, user, sinceDate) {
  const userId = user._id.toString();
  const query = sinceDate ? { userId, createdAt: { $gte: sinceDate } } : { userId };
  const history = await messagesCollection.find(query).sort({ createdAt: 1 }).toArray();
  if (!history.length) {
    console.log(
      `${user.username}: no messages on file${sinceDate ? ` since ${sinceDate.toISOString().slice(0, 10)}` : ''}, skipping.`
    );
    return;
  }

  let facts = user.facts || [];
  let selfFacts = user.selfFacts || [];
  let storyBeats = user.storyBeats || [];
  const chunks = chunk(history, CHUNK_SIZE);
  const windowNote = sinceDate ? ` since ${sinceDate.toISOString().slice(0, 10)}` : '';
  console.log(`${user.username}: ${history.length} message(s)${windowNote} in ${chunks.length} chunk(s)...`);

  for (const [i, batch] of chunks.entries()) {
    const transcript = batch.map((m) => `${m.role === 'user' ? 'User' : 'Pet'}: ${m.text}`).join('\n');
    const { facts: newFacts, selfFacts: newSelfFacts, storyBeats: newStoryBeats } = await extractFacts({
      existingFacts: facts,
      existingSelfFacts: selfFacts,
      existingStoryBeats: storyBeats,
      transcript,
      cwd: CLAUDE_CWD,
    });
    if (newFacts.length) facts = mergeFacts(facts, newFacts);
    if (newSelfFacts.length) selfFacts = mergeFacts(selfFacts, newSelfFacts);
    if (newStoryBeats.length) storyBeats = mergeFacts(storyBeats, newStoryBeats, STORY_BEATS_CAP);
    if (newFacts.length || newSelfFacts.length || newStoryBeats.length) {
      console.log(
        `  chunk ${i + 1}/${chunks.length}: +${newFacts.length} fact(s), +${newSelfFacts.length} self-fact(s), +${newStoryBeats.length} story beat(s)`
      );
    } else {
      console.log(`  chunk ${i + 1}/${chunks.length}: nothing new`);
    }
  }

  await usersCollection.updateOne({ _id: user._id }, { $set: { facts, selfFacts, storyBeats } });
  console.log(
    `${user.username}: saved ${facts.length} fact(s) about them, ${selfFacts.length} self-fact(s), ${storyBeats.length} story beat(s).`
  );
  facts.forEach((f, idx) => console.log(`  fact ${idx + 1}. ${f}`));
  selfFacts.forEach((f, idx) => console.log(`  self-fact ${idx + 1}. ${f}`));
  storyBeats.forEach((f, idx) => console.log(`  story beat ${idx + 1}. ${f}`));
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const daysFlagIndex = args.indexOf('--days');
  let days = null;
  if (daysFlagIndex !== -1) {
    const raw = args[daysFlagIndex + 1];
    days = Number(raw);
    if (!Number.isFinite(days) || days <= 0) {
      console.error(`--days must be a positive number, got "${raw}".`);
      process.exit(1);
    }
    args.splice(daysFlagIndex, 2);
  }
  const [target] = args;
  const sinceDate = days !== null ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;
  return { target, sinceDate };
}

async function main() {
  const { target, sinceDate } = parseArgs(process.argv);
  if (!target) {
    console.error('Usage:\n  node backfill-facts.js <username> [--days N]\n  node backfill-facts.js --all [--days N]');
    process.exit(1);
  }

  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(DB_NAME);
  const usersCollection = db.collection('users');
  const messagesCollection = db.collection('messages');

  try {
    if (target === '--all') {
      const users = await usersCollection.find({}).toArray();
      for (const user of users) {
        await backfillOneUser(usersCollection, messagesCollection, user, sinceDate);
      }
    } else {
      const user = await usersCollection.findOne({ username: target.trim().toLowerCase() });
      if (!user) {
        console.error(`No user found with username "${target}". Run "node admin.js users" to see who exists.`);
        process.exit(1);
      }
      await backfillOneUser(usersCollection, messagesCollection, user, sinceDate);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('backfill-facts.js failed:', err.message);
  process.exit(1);
});
