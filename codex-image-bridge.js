// Standalone HTTP service, NOT part of the main chat-app server process and
// NOT meant to run on production (the Oracle VM). This runs only on
// NPN-old, started as its own pm2 process alongside (but separate from)
// chat-app, and does exactly one thing: take a text prompt, ask the
// locally-logged-in Codex CLI (authenticated via a ChatGPT subscription,
// no API key - see dev-workflow-and-infra-notes.md in the project docs) to
// generate an image, and return the PNG bytes.
//
// story-image.js on production (Oracle VM) is the only caller, reaching
// this over the private Tailscale tailnet (never through NPN-old's public
// Funnel URL - this binds to the tailnet interface specifically, not
// 0.0.0.0, so it's simply unreachable from the public internet regardless).
// A shared secret (STORY_IMAGE_BRIDGE_SECRET, must match on both sides)
// is the only auth - same shape as the main app's INTERNAL_ADMIN_SECRET.
//
// Usage: node codex-image-bridge.js   (run via pm2 on NPN-old, not cron -
// this needs to be listening continuously, unlike the daily *-scheduler.js
// scripts elsewhere in this repo)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fs = require('fs');
const os = require('os');
const express = require('express');
const { spawn } = require('child_process');

const PORT = process.env.CODEX_BRIDGE_PORT || 3900;
// Bind to this machine's own tailnet IP specifically (not 0.0.0.0) so this
// is only ever reachable over the tailnet, never the LAN or localhost-only
// tools that might otherwise assume 127.0.0.1. Override via env if this
// machine's Tailscale IP ever changes (tailscale ip -4).
const BIND_HOST = process.env.CODEX_BRIDGE_HOST || '100.73.241.31';
const BRIDGE_SECRET = process.env.STORY_IMAGE_BRIDGE_SECRET || '';
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const GENERATED_IMAGES_DIR = path.join(CODEX_HOME, 'generated_images');
// Same idea as the .claude-cwd scratch directories used elsewhere in this
// repo for the claude CLI - gives codex its own empty working directory so
// `codex exec` never treats this repo as "the project" it's working in.
const CODEX_CWD = path.join(__dirname, '.codex-bridge-cwd');
if (!fs.existsSync(CODEX_CWD)) fs.mkdirSync(CODEX_CWD, { recursive: true });

// codex exec's own image generation can genuinely take a while (it's a
// real model call, not a lookup) - bounded so a wedged/hung process can't
// pile up forever, but generous enough not to false-fail a normal run.
const CODEX_TIMEOUT_MS = 110_000;

if (!BRIDGE_SECRET) {
  console.warn('[codex-image-bridge] STORY_IMAGE_BRIDGE_SECRET not set - refusing all requests until it is.');
}

// Only one codex exec at a time - this only ever needs to serve one request
// a day, and serializing avoids two runs' generated-image folders getting
// picked up by each other's "find the newest file" logic.
let busy = false;

function runCodexExec(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['exec', '--skip-git-repo-check'], { cwd: CODEX_CWD });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('codex exec timed out'));
    }, CODEX_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`codex exec exited ${code}: ${stderr.slice(0, 500)}`));
      resolve();
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Recursively finds the most recently modified .png under
// ~/.codex/generated_images (one session-uuid subfolder per codex exec
// call - see dev-workflow-and-infra-notes.md for how this was confirmed).
// Only returns files newer than `sinceMs` so a request that failed to
// actually produce anything new can't accidentally return a stale image
// from an earlier run.
function findNewestPngSince(dir, sinceMs) {
  let newest = null;
  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png')) {
        const stat = fs.statSync(full);
        if (stat.mtimeMs >= sinceMs && (!newest || stat.mtimeMs > newest.mtimeMs)) {
          newest = { path: full, mtimeMs: stat.mtimeMs };
        }
      }
    }
  }
  walk(dir);
  return newest ? newest.path : null;
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/generate', async (req, res) => {
  if (!BRIDGE_SECRET || req.get('X-Bridge-Secret') !== BRIDGE_SECRET) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const prompt = String((req.body || {}).prompt || '').trim();
  if (!prompt) {
    return res.status(400).json({ ok: false, error: 'prompt required' });
  }
  if (busy) {
    return res.status(409).json({ ok: false, error: 'a generation is already in progress' });
  }

  busy = true;
  const startedAt = Date.now() - 2000; // small buffer for clock skew
  try {
    await runCodexExec(prompt);
    const imagePath = findNewestPngSince(GENERATED_IMAGES_DIR, startedAt);
    if (!imagePath) {
      return res.status(502).json({ ok: false, error: 'codex exec finished but produced no new image' });
    }
    const buffer = await fs.promises.readFile(imagePath);
    res.set('Content-Type', 'image/png');
    res.send(buffer);
    console.log(`[codex-image-bridge] generated ${imagePath} (${buffer.length} bytes).`);
  } catch (err) {
    console.error('[codex-image-bridge] generation failed:', err.message);
    res.status(502).json({ ok: false, error: err.message });
  } finally {
    busy = false;
  }
});

app.listen(PORT, BIND_HOST, () => {
  console.log(`[codex-image-bridge] listening on ${BIND_HOST}:${PORT} (tailnet-only)`);
});
