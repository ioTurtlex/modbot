// Jelly Guardian + Backup Bot Combined
// MODERATION + BACKUP in ONE BOT
// Permissions: Send Messages + Manage Messages + Read Message History
// Role: Real-time moderation AND automatic daily backups

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, REST, Routes, PermissionsBitField } = require('discord.js');
const axios = require('axios');
const OpenAI = require('openai').default;

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'defaultpassword';
const OWNER_ID = process.env.OWNER_ID;
const BOT_NAME = process.env.BOT_NAME || 'Jelly Guardian';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const express = require('express');
const app = express();

// Data directories
const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DELETION_LOG_DIR = path.join(DATA_DIR, 'deletion-logs');

[DATA_DIR, BACKUP_DIR, DELETION_LOG_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Slash commands
const commands = [
  { name: 'modbot', description: 'Moderation bot controls' },
  { name: 'backup', description: 'Backup entire server (admin only)' },
  { name: 'getbackup', description: 'DM your latest backup file (admin only)' }
];

// Permissions: Send Messages (4096) + Manage Messages (8192) + Read Message History (65536) = 77824
const BOT_PERMS = 77824;

// Register commands only if TOKEN is available
if (TOKEN) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  (async () => {
    try {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Bot slash commands registered.');
    } catch (err) {
      console.error('Failed to register commands:', err.message);
    }
  })();
} else {
  console.warn('⚠️ DISCORD_TOKEN not set. Skipping command registration.');
}

console.log('\n===============================================');
console.log(`${BOT_NAME} Ready!`);
console.log('\nBOT INVITE (Moderation + Backup permissions):');
console.log(
  `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&scope=bot+applications.commands&permissions=${BOT_PERMS}`
  );
  console.log(`\n✅ This bot does TWO things:`);
console.log(`   1. Real-time moderation (delete rule violations)`);
console.log(`   2. Automatic daily server backups at 2 AM PST/PDT`);
console.log(`\n✅ Permissions: Send Messages + Manage Messages + Read History only`);
console.log(`===============================================\n`);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildEmojisAndStickers,
  ]
});

client.once('ready', () => {
  console.log(`🟢 Ready as ${client.user.tag}`);
  scheduleAutomaticBackups();
});

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function formatDate(dt) {
  const date = new Date(dt);
  const locale = 'en-US';
  const opts = {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short'
  };
  const str = date.toLocaleString(locale, opts);
  const [datePart, timeZonePart] = str.split(',');
  const [timePart, zone] = timeZonePart.trim().split(' ');
  const [m, d, y] = datePart.split('/');
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')} ${timePart} ${zone}`;
}

// ===== MODERATION CODE =====

const { STAGE1_PROMPT, SENSITIVITY_PROMPTS } = require('./prompts');

const GUILD_DEFAULTS = {
  shadowMode: true,
  enabled: true,
  sensitivity: 'medium',
  targetIds: [],
  modLogChannel: null
};

function getConfigPath(guildId) {
  return path.join(DATA_DIR, `mod-config-${guildId}.json`);
}

function loadConfig(guildId) {
  const configPath = getConfigPath(guildId);
  if (fs.existsSync(configPath)) {
    let config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Backfill new keys from defaults
    Object.keys(GUILD_DEFAULTS).forEach(key => {
      if (!(key in config)) config[key] = GUILD_DEFAULTS[key];
    });
    return config;
  }
  return { ...GUILD_DEFAULTS };
}

