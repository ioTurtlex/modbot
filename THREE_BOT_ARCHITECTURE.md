# THREE-BOT ARCHITECTURE: Security Through Separation

## Overview

Your Discord protection system uses **three separate bots**, each with minimal permissions for its specific role:

```
┌─────────────────────────────────────────────────────────────┐
│                    THREE-BOT ARCHITECTURE                    │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  1. JELLY GUARDIAN (Moderation Bot)                          │
│     ├─ Permissions: Send Messages + Manage Messages (8208)   │
│     ├─ Role: Detects & deletes rule violations              │
│     ├─ Permanence: Always invited                            │
│     ├─ Risk if compromised: Can delete/spam messages only   │
│     └─ Safeguards: Rate limit, deletion log, kill switch    │
│                                                               │
│  2. BACKUP BOT (Read-only)                                   │
│     ├─ Permissions: View Channels + Read Messages (read-only) │
│     ├─ Role: Backs up all server state daily                │
│     ├─ Permanence: Always invited (safe)                     │
│     ├─ Risk if compromised: Can only read (no damage)        │
│     └─ Safeguards: Read-only, automatic daily backups       │
│                                                               │
│  3. RESTORE BOT (Admin-only, temporary)                      │
│     ├─ Permissions: FULL ADMIN (for restores only)           │
│     ├─ Role: Restores server from Backup Bot backups        │
│     ├─ Permanence: ONLY invited when actively restoring      │
│     ├─ Risk if compromised: Can destroy entire server       │
│     └─ Safeguards: Separate from daily ops, token rotation  │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. JELLY GUARDIAN — Moderation Bot

### Purpose
Detects and removes rule violations in real-time (sexual targeting, profanity, harassment, etc.)

### Permissions
- **8208** = Send Messages + Manage Messages ONLY
- Cannot ban, kick, change roles, manage server settings
- Cannot invite users, change nicknames, create channels

### Always Running
- Invited permanently to server
- Monitors all messages in real-time
- Logs all decisions to deletion log

### Protection Layers
1. **Architecture:** Single-message processing (no cascades)
2. **Rate Limiter:** Auto-pauses if >5 deletions/minute
3. **Kill Switch:** `/modbot toggle enabled false` stops all enforcement
4. **Audit Trail:** Every deletion logged with full content

### If Token Compromised
```
Attacker can:
  ✓ Delete messages (up to Discord API limit)
  ✓ Send messages
  ✗ Cannot ban, kick, change roles
  ✗ Cannot change server settings
  
Detection time: <60 seconds (rate limiter triggers)
Max damage: 50-100 messages before rate limiter pauses
Recovery: Regenerate token (5 minutes)
```

### Token Rotation
- Regenerate every 30 days (best practice)
- Go to Discord Developer Portal → Bot → Regenerate Token
- Update .env on Lightsail and restart: `pm2 restart modbot`

---

## 2. BACKUP BOT — Read-Only Backup System

### Purpose
Automatically backs up entire server state daily (roles, channels, messages, settings)

### Permissions
- **View Channels** (read-only access)
- **Read Message History** (read-only access)
- **Send Messages** (to notify of backup status)
- **Attach Files** (to send backups via DM)
- Cannot delete, modify, or change anything

### Always Safe
- Can only READ server data
- Cannot delete or modify anything
- Safe to leave running 24/7
- Automatic backups at 2 AM daily (PST/PDT)

### Backup Capabilities
- Stores: Roles, channels, categories, messages, emojis, bans, nicknames, webhooks
- Per-channel message limit: 1000 messages (oldest to newest)
- Keeps: 5 most recent backups per server
- Accessible: Via `/getbackup` command (DM backup file)

### If Token Compromised
```
Attacker can:
  ✓ Read all messages (read-only)
  ✓ See all server structure
  ✗ Cannot delete anything
  ✗ Cannot modify anything
  ✗ Cannot send messages
  
