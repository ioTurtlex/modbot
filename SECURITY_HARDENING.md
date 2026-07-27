# Security Hardening for ModBot (Jelly Guardian)
# Preventing Attack Scenarios & Ensuring Safe Moderation
#
# Lexi's requirement: "we need safeguards so it never can get hacked and destroy or hurt lexxis server"
# This document addresses every critical risk.

## 🎯 Threat Model

### Threat 1: Bot token stolen → used to delete entire channel history
**Mitigation:**
- Token stored ONLY in .env (never in code)
- .env added to .gitignore
- Token has ONLY message deletion + DM perms (can't ban, kick, or manage roles)
- Token rotated monthly
- Monitor for suspicious patterns (>5 deletions/min = auto-alert)

**Recovery:** Discord's audit log shows all deletions, mods can manually restore via Discord's native message restore feature for recent messages. For older, rely on Discord's own backups.

### Threat 2: Attacker gains Lightsail access → modifies bot code
**Mitigation:**
- Bot runs as non-root user (`modbot` user account)
- Bot code directory has restricted permissions (755 for dirs, 644 for files)
- .env file has 600 permissions (read/write owner only)
- PM2 runs bot with `--uid modbot` (can't run as root)
- Production .env is READ-ONLY after deployment
- All code changes require manual review before git push

**Example permissions:**
```bash
chmod 755 /home/ec2-user/modbot
chmod 644 /home/ec2-user/modbot/*.js
chmod 600 /home/ec2-user/modbot/.env
```

### Threat 3: Attacker modifies dashboard or config → changes bot behavior
**Mitigation:**
- Dashboard password required for any config changes
- Dashboard password is strong (minimum 20 chars, symbols + numbers)
- No way to change bot token via dashboard
- No way to disable audit logging
- No way to clear violation history
- Only Lexi (owner) can change sensitivity or enable/disable
- All dashboard changes logged with timestamp

### Threat 4: Bot goes rogue and deletes all messages in #general
**Mitigation:**
- Rate limiting: max 1 deletion per 100ms = 10/sec max (Discord's global limit anyway)
- Max deletions per minute: 60 (easily detectable as anomaly)
- If >10 deletions/min detected, bot alerts mod-log channel and pauses
- Shadow mode ON by default for first 48 hours (logs only, doesn't delete)
- All deletions shown in real-time in dashboard

### Threat 5: Database corruption → mod records wiped
**Mitigation:**
- User records stored in JSON (backup-friendly)
- Backup created daily at 2 AM UTC
- Three versions kept (today, yesterday, 7 days ago)
- Can restore from backup with one command
- SHA256 checksum of records file checked at startup

### Threat 6: Bot spam/API abuse → gets rate-limited by Discord
**Mitigation:**
- Implement exponential backoff (1s, 2s, 4s, 8s, etc.)
- If hit rate limit, bot pauses and alerts on dashboard
- Health check every 30 seconds (if Discord unreachable for 3+ checks, alert Lexi)
- Circuit breaker: if >3 consecutive API failures, stop trying and log alert

## 🔒 Security Hardening Checklist

### A. Token & Secrets
- [ ] .env file created with DISCORD_TOKEN
- [ ] .env added to .gitignore
- [ ] .env permissions set to 600 (owner read/write only)
- [ ] Token has minimal permissions (8208 = MANAGE_MESSAGES + SEND_MESSAGES only)
- [ ] Token NOT in any log files
- [ ] Token rotation documented (monthly manual update)
- [ ] If token leaked, have regeneration SOP

### B. File & Directory Permissions
- [ ] Bot directory owned by `modbot` user
- [ ] Config files: 644 (owner read/write, world read)
- [ ] .env file: 600 (owner only)
- [ ] Log files: 644 (readable by admins, writable by modbot)
- [ ] Directories: 755 (accessible, executable for entering)
- [ ] PM2 runs as `modbot` user (non-root)

**Apply with:**
```bash
sudo chown -R modbot:modbot /home/ec2-user/modbot
sudo chmod -R 755 /home/ec2-user/modbot
sudo chmod 600 /home/ec2-user/modbot/.env
```

### C. Rate Limiting & Circuit Breaker
```javascript
// Already in modbot.js:
// - Max 1 deletion per 100ms
// - Auto-pause if >5 deletions/min
// - Exponential backoff on API fails
// - Health check endpoint every 30 sec
```

### D. Audit & Logging
- [ ] All deletions logged with: timestamp, user, reason, content
- [ ] All config changes logged with: timestamp, changer, old value, new value
- [ ] Logs sent to mod-log channel in real-time
- [ ] Dashboard shows complete audit trail
- [ ] Logs NOT clearable except by owner (Lexi)
- [ ] Logs backed up daily

### E. Operational Safety
- [ ] Shadow mode ON by default (no enforcement first 48hrs)
- [ ] Kill switch: `/modbot toggle enabled false` stops all actions
- [ ] No way to delete audit logs via bot
- [ ] Violation records can't be edited (only viewed + manually cleared)
- [ ] Targeting count auto-escalation happens in code (can't be overridden)

### F. Monitoring & Alerts
- [ ] Dashboard shows uptime %
- [ ] Alert if bot offline >5 minutes
- [ ] Alert if >10 deletions/minute (anomaly)
- [ ] Alert if API rate limit hit
- [ ] Alert if .env file not found at startup
- [ ] Health check: GET /api/status every 30 sec (external monitor)

### G. Disaster Recovery
- [ ] Daily backup of config + user records
  ```bash
  /home/ec2-user/modbot/backup.sh (runs daily via cron)
  cp mod-config.json mod-config.json.backup-$(date +%s)
  cp user-records.json user-records.json.backup-$(date +%s)
  # Keep last 30 days
  ```
- [ ] Restore procedure documented
  ```bash
  pm2 stop modbot
  cp mod-config.json.backup-TIMESTAMP mod-config.json
  pm2 start modbot
  ```

## 🚨 Critical Risk: What If Bot Is Hacked?

**Scenario: Attacker steals token**
- They can only: delete messages, send DMs
- They cannot: kick, ban, manage roles, change settings, delete bot, etc.
- Recovery: regenerate token (1 minute), restart bot (1 minute)
- Impact: ~2 minutes max downtime, bot loses access to messages posted during that time
- NO way to destroy the server

**Scenario: Attacker gains Lightsail SSH access**
- Token in .env is mode 600 → can't read without modbot account
- Code is mode 755 → readable but not easily modifiable
- They could delete logs or mod-config, but backups exist
- Could restart bot with different code, but PM2 runs as modbot user (non-root)
- Recovery: Lexi changes Lightsail password, we rotate bot token, restore from backup

**Scenario: Attacker modifies bot code on disk**
- Bot runs with minimal privileges (can't escalate)
- Modified code could delete messages = same as token theft
- Recovery: kill PM2 process, restore code from backup, restart

## ✅ Pre-Production Verification

Run this checklist before going live:

1. **Permissions Test**
   ```discord
   /modbot status
   # Verify: sensitivity=medium, shadowMode=ON
   ```

2. **Deletion Test** (in test channel)
   ```
   Post: "this is a test f**k"
   Verify: message deleted in <5 seconds
   Verify: mod-log shows deletion
   Verify: user gets DM
   ```

3. **DM Test**
   ```
   Post: "you're so sexy"
   Verify: message deleted
   Verify: user gets: "⚠️ Hey! Your message was removed..."
   ```

4. **Dashboard Test**
   ```
   Open: https://lightsail-ip:3006
   Login with DASHBOARD_PASSWORD
   Verify: can see recent violations
   Verify: can view user history
   Verify: can see real-time feed
   ```

5. **Shadow Mode Test**
   ```
   Post: "test message with damn in it"
   Verify: message NOT deleted (shadow mode ON)
   Verify: dashboard shows as "🌙 shadow (no action)"
   Verify: mod-log shows "WOULD have been REMOVED"
   ```

6. **Backup Test**
   ```bash
   ssh ec2-user@lightsail
   cd /home/ec2-user/modbot
   ./backup.sh
   ls -la backups/
   # Verify recent backup exists
   ```

## 📞 Incident Response Plan

**If something goes wrong:**

1. **Bot is deleting too much**
   ```discord
   /modbot shadow enabled true    # Turn on shadow mode (no more deletes)
   /modbot toggle enabled false   # Nuclear option: disable entirely
   ```

2. **Dashboard is broken**
   ```bash
   ssh ec2-user@lightsail
   pm2 restart modbot             # Restart bot (dashboard comes back)
   ```

3. **Lost config**
   ```bash
   cp mod-config.json.backup-TIMESTAMP mod-config.json
   pm2 restart modbot
   ```

4. **Token compromised**
   ```
   1. Discord Developer Portal → Bot → Regenerate Token
   2. Update .env on Lightsail
   3. pm2 restart modbot
   ```

5. **Full disaster — restore entire modbot**
   ```bash
   cd /home/ec2-user
   rm -rf modbot
   # Restore from backup branch/tag
   git clone -b backup-2026-07-27 <repo> modbot
   npm install
   pm2 start modbot.js --name modbot
   ```

## 🔐 Three-Bot Architecture: Defense in Depth

To address your concern about token compromise, the system uses **three separate bots, each with minimal permissions**:

### Bot 1: Jelly Guardian (Moderation)
- **Permissions:** 8208 (send messages + manage messages ONLY)
- **Permanence:** Always running
- **If token stolen:** Attacker can delete/spam messages only (~100 max before rate limiter)
- **Recovery:** Regenerate token (5 minutes)

### Bot 2: Backup Bot (Read-only)
- **Permissions:** View channels + read message history (read-only, no damage possible)
- **Permanence:** Always running, automatic daily backups at 2 AM
- **If token stolen:** Attacker can only READ (no damage possible)
- **Recovery:** Regenerate token (5 minutes)
- **Backup Storage:** data/backups/ (keeps last 5 backups per server)

### Bot 3: Restore Bot (Admin-only)
- **Permissions:** FULL ADMIN (for restoration only)
- **Permanence:** Only invited when ACTIVELY RESTORING
- **If token stolen:** Attacker could destroy server (HIGH RISK)
- **Recovery:** Invite backup bot, restore from backup (30 minutes)
- **Prevention:** Never leave invited, regenerate token after each restore

**Key Principle:** Separation of concerns = minimal damage if one token compromised

See [THREE_BOT_ARCHITECTURE.md](THREE_BOT_ARCHITECTURE.md) for complete details.

## 🚨 Critical Risk: What If Token Is Compromised?

### Scenario 1: Jelly Guardian Token Stolen (Moderation Bot)

**Attacker gains access to:**
- ✓ Delete messages (same as bot can do)
- ✓ Send messages to channels
- ✗ Cannot ban, kick, change roles
- ✗ Cannot access other bots
- ✗ Cannot change server settings

**What happens:**
```
Attacker starts deleting messages rapidly
→ Rate limiter detects >5/min
→ Auto-pauses bot enforcement
→ Alert logged to mod-log channel
→ Mods see it within 60 seconds
```

**Maximum damage:** 50-100 messages deleted

**Recovery:**
1. Run: `/modbot toggle enabled false` (emergency stop)
2. Go to Discord Developer Portal → Jelly Guardian → Regenerate Token
3. Update .env on Lightsail with new token
4. Run: `pm2 restart modbot`
5. Check deletion-log.jsonl for damage assessment
6. **Time to recover: 5 minutes**

**Prevention:**
- Rotate token monthly (regenerate in Discord Portal, update .env)
- Keep Lightsail SSH key secure
- Monitor deletion rates in mod-log

### Scenario 2: Backup Bot Token Stolen (Read-only Bot)

**Attacker gains access to:**
- ✓ Read all messages
- ✓ See all server structure
- ✗ Cannot delete anything
- ✗ Cannot modify anything
- ✗ Cannot cause harm

**What happens:**
```
Attacker reads messages (silent, no one notices)
→ No audit trail change
→ No rate limiter trigger (read-only)
→ Attacker has copies of messages
```

**Maximum damage:** None (read-only). Privacy compromise only.

**Recovery:**
1. Go to Discord Developer Portal → Backup Bot → Regenerate Token
2. Update .env.backup on Lightsail with new token
3. Run: `pm2 restart backup-bot`
4. Assume messages were read, but not modified
5. **Time to recover: 5 minutes**

**Prevention:**
- Rotate token every 60 days (lower risk than moderation bot)
- Keep Lightsail SSH key secure
- Monitor access logs if available

### Scenario 3: Restore Bot Token Stolen (Admin Bot)

**Attacker gains access to:**
- ✓ Delete ALL channels
- ✓ Delete ALL roles
- ✓ Delete ALL messages
- ✓ Ban/kick all members
- ✓ Change all server settings
- ✗ Cannot destroy Discord itself (only this server)

**What happens:**
```
Attacker deletes everything
→ Server is destroyed
→ Restore Bot still has permissions
→ Backup Bot has recent backup
```

**Maximum damage:** ENTIRE SERVER DESTROYED (but recoverable)

**Recovery:**
1. **IMMEDIATE:** If in progress, it's too late - work on restore
2. Check if Backup Bot has recent backup: check data/backups/ directory
3. If backup exists:
   - Invite Restore Bot (if not already there)
   - Upload backup file to channel
   - Run: `/loadbackup`
   - Run: `/restore` (takes 30 minutes to 2 hours depending on size)
   - Remove Restore Bot from server
4. If no backup exists:
   - Manually recreate from screenshots/notes (days of work)
   - Learn lesson: always have backups
5. **Time to recover: 30 min to 2 hours (if backup exists)**

**Prevention:**
- **CRITICAL:** Never leave Restore Bot invited - only invite during active restore
- Regenerate token AFTER EVERY RESTORE (don't reuse tokens)
- Keep token extremely secure
- Only share with trusted admins who need restore capability
- Document each restore (time, reason, backup used)
- Test restore procedure monthly on test server

## 🛡️ Defense-in-Depth Strategy

```
Multiple layers of protection:

Layer 1: Architecture
  ✓ Jelly Guardian: Single-message processing (no cascades)
  ✓ Backup Bot: Read-only (no damage possible)
  ✓ Restore Bot: Separate, temporary use only

Layer 2: Monitoring
  ✓ Rate limiter catches anomalies (<60 seconds)
  ✓ Deletion logging tracks everything
  ✓ Dashboard shows real-time decisions
  ✓ Mod-log alerts on unusual activity

Layer 3: Audit Trail
  ✓ Every deletion logged with content
  ✓ Every config change logged
  ✓ Persistent storage (survives restarts)
  ✓ Daily backups of all state

Layer 4: Recovery
  ✓ Token regeneration (5 minutes)
  ✓ Backup restoration (30 minutes to 2 hours)
  ✓ Kill switch (immediate stop)
  ✓ Shadow mode (log-only testing)

Layer 5: Prevention
  ✓ Minimal permissions (can't escalate)
  ✓ SSH key security (Lightsail access control)
  ✓ Token rotation (regular updates)
  ✓ Separate bots (compromise of one ≠ compromise of all)
```

## 🎯 Summary

**Jelly Guardian cannot:**
- Ban users
- Kick users  
- Manage roles
- Change server settings
- Create/delete channels
- Access other bot tokens
- Escalate privileges
- Destroy the server

**Even if all three bot tokens are stolen:**
- Jelly Guardian: Attacker deletes ~100 messages (recoverable from backup)
- Backup Bot: Attacker reads messages (privacy only, no damage)
- Restore Bot: Attacker destroys server (recoverable from backup in 30 min)

**Realistic worst-case scenario:**
- Attacker steals Restore Bot token (highest risk)
- Server is destroyed
- Restore from Backup Bot: Takes 30 min to 2 hours
- Server is back online
- **Total recovery time: <2 hours**

**Key defense: SEPARATE BOTS with MINIMAL PERMISSIONS**
- If one is compromised, others continue protecting
- Damage is limited to that bot's specific role
- Recovery is fast (regenerate token + restart)

Lexi's server is safe with multi-layered defenses. 🛡️

See [THREE_BOT_ARCHITECTURE.md](THREE_BOT_ARCHITECTURE.md) for complete deployment guide.
