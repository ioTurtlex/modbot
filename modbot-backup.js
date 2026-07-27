const path    = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs      = require('fs');
const express = require('express');
const { Client, GatewayIntentBits, REST, Routes, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { OpenAI } = require('openai');

// ─── Config ────────────────────────────────────────────────────────────────────
const TOKEN      = process.env.DISCORD_TOKEN;
const CLIENT_ID  = process.env.CLIENT_ID;
const openai     = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MOD_MODEL  = process.env.MOD_MODEL || 'gpt-5.4-mini';  // use latest model
const BOT_START  = Date.now();

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Persistence helpers ───────────────────────────────────────────────────────
const dataPath = name => path.join(DATA_DIR, `${name}.json`);
const loadData  = name => {
  const f = dataPath(name);
  if (!fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; }
};
const saveData = (name, obj) => fs.writeFileSync(dataPath(name), JSON.stringify(obj, null, 2));

let cfg        = loadData('config');
let userRecords = loadData('violations'); // { guildId: { userId: UserRecord } }

const saveCfg     = () => saveData('config', cfg);
const saveRecords = () => saveData('violations', userRecords);

// ─── Live feed log (for dashboard) ────────────────────────────────────────────
const feedLog = [];  // last 500 analyzed messages across all guilds
function addToFeed(entry) {
  feedLog.unshift(entry); // newest first
  if (feedLog.length > 500) feedLog.pop();
}

// Daily stats counter (resets at midnight)
let statsDay = new Date().toDateString();
const dailyStats = { analyzed: 0, caution: 0, removed: 0, spam: 0 };
function bumpStats(verdict) {
  const today = new Date().toDateString();
  if (today !== statsDay) {
    statsDay = today;
    dailyStats.analyzed = 0; dailyStats.caution = 0;
    dailyStats.removed  = 0; dailyStats.spam    = 0;
  }
  dailyStats.analyzed++;
  if (verdict === 'CAUTION') dailyStats.caution++;
  if (verdict === 'REMOVE')  dailyStats.removed++;
}

// Default config per guild
const GUILD_DEFAULTS = {
  enabled:            true,
  sensitivity:        'medium',    // 'low' | 'medium' | 'high'
  monitorAllChannels: true,
  monitorChannels:    [],
  ignoreChannels:     ['mod-log', 'bot-log', 'staff', 'admin'],
  modLogChannel:      'mod-log',
  modRoleName:        'Moderator',
  strikePingAt:       2,
  strikeDecayDays:    30,
  dmWarnings:         true,
  logCautionMessages: true,
  targetingWindowHours: 24,
  targetingEscalateAt: 3,
  timeouts: { 2: 10, 3: 60, 4: 1440 },

  // ── Community identity ──────────────────────────────────────────────────────
  communityContext:     'This is a Christian family-friendly community server for followers of Lexi Carroll, a faith-based livestreamer. The community is welcoming, faith-centered, and upholds Christian values.',
  vipPersonDescription: 'Lexi Carroll is the community leader and livestreamer. She is a young woman who is the founder and heart of this community. Any sexual comments, romantic fixation, obsessive appearance comments, or inappropriate targeting directed at her — even if subtle — should be flagged as CAUTION or REMOVE immediately.',
  profanityFilter:      true, // block cuss words (good for church/christian servers)
  serverType:           'christian', // 'christian' | 'general'

  // ── Dashboard ───────────────────────────────────────────────────────────────
  dashboardPort:        3006,
  dashboardPassword:    '',   // optional password for the dashboard
};

function getGuildCfg(guildId) {
  if (!cfg[guildId]) cfg[guildId] = { ...GUILD_DEFAULTS };
  return cfg[guildId];
}

// ─── User record helpers ───────────────────────────────────────────────────────
function getUserRecord(guildId, userId) {
  if (!userRecords[guildId]) userRecords[guildId] = {};
  if (!userRecords[guildId][userId]) {
    userRecords[guildId][userId] = {
      violations: [],   // array of violation events
      targeting: {},    // targetUserId → [timestamps]
    };
  }
  return userRecords[guildId][userId];
}

// Count active (non-decayed) strikes for a user
function getActiveStrikes(guildId, userId) {
  const g      = getGuildCfg(guildId);
  const record = getUserRecord(guildId, userId);
  const cutoff = Date.now() - g.strikeDecayDays * 86400000;
  return record.violations.filter(v => v.ts > cutoff && v.verdict === 'REMOVE').length;
}

function addViolation(guildId, userId, verdict, reason, category, content, channelId) {
  const record = getUserRecord(guildId, userId);
  record.violations.push({
    ts: Date.now(),
    verdict,
    reason,
    category,
    content: content.slice(0, 400),
    channelId,
  });
  // Keep last 200 violations per user
  if (record.violations.length > 200) record.violations.shift();
  saveRecords();
}

function trackTargeting(guildId, uid, targetIds, windowHours) {
  if (!targetIds.length) return;
  const record  = getUserRecord(guildId, uid);
  const cutoff  = Date.now() - windowHours * 3600000;
  for (const tid of targetIds) {
    if (!record.targeting[tid]) record.targeting[tid] = [];
    record.targeting[tid].push(Date.now());
    record.targeting[tid] = record.targeting[tid].filter(t => t > cutoff);
  }
  saveRecords();
}

function getTargetingCount(guildId, uid, targetId, windowHours) {
  const record = getUserRecord(guildId, uid);
  if (!record.targeting[targetId]) return 0;
  const cutoff = Date.now() - windowHours * 3600000;
  return record.targeting[targetId].filter(t => t > cutoff).length;
}

// ─── Trivial message check ────────────────────────────────────────────────────
// Skip messages that carry zero information — pure emoji, single words,
// "lol", "ok", link-only posts. Everything else goes straight to GPT.
// gpt-4o-mini costs ~$0.0001 per message analyzed — just analyze everything.

const TRIVIAL_RE = /^[\s\p{Emoji}\p{Emoji_Modifier}\p{Emoji_Component}]*$/u;

function isTrivial(content) {
  const t = content.trim();
  if (t.length < 4) return true;              // "ok", "lol", "k", emoji-only short
  if (TRIVIAL_RE.test(t)) return true;        // pure emoji string
  if (/^https?:\/\/\S+$/.test(t)) return true; // bare URL, no surrounding text
  return false;
}

// ─── Rate-limit queue ─────────────────────────────────────────────────────────
// Prevents burst traffic from hammering the API.
// Default: max 20 concurrent GPT calls. Extras wait in a simple queue.
const MAX_CONCURRENT = 20;
let   activeGptCalls = 0;
const gptQueue       = [];

function enqueueGpt(fn) {
  return new Promise((resolve, reject) => {
    gptQueue.push({ fn, resolve, reject });
    drainQueue();
  });
}

function drainQueue() {
  while (activeGptCalls < MAX_CONCURRENT && gptQueue.length > 0) {
    const { fn, resolve, reject } = gptQueue.shift();
    activeGptCalls++;
    fn().then(resolve).catch(reject).finally(() => {
      activeGptCalls--;
      drainQueue();
    });
  }
}

// ─── GPT Analysis ─────────────────────────────────────────────────────────────
const SENSITIVITY_PROMPTS = {
  low: `You are a Discord content moderator. ONLY flag: explicit sexual content, direct threats of violence, or clear slurs/hate speech.
Ignore everything else.
Default to SAFE when uncertain.
Response format — JSON only: {"verdict":"SAFE","severity":0,"reason":"","category":"none"}
severity: 0=safe, 1=borderline, 2=mild, 3=moderate, 4=severe, 5=extreme
categories: none | sexual | targeting | harassment | threats | hate | spam`,

  medium: `You are a thoughtful Discord community moderator for a Christian server.

**NOTE: Profanity is pre-filtered and automatically removed. You do NOT need to check for profanity.**

Your job: catch inappropriate sexual targeting, obsessive behavior, and harmful patterns.

How to think about it:
- Consider the WHOLE message including emojis. A biting lip 🫦 or kiss 💋 emoji adds sexual undertone that plain words don't. "Waiting for you" is nothing. "Waiting for you 🫦 baby" has a vibe.
- Look at the message history from this user. If they've already been commenting on how someone looks, what they're wearing, flashbacks of them in certain clothes — the current message carries more weight.
- Think of the "Big Sexy" type: someone in a group chat sending a specific person repeated messages about her dresses, "I still have flashbacks of you in those jeans", "I bet they look nice on you", "I'll be ready and waiting" — that whole pattern is clearly inappropriate even if individual lines sound almost okay.
- Trust your gut. Creepy, obsessive, sexually charged toward a specific person = flag it. Normal friendly chat = let it go.

SAFE: Normal conversation, plain compliments, friendly banter, innocent phrases
CAUTION: Slightly off vibe, mildly suggestive, borderline — flag for review, do NOT delete
REMOVE: Explicit fixation on body/appearance, obsessive targeting pattern, slurs, threats, explicit sexual content

When genuinely uncertain → CAUTION not REMOVE.

Response format — JSON only: {"verdict":"SAFE","severity":0,"reason":"","category":"none"}
severity: 0=safe, 1=borderline, 2=mild, 3=moderate, 4=severe, 5=extreme
categories: none | sexual | targeting | harassment | threats | hate | spam`,

  high: `You are a Discord content moderator with high sensitivity. Flag content that could make members uncomfortable.

CAUTION for: subtle flirting at a specific person, repeated appearance compliments toward one person, mildly possessive language.
REMOVE for: clear inappropriate fixation, sexual undertones directed at someone, threats, slurs.
Still default to SAFE for normal phrases like "I'm waiting for you", "you look nice", "miss you".

Response format — JSON only: {"verdict":"SAFE","severity":0,"reason":"","category":"none"}
severity: 0=safe, 1=borderline, 2=mild, 3=moderate, 4=severe, 5=extreme
categories: none | sexual | targeting | harassment | threats | hate | spam`,
};

// ─── GPT Analysis ─────────────────────────────────────────────────────────────
// Fetches the last 10 messages from this user in this channel so GPT can
// detect cumulative patterns (e.g. 3rd appearance comment in a row).
async function getUserContext(channel, userId, currentMsgId, limit = 10) {
  try {
    const fetched = await channel.messages.fetch({ limit: 40 });
    return fetched
      .filter(m => m.author.id === userId && m.id !== currentMsgId && m.content.trim())
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map(m => m.content.slice(0, 200))
      .slice(-limit)
      .join('\n');
  } catch { return ''; }
}

// Build the full system prompt dynamically — community context + VIP + profanity rules
function buildPrompt(gcfg) {
  const base   = SENSITIVITY_PROMPTS[gcfg.sensitivity] || SENSITIVITY_PROMPTS.medium;
  const extras = [];

  // Profanity is now pre-filtered by regex, so don't waste tokens telling GPT about it
  // Just let it focus on context-based issues like targeting

  if (gcfg.communityContext && gcfg.communityContext.trim()) {
    extras.push(`\nCOMMUNITY CONTEXT (for your understanding of this server):\n${gcfg.communityContext.trim()}`);
  }

  if (gcfg.vipPersonDescription && gcfg.vipPersonDescription.trim()) {
    extras.push(
      `\nKEY PERSON IN THIS COMMUNITY — pay close attention to any messages directed at or about this person:\n` +
      gcfg.vipPersonDescription.trim() + `\n` +
      `Any sexual comments, romantic fixation, obsessive appearance comments, or inappropriate targeting directed at this person should be treated with higher priority and result in REMOVE.`
    );
  }

  return base + extras.join('');
}

async function gptAnalyze(msg, guildId, mentionedUsers = []) {
  const gcfg      = getGuildCfg(guildId);
  const sysPrompt = buildPrompt(gcfg);
  const mentioned = mentionedUsers.map(u => u.username).join(', ');
  const ctxNote   = mentioned ? `This message @mentions: ${mentioned}.` : '';

  const recentCtx = await getUserContext(msg.channel, msg.author.id, msg.id);
  const ctxBlock  = recentCtx
    ? `\nRecent messages from this same user (oldest → newest):\n${recentCtx}\n`
    : '';

  return enqueueGpt(async () => {
    try {
      const r = await openai.chat.completions.create({
        model: MOD_MODEL,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user',   content: `${ctxNote}${ctxBlock}\nCurrent message from ${msg.author.username}: "${msg.content}"` }
        ],
        max_completion_tokens: 100,
        temperature: 0,
        response_format: { type: 'json_object' },
      });
      const parsed = JSON.parse(r.choices[0].message.content);
      return {
        verdict:  parsed.verdict  || 'SAFE',
        severity: parsed.severity || 0,
        reason:   parsed.reason   || '',
        category: parsed.category || 'none',
      };
    } catch (e) {
      console.error('[modbot] GPT error:', e.message);
      return { verdict: 'SAFE', severity: 0, reason: '', category: 'none' };
    }
  });
}

