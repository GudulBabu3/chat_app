const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');

const { loadProfile, loadWorldProfile, buildSystemPrompt } = require('./persona');
const { askPet, generateStoryPremise } = require('./claude-bridge');
const { verifyPassword, isRateLimited, recordAttempt, clearAttempts } = require('./auth');
const petAdmin = require('./pet-admin');
const storyArc = require('./story-arc');
const { PUSH_ENABLED, VAPID_PUBLIC_KEY, sendPushToUser } = require('./push-sender');
const { TTS_ENABLED, synthesizeSpeech } = require('./tts');

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'petchat';
const MAX_MESSAGE_LENGTH = 2000;
const HISTORY_LIMIT = 50;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const INTERNAL_ADMIN_SECRET = process.env.INTERNAL_ADMIN_SECRET || '';
const ADMIN_PANEL_PASSWORD = process.env.ADMIN_PANEL_PASSWORD || '';

if (!PUSH_ENABLED) {
  console.warn('[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set - push notifications are disabled.');
}

if (!INTERNAL_ADMIN_SECRET) {
  console.warn('[internal] INTERNAL_ADMIN_SECRET not set - admin.js/nudge-scheduler.js can still save messages, but cannot notify live tabs or trigger push for them.');
}

if (!TTS_ENABLED) {
  console.warn('[tts] AZURE_SPEECH_KEY/AZURE_SPEECH_REGION not set - spoken pet replies are disabled (text chat is unaffected).');
}

if (!ADMIN_PANEL_PASSWORD) {
  console.warn('[admin] ADMIN_PANEL_PASSWORD not set - the web admin panel at /admin is disabled until it is.');
}

// Gap before TukuruMukuru's next unprompted check-in, reset every time the
// user sends a real message. Keep these in sync with the matching constants
// in nudge-scheduler.js (that script is what actually sends the check-ins;
// this file only needs to know how far out to push the next one).
const NUDGE_MIN_HOURS = 3;
const NUDGE_MAX_HOURS = 6;

function randomNudgeDelayMs() {
  const hours = NUDGE_MIN_HOURS + Math.random() * (NUDGE_MAX_HOURS - NUDGE_MIN_HOURS);
  return Math.round(hours * 60 * 60 * 1000);
}

// Dedicated, empty working directory for claude CLI calls so it never picks
// up this project's own files, CLAUDE.md, or git context as extra "memory".
const CLAUDE_CWD = path.join(__dirname, '.claude-cwd');
if (!fs.existsSync(CLAUDE_CWD)) fs.mkdirSync(CLAUDE_CWD, { recursive: true });

const profile = loadProfile();
const worldProfile = loadWorldProfile();
const ALLOWED_STICKERS = Object.keys(profile.stickers.guidance);
const DEFAULT_STICKER = profile.stickers.default || 'neutral';

// Used by the admin panel's story-arc controls (mirrors admin.js's own
// generatePremise wrapper).
function generateArcPremise({ pastTitles }) {
  return generateStoryPremise({ worldProfile, pastTitles, cwd: CLAUDE_CWD });
}

const app = express();
app.set('trust proxy', 1); // needed so secure cookies work correctly behind Tailscale Funnel
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server);

let db, usersCollection, messagesCollection, pushSubscriptionsCollection, petAdminCollection, storyArcCollection;

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGO_URL, dbName: DB_NAME, collectionName: 'sessions' }),
  cookie: {
    httpOnly: true,
    secure: 'auto', // Secure over HTTPS (Funnel), plain over local HTTP (Tailscale IP) - relies on trust proxy above
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.redirect('/login');
}

// Separate admin-panel password, not tied to any chat user account - see
// ADMIN_PANEL_PASSWORD above. Its own tiny rate limiter (not auth.js's) so
// repeated wrong guesses here don't also lock the admin out of their own
// regular chat login.
const adminLoginAttempts = new Map();
const ADMIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_MAX_ATTEMPTS = 10;

function isAdminRateLimited(ip) {
  const now = Date.now();
  const entry = adminLoginAttempts.get(ip);
  if (!entry) return false;
  if (now - entry.firstAttemptAt > ADMIN_WINDOW_MS) {
    adminLoginAttempts.delete(ip);
    return false;
  }
  return entry.count >= ADMIN_MAX_ATTEMPTS;
}

