# ModBot Production Deployment Action Plan
# Jelly Guardian → Lightsail Production
# Status: Ready for Deployment ✅
#
# Generated: 2026-07-27
# Version: 2.0.0 (Lexi-approved, 147/147 tests passing)

## 📋 QUICK START

**Current Status:**
- ✅ ModBot code complete (prompts.js + modbot.js + all features)
- ✅ All tests passing (78 core + 57 holdout + 12 real-incident = 147/147 = 100%)
- ✅ PDF report generated for Lexi (ModBot-Test-Report.pdf)
- ✅ Lexi has approved the system
- ✅ Backup created: modbot-backup-2026-07-27-141053
- 🟡 Discord bot account NOT YET created
- 🟡 Token NOT YET set
- 🟡 Lightsail deployment NOT YET done

**What we're doing:**
Deploying Jelly Guardian (our moderation bot) to Lightsail alongside Bloop and Crabby,
with minimal permissions (delete messages only) and security hardening to prevent hacking.

**Estimated time:** 30-45 minutes total

---

## 🤖 STEP 1: Create Discord Bot Account (5 minutes)
### Action: Create "Jelly Guardian" bot on Discord Developer Portal

**Instructions:**

1. Open Discord Developer Portal: https://discord.com/developers/applications
2. Click "New Application" → Name it **"Jelly Guardian"**
3. Accept terms → Click "Create"
4. Go to "Bot" section (left sidebar)
5. Click "Add Bot"
6. Under "TOKEN" section, click "Copy"
7. **SAVE THIS TOKEN SECURELY** — you'll need it next

**Verify Intents (Optional, for best practices):**
- Go to "GATEWAY INTENTS"
- Disable: Server Members Intent
- Enable: Message Content Intent (required to read messages for analysis)

**Disable public bot (security):**
- Toggle OFF: "Public Bot"

**Now set permissions:**

1. Go to "OAuth2" tab (left sidebar)
2. Go to "URL Generator" (left sidebar)
3. Under "SCOPES", select ONLY: ✅ bot
4. Under "PERMISSIONS", select ONLY:
   - ✅ Send Messages
   - ✅ Manage Messages
5. Copy the URL at the bottom
6. Open the URL in a new browser tab
7. Select Lexi's server (or test server first if available)
8. Click "Authorize"
9. Complete CAPTCHA

**After authorization:**
- You should see "Jelly Guardian" added to the server
- In Discord, right-click the bot name → View Profile
- Verify it shows: "Jelly Guardian" with role permissions

**SAVE:** Your Discord bot token for the next step

---

## 💾 STEP 2: Prepare .env File (5 minutes)
### Action: Set up environment variables for production

**On your local machine:**

