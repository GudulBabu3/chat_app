const socket = io();

const messagesEl = document.getElementById('messages');
const statusEl = document.getElementById('pet-status');
const petNameEl = document.getElementById('pet-name');
const typingEl = document.getElementById('typing-indicator');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');
const logoutBtn = document.getElementById('logout-btn');
const micBtn = document.getElementById('mic-btn');
const voiceBtn = document.getElementById('voice-btn');

// Keep this in sync with pet-profile.json's "stickers.guidance" keys.
// Anything outside this list (missing, corrupted, future-mismatched) falls
// back to "neutral" so a bad value never produces a broken image request.
const STICKER_KEYS = new Set([
  'neutral', 'greeting', 'curious', 'playful', 'excited', 'affectionate',
  'sleepy', 'napping', 'hungry', 'startled', 'annoyed', 'laughing', 'sad',
]);
const DEFAULT_STICKER = 'neutral';

function stickerSrc(sticker) {
  const key = STICKER_KEYS.has(sticker) ? sticker : DEFAULT_STICKER;
  return `/stickers/${key}.webp`;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Builds the DOM for one message bubble without inserting it anywhere -
// shared by renderMessage (appends at the bottom, for live/initial messages)
// and prependMessages (inserts at the top, for older history loaded by
// scrolling up) so both paths stay in sync.
function createMessageEl(text, who, sticker) {
  const div = document.createElement('div');
  div.className = `msg ${who}`;

  if (who === 'pet') {
    const img = document.createElement('img');
    img.className = 'sticker-img';
    img.src = stickerSrc(sticker);
    img.alt = sticker || DEFAULT_STICKER;
    img.onerror = () => {
      if (img.src.indexOf(DEFAULT_STICKER) === -1) img.src = stickerSrc(DEFAULT_STICKER);
    };
    div.appendChild(img);
  }

  const row = document.createElement('div');
  row.className = 'msg-row';

  const textEl = document.createElement('div');
  textEl.className = 'msg-text';
  textEl.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
  row.appendChild(textEl);

  // Per-message replay button - lets you hear any pet reply on demand, not
  // just whichever one just arrived live. Hidden via CSS (#messages.tts-enabled)
  // until /api/tts/status confirms voice is actually configured. No audio is
  // cached anywhere for this - see the voice-output section below for why.
  if (who === 'pet') {
    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'msg-play-btn';
    playBtn.title = 'Play this message';
    playBtn.textContent = '▶️';
    playBtn.addEventListener('click', () => playMessageAudio(text, sticker, playBtn));
    row.appendChild(playBtn);
  }

  div.appendChild(row);
  return div;
}

function renderMessage(text, who, sticker) {
  const div = createMessageEl(text, who, sticker);
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

// Inserts a batch of older messages (oldest-first) at the very top of the
// chat in one go, without disturbing what's already rendered below them.
function prependMessages(items) {
  const frag = document.createDocumentFragment();
  items.forEach((m) => {
    frag.appendChild(createMessageEl(m.text, m.who, m.sticker));
  });
  messagesEl.insertBefore(frag, messagesEl.firstChild);
}

fetch('/api/pet')
  .then((r) => r.json())
  .then((info) => {
    if (info && info.name) petNameEl.textContent = info.name;
  })
  .catch(() => {});

// Lets the server know whether this tab is actually in front of the user
// right now, so it only sends a push notification for a live reply when
// every connected tab/device for this account is backgrounded (or gone) -
// no point pinging a phone whose screen is already showing the message.
function reportVisibility() {
  socket.emit('visibility', document.visibilityState === 'visible');
}
document.addEventListener('visibilitychange', reportVisibility);

socket.on('connect', () => {
  statusEl.textContent = 'online';
  reportVisibility(); // sync current state right away - don't wait for the next tab switch
});

socket.on('disconnect', () => {
  statusEl.textContent = 'disconnected - trying to reconnect...';
});

socket.on('auth-error', () => {
  window.location.href = '/login';
});

// --- Infinite-scroll pagination for older history ---
// The initial Socket.IO 'history' event only ever sends the most recent
// HISTORY_LIMIT messages (see server.js); scrolling to the top of #messages
// fetches further back from MongoDB via /api/messages, paged by timestamp.
const HISTORY_PAGE_SIZE = 50; // keep in sync with server.js's HISTORY_LIMIT
let oldestLoadedAt = null;
let hasMoreHistory = true;
let loadingMoreHistory = false;

function trackOldest(items) {
  if (items.length && items[0].createdAt) oldestLoadedAt = new Date(items[0].createdAt);
}

async function loadMoreHistory() {
  if (loadingMoreHistory || !hasMoreHistory || !oldestLoadedAt) return;
  loadingMoreHistory = true;
  try {
    const url = `/api/messages?before=${encodeURIComponent(oldestLoadedAt.toISOString())}&limit=${HISTORY_PAGE_SIZE}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    const items = (data && data.messages) || [];
    if (!items.length) {
      hasMoreHistory = false;
      return;
    }
    // Loading older messages pushes everything below them further down -
    // keep the user's current view pinned to the same message rather than
    // letting the scroll position jump around under them.
    const prevScrollHeight = messagesEl.scrollHeight;
    const prevScrollTop = messagesEl.scrollTop;
    prependMessages(items);
    trackOldest(items);
    hasMoreHistory = Boolean(data.hasMore);
    messagesEl.scrollTop = prevScrollTop + (messagesEl.scrollHeight - prevScrollHeight);
  } catch (err) {
    console.warn('[history] failed to load older messages', err);
  } finally {
    loadingMoreHistory = false;
  }
}

messagesEl.addEventListener('scroll', () => {
  if (messagesEl.scrollTop < 80) loadMoreHistory();
});

socket.on('history', (payload) => {
  const messages = (payload && payload.messages) || [];
  messagesEl.innerHTML = '';
  messages.forEach((m) => renderMessage(m.text, m.who, m.sticker));
  trackOldest(messages);
  hasMoreHistory = Boolean(payload && payload.hasMore);
});

socket.on('user-message-echo', (payload) => {
  renderMessage(payload.text, 'own');
});

socket.on('pet-message', (payload) => {
  const div = renderMessage(payload.text, 'pet', payload.sticker);
  if (voiceEnabled) playMessageAudio(payload.text, payload.sticker, div.querySelector('.msg-play-btn'));
});

socket.on('pet-error', (message) => {
  renderMessage(message, 'system');
});

socket.on('pet-typing', (isTyping) => {
  typingEl.classList.toggle('hidden', !isTyping);
  if (isTyping) scrollToBottom();
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  socket.emit('message', text);
  input.value = '';
});

if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  });
}

// --- Voice input (speech-to-text) ---
// Browser-native Web Speech API - free, no server round-trip, no API key.
// Chrome/Edge/Android support it well; Safari/iOS and Firefox don't expose
// SpeechRecognition at all, so the mic button just stays hidden there (iOS
// users still get voice input for free via the keyboard's own dictation key).
const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizing = false;
let recognition = null;

if (micBtn && SpeechRecognitionImpl) {
  recognition = new SpeechRecognitionImpl();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.addEventListener('result', (event) => {
    const transcript = event.results[0][0].transcript;
    input.value = transcript;
    input.focus();
  });

  recognition.addEventListener('end', () => {
    recognizing = false;
    micBtn.classList.remove('recording');
  });

  recognition.addEventListener('error', (event) => {
    recognizing = false;
    micBtn.classList.remove('recording');
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      renderMessage(`(Couldn't hear that - ${event.error === 'not-allowed' ? 'microphone permission was denied' : event.error}. Try again?)`, 'system');
    }
  });

  micBtn.addEventListener('click', () => {
    if (recognizing) {
      recognition.stop();
      return;
    }
    try {
      recognition.start();
      recognizing = true;
      micBtn.classList.add('recording');
    } catch (_) {
      // start() throws if called again before the previous session fully
      // ended - safe to ignore, the button just won't visibly react once.
    }
  });

  micBtn.classList.remove('hidden');
}

// --- Voice output (text-to-speech, emotion-matched via Azure) ---
// Server tells us up front whether AZURE_SPEECH_KEY/AZURE_SPEECH_REGION are
// actually configured, so the speaker button and per-message play buttons
// never appear if voice replies wouldn't work anyway.
//
// No audio is cached anywhere, client or server - every play, live or
// replayed, POSTs the message's text+sticker to /api/tts and Azure
// regenerates the MP3 fresh each time. The text/sticker for every message is
// already stored in Mongo for the chat history itself, so replaying an old
// message needs no new storage, no retention policy, and no cleanup job.
// The tradeoff is a ~1s wait and a small Azure quota hit per replay, which
// is fine since replaying is a deliberate, occasional tap rather than
// something that happens in bulk.
const VOICE_PREF_KEY = 'tukuru-voice-enabled';
let voiceEnabled = localStorage.getItem(VOICE_PREF_KEY) === 'true';
let currentAudio = null;
let currentPlayBtn = null;

function updateVoiceBtn() {
  if (!voiceBtn) return;
  voiceBtn.textContent = voiceEnabled ? '🔊' : '🔇';
  voiceBtn.classList.toggle('active', voiceEnabled);
  voiceBtn.title = voiceEnabled ? 'Voice replies on - tap to mute' : 'Voice replies off - tap to enable';
}

function setBtnPlaying(btn, playing) {
  if (!btn) return;
  btn.textContent = playing ? '⏸️' : '▶️';
  btn.classList.toggle('playing', playing);
}

function stopSpeaking() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
  }
  setBtnPlaying(currentPlayBtn, false);
  currentAudio = null;
  currentPlayBtn = null;
}

