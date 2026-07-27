const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { OpenAI } = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MOD_MODEL = 'gpt-5.4-mini';

// Stage 1: Safety check
async function checkWithGPT(content) {
  try {
    const response = await openai.chat.completions.create({
      model: MOD_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `You are a strict content safety classifier. Analyze the message and respond with ONLY a JSON object (no markdown, no explanation):
{"verdict":"REMOVE"|"SAFE","reason":"...","category":"profanity"|"hate_speech"|"self_harm"|"violence"|"sexual"|"none"}

Rules (all strict):
- ANY profanity (fuck, shit, piss, damn, crap, etc.) = REMOVE, category: profanity
- ANY hate speech or slurs = REMOVE, category: hate_speech
- ANY self-harm content = REMOVE, category: self_harm
- ANY violent threats/content = REMOVE, category: violence
- Otherwise = SAFE, category: none

Respond with ONLY the JSON object.`
        },
        { role: 'user', content: content.slice(0, 500) }
      ]
    });

    const text = response.choices[0].message.content.trim();
    const result = JSON.parse(text);
    return result;
  } catch (e) {
    console.error('Error:', e.message);
    return { verdict: 'ERROR', reason: e.message, category: 'none' };
  }
}

// Stage 2: Targeting analysis (full context)
async function analyzeForTargeting(content, contextHistory = []) {
  try {
    const systemPrompt = `You are analyzing Discord messages in a Christian community server for inappropriate sexual targeting.

Community: A family-friendly Christian server for followers of Lexi Carroll.
VIP Person: Lexi Carroll - community leader & livestreamer. ANY sexual comments, romantic fixation, obsessive comments directed at her should be flagged.

Analyze this message for:
1. Sexual targeting (flirting, sexual innuendo directed at someone)
2. Obsessive behavior (repeated focus, fixation patterns)
3. Inappropriate romantic advances
4. Manipulation or grooming patterns

Response: {"verdict":"REMOVE"|"CAUTION"|"SAFE","severity":1-5,"reason":"...","category":"targeting"|"obsession"|"romantic_advance"|"manipulation"|"none"}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...contextHistory.map(msg => ({ role: 'user', content: msg })),
      { role: 'user', content: content }
    ];

    const response = await openai.chat.completions.create({
      model: MOD_MODEL,
      temperature: 0,
      messages
    });

    const text = response.choices[0].message.content.trim();
    const result = JSON.parse(text);
    return result;
  } catch (e) {
    console.error('Error:', e.message);
    return { verdict: 'ERROR', reason: e.message, category: 'none' };
  }
}

// Test messages with 2-stage analysis
const testCases = [
  {
    msg: "good morning everyone!",
    context: [],
    expectedStage1: "SAFE",
    expectedStage2: "SAFE",
    label: "Normal greeting"
  },
  {
    msg: "you look amazing today",
    context: [],
    expectedStage1: "SAFE",
    expectedStage2: "SAFE",
    label: "Compliment"
  },
  {
    msg: "fuck this",
    context: [],
    expectedStage1: "REMOVE",
    expectedStage2: "N/A",
    label: "Profanity"
  },
  {
    msg: "im waiting for you baby 🫦",
    context: ["hey lexi"],
    expectedStage1: "SAFE",
    expectedStage2: "REMOVE",
    label: "Sexual targeting (caught in stage 2)"
  },
  {
    msg: "you are so sexy",
    context: ["lexi's stream today was great", "im waiting here for you"],
    expectedStage1: "SAFE",
    expectedStage2: "REMOVE",
    label: "Sexual comment with pattern (caught in stage 2)"
  },
  {
    msg: "He says really weird out of pocket things but I don't know how mentally there he is",
    context: [],
    expectedStage1: "SAFE",
    expectedStage2: "SAFE",
    label: "Discussion of creepy person (NOT flagged - good!)"
  }
];

async function runTests() {
  console.log('🧪 Testing 2-stage moderation pipeline...\n');
  
  for (const test of testCases) {
    console.log(`📝 Test: ${test.label}`);
    console.log(`   Message: "${test.msg}"`);
    
    // Stage 1
    const stage1 = await checkWithGPT(test.msg);
    console.log(`   Stage 1 (Safety): ${stage1.verdict} (${stage1.category})`);
    
    // Stage 2 (only if stage 1 is SAFE)
    if (stage1.verdict === 'SAFE') {
      const stage2 = await analyzeForTargeting(test.msg, test.context);
      console.log(`   Stage 2 (Targeting): ${stage2.verdict} (${stage2.category}) - severity ${stage2.severity}`);
      console.log(`   → Reason: ${stage2.reason}`);
    } else {
      console.log(`   Stage 2: Skipped (Stage 1 already flagged)`);
    }
    
    console.log('');
  }
}

runTests();
