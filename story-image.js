// Generates (or reuses) one shared AI image per day to go alongside the
// day's story beat - see story-scheduler.js (calls this after advancing the
// arc) and story-beat-scheduler.js (attaches the result as `media` on each
// user's proactive message). One image per day for the whole app, not one
// per user, since the underlying beat/premise is itself a shared singleton
// (see persona.js's resolveStoryGuidance) - matches the same "fetch once,
// reuse for everyone" shape as the shelved meme feature's media-scheduler.js.
//
// Generation actually happens on NPN-old (Tailscale IP, see
// dev-workflow-and-infra-notes.md in the project docs), which runs OpenAI's
// Codex CLI logged into a ChatGPT subscription - no API key on this side.
// Reached only over the private tailnet, never through NPN-old's public
// Funnel URL. Fails soft on purpose: any problem here (bridge unreachable,
// timeout, Codex error) just means today's story goes out text-only - never
// blocks or delays the text beat itself.

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const { resolveStoryGuidance } = require('./persona');
const { todayKey } = require('./special-dates');

const BRIDGE_URL = process.env.STORY_IMAGE_BRIDGE_URL || 'http://100.73.241.31:3900/generate';
const BRIDGE_SECRET = process.env.STORY_IMAGE_BRIDGE_SECRET || '';
const MEDIA_DIR = path.join(__dirname, 'public', 'media');
// Codex's built-in image_gen tool isn't instant - give it real room before
// giving up, but still bounded so this can never hang the calling script
// indefinitely if the bridge or Codex itself wedges.
const REQUEST_TIMEOUT_MS = 120_000;
const RETENTION_DAYS = 30;

function buildImagePrompt({ text, title }) {
  return (
    `Children's-book illustration, warm and comedic, square composition, no text or lettering anywhere in the image. ` +
    `Scene: ${text} ` +
    `TukuruMukuru is the protagonist, a red panda. Dino-Day is the villain, a tall dinosaur wearing a pink shirt, ` +
    `with a scary growl played for laughs rather than menace. ` +
    `Character rules, important: if the scene mentions Kevin, Bob, or Stuart, do not depict them at all, in any form - ` +
    `leave them out of the illustration entirely, even in the background, and focus the composition on TukuruMukuru ` +
    `and Dino-Day (and any other original characters) instead. If the scene mentions Po, depict him only as a plain, ` +
    `original cartoon panda - round and friendly, with no specific outfit, markings, or accessories - and never use ` +
    `the name "Po" or reference any existing panda character's identity.`
  );
}

async function requestImage(prompt) {
  if (!BRIDGE_SECRET) throw new Error('STORY_IMAGE_BRIDGE_SECRET not set');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Secret': BRIDGE_SECRET },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`bridge responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// Idempotent per day: a second call on the same day (script re-run, cron
// firing twice) just returns the already-generated doc instead of asking
// Codex again - same pattern as media-scheduler.js's getOrFetchTodaysMedia
// and story-beat-scheduler.js's lastStoryBeatDate.
async function getOrGenerateTodaysStoryImage(db, arcState, now) {
  if (!arcState || arcState.phase === 'resting') return null;

  const dailyStoryImageCollection = db.collection('dailyStoryImage');
  const dateKey = todayKey(now);

  const existing = await dailyStoryImageCollection.findOne({ dateKey });
  if (existing) return existing;

  const { text, title } = resolveStoryGuidance(arcState, now);
  if (!text) return null;
  const prompt = buildImagePrompt({ text, title });

  let buffer;
  try {
    buffer = await requestImage(prompt);
  } catch (err) {
    console.warn(`[story-image] generation failed, today's story goes out text-only: ${err.message}`);
    return null;
  }

  if (!fs.existsSync(MEDIA_DIR)) await fsp.mkdir(MEDIA_DIR, { recursive: true });
  const filename = `story-${dateKey}-${crypto.randomBytes(4).toString('hex')}.png`;
  await fsp.writeFile(path.join(MEDIA_DIR, filename), buffer);

  const doc = { dateKey, url: `/media/${filename}`, prompt, createdAt: now };
  await dailyStoryImageCollection.insertOne(doc);
  console.log(`[story-image] generated today's story image (${filename}, ${buffer.length} bytes).`);
  return doc;
}

// Same idea as media-scheduler.js's cleanupOldMedia - public/media/ shouldn't
// grow unbounded on the VM's modest disk.
async function cleanupOldStoryImages(db, now) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const dailyStoryImageCollection = db.collection('dailyStoryImage');
  const old = await dailyStoryImageCollection.find({ createdAt: { $lt: cutoff } }).toArray();
  for (const doc of old) {
    const filePath = path.join(__dirname, 'public', doc.url.replace(/^\//, ''));
    await fsp.unlink(filePath).catch(() => {}); // already gone is fine
  }
  if (old.length) {
    await dailyStoryImageCollection.deleteMany({ _id: { $in: old.map((d) => d._id) } });
    console.log(`[story-image] cleaned up ${old.length} story image(s) older than ${RETENTION_DAYS} days.`);
  }
}

module.exports = { getOrGenerateTodaysStoryImage, cleanupOldStoryImages };