// Plays a message's voice, or - if this exact button's audio is already
// playing - pauses it instead (tapping the same play button twice acts as
// play/pause). `btn` is optional: the auto-play-on-arrival call from the
// pet-message handler passes the new message's own button so its icon
// reflects playback, but this also works standalone.
async function playMessageAudio(text, sticker, btn) {
  if (!text) return;
  if (btn && btn === currentPlayBtn && currentAudio) {
    stopSpeaking();
    return;
  }
  stopSpeaking();
  setBtnPlaying(btn, true);
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sticker }),
    });
    if (!res.ok) {
      setBtnPlaying(btn, false);
      return; // voice is a bonus on top of text chat, fail silently
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    currentPlayBtn = btn || null;
    audio.addEventListener('ended', () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) {
        setBtnPlaying(btn, false);
        currentAudio = null;
        currentPlayBtn = null;
      }
    });
    // Browsers can block autoplay before any user gesture on the page (e.g.
    // the very first greeting on a fresh load) - that's expected, not an
    // error. A manual button click always counts as a user gesture, so this
    // only ever bites the very first auto-played message.
    await audio.play().catch(() => {
      if (currentAudio === audio) {
        setBtnPlaying(btn, false);
        currentAudio = null;
        currentPlayBtn = null;
      }
    });
  } catch (err) {
    console.warn('[voice] play failed', err);
    setBtnPlaying(btn, false);
    if (currentPlayBtn === btn) {
      currentAudio = null;
      currentPlayBtn = null;
    }
  }
}

fetch('/api/tts/status')
  .then((r) => r.json())
  .then((info) => {
    if (info && info.enabled) {
      messagesEl.classList.add('tts-enabled'); // reveals every msg-play-btn
      if (voiceBtn) {
        voiceBtn.classList.remove('hidden');
        updateVoiceBtn();
      }
    }
  })
  .catch(() => {});

if (voiceBtn) {
  voiceBtn.addEventListener('click', () => {
    voiceEnabled = !voiceEnabled;
    localStorage.setItem(VOICE_PREF_KEY, String(voiceEnabled));
    updateVoiceBtn();
    if (!voiceEnabled) stopSpeaking();
  });
}
