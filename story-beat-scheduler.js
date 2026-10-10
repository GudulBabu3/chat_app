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
// During the arc's "resting" phase (no active Dino-Day plot), this instead
// shares that day's generated wholesome slice-of-life beat (see
// resting-beat.js) - skipped only if that beat hasn't been generated yet.
//
// Usage: node story-beat-scheduler.js   (run from the project root, e.g. via cron, once daily)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fs = require('fs');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');

const { loadProfile, loadWorldProfile, buildSystemPrompt, resolveStoryGuidance } = require('./persona');
const { askPet } = require('./claude-bridge');
const petAdmin = require('./pet-admin');
const storyArc = require('./story-arc');
const storyImage = require('./story-image');
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
// share TODAY'S SPECIFIC beat, completely unprompted. Bug found 2026-09-27:
// this used to be a static generic string, relying entirely on the system
// prompt's "CURRENT STORY" section to carry the actual specific content -
// but persona.js labels that section "loose guidance...don't force it",
// which is correct for regular chat/nudges but was giving each user's
// resumed session free rein to invent its own version of the day's event
// during a dedicated broadcast turn, instead of recounting the one cached
// beat story-image.js's shared illustration was generated from. Result:
// different users' proactive messages diverging from each other and from
// the shared image. Fix: embed the literal resolved beat text directly in
// the turn's instruction (same pattern special-broadcast.js's
// buildSpecialInstruction already used, which never had this problem).
function buildStoryBeatInstruction(beatText) {
  return (
    `Here's today's specific development in the Dino-Day story: ${beatText}\n\n` +
    `Proactively bring this up with your person right now, completely unprompted - like real news you're eager to share, not a vague teaser. ` +
    `Open naturally in your own voice (something like "you know what..." or "so get this..." or however feels natural), describe this specific thing that happened - don't invent a different development - and end in a way that invites them to respond or ask more if they want to. ` +
    `Keep it a few sentences, not a whole essay.`
  );
}

// Same idea, for resting-phase days (no Dino-Day plot active right now -
// see resting-beat.js/persona.js's resolveStoryGuidance). Embeds the day's
// generated slice-of-life beat text directly, for the same reason.
function buildRestingBeatInstruction(beatText) {
  return (
    `Here's today's specific wholesome moment: ${beatText}\n\n` +
    `Proactively share this with your person right now, completely unprompted - like you're excited to tell them something cute or funny that happened, not a vague "things are good" update. ` +
    `Open naturally in your own voice, describe this specific thing - don't invent a different moment - and end in a way that invites them to respond or ask more if they want to. ` +
    `Keep it a few sentences, not a whole essay. Dino-Day is not part of this at all right now.`
  );
}

// Mirrors the same helper in nudge-scheduler.js: if resuming the stored
// session fails (corrupted/missing transcript), start a fresh one instead
// of giving up.
async function askPetWithFallback({ userId, claudeSessionId, systemPrompt, usersCollection, instruction }) {
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
    console.warn(`[story-beat] resume failed for user ${userId} (${err.message}), starting a fresh Claude session`);
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
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(DB_NAME);
  const usersCollection = db.collection('users');
  const messagesCollection = db.collection('messages');
  const petAdminCollection = db.collection('petAdmin');
  const storyArcCollection = db.collection('storyArc');

  try {
    const arcState = await storyArc.getArcState(storyArcCollection);
    const adminState = await petAdmin.getAdminState(petAdminCollection);
    const today = todayKey(now);

    // During resting there's no arc beat to report - instead we rely on
    // story-scheduler.js having already generated today's shared slice-of-life
    // beat (see resting-beat.js). If it hasn't run yet (or generation failed),
    // fail soft exactly like the old "nothing to report" skip used to.
    let restingBeatText = null;
    if (arcState.phase === 'resting') {
      const restingBeatDoc = await db.collection('dailyRestingBeat').findOne({ dateKey: today });
      if (!restingBeatDoc) {
        console.log('[story-beat] arc is resting and no beat generated yet today - nothing to report today.');
        return;
      }
      restingBeatText = restingBeatDoc.text;
    }

    // Resolved once, shared by every user this run - the exact same text
    // story-image.js generated today's shared illustration from - so the
    // instruction below can embed it literally and keep every user's
    // message and the image telling the same specific story.
    const storyText = arcState.phase === 'resting' ? null : resolveStoryGuidance(arcState, now).text;
    const instruction =
      arcState.phase === 'resting' ? buildRestingBeatInstruction(restingBeatText) : buildStoryBeatInstruction(storyText);

    // Looked up once and reused for every user below - it's one shared image
    // for the whole app (see story-image.js), not generated per user. Just a
    // read here: story-scheduler.js is what actually generates it, earlier
    // in the morning. If it's missing (generation failed, or hasn't run yet
    // today), media simply stays undefined and users get the text beat alone.
    const todaysImage = await db.collection('dailyStoryImage').findOne({ dateKey: today });
    const media = todaysImage ? { type: 'image', url: todaysImage.url } : undefined;

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
        restingBeatText,
      });

      try {
        const { text, sticker } = await askPetWithFallback({
          userId,
          claudeSessionId: sessionIdToUse,
          systemPrompt,
          usersCollection,
          instruction,
        });

        const inserted = await messagesCollection.insertOne({
          userId, // string, matching how server.js/nudge-scheduler.js store it
          role: 'pet',
          text,
          sticker,
          media,
          createdAt: new Date(),
          storyBeat: true,
        });

        await notifyLiveServer({ userId, text, sticker, media, messageId: inserted.insertedId.toString() });
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