function saveConfig(guildId, config) {
  const configPath = getConfigPath(guildId);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function getVipNames() {
  return ['lexi', 'lexi carroll'];
}

async function gptAnalyze(message, sensitivity = 'medium') {
  try {
    const replyContext = message.reference 
      ? await message.channel.messages.fetch(message.reference.messageId)
      : null;
    
    const vipNames = getVipNames();
    const referencesVip = vipNames.some(name => message.content.toLowerCase().includes(name));

    // Stage 1: Context-free explicit content
    const stage1Response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: STAGE1_PROMPT + '\n\nMessage: ' + message.content }],
      response_format: { type: 'json_object' },
      temperature: 0
    });

    const stage1 = JSON.parse(stage1Response.choices[0].message.content);

    if (stage1.explicit_content) {
      return { verdict: 'REMOVE', category: 'explicit_content', confidence: 'high' };
    }

    // Stage 2: Context-dependent analysis
    const stage2Prompt = SENSITIVITY_PROMPTS[sensitivity] || SENSITIVITY_PROMPTS.medium;
    const contextMsg = replyContext ? `\nThis is a REPLY to [${replyContext.author.username}]: "${replyContext.content}"` : '';
    const vipContext = referencesVip ? `\nThe message references VIP member: ${vipNames.join(', ')}` : '';

    const stage2Response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: stage2Prompt + '\n\nMessage: ' + message.content + contextMsg + vipContext }],
      response_format: { type: 'json_object' },
      temperature: 0
    });

    const stage2 = JSON.parse(stage2Response.choices[0].message.content);
    return { 
      verdict: stage2.verdict || 'SAFE', 
      category: stage2.category || 'general',
      confidence: stage2.confidence || 'medium'
    };
  } catch (e) {
    console.error('GPT analysis error:', e);
    return { verdict: 'SAFE', category: 'error', confidence: 'low' };
  }
}

async function logDeletion(guildId, message, reason, verdict, category) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    guildId,
    messageId: message.id,
    userId: message.author.id,
    username: message.author.username,
    channel: message.channel.name,
    content: message.content,
    reason,
    verdict,
    category
  };

  const logFile = path.join(DELETION_LOG_DIR, `deletion-log-${guildId}.jsonl`);
  fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
}

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const guild = message.guild;
  const config = loadConfig(guild.id);

  if (!config.enabled) return;

  const analysis = await gptAnalyze(message, config.sensitivity);

  if (analysis.verdict === 'REMOVE') {
    await logDeletion(guild.id, message, analysis.category, 'REMOVE', analysis.category);

    if (!config.shadowMode) {
      await message.delete().catch(() => {});
      await message.author.send(`⚠️ Your message in **${guild.name}** was removed.\nReason: ${analysis.category}`).catch(() => {});
    }

    const modLog = guild.channels.cache.get(config.modLogChannel);
    if (modLog) {
      modLog.send(`🚫 **REMOVED**: ${message.author.username} - ${analysis.category}\n\`\`\`${message.content.substring(0, 100)}\`\`\``);
    }
  } else if (analysis.verdict === 'CAUTION') {
    await logDeletion(guild.id, message, analysis.category, 'CAUTION', analysis.category);
    const modLog = guild.channels.cache.get(config.modLogChannel);
    if (modLog) {
      modLog.send(`⚠️ **CAUTION**: ${message.author.username} - ${analysis.category}`);
    }
  }
});

client.on('interactionCreate', async inter => {
  if (!inter.isChatInputCommand()) return;

  const guild = inter.guild;
  const config = loadConfig(guild.id);

  if (inter.commandName === 'modbot') {
    const subcommand = inter.options.getSubcommand();
    if (subcommand === 'shadow') {
      if (inter.user.id !== OWNER_ID) return inter.reply({ content: 'Owner only.', ephemeral: true });
      const enabled = inter.options.getBoolean('enabled');
      config.shadowMode = enabled;
      saveConfig(guild.id, config);
      await inter.reply({ content: `Shadow mode ${enabled ? 'enabled' : 'disabled'}`, ephemeral: true });
    }
  }

  if (inter.commandName === 'backup') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return inter.reply({ content: 'Admin only.', ephemeral: true });
    }
    await inter.deferReply({ ephemeral: true });
    await performBackup(guild);
    await inter.editReply('✅ Backup complete! Use `/getbackup` to receive the file.');
  }

  if (inter.commandName === 'getbackup') {
    if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return inter.reply({ content: 'Admin only.', ephemeral: true });
    }
    await inter.deferReply({ ephemeral: true });
    const backupFiles = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith(guild.id))
      .sort();
    if (!backupFiles.length) return inter.editReply('No backups found.');
    const latestFile = backupFiles[backupFiles.length - 1];
    const user = await client.users.fetch(inter.user.id);
    await user.send({
      content: `✅ Latest backup for ${guild.name}`,
      files: [path.join(BACKUP_DIR, latestFile)]
    });
    await inter.editReply('✅ Sent via DM!');
  }
});

// ===== BACKUP CODE =====

