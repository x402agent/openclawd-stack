#!/bin/bash
set -e

echo "=== Solana Clawd Runtime E2B Sandbox ==="
echo "Initializing at $(date)..."

# Set environment variables
export HELIUS_API_KEY="${HELIUS_API_KEY}"
export HELIUS_RPC_URL="${HELIUS_RPC_URL:-https://mainnet.helius-rpc.com/?api-key=$HELIUS_API_KEY}"
export XAI_API_KEY="${XAI_API_KEY}"
export PATH="/root/.local/bin:$PATH"

echo "HELIUS_API_KEY: ${HELIUS_API_KEY:+set}"
echo "XAI_API_KEY: ${XAI_API_KEY:+set}"
echo "HELIUS_RPC: ${HELIUS_RPC_URL:0:50}..."

# Install system dependencies
echo "Installing system dependencies..."
apt-get update && apt-get install -y \
    curl \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x
echo "Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g npm@latest

# Install solana-clawd
echo "Installing solana-clawd..."
npm install -g solana-clawd

# Install nemoClawd
echo "Installing nemoClawd..."
npm install -g @mawdbotsonsolana/nemoclaw

# Install agentwallet-vault
echo "Installing agentwallet-vault..."
npm install -g @mawdbotsonsolana/agentwallet

# Install MCP server
echo "Installing Solana Clawd MCP..."
npm install -g @solana-clawd/solana-clawd-mcp

# Create config directories
echo "Creating config directories..."
mkdir -p ~/.clawd ~/.nemoclaw ~/.config/clawd
chmod 700 ~/.clawd ~/.nemoclaw ~/.config/clawd

# Initialize clawd if not configured
if [ ! -f ~/.clawd/configured ]; then
    echo "Initializing solana-clawd..."
    clawd init --non-interactive || true
    touch ~/.clawd/configured
fi

# Start MCP server in background
echo "Starting MCP server..."
nohup solana-clawd-mcp > /tmp/mcp.log 2>&1 &
MCP_PID=$!

echo "=== Sandbox Ready ==="
echo "MCP Server PID: $MCP_PID"
echo "Log: /tmp/mcp.log"
echo "Started at $(date)"

# Keep container alive
echo "Keeping sandbox alive..."
tail -f /dev/null
