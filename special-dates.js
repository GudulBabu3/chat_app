// Small date helpers for TukuruMukuru's key calendar days:
// - International Red Panda Day (real-world observance, TukuruMukuru's
//   in-story birthday): the third Saturday of September, every year.
// - Each user's own chat anniversary: the day their account was created
//   (users.createdAt), which is effectively "the day TukuruMukuru started
//   talking to them".
//
// All date math uses server-local calendar dates (same reasoning as
// pet-admin.js's todayKey()), so "today" means the same thing everywhere
// in this app.

function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Third Saturday of September in the given year.
function redPandaDay(year) {
  const sept1 = new Date(year, 8, 1); // month is 0-indexed, 8 = September
  const sept1Day = sept1.getDay(); // 0 = Sunday ... 6 = Saturday
  const daysUntilFirstSaturday = (6 - sept1Day + 7) % 7;
  const firstSaturday = 1 + daysUntilFirstSaturday;
  const thirdSaturday = firstSaturday + 14;
  return new Date(year, 8, thirdSaturday);
}

function isRedPandaDayToday(date = new Date()) {
  return todayKey(date) === todayKey(redPandaDay(date.getFullYear()));
}

// True if today's month+day matches the anniversary date's month+day (any
// year - a yearly-recurring check, like a birthday).
function isAnniversaryToday(joinedAt, date = new Date()) {
  if (!joinedAt) return false;
  const joined = new Date(joinedAt);
  // Guard against literally joining today - that's a "welcome" moment
  // (already handled by server.js's brand-new-account greeting), not an
  // "anniversary" moment.
  if (todayKey(joined) === todayKey(date)) return false;
  return joined.getMonth() === date.getMonth() && joined.getDate() === date.getDate();
}

// Rough "how long have we known each other" flavor text, whole years/months.
// Returns null if it's too new to be worth mentioning as a duration.
function relationshipLengthText(joinedAt, date = new Date()) {
  if (!joinedAt) return null;
  const joined = new Date(joinedAt);
  let years = date.getFullYear() - joined.getFullYear();
  let months = date.getMonth() - joined.getMonth();
  if (date.getDate() < joined.getDate()) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  if (years <= 0 && months <= 0) return null;
  if (years <= 0) return `${months} month${months === 1 ? '' : 's'}`;
  if (months === 0) return `${years} year${years === 1 ? '' : 's'}`;
  return `${years} year${years === 1 ? '' : 's'} and ${months} month${months === 1 ? '' : 's'}`;
}

module.exports = { todayKey, redPandaDay, isRedPandaDayToday, isAnniversaryToday, relationshipLengthText };