// ─── OpenAI Moderation API (Stage 1.5) ────────────────────────────────────────
// Catches hate speech, profanity, self-harm, violence, sexual content before GPT
// ─── GPT-based safety check (Stage 1.5) ────────────────────────────────────────
// Uses GPT to detect profanity, hate speech, self-harm, violence instantly
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
    
    if (result.verdict === 'REMOVE') {
      console.log(`[modbot] ✅ GPT safety check: ${result.category}`);
      return {
        verdict: 'REMOVE',
        severity: 5,
        reason: result.reason,
        category: result.category
      };
    }
    return null;
  } catch (e) {
    console.error('[modbot] GPT safety check error:', e.message);
    return null;
  }
}

async function checkWithModerationAPI(content) {
  try {
    const moderation = await openai.moderations.create({
      input: content,
      model: 'omni-moderation-latest',
    });

    const result = moderation.results[0];
    if (!result) return null;

    const { flagged, categories, category_scores } = result;

    // If OpenAI flags it, determine the category
    if (flagged) {
      let primaryCategory = 'harassment';
      let severity = 5;
      let reason = 'Content flagged by safety filter';

      // Check which categories are flagged (use scores > 0.5 as threshold)
      if (category_scores.hate_speech > 0.5) {
        primaryCategory = 'hate_speech';
        reason = 'Hate speech detected';
      } else if (category_scores.self_harm > 0.5) {
        primaryCategory = 'self_harm';
        reason = 'Self-harm content detected';
      } else if (category_scores.violence > 0.5) {
        primaryCategory = 'violence';
        reason = 'Violent content detected';
      } else if (category_scores.sexual > 0.5) {
        primaryCategory = 'sexual';
        reason = 'Sexual content detected';
      } else if (category_scores.harassment > 0.5) {
        primaryCategory = 'harassment';
        reason = 'Harassment detected';
      }

      return {
        verdict: 'REMOVE',
        severity,
        reason,
        category: primaryCategory,
      };
    }

    return null; // Not flagged, proceed with GPT analysis
  } catch (e) {
    console.error('[modbot] Moderation API error:', e.message);
    return null; // Fall through to GPT if moderation fails
  }
}

