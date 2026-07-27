// Backup Bot - Read-only Server Backup (Safe permissions)
// This bot ONLY reads and backs up server state
// Cannot delete, ban, or modify anything
// Safe to leave running 24/7 for automatic daily backups

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, REST, Routes, PermissionsBitField } = require('discord.js');
const axios = require('axios');

const TOKEN = process.env.BACKUP_BOT_TOKEN;
const CLIENT_ID = process.env.BACKUP_BOT_CLIENT_ID;
const BACKUP_DIR = path.join(__dirname, 'backups');
const PENDING_DIR = path.join(__dirname, 'pending');
const EMOJI_DIR = path.join(__dirname, 'emojis');
const MAX_BACKUPS = 5;
const MAX_MESSAGES_PER_CHANNEL = 1000;

// Ensure required directories exist
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
if (!fs.existsSync(EMOJI_DIR)) fs.mkdirSync(EMOJI_DIR, { recursive: true });

// Slash command definitions
const commands = [
  { name: 'backup', description: 'Backup entire server (admin only)' },
  { name: 'getbackup', description: 'DM your latest backup file (admin only)' },
  { name: 'schedulebackup', description: 'Enable automatic daily backups (admin only)' }
];

// SAFE permissions (read-only, no modifications possible)
const SAFE_PERMS = (
  PermissionsBitField.Flags.ViewChannel |
  PermissionsBitField.Flags.ReadMessageHistory |
  PermissionsBitField.Flags.SendMessages |
  PermissionsBitField.Flags.AttachFiles |
  PermissionsBitField.Flags.EmbedLinks
);

// Global registration of slash commands
const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Backup bot slash commands registered globally.');
  console.log('\n===============================================');
  console.log('Discord Backup Bot Ready!');
  console.log('\nBACKUP BOT INVITE (read-only, safe permissions):');
  console.log(
    `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&scope=bot+applications.commands&permissions=${SAFE_PERMS}`
  );
  console.log('\n✅ This bot only reads and backs up. Cannot delete, ban, or modify anything.');
  console.log('✅ Safe to leave running 24/7 for automatic daily backups.');
  console.log('===============================================\n');
})();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildMembers,
  ]
});

client.once('ready', () => {
  console.log(`🟢 Backup bot ready as ${client.user.tag}`);
  // Start automatic daily backups
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

async function performBackup(guild, showMessages = true) {
  let backup = { guild: {}, roles: [], categories: [], channels: [], nicknames: {}, emojis: [], bans: [], webhooks: [] };

  // Guild info
  backup.guild = {
    id: guild.id,
    name: guild.name,
    description: guild.description,
    icon: guild.iconURL(),
    banner: guild.banner,
    ownerId: guild.ownerId,
    verificationLevel: guild.verificationLevel,
    explicitContentFilter: guild.explicitContentFilter,
    defaultMessageNotifications: guild.defaultMessageNotifications,
    mfaLevel: guild.mfaLevel,
    systemChannelId: guild.systemChannelId,
  };

  // Roles (sorted by position, skipping @everyone)
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

  // Categories & Channels
  backup.categories = [];
  backup.channels = [];
  for (const [, channel] of guild.channels.cache) {
    if (channel.type === 4 || channel.type === 'GUILD_CATEGORY') {
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
        rateLimitPerUser: channel.rateLimitPerUser,
        bitrate: channel.bitrate,
        userLimit: channel.userLimit,
        rtcRegion: channel.rtcRegion,
        permissionOverwrites: channel.permissionOverwrites.cache.map(po => ({
          id: po.id,
          type: po.type,
          allow: po.allow.bitfield.toString(),
          deny: po.deny.bitfield.toString(),
        })),
        messages: [],
        pinned: [],
      };

      try {
        let messages = await fetchAllMessages(channel, MAX_MESSAGES_PER_CHANNEL);
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
              size: a.size,
            })),
            embeds: m.embeds,
            reactions: m.reactions.cache.map(r => ({
              emoji: r.emoji.name,
              count: r.count,
            })),
          }));

        const pins = await channel.messages.fetchPinned();
        channelData.pinned = pins.map(m => m.id);
      } catch (e) {
        // Skip non-text channels or errors
      }

      backup.channels.push(channelData);
    }
  }

  // Member Nicknames
  await guild.members.fetch();
  guild.members.cache.forEach(member => {
    if (member.nickname) backup.nicknames[member.id] = member.nickname;
  });

  // Emojis
  for (const [, emoji] of guild.emojis.cache) {
    let emojiData = {
      name: emoji.name,
      id: emoji.id,
      url: emoji.url,
      animated: emoji.animated,
    };
    const ext = emoji.animated ? 'gif' : 'png';
    const emPath = path.join(EMOJI_DIR, `${emoji.name}_${emoji.id}.${ext}`);
    try {
      const res = await axios.get(emoji.url, { responseType: 'arraybuffer' });
      fs.writeFileSync(emPath, res.data);
      emojiData.localPath = emPath;
    } catch {}
    backup.emojis.push(emojiData);
  }

  // Save backup file
  const timestamp = Date.now();
  const fileBase = `${guild.id}-${timestamp}`;
  const backupFiles = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(guild.id));
  if (backupFiles.length >= MAX_BACKUPS) {
    const sorted = backupFiles.sort();
    fs.unlinkSync(path.join(BACKUP_DIR, sorted[0]));
  }
  const backupFilePath = path.join(BACKUP_DIR, `${fileBase}.json`);
  fs.writeFileSync(backupFilePath, JSON.stringify(backup, null, 2));
  
  return { success: true, file: fileBase, size: backup.channels.length, messages: backup.channels.reduce((a, c) => a + c.messages.length, 0) };
}

