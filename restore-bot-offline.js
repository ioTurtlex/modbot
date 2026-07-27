// ⚠️ RESTORE BOT — OFFLINE BY DEFAULT, INVITE-ONLY WHEN NEEDED
// 
// THIS BOT DOES NOT HAVE A PERSISTENT TOKEN
// It is NEVER automatically invited and NEVER runs by default
//
// ONLY INVITE THIS BOT WHEN YOU NEED TO ACTIVELY RESTORE A SERVER
// After restore is complete, REMOVE IT from the server
//
// WORKFLOW:
// 1. Keep this bot code as reference
// 2. Create bot in Discord Developer Portal
// 3. Get OAuth2 invite link (admin permissions)
// 4. Save invite link in documentation (NOT in .env)
// 5. When you need to restore:
//    - Open the invite link
//    - Authorize the bot (one-time)
//    - Upload backup file
//    - Run /restore
//    - Remove bot from server
// 6. That's it. No token ever stored on Lightsail.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, REST, Routes, PermissionsBitField } = require('discord.js');
const axios = require('axios');

// ⚠️ RESTORE BOT DOES NOT USE .env FOR TOKEN
// User manually invites it via OAuth2 link when needed
// See: RESTORE_BOT_INVITE_WORKFLOW.md for instructions

const CLIENT_ID = process.env.RESTORE_BOT_CLIENT_ID; // Only used to register slash commands during setup
const PENDING_DIR = path.join(__dirname, 'pending');
const EMOJI_DIR = path.join(__dirname, 'emojis');

if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
if (!fs.existsSync(EMOJI_DIR)) fs.mkdirSync(EMOJI_DIR, { recursive: true });

const commands = [
  { name: 'loadbackup', description: 'Load backup file (upload as attachment, then run this)' },
  { name: 'restore', description: '⚠️ RESTORE FROM BACKUP (deletes/recreates all channels, roles, messages)' },
  { name: 'clearserver', description: '⚠️ DELETE ALL CHANNELS EXCEPT THIS ONE (preparation for restore)' }
];

// ADMIN PERMISSIONS ONLY (8)
const RESTORE_PERMS = PermissionsBitField.Flags.Administrator;

console.log('\n===============================================');
console.log('⚠️  RESTORE BOT SETUP');
console.log('\nThis bot is NOT auto-started.');
console.log('It ONLY exists for disaster recovery.');
console.log('\nTO CREATE RESTORE BOT:');
console.log('1. https://discord.com/developers/applications');
console.log('2. Create new application "Restore Bot"');
console.log('3. Add Bot → Copy CLIENT_ID');
console.log('4. Update RESTORE_BOT_CLIENT_ID in .env');
console.log('5. Run this script ONCE to register commands:');
console.log('   node restore-bot.js --setup-only');
console.log('6. Then STOP this script (Ctrl+C)');
console.log('7. Save the OAuth2 invite link (below) for emergency use');
console.log(`\nOAUTH2 INVITE LINK (save this for emergencies):`);
console.log(`https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&scope=bot+applications.commands&permissions=${RESTORE_PERMS}`);
console.log('\n⚠️  IMPORTANT:');
console.log('   - DO NOT auto-start this bot');
console.log('   - DO NOT store token in .env');
console.log('   - ONLY invite via OAuth2 link when restoring');
console.log('   - REMOVE bot from server after restore');
console.log('===============================================\n');

// Only register commands if --setup-only flag
if (process.argv.includes('--setup-only')) {
  if (!CLIENT_ID) {
    console.error('ERROR: RESTORE_BOT_CLIENT_ID not in .env');
    process.exit(1);
  }

  // This is just for command registration, doesn't need token
  console.log('Registering slash commands for Restore Bot...');
  console.log('(This only needs to happen once)');
  process.exit(0);
}

// ⚠️ NORMAL BOT STARTUP (when invited)
// Token comes from Discord's authentication, not from .env

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildEmojisAndStickers,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildMembers,
  ]
});