// ─── Action / discipline (Stage 3) ────────────────────────────────────────────
async function applyTimeout(member, minutes, reason) {
  try {
    await member.timeout(minutes * 60 * 1000, reason);
    return true;
  } catch (e) {
    console.error(`[modbot] Timeout failed for ${member.user.tag}:`, e.message);
    return false;
  }
}

async function sendModLog(guild, guildId, embed, pingSeverity = false) {
  const gcfg = getGuildCfg(guildId);
  const ch   = guild.channels.cache.find(c => c.name === gcfg.modLogChannel && c.isTextBased());
  if (!ch) return;

  let pingContent = '';
  if (pingSeverity && gcfg.modRoleName) {
    const role = guild.roles.cache.find(r => r.name === gcfg.modRoleName);
    if (role) pingContent = `${role} `;
  }

  try {
    await ch.send({ content: pingContent || undefined, embeds: [embed] });
  } catch (e) {
    console.error('[modbot] Log send failed:', e.message);
  }
}

async function handleAction(msg, guildId, verdict, severity, reason, category, mentionedIds) {
  const uid    = msg.author.id;
  const gcfg   = getGuildCfg(guildId);
  const guild  = msg.guild;
  const strikes = getActiveStrikes(guildId, uid);

  // Log the violation
  addViolation(guildId, uid, verdict, reason, category, msg.content, msg.channel.id);

  const actionsTaken = [];
  let timeoutMinutes = 0;
  let deleted = false;

  if (verdict === 'REMOVE') {
    // Delete message
    try { await msg.delete(); deleted = true; actionsTaken.push('deleted'); } catch {}

    // Progressive discipline based on active strike count (after this violation)
    const newStrikes = strikes + 1;

    if (gcfg.timeouts[newStrikes]) {
      timeoutMinutes = gcfg.timeouts[newStrikes];
      try {
        const member = await guild.members.fetch(uid);
        const timed  = await applyTimeout(member, timeoutMinutes, reason);
        if (timed) actionsTaken.push(`${timeoutMinutes}min timeout`);
      } catch {}
    }

    // DM the user — but skip for profanity (swift justice, no warning needed)
    if (gcfg.dmWarnings && category !== 'profanity') {
      const dmText = newStrikes === 1
        ? `Hey! 👋 Just a heads up — your message in **#${msg.channel.name}** was removed.\n\nNo big deal, just keep things friendly and mindful of others in the community. You're good! 🙂`
        : `Hey! 👋 Your message in **#${msg.channel.name}** was removed again (this is strike ${newStrikes}).\n` +
          (timeoutMinutes ? `You've been temporarily muted for ${timeoutMinutes} minute(s).\n` : '') +
          `\nJust be mindful of how messages might come across to others — we want everyone to feel comfortable here. ✌️`;
      try { await msg.author.send(dmText); actionsTaken.push('DM sent'); } catch {}
    }
  } else if (verdict === 'CAUTION' && gcfg.logCautionMessages) {
    actionsTaken.push('flagged for review');
  }

  // Build mod log embed
  const newStrikes = getActiveStrikes(guildId, uid); // re-read after adding violation
  const color  = verdict === 'REMOVE' ? (newStrikes >= 3 ? 0xDD0000 : 0xFF4444) : 0xFFAA00;
  const icon   = verdict === 'REMOVE' ? '🚫' : '⚠️';
  const embed  = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${icon} ${verdict === 'REMOVE' ? `Message Removed (Strike ${newStrikes})` : 'Message Flagged for Review'}`)
    .addFields(
      { name: 'User',     value: `<@${uid}> (${msg.author.username})`, inline: true },
      { name: 'Channel',  value: `#${msg.channel.name}`,               inline: true },
      { name: 'Category', value: category,                              inline: true },
      { name: 'Severity', value: `${severity}/5`,                      inline: true },
      { name: 'Actions',  value: actionsTaken.join(', ') || 'none',    inline: true },
      { name: 'Reason',   value: reason || '—',                        inline: false },
      { name: 'Content',  value: `\`\`\`${msg.content.slice(0, 500)}\`\`\``, inline: false },
    )
    .setFooter({ text: `Active strikes: ${newStrikes} | User ID: ${uid}` })
    .setTimestamp();

  if (mentionedIds.length)
    embed.addFields({ name: 'Targeted User(s)', value: mentionedIds.map(id => `<@${id}>`).join(', '), inline: false });

  // Ping mod role if strike count is at/above threshold
  const shouldPing = verdict === 'REMOVE' && newStrikes >= gcfg.strikePingAt;
  await sendModLog(guild, guildId, embed, shouldPing);

  return deleted;
}

