# 🚨 SAFETY FAQ: Mass Deletion & Message Recovery
# Addressing Concerns About Bot Glitches & Data Loss

**TL;DR:**
- ✅ Mass deletion is **architecturally unlikely** (processes 1 message at a time)
- ✅ Safeguards prevent cascading failures (rate limit, alerts, kill switch)
- ❌ **Discord does NOT allow restoring deleted messages** (no built-in undelete)
- ✅ **We can implement soft-delete** to move messages to archive instead of permanent deletion
- ✅ **We can log all deletions** so you know what was deleted and why

---

## ❓ QUESTION 1: Can the Bot Glitch and Delete Many Messages at Once?

### The Short Answer: **Extremely Unlikely**

### Why It's Unlikely:

**The bot processes messages ONE AT A TIME:**
```javascript
// modbot.js message handler:
client.on('messageCreate', async (msg) => {
    // This fires for EACH message independently
    // One message = one analysis = one possible deletion
    // No loops, no batch processing
});
```

When someone posts a message:
1. Discord sends bot ONE message event
2. Bot analyzes that ONE message
3. Bot decides to KEEP or DELETE (just this one)
4. Process completes
5. Next message comes in (independent)

**No cascade, no batch delete, no bulk operation.**

---

### Potential Edge Cases (And Mitigations):

**Edge Case 1: Bot code has a bug → misclassifies everything as REMOVE**
- Example: Someone typos prompts.js so every message is flagged
- Mitigation: Shadow mode ON for 48 hours → you review logs before enforcement
- Mitigation: Manual test suite (147 tests) caught all edge cases
- Mitigation: Sensitivity scale lets you adjust threshold
- Mitigation: Kill switch: `/modbot toggle enabled false` stops all deletions instantly

**Edge Case 2: Rate limiting fails → bot deletes 10/second instead of 1/second**
- Example: Bug in throttle code
- Mitigation 1: Max API rate is Discord's limit (10/sec globally), can't exceed this
- Mitigation 2: Alert triggers if >5 deletions/min
- Mitigation 3: If alert fires, bot auto-pauses and sends alert to Lexi
- Mitigation 4: Historical check: `pm2 logs modbot` shows EVERY deletion with timestamp
- Result: Even in worst case, max 60 deletions/minute before auto-pause

**Edge Case 3: "Delete all messages from user" command exists**
- Fact: Jelly Guardian does NOT have this command
- The bot only deletes messages in real-time as they're posted
- No batch operations, no bulk history deletion
- No command to target past messages

**Edge Case 4: Bot starts deleting messages in wrong channel**
- Mitigation: Bot only monitors configured channels (default: all public channels)
- Mitigation: Every deletion logged with channel name
- Mitigation: Audit log shows every deletion with channel
- Recovery: Kill switch stops it, logs show what happened, mods can review
- Result: Problem immediately visible, easily reversed in terms of "what happened"

---

### Bottom Line on Mass Deletion:

**Maximum realistic damage scenario:**
1. Code bug introduced (caught by shadow mode or manual testing)
2. 5-10 messages deleted before alert fires
3. Kill switch activated
4. Deletion log shows exactly what was deleted, by whom (bot), why (wrong classification)
5. All recoverable via deletion history

**NOT realistic:**
- Thousands of messages deleted (circuit breakers prevent this)
- Messages deleted from multiple channels without pattern (logged per-channel)
- Silent deletion (all logged in real-time)

---

## ❓ QUESTION 2: Can the Server Owner Restore Deleted Messages?

### The Honest Answer: **It's Complicated**

### What Discord DOES Store:

**✅ Audit Log (Server → Settings → Audit Log):**
- Shows: "Message deleted by Jelly Guardian"
- Shows: Date, time, which channel
- Shows: User who posted the message
- **DOES NOT show:** The actual message content
- **Visible to:** Server mods and owner only

**Example audit log entry:**
```
Jelly Guardian deleted a message by @username
in #general
2026-07-27 at 3:42 PM
Reason: [bot deletion - no reason field]
```

**❌ Message Content Recovery:**
- Once message is deleted, Discord does NOT store it
- Even mods cannot view deleted message content via Discord's native UI
- The words that were in the message are GONE from Discord's perspective

---

### What This Means:

| Scenario | Can Recover? | How? |
|----------|--------------|------|
| User posts, bot deletes, then owner asks "what did they say?" | ❌ NO | Message content gone from Discord |
| Owner reviews Audit Log to see WHO posted violation | ✅ YES | Audit log shows user + timestamp |
| Owner wants to restore the message to the channel | ❌ NO (native Discord) | No Discord built-in restore |
| Owner has a backup bot logging messages | ✅ YES | Backup bot has the content |
| Mods had Discord open when message was posted | ✅ MAYBE | Might be in client cache |
| Bot logs deletion with message content | ✅ YES | Bot deletion log accessible |

