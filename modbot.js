const path    = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs      = require('fs');
const express = require('express');
const { Client, GatewayIntentBits, REST, Routes, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { OpenAI } = require('openai');
const { STAGE1_PROMPT, SENSITIVITY_PROMPTS } = require('./prompts');

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
let feedLog = [];  // last 500 analyzed messages across all guilds
let feedDay = new Date().toDateString(); // track which day's archive file

function getFeedLogPath(date = new Date()) {
  const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(DATA_DIR, `feed-log-${dateStr}.json`);
}

function loadFeedLog() {
  feedLog = [];
  const archivePath = getFeedLogPath();
  const masterPath = dataPath('feed-log');
  
  // Try today's archive first
  if (fs.existsSync(archivePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
      if (Array.isArray(data) && data.length > 0) {
        feedLog = data;
        console.log(`[Feed] ✓ Loaded ${feedLog.length} messages from today's archive`);
        return;
      }
    } catch (e) {
      console.error('[Feed] Error reading today\'s archive:', e.message);
    }
  }
  
  // Fallback: load from master feed-log (cross-day persistence)
  if (fs.existsSync(masterPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
      if (Array.isArray(data) && data.length > 0) {
        feedLog = data;
        console.log(`[Feed] ✓ Loaded ${feedLog.length} messages from master feed-log (cross-day)`);
        return;
      }
    } catch (e) {
      console.error('[Feed] Error reading master feed-log:', e.message);
    }
  }
  
  console.log('[Feed] No archived messages found (fresh start)');
}

function saveFeedLog() {
  const archivePath = getFeedLogPath();
  const masterPath = dataPath('feed-log');
  try {
    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    
    // Save to today's archive (persistent)
    fs.writeFileSync(archivePath, JSON.stringify(feedLog, null, 2));
    // Also save to master feed-log.json (for cross-day access)
    fs.writeFileSync(masterPath, JSON.stringify(feedLog.slice(0, 500), null, 2));
    console.log(`[Feed] Saved ${feedLog.length} messages to ${archivePath}`);
  } catch (e) {
    console.error('[Feed] SAVE ERROR:', e.message, '| Path:', archivePath);
  }
}

function addToFeed(entry) {
  feedLog.unshift(entry); // newest first
  if (feedLog.length > 500) feedLog.pop();
  
  // Check if day changed — rotate to new archive file
  const today = new Date().toDateString();
  if (today !== feedDay) {
    feedDay = today;
  }
  
  saveFeedLog(); // save to disk after each entry
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

// ─── Deletion Log (for transparency & recovery) ────────────────────────────────
// Every deleted message is logged here with full details
// This ensures nothing is ever lost and mods can see exactly what was deleted and why
const deletionLog = [];  // current session deletions (in-memory)
const DELETION_LOG_PATH = path.join(DATA_DIR, 'deletion-log.jsonl');  // persistent log (one entry per line)

function logDeletion(guildId, messageId, userId, username, channelName, content, reason, verdict, category) {
  const entry = {
    timestamp: new Date().toISOString(),
    guildId: guildId,
    messageId: messageId,
    userId: userId,
    username: username,
    channel: channelName,
    content: content,
    reason: reason,
    verdict: verdict,
    category: category,
  };
  
  // Add to in-memory log
  deletionLog.unshift(entry);
  if (deletionLog.length > 1000) deletionLog.pop();
  
  // Append to persistent file (JSONL format = one JSON object per line)
  try {
    fs.appendFileSync(DELETION_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[modbot] Failed to write deletion log:', err.message);
  }
  
  console.log(`[modbot] 📋 DELETION LOGGED: ${username} in #${channelName} — "${content.slice(0, 50)}..."`);
}

// Load deletion log from persistent storage on startup
function loadDeletionLog() {
  if (!fs.existsSync(DELETION_LOG_PATH)) return;
  try {
    const lines = fs.readFileSync(DELETION_LOG_PATH, 'utf8').split('\n').filter(l => l.trim());
    deletionLog.length = 0;
    lines.slice(-1000).forEach(line => {  // load last 1000 entries
      try {
        deletionLog.push(JSON.parse(line));
      } catch {}
    });
    deletionLog.reverse();  // most recent first
    console.log(`[modbot] 📋 Loaded ${deletionLog.length} deletion log entries`);
  } catch (err) {
    console.error('[modbot] Failed to load deletion log:', err.message);
  }
}

// Backup deletion log daily
function backupDeletionLog() {
  if (!fs.existsSync(DELETION_LOG_PATH)) return;
  try {
    const timestamp = new Date().toISOString().split('T')[0];
    const backupPath = path.join(DATA_DIR, `deletion-log-backup-${timestamp}.jsonl`);
    fs.copyFileSync(DELETION_LOG_PATH, backupPath);
    console.log(`[modbot] 📋 Deletion log backed up to ${backupPath}`);
  } catch (err) {
    console.error('[modbot] Failed to backup deletion log:', err.message);
  }
}

// Rate limiting for deletions (prevent cascade deletes)
const deletionRateLimiter = {};  // { guildId: { count: 0, resetTime: timestamp } }
function checkDeletionRateLimit(guildId) {
  const now = Date.now();
  if (!deletionRateLimiter[guildId]) {
    deletionRateLimiter[guildId] = { count: 0, resetTime: now + 60000 };  // 1-minute window
  }
  
  const limiter = deletionRateLimiter[guildId];
  if (now > limiter.resetTime) {
    limiter.count = 0;
    limiter.resetTime = now + 60000;
  }
  
  limiter.count++;
  
  // Alert if >20 deletions per minute (allows handling profanity spam bursts)
  if (limiter.count > 20) {
    console.warn(`[modbot] ⚠️  ALERT: ${limiter.count} deletions in the last minute! Possible bug or cascade delete.`);
    return false;  // Pause deletion
  }
  
  return true;  // Deletion OK
}

// Default config per guild
const GUILD_DEFAULTS = {
  enabled:            true,
  sensitivity:        'medium',    // 'low' | 'medium' | 'high'
  monitorAllChannels: true,
  monitorChannels:    [],
  ignoreChannels:     ['mod-log', 'bot-log', 'staff', 'admin'],
  exemptRoles:        ['Moderator', 'Admin', 'Staff'],  // members with these roles are never moderated
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
  vipPersonDescription: 'Lexi Carroll is the community leader and livestreamer. She is a young woman who is the founder and heart of this community. Any sexual comments, romantic fixation, obsessive appearance comments, or inappropriate targeting directed at her — even if subtle — should be flagged as CAUTION or REMOVE immediately.',  vipNames:             ['lexi', 'lexi carroll'],  // name references count as targeting the VIP even without @mention  profanityFilter:      true, // block cuss words (good for church/christian servers)
  serverType:           'christian', // 'christian' | 'general'

  // ── Dashboard ───────────────────────────────────────────────────────────────
  dashboardPort:        3006,
  dashboardPassword:    '',   // optional password for the dashboard
};

function getGuildCfg(guildId) {
  if (!cfg[guildId]) cfg[guildId] = { ...GUILD_DEFAULTS };
  else {
    // Backfill any new default keys missing from saved configs
    for (const k of Object.keys(GUILD_DEFAULTS)) {
      if (!(k in cfg[guildId])) cfg[guildId][k] = GUILD_DEFAULTS[k];
    }
  }
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

function addViolation(guildId, userId, verdict, reason, category, content, channelId, username = '') {
  const record = getUserRecord(guildId, userId);
  record.violations.push({
    ts: Date.now(),
    verdict,
    reason,
    category,
    content: content.slice(0, 400),
    channelId,
    username,
  });
  // Keep last 200 violations per user
  if (record.violations.length > 200) record.violations.shift();
  saveRecords();
}

// Backfill missing usernames in old violations
function backfillMissingUsernames() {
  let fixed = 0;
  for (const guildId in userRecords) {
    for (const userId in userRecords[guildId]) {
      const record = userRecords[guildId][userId];
      if (!record.violations) continue;
      
      // Find the last violation with a username
      let lastUsername = null;
      for (let i = record.violations.length - 1; i >= 0; i--) {
        if (record.violations[i].username) {
          lastUsername = record.violations[i].username;
          break;
        }
      }
      
      // If found, backfill all violations without username
      if (lastUsername) {
        for (let i = 0; i < record.violations.length; i++) {
          if (!record.violations[i].username) {
            record.violations[i].username = lastUsername;
            fixed++;
          }
        }
      }
    }
  }
  if (fixed > 0) {
    console.log(`[backfill] Fixed ${fixed} violations with missing usernames`);
    saveRecords();
  }
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
  // Allow short messages — profanity can be 3 chars (e.g., "cum", "ass")
  if (t.length < 2) return true;              // single char is truly trivial
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
// Prompts live in prompts.js (shared with test files — single source of truth).
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
      `\nKEY PERSON IN THIS COMMUNITY — pay close attention to messages directed at this person:\n` +
      gcfg.vipPersonDescription.trim() + `\n` +
      `Any sexual comments, romantic targeting, or inappropriate advances directed at this person should be treated with high priority and result in REMOVE.`
    );
  }

  return base + extras.join('');
}

async function gptAnalyze(msg, guildId, mentionedUsers = []) {
  const gcfg      = getGuildCfg(guildId);
  const sysPrompt = buildPrompt(gcfg);
  const mentioned = mentionedUsers.map(u => u.username).join(', ');
  const ctxNote   = mentioned ? `This message @mentions: ${mentioned}.` : '';

  // If this is a reply, include the replied-to message — critical context
  // (e.g. "I'm waiting for you 🫦" replying to "just got out of the shower")
  let replyCtx = '';
  if (msg.reference?.messageId) {
    try {
      const ref = await msg.channel.messages.fetch(msg.reference.messageId);
      if (ref?.content) {
        replyCtx = `\nThis message is a REPLY to ${ref.author.username}'s message: "${ref.content.slice(0, 200)}"\n`;
      }
    } catch {}
  }

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
          { role: 'user',   content: `${ctxNote}${replyCtx}${ctxBlock}\nCurrent message from ${msg.author.username}: "${msg.content}"` }
        ],
        max_completion_tokens: 150,
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

// ─── Stage 1: GPT explicit-content classifier ──────────────────────────────────
// Catches profanity, hate speech, self-harm, explicit sexual language, and
// credible real-world threats. Context-free by design — romantic/flirty content
// passes through to Stage 2 which judges it with conversation context.
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
    
    if (result.verdict === 'REMOVE') {
      console.log(`[modbot] ✅ Stage 1 FLAGGED: ${result.category} — ${result.reason}`);
      return {
        verdict: 'REMOVE',
        severity: 5,
        reason: result.reason,
        category: result.category
      };
    }
    
    console.log(`[modbot] ✅ Stage 1 PASS (safety check clean)`);
    return null;
  } catch (e) {
    console.error('[modbot] GPT safety check error:', e.message);
    return null;
  }
}



