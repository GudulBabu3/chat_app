const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// Very small in-memory rate limiter for the login route - not distributed,
// not persistent across restarts, but enough to slow down casual brute
// forcing on a small personal app. Keyed by IP.
const attempts = new Map(); // ip -> { count, firstAttemptAt }
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 15;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (now - entry.firstAttemptAt > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordAttempt(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.firstAttemptAt > WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAttemptAt: now });
    return;
  }
  entry.count += 1;
}

function clearAttempts(ip) {
  attempts.delete(ip);
}

module.exports = { hashPassword, verifyPassword, isRateLimited, recordAttempt, clearAttempts };