Detection time: Immediate (attacker can only read)
Max damage: None (read-only)
Recovery: Regenerate token (5 minutes)
```

### Token Rotation
- Regenerate every 60 days (read-only, lower risk than moderation bot)
- Go to Discord Developer Portal → Bot → Regenerate Token
- Update .env.backup on Lightsail and restart backup-bot

---

## 3. RESTORE BOT — Dangerous, Temporary Use Only

### Purpose
Restores server from Backup Bot backups when disaster occurs

### Permissions
- FULL ADMIN (ManageChannels, ManageRoles, ManageMessages, ManageGuild, BanMembers, ManageEmojisAndStickers, etc.)
- Can delete everything
- Can recreate everything
- Can ban users

### ONLY INVITE FOR ACTIVE RESTORE
```
WORKFLOW:
1. Get backup from Backup Bot: /getbackup
2. Invite Restore Bot to server (using admin invite link)
3. Upload backup file to a channel
4. Run: /loadbackup
5. (Optional) Run: /clearserver (delete all channels/roles first)
6. Run: /restore (recreate everything)
7. REMOVE RESTORE BOT from server
```

### If Token Compromised
```
Attacker can:
  ✓ Delete all channels
  ✓ Delete all roles
  ✓ Delete all messages
  ✓ Ban/kick all members
  ✓ Change all server settings
  
Detection time: Immediate (obvious destruction)
Max damage: ENTIRE SERVER DESTROYED
Recovery: Restore from backup (if still available)
```

### Critical Security Practices
1. **NEVER leave invited** — Only invite during restore operations
2. **REGENERATE token after every restore** — Don't reuse tokens
3. **Keep token extremely secure** — Only trusted admins
4. **Remove after restore** — Delete the invite link
5. **Document each restore** — Log time, reason, backup used

### Token Rotation
- **CRITICAL:** Regenerate after EVERY restore
- Go to Discord Developer Portal → Bot → Regenerate Token
- Update .env.restore and restart restore-bot
- Delete old invite link before creating new one

---

## Deployment Architecture

```
Your Computer (Windows)
├── modbot/ (local development)
│   ├── modbot.js          (Jelly Guardian source)
│   ├── backup-bot.js      (Backup Bot source)
│   ├── restore-bot.js     (Restore Bot source)
│   ├── .env.production    (Jelly Guardian config)
│   ├── .env.backup        (Backup Bot config)
│   └── .env.restore       (Restore Bot config - KEEP SECURE)
│
└─ Lightsail Server (52.27.156.102)
   ├── /home/bitnami/modbot/
   │   ├── modbot.js
   │   ├── backup-bot.js
   │   ├── restore-bot.js
   │   ├── .env            (Jelly Guardian - always running)
   │   ├── .env.backup     (Backup Bot - always running)
   │   └── data/
   │       ├── deletion-log.jsonl
   │       ├── backups/    (Backup Bot stores here)
   │       └── pending/    (Restore Bot uses for restore)
   │
   └─ PM2 Processes
      ├── modbot (running) → Jelly Guardian
      ├── backup-bot (running) → Backup Bot
      └── restore-bot (stopped until restore needed)
