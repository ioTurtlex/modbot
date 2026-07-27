#!/bin/bash
# Deploy Jelly Guardian (ModBot) to Lightsail
# Run this script on the Lightsail server after cloning the modbot repository
#
# Usage:
#   ssh ec2-user@52.27.156.102  (or appropriate IP)
#   cd /home/ec2-user
#   bash modbot/deploy.sh

set -e  # Exit on error

echo "🚀 Deploying Jelly Guardian ModBot to Lightsail"
echo "=================================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as correct user
if [ "$USER" != "ec2-user" ] && [ "$USER" != "ubuntu" ]; then
    echo -e "${RED}❌ Must run as ec2-user or ubuntu (current: $USER)${NC}"
    exit 1
fi

HOME_DIR="/home/$USER"
MODBOT_DIR="$HOME_DIR/modbot"
BACKUPS_DIR="$MODBOT_DIR/backups"
LOGS_DIR="/var/log/modbot"

# Step 1: Verify modbot directory exists
echo -e "${YELLOW}[1/9]${NC} Checking modbot directory..."
if [ ! -d "$MODBOT_DIR" ]; then
    echo -e "${RED}❌ $MODBOT_DIR not found!${NC}"
    echo "Clone the modbot repository first:"
    echo "  git clone <repo> $MODBOT_DIR"
    exit 1
fi
echo -e "${GREEN}✅${NC} Found $MODBOT_DIR"

# Step 2: Create modbot system user (if not exists)
echo -e "${YELLOW}[2/9]${NC} Ensuring modbot system user exists..."
if ! id -u modbot &>/dev/null; then
    sudo useradd -r -s /bin/bash modbot || echo -e "${YELLOW}⚠️${NC} modbot user may already exist"
else
    echo -e "${GREEN}✅${NC} modbot user already exists"
fi

# Step 3: Set file permissions
echo -e "${YELLOW}[3/9]${NC} Setting secure file permissions..."
sudo chown -R modbot:modbot "$MODBOT_DIR"
find "$MODBOT_DIR" -type d -exec chmod 755 {} \;
find "$MODBOT_DIR" -type f -exec chmod 644 {} \;
chmod 700 "$MODBOT_DIR"  # Only modbot can access main dir

# Step 4: Create directories for config and logs
echo -e "${YELLOW}[4/9]${NC} Creating backup and log directories..."
mkdir -p "$BACKUPS_DIR"
mkdir -p "$LOGS_DIR"
sudo chown modbot:modbot "$BACKUPS_DIR" "$LOGS_DIR"
chmod 750 "$BACKUPS_DIR" "$LOGS_DIR"
echo -e "${GREEN}✅${NC} Directories created"

# Step 5: Check .env file
echo -e "${YELLOW}[5/9]${NC} Checking .env file..."
if [ ! -f "$MODBOT_DIR/.env" ]; then
    echo -e "${YELLOW}⚠️${NC} .env not found. Creating from template..."
    cp "$MODBOT_DIR/.env.production.template" "$MODBOT_DIR/.env"
    chmod 600 "$MODBOT_DIR/.env"
    echo -e "${RED}📝 IMPORTANT: Edit $MODBOT_DIR/.env and set DISCORD_TOKEN${NC}"
    echo "  nano $MODBOT_DIR/.env"
    echo ""
    read -p "Press Enter after setting DISCORD_TOKEN..."
else
    echo -e "${GREEN}✅${NC} .env file exists"
    chmod 600 "$MODBOT_DIR/.env"
fi

# Step 6: Install dependencies
echo -e "${YELLOW}[6/9]${NC} Installing Node dependencies..."
cd "$MODBOT_DIR"
npm install --production
echo -e "${GREEN}✅${NC} Dependencies installed"

# Step 7: Run tests
echo -e "${YELLOW}[7/9]${NC} Running pre-flight tests..."
# Quick sanity check - just verify the main files exist
if [ ! -f "$MODBOT_DIR/modbot.js" ]; then
    echo -e "${RED}❌ modbot.js not found!${NC}"
    exit 1
fi
if [ ! -f "$MODBOT_DIR/prompts.js" ]; then
    echo -e "${RED}❌ prompts.js not found!${NC}"
    exit 1
fi
echo -e "${GREEN}✅${NC} Core files verified"

# Step 8: Setup PM2 (if not already set up for other bots)
echo -e "${YELLOW}[8/9]${NC} Configuring PM2..."
# Check if pm2 is installed globally
if ! command -v pm2 &>/dev/null; then
    echo "Installing PM2 globally..."
    npm install -g pm2
fi

# Stop any existing modbot process
pm2 stop modbot 2>/dev/null || true
pm2 delete modbot 2>/dev/null || true

# Start with PM2
pm2 start modbot.js --name modbot --user modbot --cwd "$MODBOT_DIR" --env PATH=/usr/bin:/bin

# Setup auto-restart on reboot
echo "Setting up auto-restart on reboot..."
pm2 startup systemd -u $USER --hp "$HOME_DIR" || true
pm2 save

echo -e "${GREEN}✅${NC} PM2 configured"

# Step 9: Verify bot is running
echo -e "${YELLOW}[9/9]${NC} Verifying bot is running..."
sleep 2
if pm2 describe modbot | grep -q "online"; then
    echo -e "${GREEN}✅${NC} ModBot is online!"
else
    echo -e "${RED}❌ ModBot failed to start${NC}"
    echo "Check logs with: pm2 logs modbot"
    exit 1
fi

# Final summary
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║${NC}                   🎉 Jelly Guardian ModBot deployed successfully!                  ${GREEN}║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Next steps:"
echo ""
echo "1. Verify bot token is set:"
echo "   cat $MODBOT_DIR/.env | grep DISCORD_TOKEN"
echo ""
echo "2. Check bot logs:"
echo "   pm2 logs modbot"
echo ""
echo "3. Test the bot:"
echo "   - In Discord, type: @Jelly Guardian"
echo "   - Or use: /modbot status"
echo ""
echo "4. Access dashboard (if nginx is configured):"
echo "   http://lightsail-ip:3006"
echo ""
echo "5. Monitor bot:"
echo "   pm2 monit"
echo ""
echo "⚠️  Remember:"
echo "   - Shadow mode is ON by default (no enforcement yet)"
echo "   - Review logs for 24-48 hours before enabling enforcement"
echo "   - Rotate Discord token monthly"
echo ""
echo "Useful commands:"
echo "   pm2 stop modbot          # Stop the bot"
echo "   pm2 start modbot         # Start the bot"
echo "   pm2 restart modbot       # Restart the bot"
echo "   pm2 logs modbot          # View logs"
echo "   pm2 save                 # Save PM2 startup state"
echo ""
echo "Emergency:"
echo "   pm2 delete modbot        # Remove from PM2"
echo "   rm -rf $MODBOT_DIR       # Delete everything (use with care!)"
echo ""
