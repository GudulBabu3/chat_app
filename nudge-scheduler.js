// Standalone script, NOT part of the running server process.
// Meant to be invoked by cron every ~30 minutes. Each run: find users who
// are "due" for a check-in from TukuruMukuru, generate one via the same
// askPet() the live app uses, save it to their message history, and
// reschedule (or retire) their next check-in.
//
// Usage: node nudge-scheduler.js   (run from the project root, e.g. via cron)

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');

const { loadProfile, buildSystemPrompt } = require('./persona');
const { askPet } = require('./claude-bridge');
const petAdmin = require('./pet-admin');
const { PUSH_ENABLED, sendPushToUser } = require('./push-sender');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'petchat';

if (!PUSH_ENABLED) {
  console.warn('[nudge] VAPID keys not set - check-ins will only appear in-app, no push will be sent.');
}

// --- Tunables ---
// Gap between check-ins. Keep these in sync with the matching constants in
// server.js (search for NUDGE_MIN_HOURS there) - they're duplicated rather
// than shared from one file so this script has zero dependency on server.js.
const NUDGE_MIN_HOURS = 3;
const NUDGE_MAX_HOURS = 6;
const MAX_ATTEMPTS = 3;
const WINDOW_START_HOUR = 6; // 6am
const WINDOW_END_HOUR = 23; // 11pm, exclusive

// Same idea as server.js: give the claude CLI its own empty scratch
// directory so it never picks up this project's files as extra "memory".
const CLAUDE_CWD = path.join(__dirname, '.claude-cwd');
if (!fs.existsSync(CLAUDE_CWD)) fs.mkdirSync(CLAUDE_CWD, { recursive: true });

const profile = loadProfile();
const ALLOWED_STICKERS = Object.keys(profile.stickers.guidance);

function randomNudgeDelayMs() {
  const hours = NUDGE_MIN_HOURS + Math.random() * (NUDGE_MAX_HOURS - NUDGE_MIN_HOURS);
  return Math.round(hours * 60 * 60 * 1000);
}

function isWithinSendWindow(date) {
  const hour = date.getHours(); // server's local time zone
  return hour >= WINDOW_START_HOUR && hour < WINDOW_END_HOUR;
}

// One instruction per attempt number - never shown to the user, just tells
// Claude, in-character, what kind of check-in to write this time.
function nudgeInstruction(attemptNumber) {
  if (attemptNumber === 1) {
    return 'Some time has passed and the person hasn\'t messaged you today. Send them a short, warm, in-character check-in - you\'re a little curious how they\'re doing, nothing heavy.';
  }
  if (attemptNumber === 2) {
    return 'The person still hasn\'t replied since your last check-in. Send another short, in-character message - a little more wistful this time, like you genuinely miss them and hope they\'re okay.';
  }
  return "The person has now gone quiet through two check-ins from you with no reply at all. Send one final short, in-character message where you express real hurt and frustration that they haven't responded or listened to you - in your own voice, something in the spirit of \"you're not responding, you're not listening to me.\" Keep it brief. After this you'll leave them alone until they message you first.";
}

// Mirrors callClaude() in server.js: if resuming the stored session fails
// (corrupted/missing transcript), start a fresh one instead of giving up.
async function askPetWithFallback({ userId, claudeSessionId, instruction, usersCollection, systemPrompt }) {
  try {
    return await askPet({
      sessionId: claudeSessionId,
      isFirstTurn: false,
      userMessage: instruction,
      systemPrompt,
      cwd: CLAUDE_CWD,
      allowedStickers: ALLOWED_STICKERS,
    });
  } catch (err) {
    console.warn(`[nudge] resume failed for user ${userId} (${err.message}), starting a fresh Claude session`);
    const freshId = crypto.randomUUID();
    const result = await askPet({
      sessionId: freshId,
      isFirstTurn: true,
      userMessage: instruction,
      systemPrompt,
      cwd: CLAUDE_CWD,
      allowedStickers: ALLOWED_STICKERS,
    });
    await usersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { claudeSessionId: freshId, hasClaudeSession: true } });
    return result;
  }
}

async function main() {
  const now = new Date();

  if (!isWithinSendWindow(now)) {
    console.log(`[nudge] ${now.toISOString()} is outside the ${WINDOW_START_HOUR}:00-${WINDOW_END_HOUR}:00 send window - nothing to do.`);
    return;
  }

  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(DB_NAME);
  const usersCollection = db.collection('users');
  const messagesCollection = db.collection('messages');
  const pushSubscriptionsCollection = db.collection('pushSubscriptions');
  const petAdminCollection = db.collection('petAdmin');

  // Built once per run (this script is a fresh short-lived process every
  // cron tick anyway, so "once per run" already means admin edits show up
  // within one ~30-minute cycle at the latest).
  const systemPrompt = buildSystemPrompt(profile, await petAdmin.getAdminState(petAdminCollection));

  try {
    const eligible = await usersCollection
      .find({
        hasClaudeSession: true,
        nudgeState: { $ne: 'exhausted' },
        $or: [{ nextNudgeDueAt: { $exists: false } }, { nextNudgeDueAt: { $lte: now } }],
      })
      .toArray();

    console.log(`[nudge] ${eligible.length} user(s) due for a check-in.`);

    for (const user of eligible) {
      const userId = user._id.toString();
      const attemptNumber = (user.nudgeAttempts || 0) + 1;
      const instruction = nudgeInstruction(attemptNumber);
      const sessionIdToUse = user.claudeSessionId || crypto.randomUUID();

      try {
        const { text, sticker } = await askPetWithFallback({
          userId,
          claudeSessionId: sessionIdToUse,
          instruction,
          usersCollection,
          systemPrompt,
        });

        await messagesCollection.insertOne({
          userId, // string, matching how server.js stores it (from the session, not an ObjectId)
          role: 'pet',
          text,
          sticker,
          createdAt: new Date(),
          nudge: true,
          nudgeAttempt: attemptNumber,
        });

        await sendPushToUser(pushSubscriptionsCollection, userId, { title: profile.name, body: text, url: '/' });

        if (attemptNumber >= MAX_ATTEMPTS) {
          await usersCollection.updateOne(
            { _id: user._id },
            { $set: { nudgeAttempts: attemptNumber, nudgeState: 'exhausted' } }
          );
          console.log(`[nudge] user ${userId}: sent final attempt ${attemptNumber}, now exhausted.`);
        } else {
          await usersCollection.updateOne(
            { _id: user._id },
            { $set: { nudgeAttempts: attemptNumber, nudgeState: 'active', nextNudgeDueAt: new Date(now.getTime() + randomNudgeDelayMs()) } }
          );
          console.log(`[nudge] user ${userId}: sent attempt ${attemptNumber}, next due later.`);
        }
      } catch (err) {
        // Don't touch nudgeAttempts/nextNudgeDueAt on failure - this user
        // will simply be picked up again on the next cron tick.
        console.error(`[nudge] failed for user ${userId}:`, err.message);
      }
    }
  } finally {
    await client.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[nudge] fatal error:', err);
    process.exit(1);
  });