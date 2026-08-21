const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');

const { loadProfile, buildSystemPrompt } = require('./persona');
const { askPet } = require('./claude-bridge');
const { verifyPassword, isRateLimited, recordAttempt, clearAttempts } = require('./auth');

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'petchat';
const MAX_MESSAGE_LENGTH = 2000;
const HISTORY_LIMIT = 50;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// Dedicated, empty working directory for claude CLI calls so it never picks
// up this project's own files, CLAUDE.md, or git context as extra "memory".
const CLAUDE_CWD = path.join(__dirname, '.claude-cwd');
if (!fs.existsSync(CLAUDE_CWD)) fs.mkdirSync(CLAUDE_CWD, { recursive: true });

const profile = loadProfile();
const SYSTEM_PROMPT = buildSystemPrompt(profile);
const ALLOWED_STICKERS = Object.keys(profile.stickers.guidance);
const DEFAULT_STICKER = profile.stickers.default || 'neutral';

const app = express();
app.set('trust proxy', 1); // needed so secure cookies work correctly behind Tailscale Funnel
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server);

let db, usersCollection, messagesCollection;

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

// --- Protected app + assets ---
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'chat.html'));
});

app.get('/api/pet', requireAuth, (req, res) => {
  res.json({ name: profile.name, species: profile.species, username: req.session.username });
});

async function start() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  db = client.db(DB_NAME);
  usersCollection = db.collection('users');
  messagesCollection = db.collection('messages');
  console.log(`Connected to MongoDB (${MONGO_URL}/${DB_NAME})`);

  const busyUsers = new Set();

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
      try {
        return await askPet({
          sessionId: sessionIdToUse,
          isFirstTurn,
          userMessage,
          systemPrompt: SYSTEM_PROMPT,
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
          systemPrompt: SYSTEM_PROMPT,
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
