// Wraps the `claude` CLI as a one-shot, session-continuable text generator.
// Each browser chat session maps to one Claude Code session ID: the first
// turn creates it with --session-id, every later turn continues it with
// --resume, so Claude Code's own transcript storage is what gives the pet
// its memory of the conversation - we don't reconstruct history ourselves.

const { execFile } = require('child_process');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const { PHASE_DAY_RANGE } = require('./story-arc');

// Max possible length of each phase (the upper end of story-arc.js's
// PHASE_DAY_RANGE) - how many day-by-day beats to ask Claude to generate
// per phase when inventing a premise. A given cycle's actual phase length
// is randomized within that range and may end up shorter, in which case
// the trailing beats simply go unused - see persona.js's dayIndexInPhase.
const MAX_PHASE_DAYS = {
  opening: PHASE_DAY_RANGE.opening[1],
  escalation: PHASE_DAY_RANGE.escalation[1],
  confrontation: PHASE_DAY_RANGE.confrontation[1],
  resolution: PHASE_DAY_RANGE.resolution[1],
};

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
// Each phase field is now an array of day-by-day beats (one entry per
// possible day the phase could run, per MAX_PHASE_DAYS above) instead of a
// single static block of guidance - so a phase that runs several days
// (e.g. escalation, 3-5 days) has genuinely different, progressing content
// for each day instead of the same guidance repeated. Exact-length arrays
// so the CLI enforces the count itself rather than hoping the model
// produces enough.
function buildPremiseJsonSchema(maxDays) {
  const dayArray = (n) => ({ type: 'array', items: { type: 'string' }, minItems: n, maxItems: n });
  return JSON.stringify({
    type: 'object',
    properties: {
      title: { type: 'string' },
      opening: dayArray(maxDays.opening),
      escalation: dayArray(maxDays.escalation),
      confrontation: dayArray(maxDays.confrontation),
      resolution: dayArray(maxDays.resolution),
    },
    required: ['title', 'opening', 'escalation', 'confrontation', 'resolution'],
    additionalProperties: false,
  });
}

function buildPremisePrompt({ worldProfile, pastTitles, maxDays }) {
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

The arc always has this same four-part shape, but you invent the specific plot each time. Crucially, each phase can run several days in a row, and it must NOT feel like the same static situation repeated every day - write each phase as a DAY-BY-DAY PROGRESSION where every entry is a distinct, concrete new development that clearly moves the plot forward from the entry before it (day 2 builds on day 1's specific event, references what already happened, and escalates or complicates it - never just restates day 1 in different words):

- OPENING (exactly ${maxDays.opening} day-by-day entries): the villain reappears, demanding admiration in some new specific way, and starts individually pushing one or more friends around in small selfish ways - each day a new small incident, building up. Comedic, not yet alarming.
- ESCALATION (exactly ${maxDays.escalation} day-by-day entries): his scheme gets pettier and more selfish day by day, and the entries together MUST build to one specific, genuinely mean/hurtful beat targeting one particular friend by name (not just generic annoyance) by the final entry - something that would make TukuruMukuru truly worried and protective, while the overall situation stays absurd/comedic in its specifics.
- CONFRONTATION (exactly ${maxDays.confrontation} day-by-day entries): the whole friend group's plan against him unfolds and escalates day by day into a big, comedic climactic showdown by the final entry.
- RESOLUTION (exactly ${maxDays.resolution} day-by-day entries): he's humbled and driven off, vowing to return; the day-by-day entries cover the immediate aftermath through the group celebrating and reconnecting.

Each entry: 1-3 sentences, specific and concrete, written as loose direction for another AI to improvise dialogue from in conversation - not a scripted scene or dialogue itself. Also give the whole arc a short (under 8 words) title.${avoidBlock}`;
}

// A phase field is valid if it's a non-empty array of non-empty strings -
// tolerant of the model coming up slightly short on count (still usable,
// see persona.js's clamping) rather than requiring an exact match to
// MAX_PHASE_DAYS, so a minor generation shortfall doesn't discard an
// otherwise-good premise.
function isValidBeatArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.trim());
}

function generateStoryPremise({ worldProfile, pastTitles, cwd, maxDays = MAX_PHASE_DAYS }) {
  const args = [
    '-p', buildPremisePrompt({ worldProfile, pastTitles, maxDays }),
    '--session-id', crypto.randomUUID(), // fresh, one-shot - never resumed
    '--output-format', 'json',
    '--json-schema', buildPremiseJsonSchema(maxDays),
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
            isValidBeatArray(structured.opening) &&
            isValidBeatArray(structured.escalation) &&
            isValidBeatArray(structured.confrontation) &&
            isValidBeatArray(structured.resolution)
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
