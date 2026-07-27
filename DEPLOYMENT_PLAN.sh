#!/bin/bash
# ModBot Production Deployment Setup
# Jelly Labs Studio Community Protection Bot
# Target: Lightsail (alongside Bloop and Crabby)

## STEP 1: Discord Bot Account Setup
# The bot needs ONLY these permissions:
# - View Channels (read)
# - Send Messages (implied by moderation)
# - Manage Messages (delete messages ONLY)
# - View Audit Log (optional, for logging)
#
# NEVER grant:
# - Kick Members
# - Ban Members
# - Administrator
# - Manage Guild
# - Manage Roles
#
# Required scopes:
# - bot
# 
# Required permissions (numeric):
# 0x800 = MANAGE_MESSAGES (8192 in decimal)
# 0x400 = ADD_REACTIONS (1024) — NOT needed, can exclude
# 0x20 = READ_MESSAGES (32) — already implied
# 0x10 = SEND_MESSAGES (16) — for DMs to violators
#
# Total: 8192 (MANAGE_MESSAGES) + 16 (SEND_MESSAGES) = 8208
# OR use Discord's permission calculator at:
# https://discordapi.com/permissions.html#8208

## STEP 2: Suggested Bot Name
# Thematic options (matches Jelly Labs / Crabby):
# 1. "Jelly Guardian" — protects the jelly community (matches Jelly Labs theme)
# 2. "Crabby Mod" — extends Crabby's role
# 3. "Shellguard" — the jelly/crab theme
# 4. "Reef Keeper" — ocean theme, protective
#
# RECOMMENDATION: "Jelly Guardian" (thematic, clear purpose, matches brand)

## STEP 3: Environment Setup (Lightsail)
# Assumption: Lightsail server already has Node.js, PM2, nginx
#
# Structure (alongside bloop and crabby):
# /home/ec2-user/ (or ubuntu/)
#   ├── bloop/          (existing)
#   ├── crabby/         (existing)
#   ├── modbot/         (NEW)
#   │   ├── modbot.js
#   │   ├── prompts.js
#   │   ├── package.json
#   │   ├── .env
#   │   ├── config/
#   │   │   ├── mod-config.json
#   │   │   └── user-records.json
#   │   ├── logs/
#   │   └── dashboard/

## STEP 4: Minimal Permissions Matrix
# What modbot CAN do:
# ✅ Read messages (required for analysis)
# ✅ Delete messages (core function)
# ✅ Send DMs to users (for violation notices)
# ✅ View member list (for context)
# ✅ View audit log (for logging, optional)
#
# What modbot CANNOT do:
# ❌ Ban members
# ❌ Kick members
# ❌ Create roles or channels
# ❌ Manage members (can't change roles, etc.)
# ❌ Manage guild settings
# ❌ Access sensitive channels

## STEP 5: Hardening & Safeguards
# A. Token Security
#    - Store token in .env file (never in code)
#    - Use GitHub Actions secrets for CI/CD
#    - Rotate token monthly (manually for now)
#    - Token only exists on prod server
#
# B. Rate Limiting
#    - Max 10 API calls/sec (Discord's limit is 10/sec)
#    - Queue deletions with 50ms delay between calls
#    - Backpressure if API fails
#
# C. Audit Trail
#    - Every action logged with timestamp, user, reason
#    - Logs sent to mod-log channel in real-time
#    - Dashboard shows complete history
#    - Cannot be cleared except by Lexi (owner)
#
# D. Operational Limits
#    - Cannot delete messages > 14 days old (Discord limit anyway)
#    - Cannot delete messages in locked/archived channels
#    - Requires explicit admin approval to change sensitivity
#    - Shadow mode ON by default (no enforcement for first 48hrs)
#
# E. Escape Hatch
#    - Kill switch: `/modbot toggle enabled false` disables all enforcement
#    - Moderators can manually restore deleted messages (via audit log)
#    - All changes can be reviewed and reversed
#
# F. Monitoring
#    - Alert if more than 5 deletions/min (possible crash/bug)
#    - Alert if bot stops responding
#    - Health check endpoint every 30 seconds
#    - Dashboard shows uptime %

## STEP 6: Deployment Checklist
# ☐ Create Discord bot account (Jelly Guardian)
# ☐ Set permissions to 8208 (manage messages + send messages)
# ☐ Copy token securely
# ☐ SSH to Lightsail
# ☐ Clone modbot to /home/ec2-user/modbot
# ☐ Create .env file with token + port
# ☐ Run `npm install`
# ☐ Add PM2 startup config
# ☐ Start with PM2: `pm2 start modbot.js --name modbot`
# ☐ Set PM2 to auto-restart on reboot
# ☐ Point nginx to dashboard port (3006)
# ☐ Enable shadow mode in initial config
# ☐ Test deletion on test server
# ☐ Ask Lexi to enable production after 24-48hrs review

echo "✅ Deployment plan ready. Follow STEP 1-6 above."
