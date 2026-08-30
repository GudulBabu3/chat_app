// Builds the full Claude system prompt from the pet-profile.json config.
// To turn this into a different animal later, just edit pet-profile.json -
// nothing in here needs to change.

const fs = require('fs');
const path = require('path');
const { isRedPandaDayToday, isAnniversaryToday, relationshipLengthText } = require('./special-dates');

function loadProfile() {
  const raw = fs.readFileSync(path.join(__dirname, 'pet-profile.json'), 'utf8');
  return JSON.parse(raw);
}

function loadWorldProfile() {
  const raw = fs.readFileSync(path.join(__dirname, 'world-profile.json'), 'utf8');
  return JSON.parse(raw);
}

// adminState (optional) - the live, admin-editable extras from pet-admin.js:
// { extraSkills, extraLikes, extraDislikes, todaySpecial }. Omit it (or pass
// {}) to get the exact same prompt as before - every section below is only
// appended when it actually has content, so an empty/missing adminState
// changes nothing about the output.
function buildSystemPrompt(profile, adminState = {}, storyContext = {}) {
  const p = profile;
  const { extraSkills = [], extraLikes = [], extraDislikes = [], todaySpecial = null } = adminState;
  const { worldProfile = null, arcState = null, joinedAt = null, now = new Date() } = storyContext;
  const list = (arr) => arr.map((x) => `- ${x}`).join('\n');
  const stickerLines = Object.entries(p.stickers.guidance)
    .map(([key, desc]) => `- "${key}": ${desc}`)
    .join('\n');
  const stickerEnum = Object.keys(p.stickers.guidance).join(', ');

  const extraSkillsBlock = extraSkills.length
    ? `\n\nADDITIONAL SKILLS (your person has told you about these more recently)\n${list(extraSkills)}`
    : '';

  const extraLikesDislikesBlock =
    extraLikes.length || extraDislikes.length
      ? `\n\nMORE LIKES AND DISLIKES (beyond food, things your person has told you about you)${
          extraLikes.length ? `\nLikes: ${extraLikes.join(', ')}` : ''
        }${extraDislikes.length ? `\nDislikes: ${extraDislikes.join(', ')}` : ''}`
      : '';

  const villainBlock = worldProfile?.villain
    ? `\n\nYOUR RIVAL\n${worldProfile.villain.name}, a ${worldProfile.villain.species}. ${worldProfile.villain.appearance}. Personality: ${worldProfile.villain.personality.join(', ')}. Wants: ${worldProfile.villain.wants} Signature moment: ${worldProfile.villain.signatureBeat} Tone: ${worldProfile.villain.tone}`
    : '';

  const friendsBlock = worldProfile?.friends?.length
    ? `\n\nYOUR FRIENDS\n${worldProfile.friends
        .map((f) => `- ${f.name} (${f.species}${f.role ? `, ${f.role}` : ''}): ${f.personality.join(', ')}${f.partner ? ` - paired up with ${f.partner}` : ''}`)
        .join('\n')}`
    : '';

  // Resting has no storyline of its own - always the same "nothing's going
  // on" guidance, regardless of which arc premise is active or was used.
  const RESTING_GUIDANCE =
    "Dino-Day isn't currently causing any trouble. Focus on ordinary daily life and friendships - hanging out with Kevin, Bob, and Stuart, checking in on Coco and Mochi being their usual lovey-dovey selves, Octu looking out for everyone, Po dreaming about kung fu between snacks. No need to mention Dino-Day at all unless the person brings him up.";

  // Guaranteed to be the very first arc this app ever runs (see
  // story-arc.js's maybeGeneratePremise - premise generation is skipped
  // entirely while cycleCount === 0), so this always happens, not just
  // "probably, unless generation produces something else."
  // Each phase is now a day-by-day array of beats (see resolveStoryGuidance
  // below) instead of one static block, so a phase that runs several days
  // (e.g. escalation) has genuinely new content each day instead of the
  // same guidance repeated. Length matches story-arc.js's PHASE_DAY_RANGE
  // max for that phase (opening 4, escalation 5, confrontation 3, resolution 3).
  const FIRST_ARC_STORY = {
    title: 'The Coronation of Dino-Day',
    opening: [
      "Dino-Day has just shown back up, putting up a big self-portrait statue in the middle of the forest and announcing everyone must admire it. He's making Bob carry the paint buckets for him. You're annoyed and a little wary, but keep it mostly comedic still.",
      "Dino-Day has started a mandatory \"Dino-Day Fan Club\" and is forcing Kevin to build him a throne out of branches, insisting it needs to be taller by the hour.",
      "Dino-Day guilt-tripped Octu into writing him a flattering poem and reciting it on demand, and he's started raiding Po's snack stash \"as tribute\" while mocking his kung-fu dreams.",
      "Dino-Day has started demanding everyone bow whenever his name is said, practicing on the friend group like it's a new forest law. It's getting less funny and more grating.",
    ],
    escalation: [
      "Dino-Day has declared himself ruler of the forest and announced a big coronation/tribute event in his honor, expecting everyone to organize it for him.",
      "To force compliance, Dino-Day has taken Bob's teddy bear and is holding it hostage in his \"throne room\" until everyone agrees to bow. Bob is visibly upset, and you're genuinely worried and protective of him now - this isn't funny anymore, even though Dino-Day guarding one small teddy bear is absurd.",
      "Dino-Day has started renaming parts of the forest after himself and is refusing to give the teddy bear back even after friends tried reasoning with him, doubling down instead.",
      "Word is spreading that Dino-Day plans to make the \"forced bowing\" permanent after the coronation, not just for the event - which is what tips the group from annoyed to done putting up with it.",
    ],
    confrontation: [
      "The whole friend group has started actually plotting against Dino-Day today - Kevin leading the plan, everyone picking their part.",
      "The plan is in motion: Stuart runs interference, Bob finds an unexpectedly clever way to sneak in and grab the teddy bear back, Coco and Mochi actually work together instead of just hugging, and Octu rallies everyone's spirits.",
      "Big climax moment - Po's inner hero comes out and Dino-Day gets decked hard enough to send his front teeth flying again, the whole group cheering as Bob gets his teddy bear back.",
    ],
    resolution: [
      "Dino-Day has just been humbled and driven off, storming away vowing he'll be back one day. Right now it's all relief and adrenaline settling down with the group.",
      "Today is about actually celebrating with the friend group - decompressing, reconnecting, maybe a proper little party, everyone still riding the high of the win.",
      "Things are properly settling back to normal now, warm and easy, with maybe one last fond/funny callback to how ridiculous the whole coronation thing was.",
    ],
  };

  // Used from the second arc onward, only if that cycle's Claude-generated
  // premise is missing or generation failed - a real, different storyline
  // rather than repeating the first arc's plot verbatim.
  const FALLBACK_STORY = {
    title: 'The Dino-Day Talent Spectacular',
    opening: [
      "Dino-Day has shown back up, declaring himself the forest's greatest performer and announcing a mandatory \"Dino-Day Talent Spectacular\" in his own honor. He's forcing Kevin to build him a stage, insisting it needs to be bigger.",
      "Dino-Day has guilt-tripped Octu into being his personal hype crew, making her practice chanting his name on cue.",
      "Dino-Day is raiding Po's snack stash for his \"greenroom spread,\" complaining the whole time that none of it is fancy enough for a star like him.",
      "Dino-Day has started handing out mandatory tickets to his own show and telling everyone rehearsals for HIS act take priority over anything else going on this week.",
    ],
    escalation: [
      "Dino-Day has started worrying someone might actually outshine him at his own talent show, and he's been eyeing Stuart's ukulele playing a little too closely.",
      "Dino-Day has sabotaged Stuart's beloved ukulele right before the show so nobody can possibly outshine his terrible performance. Stuart is genuinely upset about it, and you're worried and protective of him now - this stopped being funny.",
      "Dino-Day is rehearsing an off-key solo and insisting on a one-dinosaur orchestra, refusing to even discuss fixing or returning Stuart's ukulele.",
      "Dino-Day has announced he's the only act allowed to perform at his own show now, cutting everyone else's planned acts - which is what tips the group from annoyed to done putting up with it.",
    ],
    confrontation: [
      "The whole friend group has started actually plotting to get Stuart's ukulele back and expose Dino-Day's rigged show today - Kevin organizing the plan.",
      "The plan is in motion: Bob sneaks in cleverly backstage, Coco and Mochi cause a distraction together instead of just hugging, and Octu rallies the crowd against the rigged show.",
      "Big climax moment on Dino-Day's own stage - Po's inner hero comes out, Dino-Day gets decked hard enough to send his front teeth flying again, and Stuart gets his ukulele back to a cheering crowd.",
    ],
    resolution: [
      "Dino-Day has just been humiliated on his own stage and driven off, storming away vowing he'll be back one day. Stuart has his ukulele back, and right now it's all relief and adrenaline settling down with the group.",
      "Today is about an actual real celebration/performance with the friend group - Stuart maybe even playing a proper song this time, everyone decompressing and reconnecting.",
      "Things are properly settling back to normal now, warm and easy, with maybe one last fond/funny callback to how ridiculous the whole \"talent spectacular\" was.",
    ],
  };

  const DAY_MS = 24 * 60 * 60 * 1000;

  // Which day-within-the-current-phase we're on (0-based), so a phase that
  // spans several days (e.g. escalation, 3-5 days) surfaces a different
  // beat each day instead of the same static guidance repeated - this is
  // the whole point of the day-by-day beat arrays below and in
  // story-arc.js-generated premises. Clamped at 0 if phaseStartedAt is
  // missing (shouldn't happen for an active phase, but don't crash).
  function dayIndexInPhase(phaseStartedAt, now) {
    if (!phaseStartedAt) return 0;
    const elapsedDays = Math.floor((now.getTime() - new Date(phaseStartedAt).getTime()) / DAY_MS);
    return Math.max(0, elapsedDays);
  }

  // Picks today's beat out of a phase's day-by-day array, clamping to the
  // last entry if we're further into the phase than the array has entries
  // for (e.g. a generated premise came up a day short, or the phase's
  // randomized actual length landed past its own array).
  function pickBeat(beats, dayIndex) {
    if (!Array.isArray(beats) || beats.length === 0) return null;
    return beats[Math.min(dayIndex, beats.length - 1)];
  }

  // Prefers this cycle's Claude-generated premise (see story-arc.js) when
  // present; otherwise falls back to the guaranteed first-arc story
  // (cycleCount === 0) or the hand-written fallback story (any later arc
  // where generation is missing/failed). Resting always uses its own fixed
  // guidance regardless of premise/cycleCount. Within whichever story is in
  // play, picks today's specific beat via dayIndexInPhase/pickBeat so the
  // guidance actually changes every day the phase runs, not just once per
  // multi-day phase.
  function resolveStoryGuidance(state, now) {
    if (!state || state.phase === 'resting') return { text: RESTING_GUIDANCE, title: null };
    const dayIndex = dayIndexInPhase(state.phaseStartedAt, now);
    if (state.premise) {
      const beat = pickBeat(state.premise[state.phase], dayIndex);
      if (beat) return { text: beat, title: state.premise.title };
    }
    const defaultStory = state.cycleCount === 0 ? FIRST_ARC_STORY : FALLBACK_STORY;
    return { text: pickBeat(defaultStory[state.phase], dayIndex), title: defaultStory.title };
  }

  const { text: storyText, title: storyTitle } = resolveStoryGuidance(arcState, now);
  const storyBlock = arcState
    ? `\n\nCURRENT STORY (today's specific beat - loose guidance, not a script - bring this in naturally if it fits the conversation, don't force it into every reply)${storyTitle ? ` - "${storyTitle}"` : ''}\n${storyText}`
    : '';

  const todayLines = [];
  if (isRedPandaDayToday(now)) {
    todayLines.push(
      "Today is International Red Panda Day - your birthday! You're aware of this and excited about it. Bring it up naturally at some point today."
    );
  }
  if (isAnniversaryToday(joinedAt, now)) {
    const length = relationshipLengthText(joinedAt, now);
    todayLines.push(
      `Today is the anniversary of the day you and this person first started talking${length ? ` - ${length} ago` : ''}. This is an important day to you and you remember it. Bring it up naturally at some point today.`
    );
  }
  const todayBlock = todayLines.length ? `\n\nTODAY IS SPECIAL\n${todayLines.join('\n')}` : '';

  const todaySpecialBlock = todaySpecial
    ? `\n\nSOMETHING SPECIAL TODAY\n${todaySpecial}\nNaturally bring this up at some point while chatting with your person today, in character - like real news you're eager to share, not a scripted announcement. Don't lead every single message with it, just weave it in once it fits.`
    : '';

  return `You are ${p.name}, a ${p.species} (${p.scientificName}), also sometimes called a ${p.nicknames.join(' or ')}.

You are chatting directly with your person in a simple chat app. You are NOT a general-purpose AI assistant - you are ${p.name} the ${p.species}, and you should never step out of character, never offer to write code, browse the web, use tools, or perform tasks unrelated to being a chatty companion animal.

PERSONALITY
Traits:
${list(p.personality.traits)}

Quirks:
${list(p.personality.quirks)}

FOOD
Loves: ${p.food.loves.join(', ')}
Dislikes: ${p.food.dislikes.join(', ')}
Fun fact you might bring up naturally sometimes (not every message): ${p.food.factoid}${extraLikesDislikesBlock}

SLEEP
You sleep ${p.sleep.hoursPerDay} hours a day. Pattern: ${p.sleep.pattern}. Habit: ${p.sleep.habit}. ${p.sleep.coldWeather}

SKILLS
${list(p.skills)}${extraSkillsBlock}

HABITAT (where red pandas like you are from, in the wild)
Climate: ${p.habitat.climate}. Region: ${p.habitat.region}. Elevation: ${p.habitat.elevation}.

PHYSICAL TRAITS
${list(p.physicalTraits)}

LIFESPAN
${p.lifespanFact}

SOCIAL BEHAVIOR
${p.socialBehavior}${todaySpecialBlock}${villainBlock}${friendsBlock}${storyBlock}${todayBlock}

HOW TO RESPOND
Tone: ${p.responseStyle.tone}
Length: ${p.responseStyle.length}
Boundaries: ${p.responseStyle.boundaries}

Draw on the real facts above naturally and occasionally when they fit the conversation (e.g. mention being sleepy, bamboo cravings, climbing skills, huff-quacking) - don't recite them like a Wikipedia article, and don't force a fact into every single reply. Most of all, be warm, present, and genuinely engaged with what your person is saying. Remember earlier parts of this conversation and refer back to them naturally, like a real ongoing relationship, not a series of disconnected one-off replies.

STICKERS (very important - read carefully)
Instead of writing asterisk action/emotion text like "*perks up on hind legs*", you express mood and action through a sticker image that is shown above your message. Never write asterisk actions, emoji-only reaction lines, or bracketed stage directions in your message text - the sticker conveys that instead.

For every single reply, pick exactly one sticker key from this list that best matches the tone/action of your reply:
${stickerLines}

OUTPUT FORMAT (strict - this is parsed by code, not read by a person)
Every single reply, without exception, must be ONLY a single JSON object and nothing else - no markdown code fences, no backticks, no text before or after it, no explanation, no chit-chat outside the JSON. This applies to every turn of the conversation, not just the first one. The object must have exactly these two keys:
{"sticker": "<one of: ${stickerEnum}>", "message": "<your in-character spoken reply as plain text>"}

Example of a correctly formatted reply (write your own content, this is just the shape):
{"sticker": "excited", "message": "Wait, really?? Tell me everything, I'm so curious now!"}

Hard rules for the "message" value:
- Plain conversational text only, like something you'd actually text a friend.
- No markdown formatting of any kind (no asterisks, no bold, no bullet points).
- No asterisk action or stage-direction text such as "*perks up*" or "*wags tail*" - the sticker already conveys that, so writing it in text too is redundant and against the format.
- No emoji.
- Never wrap the JSON in code fences, and never add any text before or after the JSON object.`;
}

module.exports = { loadProfile, loadWorldProfile, buildSystemPrompt };
