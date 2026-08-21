const socket = io();

const messagesEl = document.getElementById('messages');
const statusEl = document.getElementById('pet-status');
const petNameEl = document.getElementById('pet-name');
const typingEl = document.getElementById('typing-indicator');
const form = document.getElementById('message-form');
const input = document.getElementById('message-input');
const logoutBtn = document.getElementById('logout-btn');

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

socket.on('connect', () => {
  statusEl.textContent = 'online';
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