function scheduleAutomaticBackups() {
  // Run at 2 AM every day (PST/PDT)
  const now = new Date();
  const target = new Date();
  target.setHours(2, 0, 0, 0);
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }
  const delay = target.getTime() - now.getTime();
  console.log(`Next automatic backup scheduled in ${Math.round(delay / 1000 / 60)} minutes`);
  
  setTimeout(async () => {
    console.log('Running automatic backups...');
    for (const guild of client.guilds.cache.values()) {
      try {
        await performBackup(guild, false);
        console.log(`✅ Auto-backup complete for ${guild.name}`);
      } catch (e) {
        console.error(`Auto-backup failed for ${guild.name}:`, e.message);
      }
      await delay(2000);
    }
    scheduleAutomaticBackups(); // Reschedule for next day
  }, delay);
}

client.on('interactionCreate', async inter => {
  if (!inter.isChatInputCommand()) return;
  if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator))
    return inter.reply({ content: 'Admin only.', ephemeral: true });

  const guild = inter.guild;
  const guildId = guild.id;
  const userId = inter.user.id;

  // --- BACKUP ---
  if (inter.commandName === 'backup') {
    await inter.deferReply({ ephemeral: true });
    try {
      const result = await performBackup(guild);
      await inter.editReply(
        `✅ Server backup complete!\nFile: \`${result.file}.json\`\nChannels: ${result.size}, Messages: ${result.messages}\nUse \`/getbackup\` to receive via DM.`
      );
    } catch (e) {
      await inter.editReply(`Backup failed: ${e.message}`);
    }
    return;
  }

  // --- GET BACKUP ---
  if (inter.commandName === 'getbackup') {
    await inter.deferReply({ ephemeral: true });
    const backupFiles = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith(guildId) && f.endsWith('.json'))
      .sort();
    if (!backupFiles.length) return inter.editReply('No backups found for this server.');
    const latestFile = backupFiles[backupFiles.length - 1];
    const user = await client.users.fetch(userId);
    await user.send({
      content: `✅ Latest backup for **${guild.name}**: \`${latestFile}.json\`\n\nTo restore this backup, you will need the separate **Restore Bot** (admin permissions only).`,
      files: [path.join(BACKUP_DIR, latestFile)]
    });
    await inter.editReply('✅ Backup file sent via DM!');
    return;
  }

  // --- SCHEDULE BACKUP ---
  if (inter.commandName === 'schedulebackup') {
    await inter.deferReply({ ephemeral: true });
    await inter.editReply('✅ Automatic backups are scheduled daily at 2 AM (PST/PDT).\nUse `/getbackup` to download the latest backup anytime.');
    return;
  }
});

client.login(TOKEN);
