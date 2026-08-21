// One-off CLI script to create or update a login for the chat app.
// Usage: node create-user.js <username> <password>
// There is no public sign-up page on purpose - accounts are created this way.

const { MongoClient } = require('mongodb');
const { hashPassword } = require('./auth');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'petchat';

async function main() {
  const [, , usernameRaw, password] = process.argv;
  if (!usernameRaw || !password) {
    console.error('Usage: node create-user.js <username> <password>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }
  const username = usernameRaw.trim().toLowerCase();

  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(DB_NAME);
  const users = db.collection('users');

  const passwordHash = await hashPassword(password);
  const existing = await users.findOne({ username });

  if (existing) {
    await users.updateOne({ username }, { $set: { passwordHash } });
    console.log(`Updated password for existing user "${username}".`);
  } else {
    await users.insertOne({
      username,
      passwordHash,
      claudeSessionId: null,
      hasClaudeSession: false,
      createdAt: new Date(),
    });
    console.log(`Created new user "${username}".`);
  }

  await client.close();
}

main().catch((err) => {
  console.error('Failed to create user:', err.message);
  process.exit(1);
});