async function fetchAllMessages(channel, max = 1000) {
  let allMessages = [];
  let lastId = undefined;
  while (allMessages.length < max) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    let messages = await channel.messages.fetch(options);
    if (!messages.size) break;
    allMessages = allMessages.concat(Array.from(messages.values()));
    lastId = messages.last().id;
    if (messages.size < 100) break;
    await delay(400);
  }
  return allMessages.reverse().slice(0, max);
}

async function performBackup(guild) {
  let backup = { guild: {}, roles: [], categories: [], channels: [], nicknames: {}, emojis: [], webhooks: [] };

  backup.guild = {
    id: guild.id,
    name: guild.name,
    description: guild.description,
    icon: guild.iconURL(),
    ownerId: guild.ownerId,
  };

  backup.roles = guild.roles.cache
    .filter(r => r.name !== '@everyone')
    .sort((a, b) => a.position - b.position)
    .map(role => ({
      id: role.id,
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      position: role.position,
      permissions: role.permissions.bitfield.toString(),
      mentionable: role.mentionable,
    }));

  for (const [, channel] of guild.channels.cache) {
    if (channel.type === 4) {
      backup.categories.push({
        id: channel.id,
        name: channel.name,
        position: channel.position,
        permissionOverwrites: channel.permissionOverwrites.cache.map(po => ({
          id: po.id,
          type: po.type,
          allow: po.allow.bitfield.toString(),
          deny: po.deny.bitfield.toString(),
        })),
      });
    } else {
      let channelData = {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        parentId: channel.parentId,
        position: channel.position,
        topic: channel.topic,
        nsfw: channel.nsfw,
        messages: [],
      };

      try {
        let messages = await fetchAllMessages(channel, 1000);
        channelData.messages = messages
          .filter(m => !!m)
          .map(m => ({
            id: m.id,
            authorId: m.author.id,
            authorUsername: m.author.username,
            content: m.content,
            createdAt: m.createdAt,
            attachments: Array.from(m.attachments.values()).map(a => ({
              id: a.id,
              url: a.url,
              name: a.name,
            })),
            embeds: m.embeds,
          }));
      } catch (e) {}

      backup.channels.push(channelData);
    }
  }

  await guild.members.fetch();
  guild.members.cache.forEach(member => {
    if (member.nickname) backup.nicknames[member.id] = member.nickname;
  });

  for (const [, emoji] of guild.emojis.cache) {
    backup.emojis.push({
      name: emoji.name,
      id: emoji.id,
      url: emoji.url,
      animated: emoji.animated,
    });
  }

  const timestamp = Date.now();
  const fileBase = `${guild.id}-${timestamp}`;
  const backupFiles = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(guild.id));
  if (backupFiles.length >= 5) {
    fs.unlinkSync(path.join(BACKUP_DIR, backupFiles.sort()[0]));
  }
  const backupFilePath = path.join(BACKUP_DIR, `${fileBase}.json`);
  fs.writeFileSync(backupFilePath, JSON.stringify(backup, null, 2));
}

function scheduleAutomaticBackups() {
  const now = new Date();
  const target = new Date();
  target.setHours(2, 0, 0, 0);
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  const delayMs = target.getTime() - now.getTime();
  console.log(`Next automatic backup in ${Math.round(delayMs / 1000 / 60)} minutes`);
  
  setTimeout(async () => {
    console.log('Running automatic backups...');
    for (const guild of client.guilds.cache.values()) {
      try {
        await performBackup(guild);
        console.log(`✅ Backup: ${guild.name}`);
      } catch (e) {
        console.error(`Backup failed: ${guild.name}`, e.message);
      }
      await delay(2000);
    }
    scheduleAutomaticBackups();
  }, delayMs);
}

// ===== EXPRESS DASHBOARD =====

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/deletions/:guildId', (req, res) => {
  const { guildId } = req.params;
  const { limit = 100 } = req.query;
  const logFile = path.join(DELETION_LOG_DIR, `deletion-log-${guildId}.jsonl`);
  
  if (!fs.existsSync(logFile)) {
    return res.json([]);
  }
  
  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(l => l);
  const deletions = lines.map(l => JSON.parse(l)).reverse().slice(0, parseInt(limit));
  res.json(deletions);
});

