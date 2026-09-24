// Generates (or reuses) one shared, wholesome "ordinary day" beat during the
// story arc's resting phase (the ~3-4 week gap between Dino-Day arcs), so
// story-beat-scheduler.js's daily proactive message + story-image.js's
// shared image don't go completely silent during that stretch - see
// dev-workflow-and-infra-notes.md for the decision behind this. One shared
// beat per day for the whole app (matches the shared arc-state singleton),
// not per user - same "fetch once, reuse for everyone" shape as
// story-image.js's daily image.
//
// Unlike the arc's day-by-day premise beats (pre-generated as a whole array
// up front, one per possible day of a phase - see persona.js's
// resolveStoryGuidance), resting isn't phase-day-tracked at all (no
// phaseStartedAt while resting - see story-arc.js), and can run a randomized
// 21-28 days. So instead this generates ONE fresh beat per day, on demand,
// rather than a pre-generated array sized to an unknown length.

const { todayKey } = require('./special-dates');

const RETENTION_DAYS = 30;

// generateBeat is injected (a closure over worldProfile/cwd, built by the
// caller - see story-scheduler.js) rather than importing claude-bridge here
// directly, so this module stays a thin Mongo-facing wrapper, same
// separation as story-image.js/story-scheduler.js already use for premise
// generation.
async function getOrGenerateTodaysRestingBeat(db, now, generateBeat) {
  const dateKey = todayKey(now);
  const collection = db.collection('dailyRestingBeat');

  const existing = await collection.findOne({ dateKey });
  if (existing) return existing.text;

  let text;
  try {
    text = await generateBeat();
  } catch (err) {
    console.warn(`[resting-beat] generation failed, resting day goes without a specific beat today: ${err.message}`);
    return null;
  }
  if (!text) return null;

  await collection.insertOne({ dateKey, text, createdAt: now });
  console.log(`[resting-beat] generated today's resting-day beat.`);
  return text;
}

async function cleanupOldRestingBeats(db, now) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const collection = db.collection('dailyRestingBeat');
  const result = await collection.deleteMany({ createdAt: { $lt: cutoff } });
  if (result.deletedCount) {
    console.log(`[resting-beat] cleaned up ${result.deletedCount} resting beat(s) older than ${RETENTION_DAYS} days.`);
  }
}

module.exports = { getOrGenerateTodaysRestingBeat, cleanupOldRestingBeats };
