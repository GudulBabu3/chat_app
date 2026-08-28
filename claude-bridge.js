// Wraps the `claude` CLI as a one-shot, session-continuable text generator.
// Each browser chat session maps to one Claude Code session ID: the first
// turn creates it with --session-id, every later turn continues it with
// --resume, so Claude Code's own transcript storage is what gives the pet
// its memory of the conversation - we don't reconstruct history ourselves.

const { execFile } = require('child_process');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const CALL_TIMEOUT_MS = 60_000;
const MAX_BUDGET_USD = '0.50';
const MODEL = process.env.CLAUDE_MODEL || 'sonnet';
const DEFAULT_STICKER = 'neutral';

// Safety net for the rare case where structured output isn't available and we
// fall back to parsing plain text. Strips "*action text*" stage directions
// and emoji so a format slip doesn't leak visibly broken-looking text into
// the chat.
function stripActionTextAndEmoji(text) {
  return text
    .replace(/\*[^*]*\*/g, '') // remove *action text* segments
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '') // remove emoji
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Builds a JSON Schema for the --json-schema flag, constraining "sticker" to
// exactly the allowed keys so the CLI enforces this itself rather than us
// hoping the model happens to pick a valid one.
function buildJsonSchema(allowedStickers) {
  return JSON.stringify({
    type: 'object',
    properties: {
      sticker: { type: 'string', enum: allowedStickers },
      message: { type: 'string' },
    },
    required: ['sticker', 'message'],
    additionalProperties: false,
  });
}

// Fallback path only - used if structured_output is ever missing from the
// CLI response. Tolerates stray markdown fences or extra whitespace, and
// falls back further to cleaned plain text if even that fails, so a single
// malformed reply never breaks the chat.
function extractStickerReply(rawText, allowedStickers) {
  const cleaned = String(rawText || '')
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();

  let jsonSlice = cleaned;
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonSlice = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(jsonSlice);
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    const sticker =
      typeof parsed.sticker === 'string' && allowedStickers.includes(parsed.sticker)
        ? parsed.sticker
        : DEFAULT_STICKER;
    if (message) return { message, sticker };
  } catch (_) {
    // fall through to the plain-text fallback below
  }

  // Model didn't follow the JSON format this one time - still show something
  // sensible rather than erroring the whole turn out, but clean up any
  // asterisk actions/emoji that would otherwise look broken on screen.
  return { message: stripActionTextAndEmoji(cleaned), sticker: DEFAULT_STICKER };
}

function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    const found = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
    if (found) return found;
  } catch (_) {
    // fall through
  }
  const home = process.env.HOME || '/root';
  return `${home}/.local/bin/claude`;
}

const CLAUDE_BIN = resolveClaudeBin();

/**
 * @param {object} opts
 * @param {string} opts.sessionId - UUID for this browser chat session
 * @param {boolean} opts.isFirstTurn - true for the very first message in this session
 * @param {string} opts.userMessage - the raw text the human typed
 * @param {string} opts.systemPrompt - the full persona system prompt
 * @param {string} opts.cwd - working directory to run claude in (should contain no CLAUDE.md/project config)
 * @param {string[]} opts.allowedStickers - valid sticker keys; anything else falls back to "neutral"
 * @returns {Promise<{ text: string, sticker: string, costUsd: number|null }>}
 */
function askPet({ sessionId, isFirstTurn, userMessage, systemPrompt, cwd, allowedStickers }) {
  const args = [
    '-p', userMessage,
    isFirstTurn ? '--session-id' : '--resume', sessionId,
    '--system-prompt', systemPrompt,
    '--output-format', 'json',
    '--json-schema', buildJsonSchema(allowedStickers || []),
    '--tools', '',
    '--strict-mcp-config',
    '--model', MODEL,
    '--fallback-model', MODEL,
    '--max-budget-usd', MAX_BUDGET_USD,
  ];

  return new Promise((resolve, reject) => {
    execFile(
      CLAUDE_BIN,
      args,
      { cwd, timeout: CALL_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`claude CLI failed: ${err.message}${stderr ? ` | stderr: ${stderr}` : ''}`));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch (parseErr) {
          reject(new Error(`Could not parse claude CLI output as JSON: ${parseErr.message} | raw: ${stdout.slice(0, 500)}`));
          return;
        }
        if (parsed.is_error) {
          reject(new Error(`claude CLI reported an error: ${parsed.result || 'unknown error'}`));
          return;
        }

        let message, sticker;
        const structured = parsed.structured_output;
        if (structured && typeof structured.message === 'string' && structured.message.trim()) {
          message = structured.message.trim();
          sticker =
            typeof structured.sticker === 'string' && (allowedStickers || []).includes(structured.sticker)
              ? structured.sticker
              : DEFAULT_STICKER;
        } else {
          // structured_output missing/empty - fall back to parsing parsed.result as text/JSON
          ({ message, sticker } = extractStickerReply(parsed.result, allowedStickers || []));
        }

        // The schema guarantees valid JSON structure, but not that the model
        // kept asterisk actions/emoji out of the message text itself - clean
        // that up regardless of which branch produced the message.
        if (message) {
          const cleaned = stripActionTextAndEmoji(message);
          if (cleaned) message = cleaned;
        }

        resolve({
          text: message,
          sticker,
          costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
        });
      }
    );
  });
}

