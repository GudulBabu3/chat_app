// Text-to-speech via Azure Cognitive Services' REST TTS endpoint.
//
// Deliberately NOT using the microsoft-cognitiveservices-speech-sdk npm
// package here - that SDK pulls in a websocket-based native runtime that's
// overkill for "POST some SSML, get an MP3 back" and adds real memory
// overhead on the 1GB-RAM Oracle VM this app runs on. A single HTTPS POST
// with Node's built-in fetch does the same job with zero new dependencies.
//
// Emotion comes for free from the "sticker" key the pet already picks for
// every reply (see persona.js's prompt / claude-bridge.js's schema) - no
// separate emotion-detection step needed. STICKER_VOICE_STYLE maps each of
// the 13 sticker keys (pet-profile.json's stickers.guidance) to an Azure
// neural voice "style" (mstts:express-as) plus a rate/pitch nudge, so the
// same line of text is spoken differently depending on mood.

const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY || '';
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || '';
// JennyNeural has one of the broadest style libraries of Azure's neural
// voices and reads well as a small, expressive animal character. Override
// via env if you'd rather use a different voice/region's offering.
const AZURE_TTS_VOICE = process.env.AZURE_TTS_VOICE || 'en-US-JennyNeural';
const TTS_ENABLED = Boolean(AZURE_SPEECH_KEY && AZURE_SPEECH_REGION);

// style/styledegree are Azure's mstts:express-as values (JennyNeural
// supports: angry, cheerful, sad, excited, friendly, terrified, shouting,
// unfriendly, whispering, hopeful, plus a few assistant/chat/newscast ones
// that don't fit a companion-animal reply). rate/pitch are <prosody> nudges
// layered on top - used alone (style: null) for moods Azure has no
// matching style for, and combined with a style elsewhere for extra "oomph".
const STICKER_VOICE_STYLE = {
  neutral: { style: null, rate: '0%', pitch: '+0%' },
  greeting: { style: 'friendly', styledegree: 1.1, rate: '+5%', pitch: '+3%' },
  curious: { style: 'friendly', styledegree: 0.9, rate: '+2%', pitch: '+6%' },
  playful: { style: 'cheerful', styledegree: 1.3, rate: '+8%', pitch: '+5%' },
  excited: { style: 'excited', styledegree: 1.5, rate: '+12%', pitch: '+8%' },
  affectionate: { style: 'friendly', styledegree: 0.8, rate: '-5%', pitch: '-2%' },
  sleepy: { style: null, rate: '-15%', pitch: '-6%' },
  napping: { style: 'whispering', rate: '-20%', pitch: '-8%' },
  hungry: { style: 'cheerful', styledegree: 0.7, rate: '+3%', pitch: '+2%' },
  startled: { style: 'excited', styledegree: 1.2, rate: '+15%', pitch: '+10%' },
  annoyed: { style: 'unfriendly', styledegree: 0.7, rate: '+2%', pitch: '-3%' },
  laughing: { style: 'cheerful', styledegree: 1.4, rate: '+10%', pitch: '+6%' },
  sad: { style: 'sad', styledegree: 1.0, rate: '-10%', pitch: '-5%' },
};
const DEFAULT_VOICE_STYLE = STICKER_VOICE_STYLE.neutral;

function escapeSsml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSsml(text, sticker) {
  const cfg = STICKER_VOICE_STYLE[sticker] || DEFAULT_VOICE_STYLE;
  const escaped = escapeSsml(text);
  const prosodyEl = `<prosody rate="${cfg.rate || '0%'}" pitch="${cfg.pitch || '+0%'}">${escaped}</prosody>`;
  const voiceInner = cfg.style
    ? `<mstts:express-as style="${cfg.style}"${cfg.styledegree ? ` styledegree="${cfg.styledegree}"` : ''}>${prosodyEl}</mstts:express-as>`
    : prosodyEl;
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">` +
    `<voice name="${AZURE_TTS_VOICE}">${voiceInner}</voice></speak>`
  );
}

// Returns a Buffer of MP3 audio, or throws. Callers should treat a throw as
// "voice unavailable this time" and fail soft (text chat still works) -
// this is a bonus feature, not core functionality.
async function synthesizeSpeech(text, sticker) {
  if (!TTS_ENABLED) {
    throw new Error('Azure Speech is not configured (AZURE_SPEECH_KEY/AZURE_SPEECH_REGION missing).');
  }
  const ssml = buildSsml(text, sticker);
  const url = `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'tukurumukuru-chat-app',
    },
    body: ssml,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Azure TTS request failed: ${res.status} ${res.statusText} ${errText.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { TTS_ENABLED, synthesizeSpeech, STICKER_VOICE_STYLE, AZURE_TTS_VOICE };