function recordAdminAttempt(ip) {
  const now = Date.now();
  const entry = adminLoginAttempts.get(ip);
  if (!entry || now - entry.firstAttemptAt > ADMIN_WINDOW_MS) {
    adminLoginAttempts.set(ip, { count: 1, firstAttemptAt: now });
    return;
  }
  entry.count += 1;
}

function clearAdminAttempts(ip) {
  adminLoginAttempts.delete(ip);
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

function requireAdminApi(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ ok: false, error: 'Not authenticated as admin.' });
}

// --- Public routes ---
app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again later.' });
  }
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password required.' });
  }
  const user = await usersCollection.findOne({ username: String(username).trim().toLowerCase() });
  if (!user) {
    recordAttempt(ip);
    return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
  }
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    recordAttempt(ip);
    return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
  }
  clearAttempts(ip);
  req.session.userId = user._id.toString();
  req.session.username = user.username;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// --- Admin panel auth (separate password, not a chat user account) ---
app.get('/admin/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.post('/admin/api/login', (req, res) => {
  if (!ADMIN_PANEL_PASSWORD) {
    return res.status(503).json({ ok: false, error: 'Admin panel is not configured (ADMIN_PANEL_PASSWORD missing on the server).' });
  }
  const ip = req.ip || 'unknown';
  if (isAdminRateLimited(ip)) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again later.' });
  }
  const { password } = req.body || {};
  if (password !== ADMIN_PANEL_PASSWORD) {
    recordAdminAttempt(ip);
    return res.status(401).json({ ok: false, error: 'Wrong password.' });
  }
  clearAdminAttempts(ip);
  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.post('/admin/api/logout', (req, res) => {
  if (req.session) delete req.session.isAdmin;
  res.json({ ok: true });
});

app.get('/admin', requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

// --- Protected app + assets ---
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'chat.html'));
});

app.get('/api/pet', requireAuth, (req, res) => {
  res.json({ name: profile.name, species: profile.species, username: req.session.username });
});

// --- Text-to-speech (emotion-matched via the same "sticker" mood the pet
// already picks for every reply - see tts.js) ---
app.get('/api/tts/status', requireAuth, (_req, res) => {
  res.json({ enabled: TTS_ENABLED });
});

app.post('/api/tts', requireAuth, async (req, res) => {
  if (!TTS_ENABLED) return res.status(503).json({ ok: false, error: 'Voice replies are not configured.' });
  const { text, sticker } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, error: 'text required.' });
  }
  try {
    const audio = await synthesizeSpeech(text.trim().slice(0, MAX_MESSAGE_LENGTH), sticker);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'no-store');
    res.send(audio);
  } catch (err) {
    console.warn('[tts] synthesis failed:', err.message);
    res.status(502).json({ ok: false, error: 'Voice synthesis failed.' });
  }
});

// --- Web Push subscription management ---
app.get('/api/push/vapid-public-key', requireAuth, (_req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ ok: false, error: 'Push notifications are not configured.' });
  res.json({ key: VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  if (!PUSH_ENABLED) return res.status(503).json({ ok: false, error: 'Push notifications are not configured.' });
  const subscription = req.body || {};
  if (!subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ ok: false, error: 'Invalid subscription.' });
  }
  await pushSubscriptionsCollection.updateOne(
    { endpoint: subscription.endpoint },
    {
      $set: {
        userId: req.session.userId,
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        updatedAt: new Date(),
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ ok: false, error: 'endpoint required.' });
  await pushSubscriptionsCollection.deleteOne({ endpoint, userId: req.session.userId });
  res.json({ ok: true });
});

