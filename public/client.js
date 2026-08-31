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

function renderMessage(text, who, sticker) {
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

  const textEl = document.createElement('div');
  textEl.className = 'msg-text';
  textEl.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
  div.appendChild(textEl);

  messagesEl.appendChild(div);
  scrollToBottom();
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

socket.on('history', (messages) => {
  messagesEl.innerHTML = '';
  messages.forEach((m) => renderMessage(m.text, m.who, m.sticker));
});

socket.on('user-message-echo', (payload) => {
  renderMessage(payload.text, 'own');
});

socket.on('pet-message', (payload) => {
  renderMessage(payload.text, 'pet', payload.sticker);
  speak(payload.text, payload.sticker);
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
// actually configured, so the speaker button never appears if voice replies
// wouldn't work anyway.
const VOICE_PREF_KEY = 'tukuru-voice-enabled';
let voiceEnabled = localStorage.getItem(VOICE_PREF_KEY) === 'true';
let currentAudio = null;

function updateVoiceBtn() {
  if (!voiceBtn) return;
  voiceBtn.textContent = voiceEnabled ? '🔊' : '🔇';
  voiceBtn.classList.toggle('active', voiceEnabled);
  voiceBtn.title = voiceEnabled ? 'Voice replies on - tap to mute' : 'Voice replies off - tap to enable';
}

function stopSpeaking() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
}

async function speak(text, sticker) {
  if (!voiceEnabled || !text || !voiceBtn || voiceBtn.classList.contains('hidden')) return;
  stopSpeaking();
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sticker }),
    });
    if (!res.ok) return; // voice is a bonus on top of text chat, fail silently
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    currentAudio = new Audio(url);
    currentAudio.addEventListener('ended', () => URL.revokeObjectURL(url));
    // Browsers can block autoplay before any user gesture on the page (e.g.
    // the very first greeting on a fresh load) - that's expected, not an error.
    await currentAudio.play().catch(() => {});
  } catch (err) {
    console.warn('[voice] speak failed', err);
  }
}

if (voiceBtn) {
  fetch('/api/tts/status')
    .then((r) => r.json())
    .then((info) => {
      if (info && info.enabled) {
        voiceBtn.classList.remove('hidden');
        updateVoiceBtn();
      }
    })
    .catch(() => {});

  voiceBtn.addEventListener('click', () => {
    voiceEnabled = !voiceEnabled;
    localStorage.setItem(VOICE_PREF_KEY, String(voiceEnabled));
    updateVoiceBtn();
    if (!voiceEnabled) stopSpeaking();
  });
}
