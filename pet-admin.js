// Admin-controlled additions to TukuruMukuru's persona, stored in Mongo
// (petAdmin collection, one singleton document) so they take effect
// immediately via admin.js without editing pet-profile.json or redeploying.
//
// Read fresh on every reply rather than cached anywhere - traffic on this
// app is tiny, so a per-turn DB read is cheap, and it means an admin change
// is visible on the very next message instead of waiting on a cache TTL or
// a restart.

const SINGLETON_ID = 'petAdminState';

// Server-local calendar date as YYYY-MM-DD - same "local time" reasoning
// nudge-scheduler.js already uses for its send window, so "today" means the
// same thing across this whole app.
function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function getAdminState(petAdminCollection) {
  const doc = await petAdminCollection.findOne({ _id: SINGLETON_ID });
  return {
    extraSkills: doc?.extraSkills || [],
    extraLikes: doc?.extraLikes || [],
    extraDislikes: doc?.extraDislikes || [],
    // Auto-expires: only applies on the exact date it was set for, so admin
    // doesn't need to remember to clear it the next day.
    todaySpecial: doc?.todaySpecial && doc.todaySpecial.date === todayKey() ? doc.todaySpecial.note : null,
  };
}

async function addToList(petAdminCollection, field, text) {
  await petAdminCollection.updateOne({ _id: SINGLETON_ID }, { $addToSet: { [field]: text } }, { upsert: true });
}

async function removeFromList(petAdminCollection, field, text) {
  await petAdminCollection.updateOne({ _id: SINGLETON_ID }, { $pull: { [field]: text } }, { upsert: true });
}

async function setTodaySpecial(petAdminCollection, note) {
  await petAdminCollection.updateOne(
    { _id: SINGLETON_ID },
    { $set: { todaySpecial: { date: todayKey(), note } } },
    { upsert: true }
  );
}

async function clearTodaySpecial(petAdminCollection) {
  await petAdminCollection.updateOne({ _id: SINGLETON_ID }, { $set: { todaySpecial: null } }, { upsert: true });
}

module.exports = { getAdminState, addToList, removeFromList, setTodaySpecial, clearTodaySpecial };
