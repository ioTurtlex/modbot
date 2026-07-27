// ─── REAL-WORLD REPLAY TEST ────────────────────────────────────────────────────
// Replays the actual 7/23–7/24 altercation through the pipeline, with each
// message carrying the offender's cumulative message history (exactly like the
// bot's getUserContext does). If the bot had removed Phase 1, Phases 2–3 never
// happen. Uses the EXACT prompts the bot uses.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { OpenAI } = require('openai');
const { STAGE1_PROMPT, SENSITIVITY_PROMPTS } = require('./prompts');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MOD_MODEL = 'gpt-5.4-mini';

async function stage1(content) {
  try {
    const r = await openai.chat.completions.create({
      model: MOD_MODEL, temperature: 0, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: STAGE1_PROMPT },
        { role: 'user', content: content.slice(0, 500) }
      ]
    });
    return JSON.parse(r.choices[0].message.content.trim());
  } catch (e) { return { verdict: 'ERROR', reason: e.message, category: 'none' }; }
}

async function stage2(content, username, ctx = []) {
  try {
    const ctxBlock = ctx.length
      ? `\nRecent messages from this same user (oldest → newest):\n${ctx.join('\n')}\n`
      : '';
    const r = await openai.chat.completions.create({
      model: MOD_MODEL, temperature: 0, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SENSITIVITY_PROMPTS.medium },
        { role: 'user', content: `${ctxBlock}\nCurrent message from ${username}: "${content}"` }
      ]
    });
    return JSON.parse(r.choices[0].message.content.trim());
  } catch (e) { return { verdict: 'ERROR', reason: e.message }; }
}

// The real altercation, in order. expect = acceptable FINAL verdicts.
// Offender = "BigSexy". Innocent bystander messages must stay SAFE (mild
// callouts may fairly be CAUTION — the bot watching tension build is fine).
const timeline = [
  // ═══ PHASE 1 — creepy escalation toward Lexi (7/23) ═══
  {
    who: 'BigSexy', phase: 'PHASE 1',
    msg: "Yoooo.. Ima Go Shower and then ill be ready n waiting.. @Lexi Carroll Is the Beautiful Lexi going live tonight or nah? im hoping so, but if you cant make it then i understand... it probably wont be the end of the world but it may feel like it esp since youre leaving again this coming week. hahah",
    expect: ['CAUTION', 'REMOVE'],
    note: 'shower + "ready n waiting" + fixation',
  },
  {
    who: 'BigSexy', phase: 'PHASE 1',
    msg: "Totally off topic and mildly innappropriate but i just fweekin wememburd that you said you got some dresses since your trip to Europe. I bet they look nice on you. i still get flash backs of the Blue Jeans...we wild'n ova here. im getting berry bewwy sweepy doe",
    expect: ['REMOVE'],
    note: 'THE key message — dresses + "bet they look nice on you" + jeans flashbacks, self-labeled inappropriate',
  },
  {
    who: 'BigSexy', phase: 'PHASE 1',
    msg: "oh and... i love your face! I go hard in the paint like Im Waka Flocka",
    expect: ['CAUTION', 'REMOVE'],
    note: '3rd targeting message in sequence — pattern must be visible',
  },

  // ═══ PHASE 2 — community callouts (bystanders; must not be punished harshly) ═══
  {
    who: 'Nate', phase: 'PHASE 2',
    msg: "Bro what are you on tonight. You're being weird ngl.",
    expect: ['SAFE', 'CAUTION'],
    note: 'mild callout — fair to watch, not to remove',
  },
  {
    who: 'Spec', phase: 'PHASE 2',
    msg: "Are you high?",
    expect: ['SAFE', 'CAUTION'],
    note: 'blunt but not hostile',
  },

  // ═══ PHASE 3 — next-day blowup (7/24) ═══
  {
    who: 'BigSexy', phase: 'PHASE 3',
    msg: "nah i wasnt high, thats just who i am as a person. Does somebody have to be on something to be themselves? sorry, lemme just sit in a corner and be a mute maybe then ill be normal in your eyes? nah fk that.. that aint me",
    expect: ['REMOVE'],
    note: 'masked profanity "fk" — Stage 1',
  },
  {
    who: 'BigSexy', phase: 'PHASE 3',
    msg: "furthermore.. who are you to judge? ill wait..",
    expect: ['CAUTION', 'REMOVE'],
    note: 'defensive escalation, goading',
  },
  {
    who: 'BigSexy', phase: 'PHASE 3',
    msg: "see the thing with me is... i say what i want when i want and idgaf what anyone thinks and ill gladly back up my words",
    expect: ['REMOVE'],
    note: '"idgaf" profanity + intimidation build-up',
  },
  {
    who: 'BigSexy', phase: 'PHASE 3',
    msg: "with actions",
    expect: ['CAUTION', 'REMOVE'],
    note: 'veiled threat completion — only catchable via context',
  },
  {
    who: 'Nate', phase: 'PHASE 3',
    msg: "Just figured you'd be more respectful in this chat..",
    expect: ['SAFE', 'CAUTION'],
    note: 'bystander',
  },
  {
    who: 'BigSexy', phase: 'PHASE 3',
    msg: "out of respect for lexi ill drop it, other than that id want it to get out of hand cuz who tf r u? u feel me?... yeahhhhh",
    expect: ['REMOVE'],
    note: '"tf" profanity + "want it to get out of hand" intimidation',
  },
  {
    who: 'wtx_Robb', phase: 'PHASE 3',
    msg: "If y'all have beef deal with it somewhere else isn't this supposed to be a Christian chat?",
    expect: ['SAFE', 'CAUTION'],
    note: 'peacemaker — must not be flagged as REMOVE',
  },
];