1. Open: `c:\Users\jdree\Downloads\botlaunch\ioturtlebotcreator\modbot\.env`
   (If it doesn't exist, copy from `.env.production.template`)

2. Fill in these values:
   ```env
   DISCORD_TOKEN=your_bot_token_here_from_step_1
   DASHBOARD_PORT=3006
   DASHBOARD_PASSWORD=your_strong_password_here_min_20_chars
   BOD_NAME=Jelly Guardian
   OWNER_ID=lexi_discord_id_here
   FEATURE_SHADOW_MODE=true
   ```

3. **IMPORTANT:** 
   - DISCORD_TOKEN: paste the token from Step 1
   - DASHBOARD_PASSWORD: choose something strong (example: `Jelly2024Guardian!Protect$Community`)
   - OWNER_ID: Lexi's Discord ID (numeric)

4. Save the file
5. DO NOT commit to GitHub

**Get Lexi's Discord ID:**
- In Discord, enable Developer Mode (Settings → Advanced → Developer Mode)
- Right-click Lexi's name → "Copy User ID"
- Paste into OWNER_ID

---

## 🔐 STEP 3: Security Hardening Verification (5 minutes)
### Action: Ensure all safeguards are in place

**Read and verify:**
- [ ] Read: `SECURITY_HARDENING.md` (in modbot directory)
- [ ] Understand: Token security, rate limiting, audit logging, disaster recovery
- [ ] Confirm: Bot has NO ban/kick/admin permissions

**Checklist:**
- [ ] Bot permissions are: SEND_MESSAGES (16) + MANAGE_MESSAGES (8192) = 8208 total
- [ ] Bot token is stored ONLY in .env (not in code, not in logs)
- [ ] .env will be kept secure on Lightsail with 600 permissions
- [ ] Rate limiting configured (max 10 deletes/sec, alerts if >5 deletions/min)
- [ ] All actions logged to mod-log channel
- [ ] Shadow mode ON by default (no enforcement for first 48 hours)
- [ ] Kill switch available: `/modbot toggle enabled false`

**No surprises here — just verify you understand the safeguards.**

---

## 🚀 STEP 4: Deploy to Lightsail (10 minutes)
### Action: Copy modbot to Lightsail and start running

**Prerequisites:**
- SSH key for Lightsail (you have: LightsailDefaultKey-us-west-2 (5).pem)
- Lightsail IP: 52.27.156.102
- Username: bitnami (or ec2-user, whichever is configured)

**Step 4a: SSH into Lightsail**

```powershell
# Open PowerShell
$key = "C:\Users\jdree\Downloads\LightsailDefaultKey-us-west-2 (5).pem"
ssh -i $key bitnami@52.27.156.102
```

**Step 4b: Clone/copy modbot repo**

```bash
# Once SSH'd in:
cd /home/bitnami  (or /home/ec2-user if applicable)

# Option A: If you have a git repo
git clone <your-repo-url> modbot

# Option B: If you're copying from local
# (First, exit SSH and SCP the files)
```

**Step 4c: Run deployment script**

```bash
cd modbot
bash deploy.sh
```

The script will:
1. Create a `modbot` system user
2. Set secure file permissions
3. Install Node dependencies
4. Setup PM2 for auto-restart
5. Start the bot
6. Verify it's running

**After deployment:**
```bash
pm2 logs modbot  # Watch the logs
```

You should see:
```
✓ Jelly Guardian connected to Discord
✓ Shadow mode enabled
✓ Dashboard listening on port 3006
```

---

## 🧪 STEP 5: Testing in Shadow Mode (10 minutes)
### Action: Verify bot works before enabling enforcement

**In Discord:**

1. In a test channel, post:
   ```
   Test message with profanity: f**k this
   ```
   (Use actual word, not censored)

2. Check:
   - [ ] Message is NOT deleted (shadow mode ON)
   - [ ] mod-log channel shows: "🌙 SHADOW: Would have removed message"
   - [ ] Dashboard shows the message in real-time feed

3. Test targeting:
   ```
   I can't stop thinking about you, Lexi...
   ```

4. Check:
   - [ ] Message NOT deleted (shadow mode ON)
   - [ ] Dashboard shows: CAUTION verdict
   - [ ] "Targeting: Lexi (1/3)" shown in mod-log

5. Test innocent message:
   ```
   Hey Lexi, great job on that!
   ```

6. Check:
   - [ ] Message NOT affected
   - [ ] Dashboard shows: SAFE verdict

**If all tests pass:** ✅ Ready to enable enforcement

**If something is wrong:**
```bash
pm2 logs modbot  # Check logs
pm2 restart modbot  # Restart
```

---

## ✅ STEP 6: Enable Enforcement (1 minute)
### Action: Flip the switch — bot now removes rule-breaking messages

**When ready (after 24-48 hours in shadow mode):**

1. In Discord, run:
   ```
   /modbot shadow enabled false
   ```
   (or send: `!modbot shadow off` depending on your command syntax)

2. Verify in dashboard:
   - [ ] Shadow mode: OFF
   - [ ] Status: "ENFORCING"

3. Post test message again:
   ```
   f**k this
   ```

4. Check:
   - [ ] Message IS deleted (within 2-5 seconds)
   - [ ] User gets DM: "⚠️ Hey! Your message was removed because it violates community guidelines"
   - [ ] mod-log shows: "🚨 REMOVED: [username] - Profanity"

**You're live!** 🎉

---

## 📚 REFERENCE GUIDES

All these docs are in your modbot directory:

1. **DEPLOYMENT_PLAN.sh** — High-level deployment strategy
2. **DISCORD_BOT_SETUP.md** — Detailed Discord bot account creation (Step 1 expanded)
3. **SECURITY_HARDENING.md** — Complete security threat model + mitigations
4. **deploy.sh** — Automated deployment script for Lightsail
5. **.env.production.template** — Environment variables template
6. **prompts.js** — AI prompts (single source of truth)
7. **modbot.js** — Main bot code (production-ready)
8. **test-massive.js** — 78 core regression tests
9. **test-holdout.js** — 57 fresh/holdout tests
10. **test-realworld.js** — 12 real-incident replay tests
11. **ModBot-Test-Report.pdf** — Lexi-approved report (10 pages)

---

## 🚨 TROUBLESHOOTING

**Bot is not responding:**
```bash
pm2 logs modbot
# Check for DISCORD_TOKEN errors or connection issues
pm2 restart modbot
```

**Dashboard not accessible:**
- Verify nginx is configured to proxy to port 3006
- Or access directly: http://lightsail-ip:3006
- Check password: DASHBOARD_PASSWORD from .env

**Bot is deleting too much:**
```bash
# Immediately enable shadow mode:
/modbot shadow enabled true
```

**Lost/corrupted config:**
```bash
ssh -i $key bitnami@52.27.156.102
cd /home/bitnami/modbot
ls -la backups/
# Restore from backup
cp backups/mod-config.json.backup-TIMESTAMP mod-config.json
pm2 restart modbot
```

**Token compromised:**
1. Go to Discord Developer Portal
2. Bot → Regenerate Token
3. Update .env on Lightsail
4. pm2 restart modbot
5. Done in <5 minutes

---

## 📋 DEPLOYMENT CHECKLIST

Before going live, verify:

- [ ] Step 1: Discord bot account created ("Jelly Guardian")
- [ ] Step 1: Permissions are 8208 (send messages + manage messages ONLY)
- [ ] Step 2: .env file filled with DISCORD_TOKEN and DASHBOARD_PASSWORD
- [ ] Step 3: Read SECURITY_HARDENING.md and understand safeguards
- [ ] Step 4: Connected to Lightsail via SSH
- [ ] Step 4: Ran deploy.sh successfully
- [ ] Step 4: pm2 shows modbot is "online"
- [ ] Step 5: Shadow mode tests pass (message not deleted, logged correctly)
- [ ] Step 5: Targeting test passes (recognizes Lexi references)
- [ ] Step 5: Innocent message test passes (no false positives)
- [ ] Step 6: After 24-48 hours, enabled enforcement
- [ ] Step 6: Enforcement test passes (message deleted, user gets DM)

---

## 💬 NEXT ACTIONS

1. **Before you start:**
   - Get Lexi's Discord ID (Settings → Advanced → Developer Mode → right-click name → Copy User ID)
   - Confirm IP/username for Lightsail access

2. **Execute steps 1-6 above**

3. **After deployment:**
   - Monitor logs for 24 hours
   - Collect any edge cases
   - Document learnings (share in team channels)

4. **Ongoing:**
   - Monthly token rotation
   - Daily backups (automatic via deploy.sh)
   - Weekly dashboard review of violations
   - Monthly community feedback

---

## ✨ Summary

**What you're deploying:**
- Jelly Guardian: AI-powered moderation bot
- Catches: profanity, hate speech, sexual/romantic targeting, self-harm, threats
- Respects: innocent compliments, gaming banter, religious language
- Protects: Lexi's community from escalating conflicts
- Safeguards: minimal permissions, rate limiting, audit logging, kill switch

**Why it works:**
- Two-stage AI pipeline (explicit content + context-dependent analysis)
- 100% accuracy on 147 diverse test cases
- Contrastive pairs trained the model to understand nuance
- Shadow mode allows safe testing before enforcement
- Every action logged and recoverable

**Your job:**
1. Create Discord bot account ← **START HERE**
2. Set up .env file
3. Deploy to Lightsail
4. Test in shadow mode
5. Enable enforcement after 24-48 hours

**You've got this!** 🎉 Questions? Check the markdown files in the modbot directory.

---

Generated: 2026-07-27  
Bot Status: APPROVED & READY FOR PRODUCTION ✅  
Next Review: After 1 week of live enforcement  
Lexi Approval: Confirmed  