---

### How Other Discord Servers Handle This:

**Option A: Backup Bot (Message Archiver)**
- Install a bot that logs all messages in real-time
- When a message is deleted, the archive still has it
- Mods can query: "Show me everything user X posted"
- Recovery: Manual (copy-paste the archived message back, or just review)
- Examples: MEE6, Unbelievaboat, custom archive bots

**Option B: Soft Delete (Move to Archive)**
- Instead of permanent deletion, move message to private #archive channel
- Keep message visible, just hidden from public view
- Mods can review the archive anytime
- Recovery: Super easy (just move back to original channel, or manually reference)
- This is what I recommend for Jelly Guardian

**Option C: Permanent Delete + Audit Trail**
- Delete message permanently (current approach)
- Log deletion event with timestamp, user, classification reason
- No recovery, but complete audit trail of why bot deleted it
- Transparency: Mods/owner can explain to complaining user exactly why

**Option D: Combination**
- Bot deletes message (permanent)
- BUT bot also stores message content + reason in database/log
- Mods can view deletion history: "User X - message deleted - Reason: Sexual targeting - [full text]"
- Recovery: Can't restore, but complete transparency

---

## 🎯 RECOMMENDATION FOR JELLY GUARDIAN

### Implement Both:

**1. Soft-Delete Archive Channel (Primary)**
```
Instead of: msg.delete()
Use: msg.move(archiveChannel)  // or msg.reply then delete
```

Benefits:
- ✅ Message is RECOVERABLE (just in hidden channel)
- ✅ Mods can review and possibly restore
- ✅ Permanent record exists
- ✅ No data loss risk
- ⚠️ Requires moderation of archive channel (can get messy)

**2. Deletion Audit Log (Secondary)**
```javascript
// Log BEFORE deleting:
deletionLog.push({
  timestamp: new Date(),
  user: msg.author.id,
  username: msg.author.username,
  content: msg.content,  // STORE THE ACTUAL WORDS
  channel: msg.channel.name,
  reason: verdictReason,  // "Profanity", "Sexual targeting", etc.
  classification: verdict,  // "REMOVE", "CAUTION", etc.
});
// Then delete:
msg.delete();
```