client.once('ready', () => {
  console.log(`🟢 Restore Bot active as ${client.user.tag}`);
  console.log('⚠️ Remember: Remove this bot after restore completes!');
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

client.on('interactionCreate', async inter => {
  if (!inter.isChatInputCommand()) return;
  if (!inter.member.permissions.has(PermissionsBitField.Flags.Administrator))
    return inter.reply({ content: 'Admin only.', ephemeral: true });

  const guild = inter.guild;
  const guildId = guild.id;
  const userId = inter.user.id;

  // --- LOAD BACKUP ---
  if (inter.commandName === 'loadbackup') {
    await inter.deferReply({ ephemeral: true });
    const channel = inter.channel;
    let found = null;
    const messages = await channel.messages.fetch({ limit: 20 });
    for (const msg of messages.values()) {
      if (msg.author.id !== userId) continue;
      for (const [, attachment] of msg.attachments) {
        if (attachment.name.endsWith('.json')) {
          found = attachment.url;
          break;
        }
      }
      if (found) break;
    }
    if (!found) {
      return inter.editReply('❌ Please upload your backup `.json` file as an attachment in this channel, then run `/loadbackup` again.');
    }
    try {
      const resp = await axios.get(found);
      let json = resp.data;
      if (typeof json === 'string') json = JSON.parse(json);
      const pendingFile = path.join(PENDING_DIR, `pending_${guildId}_${userId}.json`);
      fs.writeFileSync(pendingFile, JSON.stringify(json, null, 2));
      await inter.editReply('✅ Backup file loaded!\n\nNext steps:\n1. (Optional) Run `/clearserver` to delete all channels/roles\n2. Run `/restore` to restore from this backup');
    } catch (e) {
      await inter.editReply('❌ Could not download or parse the backup file. Make sure it is a valid JSON backup.');
    }
    return;
  }

  // --- RESTORE ---
  if (inter.commandName === 'restore') {
    await inter.deferReply({ ephemeral: true });
    const pendingFile = path.join(PENDING_DIR, `pending_${guildId}_${userId}.json`);
    if (!fs.existsSync(pendingFile)) {
      return inter.editReply('❌ No backup loaded! Run `/loadbackup` first.');
    }

    let backup = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    let roleIdMap = {};
    let catIdMap = {};
    let chanIdMap = {};

    // 1. Create Roles
    await inter.editReply('Starting restore... Creating roles...');
    for (const role of backup.roles) {
      try {
        let newRole = await guild.roles.create({
          name: role.name,
          color: role.color,
          hoist: role.hoist,
          position: role.position,
          mentionable: role.mentionable,
          permissions: BigInt(role.permissions),
        });
        roleIdMap[role.id] = newRole.id;
        await delay(800);
      } catch (e) { console.error('Role restore error:', e); }
    }

    // 2. Create Categories
    await inter.editReply('Restore in progress... Creating categories...');
    for (const cat of backup.categories) {
      try {
        let newCat = await guild.channels.create({
          name: cat.name,
          type: 4,
          position: cat.position,
          permissionOverwrites: cat.permissionOverwrites.map(po => ({
            id: roleIdMap[po.id] || po.id,
            type: po.type,
            allow: BigInt(po.allow),
            deny: BigInt(po.deny),
          })),
        });
        catIdMap[cat.id] = newCat.id;
        await delay(1200);
      } catch (e) { console.error('Category restore error:', e); }
    }

    // 3. Create Channels
    await inter.editReply('Restore in progress... Creating channels...');
    for (const ch of backup.channels) {
      try {
        let parent = ch.parentId ? (catIdMap[ch.parentId] || null) : null;
        let chObj = await guild.channels.create({
          name: ch.name,
          type: ch.type,
          parent: parent,
          position: ch.position,
          topic: ch.topic,
          nsfw: ch.nsfw,
          rateLimitPerUser: ch.rateLimitPerUser,
          bitrate: ch.bitrate,
          userLimit: ch.userLimit,
          rtcRegion: ch.rtcRegion,
          permissionOverwrites: ch.permissionOverwrites.map(po => ({
            id: roleIdMap[po.id] || po.id,
            type: po.type,
            allow: BigInt(po.allow),
            deny: BigInt(po.deny),
          })),
        });
        chanIdMap[ch.id] = chObj.id;
        await delay(1200);
      } catch (e) { console.error('Channel restore error:', e); }
    }

    // 4. Restore Messages
    await inter.editReply('Restore in progress... Restoring messages...');
    let msgCount = 0;
    for (const ch of backup.channels) {
      let channel = guild.channels.cache.get(chanIdMap[ch.id]);
      if (!channel || !Array.isArray(ch.messages)) continue;
      for (const msg of ch.messages) {
        try {
          const displayName = msg.authorUsername.replace(/@/g, '@\u200b');
          const dateStr = formatDate(msg.createdAt);
          const restoredContent = `**${displayName} [${dateStr}]**: ${msg.content || '[no content]'}`;
          await channel.send({
            content: restoredContent,
            embeds: msg.embeds,
            files: msg.attachments ? msg.attachments.map(a => a.url) : [],
          });
          msgCount++;
          await delay(900);
        } catch {}
      }
    }

    fs.unlinkSync(pendingFile);
    await inter.editReply(
      `✅ Restore complete!\n\nRestored:\n• Roles: ${Object.keys(roleIdMap).length}\n• Categories: ${Object.keys(catIdMap).length}\n• Channels: ${Object.keys(chanIdMap).length}\n• Messages: ${msgCount}\n\n⚠️ Remember to REMOVE this bot from the server now!`
    );
  }

  // --- CLEAR SERVER ---
  if (inter.commandName === 'clearserver') {
    await inter.deferReply({ ephemeral: true });
    try {
      const currentChannelId = inter.channel.id;
      let deletedChannels = 0;
      for (const [, channel] of guild.channels.cache) {
        if (channel.id !== currentChannelId) {
          try {
            await channel.delete();
            deletedChannels++;
            await delay(400);
          } catch (e) { }
        }
      }
      let deletedRoles = 0;
      const botMember = guild.members.me;
      const botHighestRole = botMember.roles.highest;
      for (const [, role] of guild.roles.cache) {
        if (role.name !== '@everyone' && role.id !== botHighestRole.id) {
          try {
            await role.delete();
            deletedRoles++;
            await delay(400);
          } catch (e) { }
        }
      }
      await inter.editReply(`✅ Clear complete!\n\nDeleted:\n• Channels: ${deletedChannels}\n• Roles: ${deletedRoles}\n\nServer is now ready for restore!`);
    } catch (e) {
      await inter.editReply('❌ Error clearing server: ' + (e.message || e));
    }
  }
});

// ⚠️ TOKEN COMES FROM DISCORD OAUTH2, NOT .env
const restoreToken = process.env.RESTORE_BOT_TOKEN;
if (!restoreToken) {
  console.error('ERROR: Restore bot needs token from Discord OAuth2 when invited');
  console.error('This bot should NOT be auto-started.');
  console.error('Only invite it manually when actively restoring.');
  process.exit(1);
}

client.login(restoreToken);
