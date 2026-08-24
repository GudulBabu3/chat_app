// Shared Web Push sending logic. Used by server.js (live replies while a
// tab isn't foregrounded), nudge-scheduler.js (out-of-session check-ins),
// and admin.js (admin-sent messages) - pulled out here instead of each
// duplicating its own copy, now that there are three callers.
//
// VAPID setup (unlike the nudge-timing constants elsewhere in this repo,
// which ARE deliberately duplicated so nudge-scheduler.js has zero
// dependency on server.js) is fine to share: this module has no dependency
// on server.js either way, it's just a small always-standalone library, the
// same role persona.js and auth.js already play.

const webpush = require('web-push');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const PUSH_ENABLED = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

function truncateForPush(text) {
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

// Notifies every device the user has subscribed for push on, dropping any
// subscription the push service reports as gone (404/410) so it doesn't
// keep failing forever. No-ops quietly if push isn't configured at all.
async function sendPushToUser(pushSubscriptionsCollection, userId, { title, body, url }) {
  if (!PUSH_ENABLED) return;
  const subs = await pushSubscriptionsCollection.find({ userId }).toArray();
  if (subs.length === 0) return;
  const payload = JSON.stringify({ title, body: truncateForPush(body), url });
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pushSubscriptionsCollection.deleteOne({ _id: sub._id });
        } else {
          console.warn(`[push] send failed for user ${userId}:`, err.message);
        }
      }
    })
  );
}

module.exports = { PUSH_ENABLED, VAPID_PUBLIC_KEY, VAPID_SUBJECT, sendPushToUser, truncateForPush };
