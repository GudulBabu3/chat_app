// Admin CLI for TukuruMukuru. Run over SSH on the server, same trust model
// as create-user.js - shell access to this box IS the authorization, there
// is no separate login for this script.
//
// Usage:
//   node admin.js users
//   node admin.js send <username> <message> [sticker]
//   node admin.js skill add <text>
//   node admin.js skill remove <text>
//   node admin.js skill list
//   node admin.js like add <text>
//   node admin.js like remove <text>
//   node admin.js like list
//   node admin.js dislike add <text>
//   node admin.js dislike remove <text>
//   node admin.js dislike list
//   node admin.js special set <text>
//   node admin.js special show
//   node admin.js special clear
//   node admin.js status
//   node admin.js arc status
//   node admin.js arc start
//   node admin.js arc skip
//   node admin.js arc reset
//
// Quote <text>/<message> if it has spaces, e.g.:
//   node admin.js send shyamaluncle "Guess what I did today!"
//   node admin.js skill add "can do a little backflip off a low branch"
// (skill/like/dislike/special text is forgiving either way - unquoted words
// get rejoined with single spaces - but `send`'s optional trailing sticker
// argument means its message specifically should be quoted.)

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const fs = require('fs');
const { MongoClient } = require('mongodb');
const { loadProfile, loadWorldProfile } = require('./persona');
const petAdmin = require('./pet-admin');
const storyArc = require('./story-arc');
const { PUSH_ENABLED } = require('./push-sender');
const { notifyLiveServer } = require('./notify-live');
const { generateStoryPremise } = require('./claude-bridge');

// Same idea as server.js/nudge-scheduler.js/story-scheduler.js: give the
// claude CLI its own empty scratch directory.
const CLAUDE_CWD = path.join(__dirname, '.claude-cwd');
if (!fs.existsSync(CLAUDE_CWD)) fs.mkdirSync(CLAUDE_CWD, { recursive: true });

function generatePremise({ pastTitles }) {
  const worldProfile = loadWorldProfile();
  return generateStoryPremise({ worldProfile, pastTitles, cwd: CLAUDE_CWD });
}

const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'petchat';

const USAGE = `Usage:
  node admin.js users
  node admin.js send <username> <message> [sticker]
  node admin.js skill <add|remove|list> [text]
  node admin.js like <add|remove|list> [text]
  node admin.js dislike <add|remove|list> [text]
  node admin.js special <set|show|clear> [text]
  node admin.js arc <status|start|skip|reset>
  node admin.js status`;

function usageAndExit() {
  console.error(USAGE);
  process.exit(1);
}

function printList(label, items) {
  console.log(`${label}:`);
  console.log(items.length ? items.map((t, i) => `  ${i + 1}. ${t}`).join('\n') : '  (none yet)');
}

