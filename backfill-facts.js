// One-off / occasional recovery tool: rebuilds a user's persistent facts
// list (see claude-bridge.js's extractFacts and server.js's
// extractAndSaveUserFacts) from their FULL message history in MongoDB,
// instead of only what a live chat picks up going forward from here.
//
// Use this:
//   - once, for any existing user, right after this feature ships (nothing
//     was extracted retroactively - their history sits in MongoDB but
//     hasn't been scanned yet)
//   - any time a user's facts look thin or wrong compared to what they've
//     actually told the pet (e.g. the Claude CLI session compacted or
//     reset before this feature existed to catch what was said)
//
// Usage:
//   node backfill-facts.js <username>
//   node backfill-facts.js --all

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

async function backfillOneUser(usersCollection, messagesCollection, user) {
  const userId = user._id.toString();
  const history = await messagesCollection.find({ userId }).sort({ createdAt: 1 }).toArray();
  if (!history.length) {
    console.log(`${user.username}: no messages on file, skipping.`);
    return;
  }

  let facts = user.facts || [];
  let selfFacts = user.selfFacts || [];
  const chunks = chunk(history, CHUNK_SIZE);
  console.log(`${user.username}: ${history.length} message(s) in ${chunks.length} chunk(s)...`);

  for (const [i, batch] of chunks.entries()) {
    const transcript = batch.map((m) => `${m.role === 'user' ? 'User' : 'Pet'}: ${m.text}`).join('\n');
    const { facts: newFacts, selfFacts: newSelfFacts } = await extractFacts({
      existingFacts: facts,
      existingSelfFacts: selfFacts,
      transcript,
      cwd: CLAUDE_CWD,
    });
    if (newFacts.length) facts = mergeFacts(facts, newFacts);
    if (newSelfFacts.length) selfFacts = mergeFacts(selfFacts, newSelfFacts);
    if (newFacts.length || newSelfFacts.length) {
      console.log(`  chunk ${i + 1}/${chunks.length}: +${newFacts.length} fact(s), +${newSelfFacts.length} self-fact(s)`);
    } else {
      console.log(`  chunk ${i + 1}/${chunks.length}: nothing new`);
    }
  }

  await usersCollection.updateOne({ _id: user._id }, { $set: { facts, selfFacts } });
  console.log(`${user.username}: saved ${facts.length} fact(s) about them, ${selfFacts.length} self-fact(s) about the pet.`);
  facts.forEach((f, idx) => console.log(`  fact ${idx + 1}. ${f}`));
  selfFacts.forEach((f, idx) => console.log(`  self-fact ${idx + 1}. ${f}`));
}

async function main() {
  const [, , arg] = process.argv;
  if (!arg) {
    console.error('Usage:\n  node backfill-facts.js <username>\n  node backfill-facts.js --all');
    process.exit(1);
  }

  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(DB_NAME);
  const usersCollection = db.collection('users');
  const messagesCollection = db.collection('messages');

  try {
    if (arg === '--all') {
      const users = await usersCollection.find({}).toArray();
      for (const user of users) {
        await backfillOneUser(usersCollection, messagesCollection, user);
      }
    } else {
      const user = await usersCollection.findOne({ username: arg.trim().toLowerCase() });
      if (!user) {
        console.error(`No user found with username "${arg}". Run "node admin.js users" to see who exists.`);
        process.exit(1);
      }
      await backfillOneUser(usersCollection, messagesCollection, user);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('backfill-facts.js failed:', err.message);
  process.exit(1);
});