app.post('/api/shadow-mode', (req, res) => {
  const { enabled } = req.body;
  console.log(`[Dashboard] Shadow mode set to: ${enabled}`);
  res.json({ status: 'ok', shadowMode: enabled });
});

app.post('/api/enforcement', (req, res) => {
  console.log(`[Dashboard] Enforcement toggled`);
  res.json({ status: 'ok' });
});

// Serve Dashboard UI
app.get('/', (req, res) => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Jelly Guardian Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; background: linear-gradient(135deg, #667eea, #764ba2); min-height: 100vh; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    .login-box { background: white; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); width: 100%; max-width: 400px; padding: 40px; margin: 100px auto; }
    h1 { text-align: center; color: #333; margin-bottom: 30px; }
    .status-banner { background: #f0fdf4; border-left: 4px solid #10b981; padding: 15px; border-radius: 6px; margin-bottom: 25px; font-size: 14px; }
    input[type="password"] { width: 100%; padding: 12px; margin-bottom: 15px; border: 1px solid #ddd; border-radius: 6px; }
    input:focus { outline: none; border-color: #667eea; box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1); }
    button { padding: 12px 24px; background: #667eea; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; }
    button:hover { background: #764ba2; }
    .hidden { display: none; }
    
    .dashboard { background: white; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); padding: 30px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; border-bottom: 2px solid #e5e7eb; padding-bottom: 20px; }
    .header h1 { margin: 0; color: #333; }
    .logout-btn { background: #ef4444; padding: 10px 20px; }
    .logout-btn:hover { background: #dc2626; }
    
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .stat-card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; text-align: center; }
    .stat-card .number { font-size: 28px; font-weight: bold; color: #667eea; margin-bottom: 5px; }
    .stat-card .label { font-size: 12px; color: #666; text-transform: uppercase; }
    
    .controls { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin-bottom: 30px; }
    .control-group { margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
    .control-group:last-child { margin-bottom: 0; }
    .control-label { font-weight: 600; color: #333; }
    .toggle { position: relative; width: 60px; height: 30px; background: #ddd; border-radius: 15px; cursor: pointer; transition: background 0.3s; }
    .toggle.on { background: #10b981; }
    .toggle-slider { position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; background: white; border-radius: 50%; transition: left 0.3s; }
    .toggle.on .toggle-slider { left: 33px; }
    
    .feed { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; }
    .feed h3 { margin-bottom: 15px; color: #333; }
    .feed-items { max-height: 400px; overflow-y: auto; }
    .feed-item { background: white; border-left: 3px solid #667eea; padding: 12px; margin-bottom: 10px; border-radius: 4px; font-size: 13px; line-height: 1.5; }
    .feed-item.safe { border-left-color: #10b981; }
    .feed-item.caution { border-left-color: #f59e0b; }
    .feed-item.removed { border-left-color: #ef4444; }
    .feed-item .timestamp { color: #999; font-size: 11px; }
    
    .err { color: #dc2626; font-size: 12px; margin-top: 10px; }
  </style>
</head>
<body>
  <div id="login-screen" class="login-box">
    <h1>🍋 Jelly Guardian</h1>
    <div class="status-banner"><strong>✅ Status:</strong> Online and Monitoring</div>
    <input type="password" id="pwd" placeholder="Enter Dashboard Password" />
    <button onclick="tryLogin()" style="width: 100%;">Login</button>
    <div id="err" class="err"></div>
  </div>

  <div id="dashboard-screen" class="container hidden">
    <div class="dashboard">
      <div class="header">
        <div>
          <h1>🍋 Jelly Guardian Dashboard</h1>
          <p style="color: #666; font-size: 14px; margin-top: 5px;">Real-time moderation monitoring</p>
        </div>
        <button class="logout-btn" onclick="logout()">Logout</button>
      </div>

      <div class="stats">
        <div class="stat-card">
          <div class="number" id="stat-uptime">0h 0m</div>
          <div class="label">Uptime</div>
        </div>
        <div class="stat-card">
          <div class="number" id="stat-monitored">0</div>
          <div class="label">Messages Monitored</div>
        </div>
        <div class="stat-card">
          <div class="number" id="stat-flagged">0</div>
          <div class="label">Messages Flagged</div>
        </div>
        <div class="stat-card">
          <div class="number" id="stat-removed">0</div>
          <div class="label">Messages Removed</div>
        </div>
      </div>

      <div class="controls">
        <h3 style="margin-bottom: 20px;">Bot Configuration</h3>
        <div class="control-group">
          <div>
            <div class="control-label">🌙 Shadow Mode</div>
            <div style="font-size: 12px; color: #666; margin-top: 5px;">Messages logged only, not deleted</div>
          </div>
          <div class="toggle on" id="shadow-toggle" onclick="toggleShadowMode()">
            <div class="toggle-slider"></div>
          </div>
        </div>
        <div class="control-group">
          <div>
            <div class="control-label">🚨 Enforcement Enabled</div>
            <div style="font-size: 12px; color: #666; margin-top: 5px;">Bot deletes rule-breaking messages</div>
          </div>
          <div class="toggle" id="enforce-toggle" onclick="toggleEnforcement()">
            <div class="toggle-slider"></div>
          </div>
        </div>
      </div>

      <div class="feed">
        <h3>📊 Recent Activity</h3>
        <div class="feed-items" id="feed"></div>
      </div>
    </div>
  </div>

  <script>
    const PASSWORD = "JellyGuardian2026!Protect\\$Safe";
    let shadowMode = true;
    let messageCount = { monitored: 0, flagged: 0, removed: 0 };

    function tryLogin() {
      const pwd = document.getElementById("pwd").value;
      if (pwd === PASSWORD) {
        document.getElementById("login-screen").classList.add("hidden");
        document.getElementById("dashboard-screen").classList.remove("hidden");
        startDashboard();
      } else {
        document.getElementById("err").textContent = pwd ? "❌ Incorrect password" : "Please enter password";
      }
    }

    function logout() {
      document.getElementById("pwd").value = "";
      document.getElementById("err").textContent = "";
      document.getElementById("login-screen").classList.remove("hidden");
      document.getElementById("dashboard-screen").classList.add("hidden");
    }

    function toggleShadowMode() {
      shadowMode = !shadowMode;
      document.getElementById("shadow-toggle").classList.toggle("on");
      fetch("/api/shadow-mode", { method: "POST", body: JSON.stringify({ enabled: shadowMode }), headers: { "Content-Type": "application/json" } }).catch(e => console.error(e));
    }

    function toggleEnforcement() {
      document.getElementById("enforce-toggle").classList.toggle("on");
      fetch("/api/enforcement", { method: "POST", headers: { "Content-Type": "application/json" } }).catch(e => console.error(e));
    }

    function startDashboard() {
      updateStats();
      updateFeed();
      setInterval(updateStats, 2000);
      setInterval(updateFeed, 3000);
    }

    function updateStats() {
      fetch("/api/status").then(r => r.json()).then(d => {
        const h = Math.floor(d.uptime / 3600);
        const m = Math.floor((d.uptime % 3600) / 60);
        document.getElementById("stat-uptime").textContent = h + "h " + m + "m";
        document.getElementById("stat-monitored").textContent = messageCount.monitored;
        document.getElementById("stat-flagged").textContent = messageCount.flagged;
        document.getElementById("stat-removed").textContent = messageCount.removed;
      }).catch(e => {});
    }

    function updateFeed() {
      const feed = document.getElementById("feed");
      feed.innerHTML = '<div class="feed-item safe"><strong>🤖 Dashboard Active</strong> - Monitoring enabled <span class="timestamp">now</span></div>';
      if (shadowMode) {
        feed.innerHTML += '<div class="feed-item caution"><strong>🌙 Shadow Mode ON</strong> - Messages logged, not deleted <span class="timestamp">now</span></div>';
      } else {
        feed.innerHTML += '<div class="feed-item removed"><strong>⚠️ Enforcement ON</strong> - Rule violations removed <span class="timestamp">now</span></div>';
      }
    }

    document.getElementById("pwd").addEventListener("keypress", e => e.key === "Enter" && tryLogin());
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

const PORT = process.env.PORT || 3006;
app.listen(PORT, () => console.log(`Dashboard running on port ${PORT}`));

if (TOKEN) {
  client.login(TOKEN);
} else {
  console.error('❌ DISCORD_TOKEN environment variable is not set!');
  console.error('Please set DISCORD_TOKEN in your environment or .env file.');
  process.exit(1);
}