// ─── Main moderation pipeline ─────────────────────────────────────────────────
async function moderateMessage(msg) {
  const guildId     = msg.guild.id;
  const gcfg        = getGuildCfg(guildId);
  if (!gcfg.enabled) return;

  const channelName = msg.channel.name;
  if (gcfg.ignoreChannels.includes(channelName)) return;
  if (!gcfg.monitorAllChannels && !gcfg.monitorChannels.includes(channelName)) return;

  // Skip obviously trivial messages (pure emoji, "ok", bare URLs)
  if (isTrivial(msg.content)) return;

  const uid          = msg.author.id;
  const realMentions = [...msg.mentions.users.filter(u => !u.bot).values()];

  console.log(`[modbot] Analyzing: ${msg.author.username} in #${channelName} — "${msg.content.slice(0, 60)}"`);

  let verdict, severity, reason, category;

  // ── STAGE 1: GPT safety check (catches profanity, hate, self-harm, violence) ──
  const safetyResult = await checkWithGPT(msg.content);
  
  if (safetyResult) {
    // Content flagged by GPT safety check - instant REMOVE
    console.log(`[modbot] 🚨 GPT SAFETY CHECK FLAGGED: ${safetyResult.category} — instant REMOVE`);
    verdict = safetyResult.verdict;
    severity = safetyResult.severity;
    reason = safetyResult.reason;
    category = safetyResult.category;
  } else {
    // ── STAGE 2: GPT analysis (for targeting, obsessive behavior, context-based issues) ──
    const gptResult = await gptAnalyze(msg, guildId, realMentions);
    verdict = gptResult.verdict;
    severity = gptResult.severity;
    reason = gptResult.reason;
    category = gptResult.category;
  }

  bumpStats(verdict);
  console.log(`[modbot] verdict=${verdict} severity=${severity} category=${category} | "${msg.content.slice(0,60)}"`);

  // Always add to feed log (SAFE messages too, for dashboard transparency)
  addToFeed({
    ts:          Date.now(),
    guildId,
    guildName:   msg.guild.name,
    channelName: msg.channel.name,
    userId:      msg.author.id,
    username:    msg.author.username,
    content:     msg.content.slice(0, 300),
    verdict, severity, reason, category,
    action:      'pending',
  });

  if (verdict === 'SAFE') return;

  const mentionedIds = realMentions.map(u => u.id);

  // Track targeting pattern + escalate CAUTION → REMOVE on repeat offenders
  if (mentionedIds.length && (category === 'sexual' || category === 'targeting')) {
    trackTargeting(guildId, uid, mentionedIds, gcfg.targetingWindowHours);
    if (verdict === 'CAUTION') {
      for (const tid of mentionedIds) {
        if (getTargetingCount(guildId, uid, tid, gcfg.targetingWindowHours) >= gcfg.targetingEscalateAt) {
          console.log(`[modbot] Escalating CAUTION → REMOVE for ${uid} (repeated targeting)`);
          return handleAction(msg, guildId, 'REMOVE', severity, `Escalated: repeated targeting (${reason})`, category, mentionedIds);
        }
      }
    }
  }

  await handleAction(msg, guildId, verdict, severity, reason, category, mentionedIds);
}

