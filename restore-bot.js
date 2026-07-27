// Restore Bot - Server Restoration (Admin-only, dangerous permissions)
// ⚠️ THIS BOT HAS ADMIN PERMISSIONS - ONLY INVITE WHEN ACTUALLY RESTORING
// ⚠️ Keep separate from moderation bot (Jelly Guardian)
// ⚠️ After restore completes, remove this bot from the server
// 
// Workflow:
// 1. Get backup from Backup Bot (/getbackup)
// 2. Invite Restore Bot to server
// 3. Upload backup file: /loadbackup
// 4. (Optional) Clear existing channels: /clearserver
// 5. Restore: /restore
// 6. Remove Restore Bot from server

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, REST, Routes, PermissionsBitField } = require('discord.js');
const axios = require('axios');

const TOKEN = process.env.RESTORE_BOT_TOKEN;
const CLIENT_ID = process.env.RESTORE_BOT_CLIENT_ID;
const PENDING_DIR = path.join(__dirname, 'pending');
const EMOJI_DIR = path.join(__dirname, 'emojis');
const MAX_MESSAGES_PER_CHANNEL = 1000;

if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
if (!fs.existsSync(EMOJI_DIR)) fs.mkdirSync(EMOJI_DIR, { recursive: true });

const commands = [
  { name: 'loadbackup', description: 'Load backup file (upload as attachment, then run this)' },
  { name: 'restore', description: '⚠️ RESTORE FROM BACKUP (deletes/recreates all channels, roles, messages)' },
  { name: 'clearserver', description: '⚠️ DELETE ALL CHANNELS EXCEPT THIS ONE (preparation for restore)' }
];

// ADMIN permissions - POWERFUL, handle with care
const RESTORE_PERMS = (
  PermissionsBitField.Flags.ViewChannel |
  PermissionsBitField.Flags.ReadMessageHistory |
  PermissionsBitField.Flags.SendMessages |
  PermissionsBitField.Flags.AttachFiles |
  PermissionsBitField.Flags.EmbedLinks |
  PermissionsBitField.Flags.ManageChannels |
  PermissionsBitField.Flags.ManageRoles |
  PermissionsBitField.Flags.ManageMessages |
  PermissionsBitField.Flags.ManageWebhooks |
  PermissionsBitField.Flags.ManageGuild |
  PermissionsBitField.Flags.BanMembers |
  PermissionsBitField.Flags.ManageNicknames |
  PermissionsBitField.Flags.ManageEmojisAndStickers
);

const rest = new REST({ version: '10' }).setToken(TOKEN);
(async () => {
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Restore bot slash commands registered.');
  console.log('\n===============================================');
  console.log('⚠️  Discord Restore Bot Ready! ⚠️');
  console.log('\nRESTORE BOT INVITE (full admin permissions):');
  console.log(
    `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&scope=bot+applications.commands&permissions=${RESTORE_PERMS}`
  );
  console.log('\n⚠️  IMPORTANT SAFETY NOTES:');
  console.log('   1. Only invite this bot when you are ACTIVELY RESTORING');
  console.log('   2. This bot can DELETE EVERYTHING - server channels, roles, messages');
  console.log('   3. After restore completes, REMOVE this bot from the server');
  console.log('   4. For backups, use the separate Backup Bot (read-only, safe)');
  console.log('   5. Never leave this bot invited - only use during restore operations');
  console.log('===============================================\n');
})();

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
  console.log(`🟢 Restore bot ready as ${client.user.tag}`);
  console.log('⚠️  Remember: Remove this bot after restore completes!');
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

    // 4. Restore Emojis
    for (const emoji of backup.emojis) {
      try {
        const img = fs.readFileSync(emoji.localPath);
        await guild.emojis.create({ attachment: img, name: emoji.name });
        await delay(900);
      } catch (e) { console.error('Emoji restore error:', e); }
    }

    // 5. Restore Nicknames
    for (const [uid, nick] of Object.entries(backup.nicknames || {})) {
      try {
        let member = await guild.members.fetch(uid);
        if (member) await member.setNickname(nick);
        await delay(500);
      } catch {}
    }

    // 6. Restore Bans
    for (const ban of backup.bans || []) {
      try {
        await guild.members.ban(ban.id, { reason: ban.reason || 'Restored from backup' });
        await delay(700);
      } catch {}
    }

    // 7. Restore Webhooks
    for (const wh of backup.webhooks || []) {
      try {
        let ch = guild.channels.cache.get(chanIdMap[wh.channelId] || wh.channelId);
        if (ch) await ch.createWebhook({ name: wh.name, avatar: wh.avatar });
        await delay(700);
      } catch {}
    }

    // 8. Restore Messages
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
      `✅ Restore complete!\n\nRestored:\n• Roles: ${Object.keys(roleIdMap).length}\n• Categories: ${Object.keys(catIdMap).length}\n• Channels: ${Object.keys(chanIdMap).length}\n• Emojis: ${backup.emojis.length}\n• Messages: ${msgCount}\n\n⚠️ Remember to REMOVE this bot from the server now!`
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

client.login(TOKEN);
