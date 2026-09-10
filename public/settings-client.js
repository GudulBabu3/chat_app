(function () {
  const VOICE_PREF_KEY = 'tukuru-voice-enabled';
  const voiceBtn = document.getElementById('voice-setting-btn');
  const voiceCopy = document.getElementById('voice-setting-copy');
  const logoutBtn = document.getElementById('settings-logout-btn');

  function setVoiceState(enabled) {
    if (!voiceBtn) return;
    voiceBtn.classList.toggle('active', enabled);
    voiceBtn.setAttribute('aria-pressed', String(enabled));
    voiceBtn.innerHTML = `<span aria-hidden="true">${enabled ? '🔊' : '🔇'}</span> ${enabled ? 'On' : 'Off'}`;
  }

  let voiceEnabled = localStorage.getItem(VOICE_PREF_KEY) === 'true';
  setVoiceState(voiceEnabled);

  fetch('/api/tts/status')
    .then((response) => response.json())
    .then((info) => {
      if (info && info.enabled) return;
      voiceEnabled = false;
      localStorage.setItem(VOICE_PREF_KEY, 'false');
      setVoiceState(false);
      if (voiceBtn) voiceBtn.disabled = true;
      if (voiceCopy) voiceCopy.textContent = 'Spoken replies are not configured on this server yet.';
    })
    .catch(() => {
      if (voiceBtn) voiceBtn.disabled = true;
      if (voiceCopy) voiceCopy.textContent = 'Voice availability could not be checked.';
    });

  if (voiceBtn) {
    voiceBtn.addEventListener('click', () => {
      voiceEnabled = !voiceEnabled;
      localStorage.setItem(VOICE_PREF_KEY, String(voiceEnabled));
      setVoiceState(voiceEnabled);
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      logoutBtn.disabled = true;
      try {
        await fetch('/api/logout', { method: 'POST' });
      } finally {
        window.location.href = '/login';
      }
    });
  }
})();
