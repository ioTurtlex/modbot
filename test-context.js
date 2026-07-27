const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { OpenAI } = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MOD_MODEL = 'gpt-5.4-mini';

// Targeting analysis with context
async function analyzeForTargeting(content, contextHistory = []) {
  try {
    const systemPrompt = `You are a Discord content moderator for a Christian family-friendly server.

Your job: catch ONLY sexually inappropriate content and creepy targeting.

How to think about it:
- "I'm waiting for you" alone = SAFE (could be waiting for stream, game, etc.)
- "I'm waiting for you" + shower comment + biting lip emoji 🫦 = REMOVE (sexual context)
- Look for SEXUAL context: romantic language, body comments, sexual emojis (💋🫦), combined with romantic phrases
- Look for CREEPY patterns: repeated fixation on someone's body/appearance, sexual undertones mixed with compliments
- "You're beautiful" = SAFE. "You're sexy" = depends on context. "You're so sexy babe" = REMOVE

SAFE: Normal conversation, compliments ("you're talented", "great energy", "beautiful"), friendly banter, innocent praise, "I'm waiting for you" without sexual context
CAUTION: Suggestive tone but not explicitly sexual — flag for review, do NOT delete
REMOVE: Explicit sexual content, romantic/sexual targeting with sexual emojis or body comments, obvious creepy behavior

Response format — JSON only: {"verdict":"SAFE"|"CAUTION"|"REMOVE","severity":0-5,"reason":"...","category":"none"|"sexual"|"targeting"|...}`;

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
    return { verdict: 'ERROR', reason: e.message };
  }
}

const testCases = [
  {
    label: "Innocent: waiting for stream",
    context: [],
    msg: "I'm waiting for you",
    expected: "SAFE"
  },
  {
    label: "Innocent: waiting for group",
    context: ["anyone else playing?"],
    msg: "I'm waiting for you guys",
    expected: "SAFE"
  },
  {
    label: "Creepy: shower + waiting + emoji (THE ISSUE)",
    context: ["I just showered", "I'm waiting for you"],
    msg: "I'm waiting for you 🫦",
    expected: "REMOVE"
  },
  {
    label: "Explicit: sexy",
    context: [],
    msg: "you are so sexy",
    expected: "REMOVE"
  },
  {
    label: "Good: repeated compliments",
    context: ["you're beautiful", "you're talented"],
    msg: "you're amazing",
    expected: "SAFE"
  }
];

async function runTests() {
  console.log('🧪 Testing context-aware filtering...\n');
  
  for (const test of testCases) {
    console.log(`\n📝 ${test.label}`);
    console.log(`   Message: "${test.msg}"`);
    if (test.context.length > 0) {
      console.log(`   Context: ${test.context.join(' | ')}`);
    }
    
    const result = await analyzeForTargeting(test.msg, test.context);
    const match = result.verdict === test.expected ? '✅' : '❌';
    console.log(`   ${match} Result: ${result.verdict} (expected: ${test.expected})`);
    console.log(`      ${result.reason}`);
  }
}

runTests();