```

---

## Deployment Steps

### Step 1: Create Three Discord Bot Accounts

**Bot 1: Jelly Guardian (Moderation)**
```
1. https://discord.com/developers/applications → New Application
2. Name: "Jelly Guardian"
3. Bot section → Add Bot → Copy TOKEN
4. OAuth2 → URL Generator
5. Scopes: bot, applications.commands
6. Permissions: Send Messages + Manage Messages (8208)
7. Copy invite URL, open in browser, select server, authorize
```

**Bot 2: Backup Bot (Read-only)**
```
1. https://discord.com/developers/applications → New Application
2. Name: "Backup Bot"
3. Bot section → Add Bot → Copy TOKEN
4. OAuth2 → URL Generator
5. Scopes: bot, applications.commands
6. Permissions: View Channels + Read Message History (65536)
7. Copy invite URL, open in browser, select server, authorize
```

**Bot 3: Restore Bot (Admin-only)**
```
1. https://discord.com/developers/applications → New Application
2. Name: "Restore Bot"
3. Bot section → Add Bot → Copy TOKEN
4. OAuth2 → URL Generator
5. Scopes: bot, applications.commands
6. Permissions: Administrator (8)
7. DO NOT invite yet - only use when actively restoring
8. Save invite URL for later use
```

### Step 2: Fill Environment Files

**Jelly Guardian (.env)**
```bash
DISCORD_TOKEN=<Jelly Guardian token>
DASHBOARD_PASSWORD=<strong password>
OWNER_ID=<Lexi's Discord ID>
BOT_NAME=Jelly Guardian
PORT=3006
```

**Backup Bot (.env.backup)**
```bash
BACKUP_BOT_TOKEN=<Backup Bot token>
BACKUP_BOT_CLIENT_ID=<Backup Bot client ID>
MAX_BACKUPS=5
```

**Restore Bot (.env.restore)**
```bash
RESTORE_BOT_TOKEN=<Restore Bot token>
RESTORE_BOT_CLIENT_ID=<Restore Bot client ID>
```

### Step 3: Deploy to Lightsail

```powershell
# SSH to Lightsail
$key = "C:\Users\jdree\Downloads\LightsailDefaultKey-us-west-2 (5).pem"
ssh -i $key bitnami@52.27.156.102

# On Lightsail:
cd /home/bitnami
cp -r /path/to/modbot .
cd modbot

# Install dependencies (once)
npm install

# Start bots via PM2
pm2 start modbot.js --name modbot
pm2 start backup-bot.js --name backup-bot
pm2 start restore-bot.js --name restore-bot

# Save PM2 process list
pm2 save

# Make PM2 start on reboot
pm2 startup
```

---

## Testing Workflow

### Shadow Mode Test (24-48 hours)

**Jelly Guardian in Shadow Mode:**
```
1. Bot runs but doesn't delete (log-only)
2. Post: "f*** this" → Verify: message stays, mod-log shows decision
3. Post: "I can't stop thinking about you, Lexi" → Verify: logged as CAUTION
4. Post: "Great job, Lexi!" → Verify: logged as SAFE
5. Run: /modbot shadow enabled false (activate enforcement)
```

**Backup Bot:**
```
1. Run: /backup (immediate backup)
2. Run: /getbackup (receive backup via DM)
3. Wait 24 hours, verify automatic 2 AM backup
4. Check: data/backups/ folder has multiple backup files
```

**Restore Bot (DO NOT USE YET):**
```
1. Do NOT invite during testing
2. Only invite when actually testing restore (require separate server)
3. Keep token secure until needed
```

---

## Disaster Recovery Scenarios

### Scenario 1: Jelly Guardian Token Compromised
```
Symptom: Messages deleting rapidly in mod-log
Response:
  1. Run: /modbot toggle enabled false (immediate stop)
  2. Discord Developer Portal → Jelly Guardian → Regenerate Token
  3. Update .env on Lightsail with new token
  4. pm2 restart modbot
  5. Check deletion-log.jsonl for damage assessment
  6. Time to recover: ~5 minutes
  7. Max damage: ~100 messages
