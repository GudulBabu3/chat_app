// Fires once per day, the first time an admin sets "today's special" (see
// pet-admin.js's setTodaySpecial / server.js's and admin.js's "special set"
// handlers) - NOT on the nightly story-scheduler.js/story-beat-scheduler.js
// cron cadence, since a same-day announcement needs to go out right away,
// not wait for the next 3am run.
//
// Generates one Claude-written story beat elaborating on the admin's note
// (claude-bridge.js's generateSpecialBeat), one shared image to go with it
// (reusing story-image.js's buildImagePrompt + generateAndSaveImagePng, the
// same bridge pipeline story-image.js itself uses), and sends both to every
// eligible user - text personalized per user via their own resumed Claude
// session (so it reads like Tukuru genuinely telling THEM the news), image
// shared identically to everyone, same shape as story-beat-scheduler.js's
// existing per-user send loop.
//
// Cached per day in a new `dailySpecial` Mongo collection so a second call
// for the same day (should one ever happen - e.g. a crash mid-broadcast)
// reuses the already-generated beat/image instead of burning another
// Claude/bridge call, and a per-user `lastSpecialBroadcastDate` field (same
// idea as story-beat-scheduler.js's `lastStoryBeatDate`) means a re-run
// only reaches users who didn't already get today's special.

const crypto = require('crypto');

const { buildSystemPrompt } = require('./persona');
const { askPet, generateSpecialBeat } = require('./claude-bridge');
const { buildImagePrompt, generateAndSaveImagePng, cleanupOldImageDocs } = require('./story-image');
const petAdmin = require('./pet-admin');
const storyArc = require('./story-arc');
const { todayKey } = require('./special-dates');

const RETENTION_DAYS = 30;

function buildSpecialInstruction(beatText) {
  return (
    `Something special is happening today: ${beatText}\n\n` +
    `Proactively bring this up with your person right now, completely unprompted - like real exciting news you can't wait to share. ` +
    `Open naturally in your own voice, describe it specifically (not vaguely), and end in a way that invites them to respond or ask more if they want to. ` +
    `Keep it a few sentences, not a whole essay.`
  );
}

// Generates (once) or reuses today's special story beat + image. Fails soft
// at each step independently, same philosophy as story-image.js/resting-beat.js:
// a beat-generation failure falls back to the admin's raw note as the beat
// text (so something still goes out), and an image-generation failure just
// means today's special goes out text-only.
async function getOrCreateTodaysSpecialContent(db, now, specialNote, worldProfile, cwd) {
  const dateKey = todayKey(now);
  const collection = db.collection('dailySpecial');

  const existing = await collection.findOne({ dateKey });
  if (existing) return existing;

  let beatText = null;
  try {
    beatText = await generateSpecialBeat({ worldProfile, specialNote, cwd });
  } catch (err) {
    console.warn(`[special] beat generation failed, using the admin's raw note instead: ${err.message}`);
  }
  const finalBeatText = beatText || specialNote;

  let url = null;
  try {
    const prompt = buildImagePrompt({ text: finalBeatText, title: null });
    const result = await generateAndSaveImagePng(prompt, `special-${dateKey}`);
    url = result.url;
    console.log(`[special] generated today's special image (${url}, ${result.bytes} bytes).`);
  } catch (err) {
    console.warn(`[special] image generation failed, today's special goes out text-only: ${err.message}`);
  }

  const doc = { dateKey, note: specialNote, beatText: finalBeatText, url, createdAt: now };
  await collection.insertOne(doc);
  return doc;
}

// notify(userId, { text, sticker, media }) - injected so this same function
// works both in-process (server.js's own notifyUserSockets + sendPushToUser,
// no HTTP hop needed since it IS the live server) and from a separate
// process (admin.js's CLI, via notify-live.js's HTTP call to the live
// server) - same "injected delivery" shape story-beat-scheduler.js's
// per-user loop would use if it needed to run outside its own process.
async function runSpecialBroadcast({ db, worldProfile, cwd, specialNote, profile, allowedStickers, now = new Date(), notify }) {
  const usersCollection = db.collection('users');
  const messagesCollection = db.collection('messages');
  const petAdminCollection = db.collection('petAdmin');
  const storyArcCollection = db.collection('storyArc');

  const specialDoc = await getOrCreateTodaysSpecialContent(db, now, specialNote, worldProfile, cwd);
  const media = specialDoc.url ? { type: 'image', url: specialDoc.url } : undefined;
  const instruction = buildSpecialInstruction(specialDoc.beatText);

  const [adminState, arcState] = await Promise.all([
    petAdmin.getAdminState(petAdminCollection),
    storyArc.getArcState(storyArcCollection),
  ]);

  const today = todayKey(now);
  const eligible = await usersCollection
    .find({ hasClaudeSession: true, lastSpecialBroadcastDate: { $ne: today } })
    .toArray();

  console.log(`[special] sending today's special to ${eligible.length} user(s).`);

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
      let result;
      try {
        result = await askPet({
          sessionId: sessionIdToUse,
          isFirstTurn: false,
          userMessage: instruction,
          systemPrompt,
          cwd,
          allowedStickers,
        });
      } catch (err) {
        console.warn(`[special] resume failed for user ${userId} (${err.message}), starting a fresh Claude session`);
        const freshId = crypto.randomUUID();
        result = await askPet({
          sessionId: freshId,
          isFirstTurn: true,
          userMessage: instruction,
          systemPrompt,
          cwd,
          allowedStickers,
        });
        await usersCollection.updateOne({ _id: user._id }, { $set: { claudeSessionId: freshId, hasClaudeSession: true } });
      }

      const { text, sticker } = result;

      await messagesCollection.insertOne({
        userId, // string, matching how server.js/story-beat-scheduler.js store it
        role: 'pet',
        text,
        sticker,
        media,
        createdAt: new Date(),
        specialBroadcast: true,
      });

      await notify(userId, { text, sticker, media });
      await usersCollection.updateOne({ _id: user._id }, { $set: { lastSpecialBroadcastDate: today } });

      console.log(`[special] sent to user ${userId}.`);
    } catch (err) {
      // Don't mark lastSpecialBroadcastDate on failure - this user is
      // simply picked up again if the broadcast is ever re-run.
      console.error(`[special] failed for user ${userId}:`, err.message);
    }
  }

  console.log('[special] broadcast complete.');
}

async function cleanupOldSpecialBroadcasts(db, now) {
  await cleanupOldImageDocs(db, now, 'dailySpecial', RETENTION_DAYS, '[special]');
}

module.exports = { runSpecialBroadcast, cleanupOldSpecialBroadcasts };