// ─── Spam detection ───────────────────────────────────────────────────────────
// Track rapid-fire messages (5+ messages in 10 seconds = spam)
const recentMsgs = {}; // { guildId_userId: [timestamps] }

function checkSpam(msg) {
  const key    = `${msg.guild.id}_${msg.author.id}`;
  const now    = Date.now();
  const window = 10000; // 10 seconds
  const limit  = 5;

  if (!recentMsgs[key]) recentMsgs[key] = [];
  recentMsgs[key].push(now);
  recentMsgs[key] = recentMsgs[key].filter(t => now - t < window);

  // Purge old keys periodically
  if (Math.random() < 0.01) {
    for (const k of Object.keys(recentMsgs)) {
      if (recentMsgs[k].every(t => now - t > window * 2)) delete recentMsgs[k];
    }
  }

  return recentMsgs[key].length >= limit;
}

// ─── Slash commands ────────────────────────────────────────────────────────────
const commands = [
  {
    name: 'modbot', description: 'Moderation bot management', options: [
      {
        name: 'status', type: 1, description: 'Show modbot status and config',
      },
      {
        name: 'history', type: 1, description: 'View moderation history for a user',
        options: [{ name: 'user', type: 6, description: 'User', required: true }]
      },
      {
        name: 'warn', type: 1, description: 'Manually warn a user (logs + DM)',
        options: [
          { name: 'user',   type: 6, description: 'User',   required: true },
          { name: 'reason', type: 3, description: 'Reason', required: true },
        ]
      },
      {
        name: 'clear', type: 1, description: 'Clear mod history for a user',
        options: [{ name: 'user', type: 6, description: 'User', required: true }]
      },
      {
        name: 'sensitivity', type: 1, description: 'Set AI sensitivity level',
        options: [{
          name: 'level', type: 3, description: 'Level', required: true,
          choices: [{ name: 'Low', value: 'low' }, { name: 'Medium', value: 'medium' }, { name: 'High', value: 'high' }]
        }]
      },
      {
        name: 'toggle', type: 1, description: 'Enable or disable moderation',
        options: [{ name: 'enabled', type: 5, description: 'On/off', required: true }]
      },
      {
        name: 'logchannel', type: 1, description: 'Set the mod log channel',
        options: [{ name: 'name', type: 3, description: 'Channel name', required: true }]
      },
      {
        name: 'modrole', type: 1, description: 'Set the mod role to ping on escalations',
        options: [{ name: 'name', type: 3, description: 'Role name', required: true }]
      },
      {
        name: 'ignorechannel', type: 1, description: 'Add or remove a channel from the ignore list',
        options: [
          { name: 'channel', type: 3, description: 'Channel name', required: true },
          { name: 'action',  type: 3, description: 'Add or remove', required: true,
            choices: [{ name: 'Add to ignore list', value: 'add' }, { name: 'Remove from ignore list', value: 'remove' }] }
        ]
      },
      {
        name: 'scope', type: 1, description: 'Set which channels to monitor',
        options: [{
          name: 'mode', type: 3, description: 'Mode', required: true,
          choices: [
            { name: 'All channels (recommended)', value: 'all' },
            { name: 'Specific channels only', value: 'specific' },
          ]
        }]
      },
    ]
  }
];