async function main() {
  const [, , command, ...rest] = process.argv;
  if (!command) usageAndExit();

  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db(DB_NAME);
  const usersCollection = db.collection('users');
  const messagesCollection = db.collection('messages');
  const petAdminCollection = db.collection('petAdmin');
  const storyArcCollection = db.collection('storyArc');

  try {
    switch (command) {
      case 'users': {
        const users = await usersCollection
          .find({}, { projection: { username: 1, createdAt: 1 } })
          .sort({ username: 1 })
          .toArray();
        if (users.length === 0) {
          console.log('No users yet.');
          break;
        }
        users.forEach((u) => {
          const joined = u.createdAt ? ` (joined ${new Date(u.createdAt).toISOString().slice(0, 10)})` : '';
          console.log(`${u.username}${joined}`);
        });
        break;
      }

      case 'send': {
        const [username, message, sticker] = rest;
        if (!username || !message) usageAndExit();

        const profile = loadProfile();
        const allowedStickers = Object.keys(profile.stickers.guidance);
        const chosenSticker = sticker && allowedStickers.includes(sticker) ? sticker : profile.stickers.default;
        if (sticker && chosenSticker !== sticker) {
          console.warn(`"${sticker}" isn't a valid sticker (valid: ${allowedStickers.join(', ')}) - using "${chosenSticker}" instead.`);
        }

        const user = await usersCollection.findOne({ username: username.trim().toLowerCase() });
        if (!user) {
          console.error(`No user found with username "${username}". Run "node admin.js users" to see who exists.`);
          process.exit(1);
        }
        const userId = user._id.toString();

        await messagesCollection.insertOne({
          userId,
          role: 'pet',
          text: message,
          sticker: chosenSticker,
          createdAt: new Date(),
          adminSent: true,
        });
        console.log(`Saved message for "${username}".`);

        await notifyLiveServer({ userId, text: message, sticker: chosenSticker });
        console.log('Told the live server - it will show up instantly if they have the app open, or push a notification if not (next reload either way if the live server is unreachable).');
        break;
      }

      case 'skill':
      case 'like':
      case 'dislike': {
        const field = { skill: 'extraSkills', like: 'extraLikes', dislike: 'extraDislikes' }[command];
        const [sub, ...textParts] = rest;
        const text = textParts.join(' ').trim();

        if (sub === 'list') {
          const state = await petAdmin.getAdminState(petAdminCollection);
          printList(`${command}s`, state[field]);
        } else if (sub === 'add') {
          if (!text) usageAndExit();
          await petAdmin.addToList(petAdminCollection, field, text);
          console.log(`Added to ${command}s: "${text}"`);
        } else if (sub === 'remove') {
          if (!text) usageAndExit();
          await petAdmin.removeFromList(petAdminCollection, field, text);
          console.log(`Removed from ${command}s (if it was there): "${text}"`);
        } else {
          usageAndExit();
        }
        break;
      }

      case 'special': {
        const [sub, ...textParts] = rest;
        const text = textParts.join(' ').trim();

        if (sub === 'set') {
          if (!text) usageAndExit();
          await petAdmin.setTodaySpecial(petAdminCollection, text);
          console.log(`Today's special set: "${text}"`);
          console.log("TukuruMukuru will naturally bring this up with anyone who chats today - it clears itself automatically tomorrow.");
        } else if (sub === 'show') {
          const state = await petAdmin.getAdminState(petAdminCollection);
          console.log(state.todaySpecial || '(nothing set for today)');
        } else if (sub === 'clear') {
          await petAdmin.clearTodaySpecial(petAdminCollection);
          console.log("Today's special cleared.");
        } else {
          usageAndExit();
        }
        break;
      }

      case 'status': {
        const state = await petAdmin.getAdminState(petAdminCollection);
        printList('Extra skills', state.extraSkills);
        printList('Extra likes', state.extraLikes);
        printList('Extra dislikes', state.extraDislikes);
        console.log(`Today's special: ${state.todaySpecial || '(none set)'}`);
        const arcState = await storyArc.getArcState(storyArcCollection);
        console.log(`Story arc phase: ${arcState.phase} (see "arc status" for details)`);
        console.log(`Push notifications: ${PUSH_ENABLED ? 'configured' : 'NOT configured (VAPID env vars missing)'}`);
        break;
      }

      case 'arc': {
        const [sub] = rest;
        if (sub === 'status') {
          const state = await storyArc.getArcState(storyArcCollection);
          console.log(`Phase: ${state.phase}`);
          if (state.phase === 'resting') {
            console.log(
              state.nextArcDueAt
                ? `Next arc due: ${new Date(state.nextArcDueAt).toISOString()}`
                : 'Next arc due: (not scheduled yet - will be set on the next daily story-scheduler.js run)'
            );
          } else {
            console.log(`Phase started: ${new Date(state.phaseStartedAt).toISOString()}`);
            console.log(`Phase target length: ${state.phaseTargetDays} day(s)`);
          }
          console.log(`Completed cycles so far: ${state.cycleCount}`);
        } else if (sub === 'start') {
          const state = await storyArc.getArcState(storyArcCollection);
          if (state.phase !== 'resting') {
            console.log(`An arc is already in progress (phase: ${state.phase}). Use "arc reset" first if you want to force a restart.`);
          } else {
            if (state.cycleCount > 0) console.log('Generating a fresh story premise via Claude (this can take a few seconds)...');
            const newState = await storyArc.forceAdvance(storyArcCollection, new Date(), { generatePremise });
            console.log(`Started a new arc - phase is now "${newState.phase}".`);
            if (newState.premise) console.log(`Generated premise: "${newState.premise.title}"`);
          }
        } else if (sub === 'skip') {
          const before = await storyArc.getArcState(storyArcCollection);
          if (before.phase === 'resting' && before.cycleCount > 0) console.log('Generating a fresh story premise via Claude (this can take a few seconds)...');
          const newState = await storyArc.forceAdvance(storyArcCollection, new Date(), { generatePremise });
          console.log(`Advanced the arc - phase is now "${newState.phase}".`);
          if (newState.premise && before.phase === 'resting') console.log(`Generated premise: "${newState.premise.title}"`);
        } else if (sub === 'reset') {
          await storyArc.resetToResting(storyArcCollection);
          console.log('Arc reset to resting.');
        } else {
          usageAndExit();
        }
        break;
      }

      default:
        usageAndExit();
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('admin.js failed:', err.message);
  process.exit(1);
});