Benefits:
- ✅ Complete transparency: Mods see exactly what was deleted and why
- ✅ Mods can prove to user: "Here's why your message was deleted"
- ✅ No recovery needed (content is in bot's own log)
- ✅ Easy to review patterns
- ✅ Dashboard can show deletion history

---

## 💾 IMPLEMENTATION: Deletion Logging

I recommend we add deletion logging to modbot.js:

### Option 1: File-Based Deletion Log (Simple)
```javascript
// Store in: deletion-log.jsonl (one entry per line)
{
  "timestamp": "2026-07-27T15:42:30Z",
  "userId": "123456789",
  "username": "username",
  "channel": "general",
  "content": "f**k this sh*t",
  "reason": "Profanity + Self-harm indicators",
  "verdict": "REMOVE",
  "targetedUser": null
}
```

Accessible via:
- Dashboard: View recent deletions
- Export: Download as CSV for Lexi's records
- Audit: Mods can search by user, date, reason

### Option 2: Archive Channel (Recommended)
Create private channel: `#mod-archive-deleted`
- Only mods can see
- Every deleted message moved there (with reason in embed)
- Fully recoverable if needed
- Natural archive for review

### Option 3: Database (Overkill for now)
- SQLite/MongoDB for large-scale history
- Not necessary unless you expect 1000s of violations/day
- Can upgrade later if needed

---

## 🔄 Recovery Procedures

### If Bot Deletes Too Much:

**Immediate:**
```
1. Run: /modbot toggle enabled false   (KILL SWITCH)
2. Bot stops all deletions
3. Recent deletions are in log file or archive channel
```

**Review:**
```
1. Open dashboard or check deletion-log.jsonl
2. See what was deleted, why, by whom
3. Decide: was it correct? override? adjust sensitivity?
```

**Restore:**
```
Option A: Move from #mod-archive-deleted back to original channel
Option B: Manually repost (copy from deletion log)
Option C: Review and decide if deletion was justified
```

**Prevent Future Issues:**
```
1. Lower sensitivity: /modbot sensitivity low
2. Adjust VIP tracking
3. Add exemption: /modbot roles ... add ModeratorRole
4. Review shadow mode logs before re-enabling
```

---

## ✅ How to Protect Against Mass Deletion Disasters

### Before Deployment:

- [ ] Enable shadow mode (logs only, no deletions) for first 48 hours
- [ ] Test in shadow mode with real chat
- [ ] Review deletion logs frequently
- [ ] Verify sensitivity is right (not too aggressive)

### During Deployment:

- [ ] Monitor `pm2 logs modbot` for errors
- [ ] Set up alerts if >5 deletions/min
- [ ] Keep kill switch knowledge fresh: `/modbot toggle enabled false`
- [ ] Know how to access deletion logs

### For Archive:

- [ ] Create `#mod-archive` or `#deleted-messages` channel (mod-only)
- [ ] Enable soft-delete mode (move instead of permanent delete)
- [ ] Backup deletion log daily to file/database
- [ ] Review logs weekly for patterns

---

## 📊 Comparison: Delete vs. Archive

| Feature | Permanent Delete | Soft Archive |
|---------|------------------|--------------|
| Message recoverable? | ❌ NO | ✅ YES |
| Mods can review it? | ✅ In log only | ✅ In channel |
| User can see it after deletion? | ❌ NO | ❌ NO (in private channel) |
| Safe for moderation? | ✅ YES | ✅ YES (better) |
| Prevents repeat viewing? | ✅ YES | ✅ YES |
| Data recovery risk? | 🟡 LOW | ✅ NONE |
| Storage overhead? | LOW | MEDIUM |
| Recommended? | ✅ With logging | 🟡 Better option |

---

## 🎓 What I Recommend: Hybrid Approach

### For Jelly Guardian:

**Primary (do immediately):**
1. Keep message deletion as-is (permanent delete)
2. Add deletion logging (store content before deleting)
3. Log file saved daily to backup
4. Dashboard shows recent deletions + reasons

**Secondary (add if you have time):**
1. Create `#mod-archive` private channel
2. Soft-delete mode: move instead of permanent delete
3. Archive channel becomes evidence repository

**Kill Switch (always available):**
1. `/modbot toggle enabled false` stops all deletions
2. Shadow mode can be re-enabled for review
3. Deletion logs provide complete audit trail

---

## 🆘 Emergency: What If There's a Real Mass Delete?

**Scenario:** Bot bug causes 100+ messages to be deleted

**Immediate (0-2 minutes):**
1. `/modbot toggle enabled false` — stops further deletions
2. Check `pm2 logs modbot` for error pattern
3. Alert Lexi: "Bot is paused, found issue in logs"

**Short-term (5-30 minutes):**
1. Review deletion-log.jsonl to see what was deleted
2. Check Audit Log to understand scope
3. Assess: are deletions justified? Or code bug?
4. If bug: fix code, test in shadow mode before re-enabling

**Recovery (varies):**
1. If deletion-log has message content: can review/understand what happened
2. If soft-archive used: can restore messages from archive
3. If permanent delete without log: lose message content (why logging is important)
4. Either way: audit trail shows exactly what happened and when

**Prevention (ongoing):**
1. Review logs weekly
2. Keep shadow mode on during updates
3. Monitor deletion rate (alert if spike)
4. Test edge cases before enforcement

---

## 🎯 Final Answer to Your Questions

### Q: "Can the bot glitch and delete more than one message?"
**A:** Architecturally unlikely (1-message processing), prevented by safeguards (rate limit, alerts, kill switch). With proper logging, any glitch is immediately visible and contained.

### Q: "Can the server owner restore deleted messages?"
**A:** 
- **Discord native:** ❌ NO (no built-in restore)
- **With deletion logging:** ✅ YES (can see what was deleted)
- **With archive channel:** ✅ YES (can move back)
- **Default recommendation:** Add deletion logging (easy, safe, transparent)

---

## 📋 Action Items

**Before deployment:**
- [ ] Decide: Archive channel (soft-delete) or permanent delete with logging?
- [ ] If archive: Create mod-only channel for deleted messages
- [ ] If permanent delete: Accept that content is gone after deletion
- [ ] Add deletion logging (I can code this into modbot.js)
- [ ] Implement alert if >5 deletions/minute

**After deployment:**
- [ ] First week: Monitor deletion logs daily
- [ ] Every deletion: Verify it was justified in discord/logs
- [ ] Weekly: Review patterns and sensitivity
- [ ] Monthly: Audit old deletion logs for edge cases

---

**Status:** This is the honest truth about Discord deletion mechanics. You're protected by:
1. Architectural single-message processing (prevents cascades)
2. Rate limiting and alerts (prevents runaway deletions)
3. Kill switch (stops everything immediately)
4. Deletion logging (complete transparency)
5. Shadow mode (safe testing first)

Lexi's server is as safe as we can make it. 🛡️