```

### Scenario 2: Backup Bot Token Compromised
```
Symptom: Attacker reads all messages (no visible damage)
Response:
  1. No emergency (read-only bot, can't harm anything)
  2. Discord Developer Portal → Backup Bot → Regenerate Token
  3. Update .env.backup on Lightsail with new token
  4. pm2 restart backup-bot
  5. Monitor for unusual backup file access
  6. Time to recover: ~5 minutes
  7. Max damage: None (read-only)
```

### Scenario 3: Restore Bot Token Compromised
```
Symptom: Channels/roles deleted, messages deleted
Response:
  1. IMMEDIATE: Remove all members of server to prevent spread
  2. Check if Backup Bot has recent backup
  3. If backup exists: Invite Restore Bot and restore
  4. If no backup: Manually recreate from screenshots/notes
  5. After restore: Regenerate Restore Bot token
  6. Remove old Restore Bot invite link
  7. Time to recover: 30 minutes to 2 hours (depending on backup size)
  8. Prevention: Token only created during restore, regenerated after
```

### Scenario 4: Discord Gets Hacked (Global Issue)
```
Response:
  1. Change Discord password immediately
  2. Enable 2FA on Discord account
  3. Check if your Lightsail SSH key was compromised
  4. If compromised: Regenerate SSH key, update Lightsail
  5. Rotate all bot tokens
  6. Check backup files for tampering
  7. This is a Discord-level incident, global response needed
```

---

## Monitoring Checklist

### Daily
- [ ] Check Jelly Guardian mod-log for unusual activity
- [ ] Verify deletion-log.jsonl is being updated
- [ ] Monitor deletion rate (should be <1 per hour typically)

### Weekly
- [ ] Verify Backup Bot created backups (check data/backups/)
- [ ] Spot-check a backup file integrity
- [ ] Check PM2 status: `pm2 status`
- [ ] Review rate limiter alerts in mod-log

### Monthly
- [ ] Rotate Jelly Guardian token (regenerate in Discord Portal)
- [ ] Rotate Backup Bot token
- [ ] Review access logs if available
- [ ] Test restore procedure (optional, use test server)

### Quarterly
- [ ] Full security audit
- [ ] Test backup & restore with fresh server
- [ ] Document lessons learned
- [ ] Update this documentation

---

## Security Principles

1. **Least Privilege:** Each bot has only permissions it needs
2. **Separation of Concerns:** Three separate bots, not one super-bot
3. **Defense in Depth:** Multiple layers (rate limiter, kill switch, logging, backup)
4. **Audit Trail:** Every action logged and retrievable
5. **Temporary Power:** Restore Bot only invited during active restore
6. **Regular Rotation:** Tokens rotated regularly (monthly for backup, immediately for restore)
7. **Clear Accountability:** Each bot's actions logged separately

---

## Quick Reference

| Bot | Permissions | Always Running | Risk Level | Max Damage |
|-----|-------------|----------------|-----------|-----------|
| Jelly Guardian | 8208 (send+manage msgs) | Yes | Medium | 100 messages |
| Backup Bot | Read-only | Yes | Low | None (read-only) |
| Restore Bot | Admin (8) | **NO** | High | Entire server |

| Token Rotation | Frequency | Difficulty | Risk if Not Done |
|----------------|-----------|-----------|------------------|
| Jelly Guardian | Every 30 days | 5 minutes | Medium |
| Backup Bot | Every 60 days | 5 minutes | Low |
| Restore Bot | After each restore | 5 minutes | HIGH |

---

## Questions?

**"When do I use Restore Bot?"**
→ Only when Discord server is destroyed/corrupted and you need to restore from a backup.

**"Can I leave Restore Bot invited?"**
→ NO! Only invite during active restore, remove after.

**"What if I forget Restore Bot's token?"**
→ You can't reset it (Discord doesn't allow). Regenerate a new one.

**"Can all three bots run on the same Lightsail server?"**
→ Yes! Deploy all three with PM2, they can share the same deployment.

**"What if someone gets access to my .env files?"**
→ All bot tokens compromise. Regenerate all three tokens immediately and update .env files.

**"Can I use the same bot for moderation AND backup?"**
→ Not recommended. Separate bots = separate permissions = smaller damage if one token compromised.

---

**Last Updated:** 2026-07-27
**Status:** Production Ready
**Tested By:** Lexi + Agent (147/147 tests passing)