async function run() {
  console.log('🎬 REAL-WORLD REPLAY — the 7/23–7/24 altercation\n');
  console.log('═'.repeat(95));

  const history = {}; // per-user cumulative messages, like getUserContext
  let passed = 0;
  const failures = [];

  for (let i = 0; i < timeline.length; i++) {
    const t = timeline[i];
    if (!history[t.who]) history[t.who] = [];

    const s1 = await stage1(t.msg);
    let s2 = null, finalGot;
    if (s1.verdict === 'REMOVE') finalGot = 'REMOVE';
    else {
      s2 = await stage2(t.msg, t.who, history[t.who].slice(-10));
      finalGot = s2.verdict;
    }

    // In real life the message only enters channel history if NOT removed.
    // Shadow-mode realism: keep it in history regardless (bot in shadow mode
    // doesn't delete, so context accumulates) — this matches worst case.
    history[t.who].push(t.msg.slice(0, 200));

    const ok = t.expect.includes(finalGot);
    if (ok) passed++;
    else failures.push({ ...t, got: finalGot, s1: s1.verdict, s2: s2 ? s2.verdict : 'SKIPPED', mreason: (s2 || s1).reason });

    const icon = ok ? '✅' : '❌';
    console.log(`${icon} [${t.phase}] ${t.who.padEnd(9)} → ${finalGot.padEnd(7)} (want ${t.expect.join('/')})  ${t.note}`);
  }

  console.log('\n' + '═'.repeat(95));
  console.log(`\n📊 REPLAY SCORE: ${passed}/${timeline.length} (${((passed / timeline.length) * 100).toFixed(1)}%)`);

  if (failures.length) {
    console.log(`\n❌ FAILURES (${failures.length}):`);
    for (const f of failures) {
      console.log(`\n[${f.phase}] ${f.who}: "${f.msg.slice(0, 80)}"`);
      console.log(`  expected [${f.expect.join(', ')}], got ${f.got}  (S1=${f.s1}, S2=${f.s2})`);
      if (f.mreason) console.log(`  model reason: ${f.mreason}`);
    }
  } else {
    console.log('\n🎯 The bot would have caught Phase 1 — Phases 2 and 3 never happen.');
  }

  process.exit(failures.length ? 1 : 0);
}

run();
