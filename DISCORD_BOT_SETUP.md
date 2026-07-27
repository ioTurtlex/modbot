# Discord Bot Account Setup for Jelly Guardian
# Minimal Permissions — Message Moderation Only
#
# This guide ensures the bot can ONLY remove messages and send DMs,
# with no ability to ban, kick, manage roles, or destroy the server.

## 🤖 STEP 1: Create Discord Bot Account

1. Go to https://discord.com/developers/applications
2. Click "New Application"
3. Name it: **"Jelly Guardian"**
4. Accept Terms → Create
5. Go to "Bot" section
6. Click "Add Bot"
7. Under TOKEN, click "Copy" (this is your DISCORD_TOKEN for .env)
   ⚠️ NEVER share this token. If exposed, regenerate it immediately.
8. Save token securely (will paste into .env later)

## 🔐 STEP 2: Configure Permissions (CRITICAL)

**Option A: Using Discord's Permission Calculator (RECOMMENDED)**

1. In your application, go to "OAuth2" → "URL Generator"
2. Under "SCOPES", select ONLY:
   - ✅ bot
3. Under "PERMISSIONS", select ONLY:
   - ✅ Send Messages
   - ✅ Manage Messages
4. Copy the generated URL (bottom of page)
5. Open that URL in a new tab
6. Select the server (ioTurtle's server, Lexi's community, or test server first)
7. Authorize with these exact permissions

**Option B: Manual Permissions Integer**
If you need to grant permissions via API/config, use this integer:
- **8208** (decimal) = 0x2010 (hex)
  - 8192 (MANAGE_MESSAGES) + 16 (SEND_MESSAGES)

**VERIFICATION CHECKLIST**
After adding the bot to the server, in Discord:
1. Go to Server Settings → Roles
2. Find "Jelly Guardian" role
3. Click it → Permissions
4. Verify these are enabled:
   - ✅ Send Messages
   - ✅ Manage Messages
5. Verify these are DISABLED:
   - ❌ Kick Members
   - ❌ Ban Members
   - ❌ Administrator
   - ❌ Manage Roles
   - ❌ Manage Channels
   - ❌ Manage Guild
   - ❌ Manage Webhooks

If anything else is enabled, disable it immediately.

## 💬 STEP 3: Role Hierarchy (Safety Check)

1. In Server Settings → Roles, ensure Jelly Guardian role is:
   - Below "Moderator" role (if it exists)
   - Below "Owner" role obviously
   - This prevents the bot from being used to demote/control mods
2. Set role color to something visible (e.g., cyan/teal to match theme)
3. Do NOT allow "Display role separately on sidebar" (doesn't matter for perms, but keep it clean)

## ✅ STEP 4: Invite Link (for future re-invites)

Use this template to generate the invite link:
```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=8208
```

Replace `YOUR_CLIENT_ID` with the Client ID from your application (found in General Information tab).

This link can be shared with Lexi if she ever needs to re-invite the bot or add it to another server.

## 🛡️ STEP 5: Security After Adding

1. Disable "Server Members Intent" (unnecessary, reduces attack surface)
   - Go to Bot tab
   - Under "GATEWAY INTENTS", disable "Server Members Intent"
2. Disable "Message Content Intent" (bot reads messages as part of moderation, OK to enable)
   - Under "GATEWAY INTENTS", MESSAGE_CONTENT can stay enabled (required for reading messages to analyze)
3. Enable "Public Bot" = OFF (so randoms can't add it)
   - In Bot tab, toggle OFF "Public Bot"

## 🚨 STEP 6: Token Security Protocol

**If token is ever leaked:**
1. Immediately go to Discord Developer Portal
2. Click "Bot" section
3. Click "Regenerate" under TOKEN
4. Update the token in .env on the server
5. Restart modbot: `pm2 restart modbot`

**Rotation Schedule (best practice):**
- Monthly: generate new token, update server, restart
- After any suspected compromise: immediately
- Before any public demo: immediately

## 📋 Permissions Reference

Full permission matrix (for reference):

| Permission | Code | Allowed? | Reason |
|-----------|------|----------|--------|
| SEND_MESSAGES | 16 | ✅ YES | Send DMs to violators |
| MANAGE_MESSAGES | 8192 | ✅ YES | Delete rule-breaking messages |
| READ_MESSAGE_HISTORY | 65536 | Optional | Read message context (nice-to-have) |
| KICK_MEMBERS | 2 | ❌ NO | Cannot kick users |
| BAN_MEMBERS | 4 | ❌ NO | Cannot ban users |
| ADMINISTRATOR | 8 | ❌ NO | Would allow everything |
| MANAGE_ROLES | 268435456 | ❌ NO | Cannot touch user roles |
| MANAGE_CHANNELS | 16 | ❌ NO | Cannot create/delete channels |
| MANAGE_GUILD | 32 | ❌ NO | Cannot change server settings |
| MANAGE_WEBHOOKS | 536870912 | ❌ NO | Cannot create webhooks |

## ✨ Final Verification

After all steps:
- [ ] Bot appears in server member list as "Jelly Guardian"
- [ ] Bot has Cyan/Teal color role badge
- [ ] `/modbot status` command works (shows bot info)
- [ ] Dashboard accessible at https://your-lightsail-ip:3006
- [ ] Test message in #test-channel deleted successfully
- [ ] DM sent to test user with violation notice
- [ ] Audit log shows deletion with modbot as actor

You're ready for production! 🎉