async function start() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  db = client.db(DB_NAME);
  usersCollection = db.collection('users');
  messagesCollection = db.collection('messages');
  pushSubscriptionsCollection = db.collection('pushSubscriptions');
  petAdminCollection = db.collection('petAdmin');
  storyArcCollection = db.collection('storyArc');
  console.log(`Connected to MongoDB (${MONGO_URL}/${DB_NAME})`);

  const busyUsers = new Set();

  // userId -> Set<socket>, so we know how many tabs/devices this account has
  // open right now and whether any of them is actually in the foreground.
  const userSockets = new Map();

  function isUserVisible(userId) {
    const sockets = userSockets.get(userId);
    if (!sockets) return false; // nothing connected at all counts as "not visible"
    for (const s of sockets) {
      if (s.data.visible) return true;
    }
    return false;
  }

  function notifyUserSockets(userId, payload) {
    const sockets = userSockets.get(userId);
    if (!sockets) return;
    for (const s of sockets) {
      s.emit('pet-message', payload);
    }
  }

  // Lets out-of-band writers (admin.js sending as the pet, nudge-scheduler.js's
  // check-ins) - both separate short-lived processes with no socket
  // connections of their own - reach into this running server after they've
  // already saved a message to Mongo directly, so it can appear live for
  // anyone with the app open right now, or trigger a push for anyone who
  // isn't looking. Loopback-only (server.listen below binds 127.0.0.1) plus
  // a shared secret, since this deliberately bypasses normal session auth.
  app.post('/internal/notify', async (req, res) => {
    if (!INTERNAL_ADMIN_SECRET || req.get('X-Internal-Secret') !== INTERNAL_ADMIN_SECRET) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    const { userId, text, sticker } = req.body || {};
    if (!userId || !text) {
      return res.status(400).json({ ok: false, error: 'userId and text required' });
    }

    notifyUserSockets(userId, { text, sticker: sticker || DEFAULT_STICKER, createdAt: new Date() });

    if (!isUserVisible(userId)) {
      sendPushToUser(pushSubscriptionsCollection, userId, { title: profile.name, body: text, url: '/' }).catch(
        (err) => console.warn(`[internal notify] push send failed for ${userId}:`, err.message)
      );
    }

    res.json({ ok: true });
  });

  // --- Admin panel: web UI for what admin.js already does over SSH ---
  const ADMIN_LIST_FIELDS = { skill: 'extraSkills', like: 'extraLikes', dislike: 'extraDislikes' };

  app.get('/admin/api/status', requireAdminApi, async (_req, res) => {
    const [adminState, arcState, userCount] = await Promise.all([
      petAdmin.getAdminState(petAdminCollection),
      storyArc.getArcState(storyArcCollection),
      usersCollection.countDocuments(),
    ]);
    res.json({
      ok: true,
      petName: profile.name,
      extraSkills: adminState.extraSkills,
      extraLikes: adminState.extraLikes,
      extraDislikes: adminState.extraDislikes,
      todaySpecial: adminState.todaySpecial,
      arc: arcState,
      pushEnabled: PUSH_ENABLED,
      userCount,
      allowedStickers: ALLOWED_STICKERS,
      defaultSticker: DEFAULT_STICKER,
    });
  });

  app.get('/admin/api/users', requireAdminApi, async (_req, res) => {
    const users = await usersCollection
      .find({}, { projection: { username: 1, createdAt: 1 } })
      .sort({ username: 1 })
      .toArray();
    res.json({ ok: true, users: users.map((u) => ({ username: u.username, createdAt: u.createdAt || null })) });
  });

  app.post('/admin/api/send', requireAdminApi, async (req, res) => {
    const { username, message, sticker } = req.body || {};
    const text = String(message || '').trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!username || !text) {
      return res.status(400).json({ ok: false, error: 'username and message are required.' });
    }
    const chosenSticker = sticker && ALLOWED_STICKERS.includes(sticker) ? sticker : DEFAULT_STICKER;

    const user = await usersCollection.findOne({ username: String(username).trim().toLowerCase() });
    if (!user) {
      return res.status(404).json({ ok: false, error: `No user found with username "${username}".` });
    }
    const userId = user._id.toString();

    await messagesCollection.insertOne({
      userId,
      role: 'pet',
      text,
      sticker: chosenSticker,
      createdAt: new Date(),
      adminSent: true,
    });

    // Same live-delivery path as a normal reply: show it instantly on any
    // open tab, push if nobody's currently looking. In-process, so no need
    // to round-trip through /internal/notify like admin.js/nudge-scheduler.js do.
    notifyUserSockets(userId, { text, sticker: chosenSticker, createdAt: new Date() });
    if (!isUserVisible(userId)) {
      sendPushToUser(pushSubscriptionsCollection, userId, { title: profile.name, body: text, url: '/' }).catch((err) =>
        console.warn(`[admin panel] push send failed for ${username}:`, err.message)
      );
    }

    res.json({ ok: true });
  });

  app.post('/admin/api/list/:field/:action', requireAdminApi, async (req, res) => {
    const dbField = ADMIN_LIST_FIELDS[req.params.field];
    const { action } = req.params;
    if (!dbField || !['add', 'remove'].includes(action)) {
      return res.status(400).json({ ok: false, error: 'Unknown list or action.' });
    }
    const text = String((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'text is required.' });

    if (action === 'add') {
      await petAdmin.addToList(petAdminCollection, dbField, text);
    } else {
      await petAdmin.removeFromList(petAdminCollection, dbField, text);
    }
    res.json({ ok: true });
  });

  app.post('/admin/api/special', requireAdminApi, async (req, res) => {
    const { action, text } = req.body || {};
    if (action === 'set') {
      const trimmed = String(text || '').trim();
      if (!trimmed) return res.status(400).json({ ok: false, error: 'text is required to set a special.' });
      await petAdmin.setTodaySpecial(petAdminCollection, trimmed);
    } else if (action === 'clear') {
      await petAdmin.clearTodaySpecial(petAdminCollection);
    } else {
      return res.status(400).json({ ok: false, error: 'action must be "set" or "clear".' });
    }
    res.json({ ok: true });
  });

  app.post('/admin/api/arc/:action', requireAdminApi, async (req, res) => {
    const { action } = req.params;
    try {
      if (action === 'start') {
        const before = await storyArc.getArcState(storyArcCollection);
        if (before.phase !== 'resting') {
          return res.status(409).json({ ok: false, error: `An arc is already in progress (phase: ${before.phase}). Use "reset" first to force a restart.` });
        }
        const newState = await storyArc.forceAdvance(storyArcCollection, new Date(), { generatePremise: generateArcPremise });
        return res.json({ ok: true, arc: newState });
      }
      if (action === 'skip') {
        const newState = await storyArc.forceAdvance(storyArcCollection, new Date(), { generatePremise: generateArcPremise });
        return res.json({ ok: true, arc: newState });
      }
      if (action === 'reset') {
        await storyArc.resetToResting(storyArcCollection);
        const newState = await storyArc.getArcState(storyArcCollection);
        return res.json({ ok: true, arc: newState });
      }
      res.status(400).json({ ok: false, error: 'Unknown arc action.' });
    } catch (err) {
      console.error('[admin panel] arc action failed:', err.message);
      res.status(500).json({ ok: false, error: `Arc action failed: ${err.message}` });
    }
  });

  io.on('connection', async (socket) => {
    const httpSession = socket.request.session;
    if (!httpSession || !httpSession.userId) {
      socket.emit('auth-error', 'Not logged in.');
      socket.disconnect(true);
      return;
    }

    const userId = httpSession.userId;
    const username = httpSession.username;
    const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
    if (!user) {
      socket.emit('auth-error', 'Account not found.');
      socket.disconnect(true);
      return;
    }

    console.log(`${username} connected (socket ${socket.id})`);

    // Assume foreground until told otherwise - the tab just loaded/connected.
    socket.data.visible = true;
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socket);

    socket.on('visibility', (isVisible) => {
      socket.data.visible = Boolean(isVisible);
    });

    // Send prior conversation history for this account so the UI shows
    // continuity across visits, matching the model's own persisted memory.
    const history = await messagesCollection
      .find({ userId })
      .sort({ createdAt: -1 })
      .limit(HISTORY_LIMIT)
      .toArray();
    history.reverse();
    socket.emit(
      'history',
      history.map((m) => ({
        text: m.text,
        who: m.role === 'user' ? 'own' : 'pet',
        sticker: m.role === 'pet' ? m.sticker || DEFAULT_STICKER : undefined,
      }))
    );

    async function callClaude(userMessage, isFirstTurn, sessionIdToUse) {
      // Built fresh on every turn (not cached at startup) so an admin edit
      // via admin.js - a new skill, a like/dislike, today's special note -
      // takes effect on the very next message, no restart needed.
      const systemPrompt = buildSystemPrompt(profile, await petAdmin.getAdminState(petAdminCollection), {
        worldProfile,
        arcState: await storyArc.getArcState(storyArcCollection),
        joinedAt: user.createdAt,
        now: new Date(),
      });
      try {
        return await askPet({
          sessionId: sessionIdToUse,
          isFirstTurn,
          userMessage,
          systemPrompt,
          cwd: CLAUDE_CWD,
          allowedStickers: ALLOWED_STICKERS,
        });
      } catch (err) {
        if (isFirstTurn) throw err; // nothing to fall back to
        // The resumed session may be gone/corrupted - start a fresh one rather than failing outright.
        console.warn(`[${username}] resume failed (${err.message}), starting a fresh Claude session`);
        const freshId = crypto.randomUUID();
        const result = await askPet({
          sessionId: freshId,
          isFirstTurn: true,
          userMessage,
          systemPrompt,
          cwd: CLAUDE_CWD,
          allowedStickers: ALLOWED_STICKERS,
        });
        await usersCollection.updateOne({ _id: user._id }, { $set: { claudeSessionId: freshId, hasClaudeSession: true } });
        result.sessionWasReset = true;
        return result;
      }
    }

    async function sendToPet(userMessage, { synthetic = false } = {}) {
      if (busyUsers.has(userId)) {
        socket.emit('pet-error', "Hold on, I'm still thinking about your last message!");
        return;
      }
      busyUsers.add(userId);
      socket.emit('pet-typing', true);
      try {
        if (!synthetic) {
          await messagesCollection.insertOne({ userId, role: 'user', text: userMessage, createdAt: new Date() });
          // A real reply from the user - cancel any pending check-in streak
          // and push the next possible check-in back out into the future.
          await usersCollection.updateOne(
            { _id: user._id },
            {
              $set: {
                nudgeAttempts: 0,
                nudgeState: 'active',
                nextNudgeDueAt: new Date(Date.now() + randomNudgeDelayMs()),
              },
            }
          );
        }

        const freshUser = await usersCollection.findOne({ _id: user._id });
        const isFirstTurn = !freshUser.hasClaudeSession;
        const sessionIdToUse = freshUser.claudeSessionId || crypto.randomUUID();

        const { text, sticker, sessionWasReset } = await callClaude(userMessage, isFirstTurn, sessionIdToUse);

        if (isFirstTurn) {
          await usersCollection.updateOne(
            { _id: user._id },
            { $set: { claudeSessionId: sessionIdToUse, hasClaudeSession: true } }
          );
        }

        await messagesCollection.insertOne({ userId, role: 'pet', text, sticker, createdAt: new Date() });
        socket.emit('pet-message', { text, sticker, createdAt: new Date() });
        if (sessionWasReset) {
          socket.emit('pet-error', `(${profile.name}'s memory hiccuped a little and had to restart fresh - sorry about that!)`);
        }

        // No tab/device for this user is currently in the foreground (all
        // backgrounded, or the app's fully closed) - also notify via push.
        // Fire-and-forget: a slow or failing push send shouldn't hold up
        // clearing the typing indicator for whoever's actually watching.
        if (!isUserVisible(userId)) {
          sendPushToUser(pushSubscriptionsCollection, userId, { title: profile.name, body: text, url: '/' }).catch(
            (err) => console.warn(`[${username}] push send failed:`, err.message)
          );
        }
      } catch (err) {
        console.error(`[${username}] claude call failed:`, err.message);
        socket.emit(
          'pet-error',
          `${profile.name} got distracted chasing something and lost their train of thought. Try sending that again?`
        );
      } finally {
        busyUsers.delete(userId);
        socket.emit('pet-typing', false);
      }
    }

    // Greet on connect only if this is truly a brand new account with no history yet.
    if (history.length === 0) {
      sendToPet(
        'The person just opened the chat with you for the first time ever. Greet them warmly and briefly, in character, and introduce yourself.',
        { synthetic: true }
      );
    }

    socket.on('message', (text) => {
      text = String(text || '').trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!text) return;
      socket.emit('user-message-echo', { text, createdAt: new Date() });
      sendToPet(text);
    });

    socket.on('disconnect', () => {
      console.log(`${username} disconnected`);
      const sockets = userSockets.get(userId);
      if (sockets) {
        sockets.delete(socket);
        if (sockets.size === 0) userSockets.delete(userId);
      }
    });
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`${profile.name} the ${profile.species} is listening on http://0.0.0.0:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});