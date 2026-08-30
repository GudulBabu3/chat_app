// Standalone script, NOT part of the running server process. Meant to be
// invoked by cron once a day, at a normal hour (see the suggested crontab
// line below) - and after story-scheduler.js's own daily run, so it always
// sees that day's already-advanced arc phase, not yesterday's.
//
// Unlike story-scheduler.js (which only moves the arc's clock forward and
// never messages anyone) and nudge-scheduler.js (which only fires after a
// user's gone quiet for hours), this proactively tells every eligible user
// about today's Dino-Day development once a day, regardless of whether
// they're actively chatting - so the story surfaces on its own instead of
// only showing up when someone happens to ask about Dino-Day specifically.
// Skipped entirely while the arc is "resting" (nothing to report).
//
// Usage: node story-beat-scheduler.js   (run from the project root, e.g. via cron, once daily)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fs = require('fs');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');

const { loadProfile, loadWorldProfile, buildSystemPrompt } = require('./persona');
const { askPet } = require('./claude-bridge');
const petAdmin = require('./pet-admin');
const storyArc = require('./story-arc');
const { notifyLiveServer } = require('./notify-live');
const { todayKey } = require('./special-dates');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'petchat';

// Same idea as the other scripts: give the claude CLI its own empty scratch
// directory so it never picks up this project's files as extra "memory".
const CLAUDE_CWD = path.join(__dirname, '.claude-cwd');
if (!fs.existsSync(CLAUDE_CWD)) fs.mkdirSync(CLAUDE_CWD, { recursive: true });

const profile = loadProfile();
const worldProfile = loadWorldProfile();
const ALLOWED_STICKERS = Object.keys(profile.stickers.guidance);

// Never shown to the user - tells Claude, in-character, to proactively
// share a concrete development instead of waiting to be asked. The full
// CURRENT STORY guidance for today's phase is already in the system
// prompt (see persona.js) - this instruction just tells it to lead with
// that unprompted, the way real news gets shared, rather than waiting for
// an opening in the conversation.
const STORY_BEAT_INSTRUCTION =
  'Proactively bring up a specific, concrete new development in what\'s currently going on with Dino-Day, completely unprompted - like real news you\'re eager to share, not a vague teaser. Open naturally in your own voice (something like "you know what..." or "so get this..." or however feels natural), describe one real, specific thing that happened, and end in a way that invites them to respond or ask more if they want to. Keep it a few sentences, not a whole essay.';

// Mirrors the same helper in nudge-scheduler.js: if resuming the stored
// session fails (corrupted/missing transcript), start a fresh one instead
// of giving up.
async function askPetWithFallback({ userId, claudeSessionId, systemPrompt, usersCollection }) {
  try {
    return await askPet({
      sessionId: claudeSessionId,
      isFirstTurn: false,
      userMessage: STORY_BEAT_INSTRUCTION,
      systemPrompt,
      cwd: CLAUDE_CWD,
      allowedStickers: ALLOWED_STICKERS,
    });
  } catch (err) {
    console.warn(`[story-beat] resume failed for user ${userId} (${err.message}), starting a fresh Claude session`);
    const freshId = crypto.randomUUID();
    const result = await askPet({
      sessionId: freshId,
      isFirstTurn: true,
      userMessage: STORY_BEAT_INSTRUCTION,
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
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(DB_NAME);
  const usersCollection = db.collection('users');
  const messagesCollection = db.collection('messages');
  const petAdminCollection = db.collection('petAdmin');
  const storyArcCollection = db.collection('storyArc');

  try {
    const arcState = await storyArc.getArcState(storyArcCollection);
    if (arcState.phase === 'resting') {
      console.log('[story-beat] arc is resting - nothing to report today.');
      return;
    }

    const adminState = await petAdmin.getAdminState(petAdminCollection);
    const today = todayKey(now);

    // hasClaudeSession: true - same base eligibility as nudge-scheduler.js
    // (only message people who've actually started talking to TukuruMukuru
    // before). lastStoryBeatDate !== today covers both "never sent" (field
    // missing entirely, which $ne also matches) and "already sent today".
    const eligible = await usersCollection
      .find({ hasClaudeSession: true, lastStoryBeatDate: { $ne: today } })
      .toArray();

    console.log(`[story-beat] ${eligible.length} user(s) due for today's Dino-Day update (phase: ${arcState.phase}).`);

    for (const user of eligible) {
      const userId = user._id.toString();
      const sessionIdToUse = user.claudeSessionId || crypto.randomUUID();
      const systemPrompt = buildSystemPrompt(profile, adminState, {
        worldProfile,
        arcState,
        joinedAt: user.createdAt,
        now,
      });

      try {
        const { text, sticker } = await askPetWithFallback({
          userId,
          claudeSessionId: sessionIdToUse,
          systemPrompt,
          usersCollection,
        });

        await messagesCollection.insertOne({
          userId, // string, matching how server.js/nudge-scheduler.js store it
          role: 'pet',
          text,
          sticker,
          createdAt: new Date(),
          storyBeat: true,
        });

        await notifyLiveServer({ userId, text, sticker });
        await usersCollection.updateOne({ _id: user._id }, { $set: { lastStoryBeatDate: today } });

        console.log(`[story-beat] sent to user ${userId}.`);
      } catch (err) {
        // Don't mark lastStoryBeatDate on failure - this user is simply
        // picked up again the next time this script runs.
        console.error(`[story-beat] failed for user ${userId}:`, err.message);
      }
    }
  } finally {
    await client.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[story-beat] fatal error:', err);
    process.exit(1);
  });