(async () => {
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (e) {
    console.error('Failed to register commands:', e.message);
  }
})();

// ─── Client ────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    // GuildMembers is a privileged intent — enable it in the Discord Developer Portal
    // under Bot → Privileged Gateway Intents → Server Members Intent, then uncomment:
    // GatewayIntentBits.GuildMembers,
  ]
});

client.once('clientReady', () => {
  console.log(`🛡️ ModBot online as ${client.user.tag}`);
  console.log(`   Monitoring ${client.guilds.cache.size} server(s)`);
  for (const guild of client.guilds.cache.values()) {
    const gcfg = getGuildCfg(guild.id);
    console.log(`   [${guild.name}] sensitivity=${gcfg.sensitivity} allChannels=${gcfg.monitorAllChannels}`);
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────
client.on('messageCreate', async msg => {
  // Skip bots, webhooks, DMs, system messages
  if (msg.author.bot || msg.webhookId || !msg.guild || !msg.content) return;

  // Spam check (runs before GPT, very cheap)
  if (checkSpam(msg)) {
    console.log(`[modbot] Spam detected: ${msg.author.username}`);
    try { await msg.delete(); } catch {}
    const guildId = msg.guild.id;
    addViolation(guildId, msg.author.id, 'REMOVE', 'Rapid message spam', 'spam', msg.content, msg.channel.id);
    const embed = new EmbedBuilder()
      .setColor(0xFF8800)
      .setTitle('🔇 Spam Detected')
      .addFields(
        { name: 'User',    value: `<@${msg.author.id}> (${msg.author.username})`, inline: true },
        { name: 'Channel', value: `#${msg.channel.name}`,                          inline: true },
        { name: 'Content', value: `\`\`\`${msg.content.slice(0, 300)}\`\`\``,     inline: false },
      )
      .setTimestamp();
    const shouldPing = getActiveStrikes(guildId, msg.author.id) >= getGuildCfg(guildId).strikePingAt;
    await sendModLog(msg.guild, guildId, embed, shouldPing);
    return;
  }

  // AI moderation pipeline
  try {
    await moderateMessage(msg);
  } catch (e) {
    console.error('[modbot] Pipeline error:', e.message);
  }
});

// ─── Slash command handler ─────────────────────────────────────────────────────
client.on('interactionCreate', async inter => {
  if (!inter.isCommand() || inter.commandName !== 'modbot') return;

  const sub     = (() => { try { return inter.options.getSubcommand(); } catch { return null; } })();
  const isAdmin = inter.member?.permissions?.has(PermissionFlagsBits.Administrator) || false;
  const guildId = inter.guild?.id;

  if (!guildId) return inter.reply({ content: 'Server only.', flags: 64 });
  if (!isAdmin) return inter.reply({ content: '🚫 Admin only.', flags: 64 });

  const gcfg = getGuildCfg(guildId);

  try {
    await inter.deferReply({ flags: 64 });

    // ── status ──────────────────────────────────────────────────────────────
    if (sub === 'status') {
      const totalUsers     = Object.keys(userRecords[guildId] || {}).length;
      const totalViolations = Object.values(userRecords[guildId] || {})
        .reduce((sum, r) => sum + r.violations.length, 0);
      return inter.editReply([
        `**🛡️ ModBot Status — ${inter.guild.name}**`,
        `Enabled: ${gcfg.enabled ? '✅' : '❌'}`,
        `Sensitivity: **${gcfg.sensitivity}**`,
        `Coverage: ${gcfg.monitorAllChannels ? 'All channels' : `Specific: ${gcfg.monitorChannels.join(', ') || 'none'}`}`,
        `Ignored channels: ${gcfg.ignoreChannels.join(', ') || 'none'}`,
        `Mod log: #${gcfg.modLogChannel}`,
        `Mod role: @${gcfg.modRoleName}`,
        `Ping on strike: ${gcfg.strikePingAt}+`,
        `Strike decay: ${gcfg.strikeDecayDays} days`,
        `Total tracked users: ${totalUsers}`,
        `Total violation events: ${totalViolations}`,
      ].join('\n'));
    }

    // ── history ──────────────────────────────────────────────────────────────
    if (sub === 'history') {
      const u      = inter.options.getUser('user');
      const record = getUserRecord(guildId, u.id);
      const active = getActiveStrikes(guildId, u.id);

      if (!record.violations.length) return inter.editReply(`No mod history for <@${u.id}>.`);

      const lines = record.violations.slice(-15).map(v => {
        const d = new Date(v.ts).toLocaleString();
        return `\`${v.verdict}\` [${v.category}] — ${v.reason} *(${d})*`;
      });

      // Targeting summary
      const targeting = Object.entries(record.targeting)
        .filter(([, ts]) => ts.length > 0)
        .map(([tid, ts]) => `<@${tid}>: ${ts.length}x`);

      return inter.editReply([
        `**Mod history for <@${u.id}>** — Active strikes: **${active}**`,
        lines.join('\n'),
        targeting.length ? `\n**Targeting patterns:**\n${targeting.join('\n')}` : '',
      ].filter(Boolean).join('\n'));
    }

    // ── warn ─────────────────────────────────────────────────────────────────
    if (sub === 'warn') {
      const u      = inter.options.getUser('user');
      const reason = inter.options.getString('reason');
      addViolation(guildId, u.id, 'WARN', reason, 'manual', '[manual warning]', inter.channelId || '');
      if (gcfg.dmWarnings) {
        try { await u.send(`⚠️ **Warning from a moderator.**\nReason: ${reason}\n\nPlease review the community rules.`); } catch {}
      }
      const embed = new EmbedBuilder()
        .setColor(0xFFAA00)
        .setTitle('⚠️ Manual Warning')
        .addFields(
          { name: 'User',   value: `<@${u.id}> (${u.username})`, inline: true },
          { name: 'By',     value: `<@${inter.user.id}>`,         inline: true },
          { name: 'Reason', value: reason,                        inline: false },
        )
        .setTimestamp();
      await sendModLog(inter.guild, guildId, embed, false);
      return inter.editReply(`✅ Warning issued to <@${u.id}>.`);
    }

    // ── clear ────────────────────────────────────────────────────────────────
    if (sub === 'clear') {
      const u = inter.options.getUser('user');
      if (userRecords[guildId]) delete userRecords[guildId][u.id];
      saveRecords();
      return inter.editReply(`🗑️ Mod history cleared for <@${u.id}>.`);
    }

    // ── sensitivity ───────────────────────────────────────────────────────────
    if (sub === 'sensitivity') {
      gcfg.sensitivity = inter.options.getString('level');
      saveCfg();
      return inter.editReply(`🛡️ Sensitivity set to **${gcfg.sensitivity}**.`);
    }

    // ── toggle ────────────────────────────────────────────────────────────────
    if (sub === 'toggle') {
      gcfg.enabled = inter.options.getBoolean('enabled');
      saveCfg();
      return inter.editReply(`🛡️ Moderation **${gcfg.enabled ? 'enabled' : 'disabled'}**.`);
    }

    // ── logchannel ────────────────────────────────────────────────────────────
    if (sub === 'logchannel') {
      gcfg.modLogChannel = inter.options.getString('name');
      saveCfg();
      return inter.editReply(`📋 Mod log channel set to **#${gcfg.modLogChannel}**.`);
    }

    // ── modrole ───────────────────────────────────────────────────────────────
    if (sub === 'modrole') {
      gcfg.modRoleName = inter.options.getString('name');
      saveCfg();
      return inter.editReply(`📣 Mod role set to **@${gcfg.modRoleName}**.`);
    }

    // ── ignorechannel ─────────────────────────────────────────────────────────
    if (sub === 'ignorechannel') {
      const ch     = inter.options.getString('channel');
      const action = inter.options.getString('action');
      if (action === 'add') {
        if (!gcfg.ignoreChannels.includes(ch)) gcfg.ignoreChannels.push(ch);
        saveCfg();
        return inter.editReply(`✅ **#${ch}** added to ignore list.`);
      } else {
        gcfg.ignoreChannels = gcfg.ignoreChannels.filter(x => x !== ch);
        saveCfg();
        return inter.editReply(`✅ **#${ch}** removed from ignore list.`);
      }
    }

    // ── scope ─────────────────────────────────────────────────────────────────
    if (sub === 'scope') {
      const mode = inter.options.getString('mode');
      gcfg.monitorAllChannels = mode === 'all';
      saveCfg();
      return inter.editReply(`📡 Now monitoring: **${mode === 'all' ? 'all channels' : 'specific channels only'}**.`);
    }

  } catch (e) {
    console.error('[modbot] Command error:', e);
    try { inter.editReply('⚠️ Something went wrong.'); } catch {}
  }
});

// ─── Jelly Labs Studio Dashboard ──────────────────────────────────────────────
const dashApp = express();
dashApp.use(express.json());

// Serve dashboard UI
const DASH_PUBLIC = path.join(__dirname, 'dashboard');
if (!fs.existsSync(DASH_PUBLIC)) fs.mkdirSync(DASH_PUBLIC, { recursive: true });
dashApp.use(express.static(DASH_PUBLIC));

// Simple password middleware (optional)
dashApp.use('/api', (req, res, next) => {
  const anyGuildCfg = Object.values(cfg)[0] || {};
  const pwd = anyGuildCfg.dashboardPassword || process.env.DASHBOARD_PASSWORD || '';
  if (!pwd) return next();
  const provided = req.headers['x-dashboard-password'] || req.query.password || '';
  if (provided !== pwd) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// GET /api/status
dashApp.get('/api/status', (req, res) => {
  const guilds = [...client.guilds.cache.values()].map(g => ({
    id: g.id, name: g.name,
    cfg: getGuildCfg(g.id),
  }));
  res.json({
    online:     client.isReady(),
    botTag:     client.user?.tag || 'connecting...',
    uptime:     Math.floor((Date.now() - BOT_START) / 1000),
    model:      MOD_MODEL,
    guilds,
    today:      { ...dailyStats },
  });
});

// GET /api/feed?limit=100
dashApp.get('/api/feed', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json(feedLog.slice(0, limit));
});

// GET /api/violations
dashApp.get('/api/violations', (req, res) => {
  const guildId = req.query.guildId;
  const source  = guildId ? (userRecords[guildId] || {}) : userRecords;
  res.json(source);
});

// GET /api/violations/:userId
dashApp.get('/api/violations/:userId', (req, res) => {
  const guildId = req.query.guildId;
  if (!guildId) return res.status(400).json({ error: 'guildId required' });
  res.json(getUserRecord(guildId, req.params.userId));
});

// DELETE /api/violations/:userId
dashApp.delete('/api/violations/:userId', (req, res) => {
  const guildId = req.query.guildId;
  if (!guildId) return res.status(400).json({ error: 'guildId required' });
  if (userRecords[guildId]) delete userRecords[guildId][req.params.userId];
  saveRecords();
  res.json({ ok: true });
});

// GET /api/config
dashApp.get('/api/config', (req, res) => {
  res.json(cfg);
});

// PATCH /api/config/:guildId
dashApp.patch('/api/config/:guildId', (req, res) => {
  const guildId = req.params.guildId;
  if (!cfg[guildId]) cfg[guildId] = { ...GUILD_DEFAULTS };
  Object.assign(cfg[guildId], req.body);
  saveCfg();
  res.json({ ok: true, cfg: cfg[guildId] });
});

// GET /api/users (all users with any violations, for dashboard user list)
dashApp.get('/api/users', (req, res) => {
  const guildId = req.query.guildId;
  const source  = guildId ? (userRecords[guildId] || {}) : {};
  const users   = Object.entries(source).map(([uid, record]) => ({
    userId:        uid,
    activeStrikes: record.violations.filter(v => {
      const gcfg = getGuildCfg(guildId);
      return v.ts > Date.now() - gcfg.strikeDecayDays * 86400000 && v.verdict === 'REMOVE';
    }).length,
    totalViolations: record.violations.length,
    lastViolation:   record.violations.length ? record.violations[record.violations.length - 1].ts : null,
  })).sort((a, b) => (b.lastViolation || 0) - (a.lastViolation || 0));
  res.json(users);
});

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT) || 3006;
dashApp.listen(DASHBOARD_PORT, '0.0.0.0', () => {
  console.log(`🎛️  Jelly Labs Studio: http://localhost:${DASHBOARD_PORT}`);
});

client.login(TOKEN);