// One-shot, non-conversational call: invents a brand-new story premise for
// the next Dino-Day arc cycle. Unlike askPet(), this never resumes a prior
// session (each call is fully independent - there's nothing to continue),
// and its output schema is a story premise, not a sticker/message reply.
//
// Returns null (never throws) on any failure - callers should treat that as
// "no premise this time" and fall back to hand-written default content,
// rather than letting a network/CLI hiccup break the story feature.
function buildPremiseJsonSchema() {
  return JSON.stringify({
    type: 'object',
    properties: {
      title: { type: 'string' },
      opening: { type: 'string' },
      escalation: { type: 'string' },
      confrontation: { type: 'string' },
      resolution: { type: 'string' },
    },
    required: ['title', 'opening', 'escalation', 'confrontation', 'resolution'],
    additionalProperties: false,
  });
}

function buildPremisePrompt({ worldProfile, pastTitles }) {
  const villain = worldProfile.villain;
  const friendLines = (worldProfile.friends || [])
    .map((f) => `- ${f.name} (${f.species}${f.role ? `, ${f.role}` : ''}): ${f.personality.join(', ')}${f.partner ? ` - paired up with ${f.partner}` : ''}`)
    .join('\n');
  const avoidBlock = (pastTitles || []).length
    ? `\n\nStorylines already used in past cycles (write something meaningfully different from all of these - a different friend targeted, a different scheme, a different comedic hook):\n${pastTitles.map((t) => `- ${t}`).join('\n')}`
    : '';

  return `You are helping design one new story arc for a recurring comedic villain subplot in a chat-companion app. Invent a brand-new, specific storyline for this cycle - do not write a generic template.

VILLAIN: ${villain.name}, a ${villain.species}. ${villain.appearance}. Personality: ${villain.personality.join(', ')}. Wants: ${villain.wants}

FRIEND GROUP (TukuruMukuru's friends - draw on these, especially for who gets targeted in the escalation beat):
${friendLines}

The arc always has this same four-part shape, but you invent the specific plot each time:
- OPENING: the villain reappears, demanding admiration in some new specific way, and starts individually pushing one or more friends around in small selfish ways. Comedic, not yet alarming.
- ESCALATION: his scheme gets pettier and more selfish, and MUST include one specific, genuinely mean/hurtful beat targeting one particular friend by name (not just generic annoyance) - something that would make TukuruMukuru truly worried and protective, while the overall situation stays absurd/comedic in its specifics.
- CONFRONTATION: the whole friend group teams up against him for a big, comedic climactic showdown.
- RESOLUTION: he's humbled and driven off, vowing to return; the group celebrates and reconnects.

Write 2-4 sentences of specific narrative direction for each of the four phases - concrete enough that the arc feels fresh and distinct, but written as loose direction for another AI to improvise from in conversation, not as a scripted scene or dialogue. Also give it a short (under 8 words) title.${avoidBlock}`;
}

function generateStoryPremise({ worldProfile, pastTitles, cwd }) {
  const args = [
    '-p', buildPremisePrompt({ worldProfile, pastTitles }),
    '--session-id', crypto.randomUUID(), // fresh, one-shot - never resumed
    '--output-format', 'json',
    '--json-schema', buildPremiseJsonSchema(),
    '--tools', '',
    '--strict-mcp-config',
    '--model', MODEL,
    '--fallback-model', MODEL,
    '--max-budget-usd', MAX_BUDGET_USD,
  ];

  return new Promise((resolve) => {
    execFile(
      CLAUDE_BIN,
      args,
      { cwd, timeout: CALL_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          console.error('[story premise] claude CLI failed:', err.message);
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          const structured = parsed.structured_output;
          if (
            structured &&
            typeof structured.title === 'string' &&
            typeof structured.opening === 'string' &&
            typeof structured.escalation === 'string' &&
            typeof structured.confrontation === 'string' &&
            typeof structured.resolution === 'string'
          ) {
            resolve(structured);
          } else {
            console.error('[story premise] missing/invalid structured_output:', String(stdout).slice(0, 500));
            resolve(null);
          }
        } catch (parseErr) {
          console.error('[story premise] could not parse claude CLI output:', parseErr.message);
          resolve(null);
        }
      }
    );
  });
}

module.exports = { askPet, generateStoryPremise, CLAUDE_BIN, DEFAULT_STICKER, extractStickerReply };
