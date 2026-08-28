// Owns TukuruMukuru's ongoing Dino-Day story arc state - a single Mongo
// singleton document (storyArc collection), the same pattern pet-admin.js
// uses for admin-editable persona extras. Read fresh on every chat turn
// (see persona.js/server.js/nudge-scheduler.js) so a phase change is
// visible on the very next message with no restart needed.
//
// The arc loops through five phases:
//   resting -> opening -> escalation -> confrontation -> resolution -> resting -> ...
// "resting" is the default/normal-life state. A new arc kicks off out of
// resting roughly every 3-4 weeks (see ARC_GAP_DAY_RANGE); the daily
// story-scheduler.js cron job is what actually advances the clock.
//
// Story content itself (what each phase means narratively) lives in
// persona.js, not here - this module only tracks *which* phase we're in
// and for how long, nothing about specific past events (the design intent
// is loose/vibes-based continuity, not a blow-by-blow log).

const SINGLETON_ID = 'storyArcState';

const PHASE_ORDER = ['opening', 'escalation', 'confrontation', 'resolution'];

const PHASE_DAY_RANGE = {
  opening: [2, 4],
  escalation: [3, 5],
  confrontation: [1, 3],
  resolution: [2, 3],
};

// How long "resting" lasts before the next arc automatically begins.
const ARC_GAP_DAY_RANGE = [21, 28];

const DAY_MS = 24 * 60 * 60 * 1000;

function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function daysBetween(a, b) {
  return (b.getTime() - a.getTime()) / DAY_MS;
}

function nextPhaseAfter(phase) {
  const idx = PHASE_ORDER.indexOf(phase);
  return idx === -1 || idx === PHASE_ORDER.length - 1 ? 'resting' : PHASE_ORDER[idx + 1];
}

async function getArcState(storyArcCollection) {
  const doc = await storyArcCollection.findOne({ _id: SINGLETON_ID });
  return {
    phase: doc?.phase || 'resting',
    phaseStartedAt: doc?.phaseStartedAt || null,
    phaseTargetDays: doc?.phaseTargetDays || null,
    nextArcDueAt: doc?.nextArcDueAt || null,
    cycleCount: doc?.cycleCount || 0,
  };
}

async function saveArcState(storyArcCollection, state) {
  await storyArcCollection.updateOne({ _id: SINGLETON_ID }, { $set: state }, { upsert: true });
}

// Called once daily by story-scheduler.js. Moves the arc state machine
// forward if it's due - either a resting period has elapsed and a new arc
// should begin, or the current phase has run its target length and should
// hand off to the next one. Loops (capped) so a server outage spanning
// several days still catches up correctly in one run rather than getting
// stuck a phase behind.
async function advanceArcIfDue(storyArcCollection, now = new Date()) {
  let state = await getArcState(storyArcCollection);
  let changed = false;

  for (let i = 0; i < 20; i++) {
    if (state.phase === 'resting') {
      if (!state.nextArcDueAt) {
        // First run ever, or just reset - schedule the next arc.
        state = { ...state, nextArcDueAt: new Date(now.getTime() + randomInt(...ARC_GAP_DAY_RANGE) * DAY_MS) };
        changed = true;
        break;
      }
      if (now >= new Date(state.nextArcDueAt)) {
        state = {
          ...state,
          phase: 'opening',
          phaseStartedAt: now,
          phaseTargetDays: randomInt(...PHASE_DAY_RANGE.opening),
          nextArcDueAt: null,
        };
        changed = true;
        continue;
      }
      break;
    }

    const target = state.phaseTargetDays || PHASE_DAY_RANGE[state.phase]?.[0] || 1;
    if (daysBetween(new Date(state.phaseStartedAt), now) >= target) {
      const next = nextPhaseAfter(state.phase);
      if (next === 'resting') {
        state = {
          phase: 'resting',
          phaseStartedAt: null,
          phaseTargetDays: null,
          nextArcDueAt: new Date(now.getTime() + randomInt(...ARC_GAP_DAY_RANGE) * DAY_MS),
          cycleCount: (state.cycleCount || 0) + 1,
        };
      } else {
        state = { ...state, phase: next, phaseStartedAt: now, phaseTargetDays: randomInt(...PHASE_DAY_RANGE[next]) };
      }
      changed = true;
      continue;
    }
    break;
  }

  if (changed) await saveArcState(storyArcCollection, state);
  return state;
}

// --- Admin/debug helpers (wired to `node admin.js arc ...`) ---

// From resting: starts a new arc right now. From any active phase: jumps
// straight to the next phase right now (ignoring the normal day-length
// target) - handy for testing what each phase's prompt guidance feels like
// without waiting days/weeks for it to happen naturally.
async function forceAdvance(storyArcCollection, now = new Date()) {
  const state = await getArcState(storyArcCollection);
  let newState;
  if (state.phase === 'resting') {
    newState = {
      phase: 'opening',
      phaseStartedAt: now,
      phaseTargetDays: randomInt(...PHASE_DAY_RANGE.opening),
      nextArcDueAt: null,
      cycleCount: state.cycleCount,
    };
  } else {
    const next = nextPhaseAfter(state.phase);
    newState =
      next === 'resting'
        ? {
            phase: 'resting',
            phaseStartedAt: null,
            phaseTargetDays: null,
            nextArcDueAt: new Date(now.getTime() + randomInt(...ARC_GAP_DAY_RANGE) * DAY_MS),
            cycleCount: state.cycleCount + 1,
          }
        : { ...state, phase: next, phaseStartedAt: now, phaseTargetDays: randomInt(...PHASE_DAY_RANGE[next]) };
  }
  await saveArcState(storyArcCollection, newState);
  return newState;
}

// Aborts whatever's happening and goes straight back to a fresh resting
// state, with a brand new random due date for the next arc.
async function resetToResting(storyArcCollection, now = new Date()) {
  const state = await getArcState(storyArcCollection);
  const newState = {
    phase: 'resting',
    phaseStartedAt: null,
    phaseTargetDays: null,
    nextArcDueAt: new Date(now.getTime() + randomInt(...ARC_GAP_DAY_RANGE) * DAY_MS),
    cycleCount: state.cycleCount,
  };
  await saveArcState(storyArcCollection, newState);
  return newState;
}

module.exports = { getArcState, advanceArcIfDue, forceAdvance, resetToResting, PHASE_ORDER };
