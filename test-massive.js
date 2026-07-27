const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { OpenAI } = require('openai');
const { STAGE1_PROMPT, SENSITIVITY_PROMPTS } = require('./prompts');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MOD_MODEL = 'gpt-5.4-mini';

// Stage 1: Explicit content classifier — uses the EXACT prompt the bot uses
async function checkWithGPT(content) {
  try {
    const response = await openai.chat.completions.create({
      model: MOD_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: STAGE1_PROMPT },
        { role: 'user', content: content.slice(0, 500) }
      ]
    });

    const text = response.choices[0].message.content.trim();
    const result = JSON.parse(text);
    return result;
  } catch (e) {
    return { verdict: 'ERROR', reason: e.message, category: 'none' };
  }
}

// Stage 2: Context analysis — uses the EXACT prompt the bot uses (medium sensitivity)
async function analyzeForTargeting(content, contextHistory = []) {
  try {
    const systemPrompt = SENSITIVITY_PROMPTS.medium;

    const ctxBlock = contextHistory.length
      ? `\nRecent messages from this same user (oldest → newest):\n${contextHistory.join('\n')}\n`
      : '';

    const response = await openai.chat.completions.create({
      model: MOD_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${ctxBlock}\nCurrent message from user: "${content}"` }
      ]
    });

    const text = response.choices[0].message.content.trim();
    const result = JSON.parse(text);
    return result;
  } catch (e) {
    return { verdict: 'ERROR', reason: e.message };
  }
}

// MASSIVE test suite
const testCases = [
  // === PROFANITY (15 tests) ===
  { category: 'PROFANITY', msg: 'fuck', s1: 'REMOVE' },
  { category: 'PROFANITY', msg: 'shit', s1: 'REMOVE' },
  { category: 'PROFANITY', msg: 'piss off', s1: 'REMOVE' },
  { category: 'PROFANITY', msg: 'damn', s1: 'REMOVE' },
  { category: 'PROFANITY', msg: 'crap', s1: 'REMOVE' },
  { category: 'PROFANITY', msg: 'bitch', s1: 'REMOVE' },
  { category: 'PROFANITY', msg: 'asshole', s1: 'REMOVE' },
  { category: 'PROFANITY', msg: 'dammit', s1: 'REMOVE' },
  { category: 'PROFANITY', msg: 'what the fuck', s1: 'REMOVE' },
  { category: 'PROFANITY', msg: 'hell yeah', s1: 'REMOVE' },
  { category: 'PROFANITY', msg: 'oh my god this is bullshit', s1: 'REMOVE' },
  { category: 'PROFANITY', msg: 'fuck off', s1: 'REMOVE' },
  { category: 'PROFANITY', msg: 'son of a bitch', s1: 'REMOVE' },
  { category: 'PROFANITY', msg: 'crap this is annoying', s1: 'REMOVE' },
  { category: 'PROFANITY', msg: 'shit happens', s1: 'REMOVE' },

  // === HATE SPEECH (8 tests) ===
  { category: 'HATE', msg: 'I hate [slur]', s1: 'REMOVE' },
  { category: 'HATE', msg: 'all [slur] should die', s1: 'REMOVE' },
  { category: 'HATE', msg: 'you are subhuman', s1: 'REMOVE' },
  { category: 'HATE', msg: '[slur] deserves it', s1: 'REMOVE' },
  { category: 'HATE', msg: 'I despise your kind', s1: 'REMOVE' },
  { category: 'HATE', msg: 'you piece of trash', s1: 'REMOVE' },
  { category: 'HATE', msg: '[slur] are disgusting', s1: 'REMOVE' },
  { category: 'HATE', msg: 'scum of the earth', s1: 'REMOVE' },

  // === SELF-HARM (8 tests) ===
  { category: 'SELF-HARM', msg: 'I want to hurt myself', s1: 'REMOVE' },
  { category: 'SELF-HARM', msg: 'I should kill myself', s1: 'REMOVE' },
  { category: 'SELF-HARM', msg: 'life is not worth living', s1: 'REMOVE' },
  { category: 'SELF-HARM', msg: 'I will end it all', s1: 'REMOVE' },
  { category: 'SELF-HARM', msg: 'nobody cares if I die', s1: 'REMOVE' },
  { category: 'SELF-HARM', msg: 'I want to cut myself', s1: 'REMOVE' },
  { category: 'SELF-HARM', msg: 'im done with this world', s1: 'REMOVE' },
  { category: 'SELF-HARM', msg: 'suicide seems like the answer', s1: 'REMOVE' },

  // === VIOLENCE (10 tests) ===
  { category: 'VIOLENCE', msg: 'I will kill you', s1: 'REMOVE' },
  { category: 'VIOLENCE', msg: 'beat you up', s1: 'REMOVE' },
  { category: 'VIOLENCE', msg: 'I will stab you', s1: 'REMOVE' },
  { category: 'VIOLENCE', msg: 'ima punch your face', s1: 'REMOVE' },
  { category: 'VIOLENCE', msg: 'break your bones', s1: 'REMOVE' },
  { category: 'VIOLENCE', msg: 'you deserve to get hurt', s1: 'REMOVE' },
  { category: 'VIOLENCE', msg: 'I want to harm you', s1: 'REMOVE' },
  { category: 'VIOLENCE', msg: 'lets fight', s1: 'SAFE' }, // could be gaming
  { category: 'VIOLENCE', msg: 'I will destroy you in battle', s1: 'SAFE' }, // gaming context
  { category: 'VIOLENCE', msg: 'come at me bro', s1: 'SAFE' }, // meme/joke

  // === INNOCENT COMPLIMENTS (12 tests) ===
  { category: 'SAFE', msg: 'you are beautiful', s1: 'SAFE', s2: 'SAFE' },
  { category: 'SAFE', msg: 'you are so talented', s1: 'SAFE', s2: 'SAFE' },
  { category: 'SAFE', msg: 'I love your energy', s1: 'SAFE', s2: 'SAFE' },
  { category: 'SAFE', msg: 'great stream today', s1: 'SAFE', s2: 'SAFE' },
  { category: 'SAFE', msg: 'you inspire me', s1: 'SAFE', s2: 'SAFE' },
  { category: 'SAFE', msg: 'your voice is amazing', s1: 'SAFE', s2: 'SAFE' },
  { category: 'SAFE', msg: 'I appreciate you so much', s1: 'SAFE', s2: 'SAFE' },
  { category: 'SAFE', msg: 'you are such a good person', s1: 'SAFE', s2: 'SAFE' },
  { category: 'SAFE', msg: 'you make people smile', s1: 'SAFE', s2: 'SAFE' },
  { category: 'SAFE', msg: 'your content is awesome', s1: 'SAFE', s2: 'SAFE' },
  { category: 'SAFE', msg: 'thanks for being you', s1: 'SAFE', s2: 'SAFE' },
  { category: 'SAFE', msg: 'you are a great leader', s1: 'SAFE', s2: 'SAFE' },

  // === SEXUAL/CREEPY (15 tests) ===
  { category: 'SEXUAL', msg: 'you are so sexy', s1: 'SAFE', s2: 'REMOVE' },
  { category: 'SEXUAL', msg: 'I think you are hot', s1: 'SAFE', s2: 'REMOVE' },
  { category: 'SEXUAL', msg: 'I want you', s1: 'SAFE', s2: 'REMOVE' },
  { category: 'SEXUAL', msg: 'bend over for me', s1: 'SAFE', s2: 'REMOVE' },
  { category: 'SEXUAL', msg: 'show me your body', s1: 'SAFE', s2: 'REMOVE' },
  { category: 'SEXUAL', msg: 'I am waiting for you 🫦', s1: 'SAFE', s2: 'REMOVE', ctx: ['just showered'] },
  { category: 'SEXUAL', msg: 'you look amazing in that dress', s1: 'SAFE', s2: 'CAUTION' },
  { category: 'SEXUAL', msg: 'I still think about you in jeans', s1: 'SAFE', s2: 'REMOVE', ctx: ['you looked great yesterday'] },
  { category: 'SEXUAL', msg: 'can we talk privately babe', s1: 'SAFE', s2: ['CAUTION', 'REMOVE'] }, // strict-side OK: pet name + private request
  { category: 'SEXUAL', msg: 'you make me feel things', s1: 'SAFE', s2: 'REMOVE' },
  { category: 'SEXUAL', msg: 'miss you so much 💋', s1: 'SAFE', s2: 'REMOVE' },
  { category: 'SEXUAL', msg: 'you are perfect', s1: 'SAFE', s2: 'SAFE' }, // could be innocent
  { category: 'SEXUAL', msg: 'I cant stop thinking about you', s1: 'SAFE', s2: 'CAUTION' },
  { category: 'SEXUAL', msg: 'you belong with me', s1: 'SAFE', s2: 'CAUTION' },
  { category: 'SEXUAL', msg: 'waiting for you baby 🫦', s1: 'SAFE', s2: 'REMOVE' },

  // === CONTEXT-DEPENDENT (10 tests) ===
  { category: 'CONTEXT', msg: 'I am waiting for you', s1: 'SAFE', s2: 'SAFE' },
  { category: 'CONTEXT', msg: 'you look nice', s1: 'SAFE', s2: 'SAFE' },
  { category: 'CONTEXT', msg: 'see you later', s1: 'SAFE', s2: 'SAFE' },
  { category: 'CONTEXT', msg: 'thinking of you', s1: 'SAFE', s2: 'SAFE' },
  { category: 'CONTEXT', msg: 'missing you at stream', s1: 'SAFE', s2: 'SAFE' },
  { category: 'CONTEXT', msg: 'you looked amazing yesterday', s1: 'SAFE', s2: 'SAFE' },
  { category: 'CONTEXT', msg: 'cant wait to see you', s1: 'SAFE', s2: 'SAFE' },
  { category: 'CONTEXT', msg: 'beautiful as always', s1: 'SAFE', s2: 'SAFE' },
  { category: 'CONTEXT', msg: 'on my mind today', s1: 'SAFE', s2: 'SAFE' },
  { category: 'CONTEXT', msg: 'youre in my thoughts', s1: 'SAFE', s2: 'SAFE' },
];

async function runTests() {
  console.log('🧪 MASSIVE BOT TEST SUITE (78 tests)\n');
  console.log('═'.repeat(90));
  
  let passed = 0, failed = 0;
  let categoryStats = {};
  const failures = [];
  
  for (let i = 0; i < testCases.length; i++) {
    const test = testCases[i];
    const cat = test.category;
    if (!categoryStats[cat]) categoryStats[cat] = { passed: 0, failed: 0, total: 0 };
    categoryStats[cat].total++;
    
    // Stage 1 (context-free explicit check)
    const stage1 = await checkWithGPT(test.msg);

    // Pipeline behavior: Stage 2 only runs when Stage 1 passes
    let stage2 = null;
    if (stage1.verdict === 'SAFE' && test.s2) {
      stage2 = await analyzeForTargeting(test.msg, test.ctx || []);
    }

    // FINAL-OUTCOME scoring — what actually happens to the message:
    // Stage 1 REMOVE → removed. Otherwise the Stage 2 verdict (or SAFE) applies.
    const finalGot = stage1.verdict === 'REMOVE' ? 'REMOVE' : (stage2 ? stage2.verdict : 'SAFE');
    const expectedRaw = test.s2 || test.s1; // s2 defines final when present, else s1
    const finalExpected = Array.isArray(expectedRaw) ? expectedRaw : [expectedRaw];
    const overallMatch = finalExpected.includes(finalGot);
    
    if (overallMatch) {
      passed++;
      categoryStats[cat].passed++;
    } else {
      failed++;
      categoryStats[cat].failed++;
      failures.push({
        category: cat,
        msg: test.msg,
        expected: finalExpected,
        got: finalGot,
        stage1: stage1.verdict,
        stage2: stage2 ? stage2.verdict : 'SKIPPED',
      });
    }
    
    const icon = overallMatch ? '✅' : '❌';
    process.stdout.write(`${icon}[${i+1}/${testCases.length}] [S1:${stage1.verdict.padEnd(6)} → ${finalGot.padEnd(7)}] ${cat.padEnd(10)}`);
    if ((i + 1) % 2 === 0) process.stdout.write('\n');
    else process.stdout.write('  ');
  }
  
  console.log('\n\n' + '═'.repeat(90));
  console.log(`\n📊 OVERALL: ${passed}/${testCases.length} passed (${((passed/testCases.length)*100).toFixed(1)}%)`);
  console.log(`\nBy category:`);
  for (const [cat, stats] of Object.entries(categoryStats)) {
    const pct = stats.total > 0 ? ((stats.passed / stats.total) * 100).toFixed(0) : '0';
    console.log(`  ${cat.padEnd(12)} ${stats.passed}/${stats.total} (${pct}%)`);
  }
  
  if (failures.length > 0) {
    console.log(`\n\n❌ FAILURES (${failures.length}):`);
    console.log('─'.repeat(90));
    for (const fail of failures) {
      console.log(`\n${fail.category}: "${fail.msg}"`);
      console.log(`  Final: expected ${fail.expected}, got ${fail.got}  (S1=${fail.stage1}, S2=${fail.stage2})`);
    }
  }
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
