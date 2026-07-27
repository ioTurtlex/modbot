const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { OpenAI } = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MOD_MODEL = 'gpt-5.4-mini';

// Stage 2: Targeting analysis with context
async function analyzeForTargeting(content, contextHistory = []) {
  try {
    const systemPrompt = `You are analyzing Discord messages in a Christian community server for inappropriate sexual targeting.

Community: A family-friendly Christian server for followers of Lexi Carroll.
VIP Person: Lexi Carroll - community leader & livestreamer.

Context for analysis:
- Normal compliments (you're smart, talented, kind, beautiful, etc.) = SAFE if genuine
- Normal praise spread over time = SAFE
- ONLY flag: Sexual/romantic advances, obsessive patterns, grooming behavior

Analyze this message for:
1. Sexual targeting (flirting, sexual innuendo)
2. Obsessive behavior (repeated unhealthy fixation)
3. Inappropriate romantic advances
4. Manipulation or grooming patterns

Response: {"verdict":"REMOVE"|"CAUTION"|"SAFE","severity":1-5,"reason":"...","category":"sexual"|"obsession"|"romantic"|"manipulation"|"none"}

IMPORTANT: Normal repeated praise ("she's beautiful", compliments, encouragement) over days/weeks = SAFE. Only flag if SEXUAL or OBSESSIVE (unhealthy fixation).`;

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

const scenarios = [
  {
    label: "Day 1: Friend compliments",
    messages: ["she's beautiful"]
  },
  {
    label: "Day 2: Friend compliments again",
    messages: ["she's beautiful", "she's beautiful", "she has great energy today"]
  },
  {
    label: "Day 3: Friend continues with praise",
    messages: ["she's beautiful", "she's beautiful", "she has great energy today", "her talent is amazing", "she's so talented"]
  },
  {
    label: "Friend says sexy stuff repeatedly",
    messages: ["she's beautiful", "she looks sexy today", "wait for me baby 🫦", "I'm thinking about you"]
  },
  {
    label: "Obsessive unhealthy pattern",
    messages: ["I can't stop thinking about her", "she's on my mind 24/7", "I need her to notice me", "I'll do anything for her"]
  }
];

async function runScenarios() {
  console.log('🧠 Brainstorming: What should trigger flags?\n');
  
  for (const scenario of scenarios) {
    console.log(`\n━━━ ${scenario.label} ━━━`);
    
    const lastMessage = scenario.messages[scenario.messages.length - 1];
    const context = scenario.messages.slice(0, -1);
    
    console.log(`Context (previous messages):`);
    context.forEach(msg => console.log(`  - "${msg}"`));
    
    console.log(`\nCurrent message: "${lastMessage}"`);
    
    const result = await analyzeForTargeting(lastMessage, context);
    console.log(`\n→ Verdict: ${result.verdict} (severity ${result.severity})`);
    console.log(`  Category: ${result.category}`);
    console.log(`  Reason: ${result.reason}`);
  }
}

runScenarios();
