// Shared helper for out-of-band writers (admin.js sending as the pet,
// nudge-scheduler.js's check-ins) that insert a message directly into
// MongoDB from a process other than the live server. Calling this right
// after that insert tells the actual running server about it, so:
//  - anyone with the app open right now sees it appear live, no reload needed
//  - anyone who ISN'T looking gets a push notification instead (the server
//    decides this - it's the only process that actually knows who's online)
//
// Fails soft on purpose: if the live server can't be reached (down, wrong
// secret, whatever), the message is already saved in Mongo either way, so
// it'll simply show up next time the affected user reloads the app. Nothing
// is ever lost, just possibly delayed.

const PORT = process.env.PORT || 3000;
const INTERNAL_ADMIN_SECRET = process.env.INTERNAL_ADMIN_SECRET || '';

async function notifyLiveServer({ userId, text, sticker }) {
  if (!INTERNAL_ADMIN_SECRET) {
    console.warn('[notify-live] INTERNAL_ADMIN_SECRET not set - message saved, but will only appear on next reload.');
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/internal/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_ADMIN_SECRET },
      body: JSON.stringify({ userId, text, sticker }),
    });
    if (!res.ok) {
      console.warn(`[notify-live] live server responded ${res.status} - message is saved but may only show on next reload.`);
    }
  } catch (err) {
    console.warn(`[notify-live] could not reach the live server (${err.message}) - message is saved but will show on next reload.`);
  }
}

module.exports = { notifyLiveServer };