// ─── Action / discipline (Stage 3) ────────────────────────────────────────────
// Timeout/mute removed — bot lacks Manage Members intent.
// Message deletion + violation tracking is the primary moderation mechanism.

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
  addViolation(guildId, uid, verdict, reason, category, msg.content, msg.channel.id, msg.author.username);

  const actionsTaken = [];
  let timeoutMinutes = 0;
  let deleted = false;

  if (verdict === 'REMOVE') {
    // Delete message (with logging and rate limiting)
    
    // Check rate limiter to prevent cascade deletes
    if (!checkDeletionRateLimit(guildId)) {
      console.warn(`[modbot] 🛑 DELETION RATE LIMIT HIT — pausing deletions in ${guildId}`);
      actionsTaken.push('paused (rate limit)');
    } else {
      // Log the deletion BEFORE actually deleting (so we have a record)
      logDeletion(guildId, msg.id, uid, msg.author.username, msg.channel.name, msg.content, reason, verdict, category);
      
      // Actually delete the message
      try { await msg.delete(); deleted = true; actionsTaken.push('deleted'); } catch (err) {
        console.error(`[modbot] Failed to delete message: ${err.message}`);
      }
    }

    // Note: Timeout/mute removed — bot lacks Manage Members intent.
    // Message deletion + violation tracking is sufficient; admins can manually action users via dashboard.
    const newStrikes = strikes + 1;

    // DM the user — but skip for profanity (swift justice, no warning needed)
    if (gcfg.dmWarnings && category !== 'profanity') {
      const dmText = newStrikes === 1
        ? `Hey! 👋 Just a heads up — your message in **#${msg.channel.name}** was removed.\n\nNo big deal, just keep things friendly and mindful of others in the community. You're good! 🙂`
        : `Hey! 👋 Your message in **#${msg.channel.name}** was removed again (this is strike ${newStrikes}).\n\nJust be mindful of how messages might come across to others — we want everyone to feel comfortable here. ✌️`;
      try { await msg.author.send(dmText); actionsTaken.push('DM sent'); } catch {}
    }
  } else if (verdict === 'CAUTION' && gcfg.logCautionMessages) {
    actionsTaken.push('flagged for review');
  }

  // Build mod log embed
  const newStrikes = getActiveStrikes(guildId, uid); // re-read after adding violation
  const color  = verdict === 'REMOVE' ? (newStrikes >= 3 ? 0xDD0000 : 0xFF4444) : 0xFFAA00;
  const icon   = verdict === 'REMOVE' ? '🚫' : '⚠️';
  const title  = verdict === 'REMOVE' ? `🚫 Message Removed` : `⚠️ Flagged`;
  const embed  = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
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

  // Role exemption — never moderate mods/admins/staff
  const memberRoles = msg.member?.roles?.cache;
  if (memberRoles && (gcfg.exemptRoles || []).some(rn =>
    memberRoles.some(r => r.name.toLowerCase() === rn.toLowerCase()))) return;

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
    console.log(`[modbot] 🚨 STAGE 1 VERDICT: REMOVE (${safetyResult.category})`);
    verdict = safetyResult.verdict;
    severity = safetyResult.severity;
    reason = safetyResult.reason;
    category = safetyResult.category;
  } else {
    // ── STAGE 2: GPT analysis (for targeting, obsessive behavior, context-based issues) ──
    console.log(`[modbot] → STAGE 2: Context analysis...`);
    const gptResult = await gptAnalyze(msg, guildId, realMentions);
    console.log(`[modbot] 📊 STAGE 2 VERDICT: ${gptResult.verdict}`);
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
  console.log(`[modbot] 📝 FEED: ${msg.author.username} | ${verdict} | "${msg.content.slice(0, 40)}"`);

  if (verdict === 'SAFE') return;

  const mentionedIds = realMentions.map(u => u.id);

  // VIP name reference counts as targeting even without an @mention
  // (real incident: 3 escalating messages about the VIP, zero @mentions)
  const lc = msg.content.toLowerCase();
  const referencesVip = (gcfg.vipNames || []).some(n => lc.includes(n.toLowerCase()));
  const targetIds = referencesVip && !mentionedIds.includes('VIP') ? [...mentionedIds, 'VIP'] : mentionedIds;

  // Track targeting pattern + escalate CAUTION → REMOVE on repeat offenders
  if (targetIds.length && (category === 'sexual' || category === 'targeting')) {
    trackTargeting(guildId, uid, targetIds, gcfg.targetingWindowHours);
    if (verdict === 'CAUTION') {
      for (const tid of targetIds) {
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
        name: 'shadow', type: 1, description: 'Toggle shadow mode (analyze + log only, no deletes/DMs)',
        options: [{ name: 'enabled', type: 5, description: 'Shadow mode on/off', required: true }]
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
  
  // Load persistent data from disk
  loadDeletionLog();
  loadFeedLog();
  backfillMissingUsernames();  // Fix old violations without usernames
  
  // Setup daily deletion log backup
  setInterval(backupDeletionLog, 24 * 60 * 60 * 1000);  // backup every 24 hours
  
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
    const guildId = msg.guild.id;
    
    // Log the spam deletion
    logDeletion(guildId, msg.id, msg.author.id, msg.author.username, msg.channel.name, msg.content, 'Rapid message spam', 'REMOVE', 'spam');
    
    try { await msg.delete(); } catch {}
    addViolation(guildId, msg.author.id, 'REMOVE', 'Rapid message spam', 'spam', msg.content, msg.channel.id, msg.author.username);
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
      addViolation(guildId, u.id, 'WARN', reason, 'manual', '[manual warning]', inter.channelId || '', u.username);
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
    // ── logchannel ────────────────────────────────────────────────────────────────────
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

// GET /api/deletions?limit=100&guildId=optional
dashApp.get('/api/deletions', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const guildId = req.query.guildId;
  
  // Filter by guildId if specified
  const filtered = guildId 
    ? deletionLog.filter(d => d.guildId === guildId)
    : deletionLog;
  
  res.json({
    total: filtered.length,
    limit: limit,
    deletions: filtered.slice(0, limit)
  });
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

// GET /api/user-report/:userId?guildId=XXX (detailed violation history)
dashApp.get('/api/user-report/:userId', (req, res) => {
  const guildId = req.query.guildId;
  const userId = req.params.userId;
  if (!guildId) return res.status(400).json({ error: 'guildId required' });
  
  const record = getUserRecord(guildId, userId);
  if (!record.violations.length) {
    return res.json({ userId, username: 'Unknown', violations: [], summary: {} });
  }
  
  // Get username from latest violation
  let username = userId.slice(0, 8);
  for (let i = record.violations.length - 1; i >= 0; i--) {
    if (record.violations[i].username) {
      username = record.violations[i].username;
      break;
    }
  }
  
  const gcfg = getGuildCfg(guildId);
  const strikeDecay = gcfg.strikeDecayDays * 86400000;
  
  // Build summary
  const violationsByType = {};
  let activeStrikes = 0;
  for (const v of record.violations) {
    if (!violationsByType[v.verdict]) violationsByType[v.verdict] = 0;
    violationsByType[v.verdict]++;
    if (v.ts > Date.now() - strikeDecay && v.verdict === 'REMOVE') activeStrikes++;
  }
  
  res.json({
    userId,
    username,
    totalViolations: record.violations.length,
    activeStrikes,
    violationsByType,
    violations: record.violations.map((v, i) => ({
      index: i,
      ts: v.ts,
      date: new Date(v.ts).toLocaleString(),
      verdict: v.verdict,
      reason: v.reason,
      category: v.category,
      content: v.content,
      channel: v.channelId,
      username: v.username || 'Unknown',
      severity: v.severity || 0,
    })).reverse(), // newest first
  });
});

// GET /api/debug (diagnostic info)
dashApp.get('/api/debug', (req, res) => {
  res.json({
    feedLogCount: feedLog.length,
    feedLogSample: feedLog.slice(0, 3),
    userRecordsKeys: Object.keys(userRecords),
    guildSummary: Object.entries(userRecords).map(([guildId, guild]) => ({
      guildId,
      userCount: Object.keys(guild).length,
      totalViolations: Object.values(guild).reduce((sum, u) => sum + (u.violations?.length || 0), 0),
    })),
  });
});

// GET /api/users (all users with any violations, for dashboard user list)
dashApp.get('/api/users', (req, res) => {
  const guildId = req.query.guildId;
  const source  = guildId ? (userRecords[guildId] || {}) : {};
  const users   = Object.entries(source).map(([uid, record]) => {
    // Find latest violation with username, or use uid as fallback
    let username = uid.slice(0, 8); // default to uid slice
    for (let i = record.violations.length - 1; i >= 0; i--) {
      if (record.violations[i].username) {
        username = record.violations[i].username;
        break;
      }
    }
    const lastViolation = record.violations.length ? record.violations[record.violations.length - 1] : null;
    return {
      userId:        uid,
      username:      username,
      activeStrikes: record.violations.filter(v => {
        const gcfg = getGuildCfg(guildId);
        return v.ts > Date.now() - gcfg.strikeDecayDays * 86400000 && v.verdict === 'REMOVE';
      }).length,
      totalViolations: record.violations.length,
      lastViolation:   lastViolation?.ts || null,
    };
  }).sort((a, b) => (b.lastViolation || 0) - (a.lastViolation || 0));
  res.json(users);
});

const DASHBOARD_PORT = parseInt(process.env.PORT) || parseInt(process.env.DASHBOARD_PORT) || 3006;
dashApp.listen(DASHBOARD_PORT, '0.0.0.0', () => {
  console.log(`🎛️  Jelly Labs Studio: http://localhost:${DASHBOARD_PORT}`);
});

client.login(TOKEN);
