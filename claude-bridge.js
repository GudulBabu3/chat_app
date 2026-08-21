// Wraps the `claude` CLI as a one-shot, session-continuable text generator.
// Each browser chat session maps to one Claude Code session ID: the first
// turn creates it with --session-id, every later turn continues it with
// --resume, so Claude Code's own transcript storage is what gives the pet
// its memory of the conversation - we don't reconstruct history ourselves.

const { execFile } = require('child_process');
const { execFileSync } = require('child_process');

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

module.exports = { askPet, CLAUDE_BIN, DEFAULT_STICKER, extractStickerReply };
