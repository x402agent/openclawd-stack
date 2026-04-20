# NVIDIA OpenShell Community Sandbox: solana-clawd
# https://github.com/NVIDIA/OpenShell-Community

FROM ghcr.io/nvidia/openshell-sandbox-base:ubuntu24.04

# Labels
LABEL maintainer="8BIT Labs <mawdbot@gmail.com>"
LABEL description="Solana AI Agent Runtime - xAI Grok + MCP Tools + OODA Trading"
LABEL com.openshell.sandbox.name="solana-clawd"
LABEL com.openshell.sandbox.version="1.4.0"

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g npm@latest

# Install Rust (for OpenShell CLI)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install OpenShell CLI
RUN curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh

# Install solana-clawd
RUN npm install -g solana-clawd

# Install nemoClawd
RUN npm install -g @mawdbotsonsolana/nemoclaw

# Install agentwallet-vault
RUN npm install -g @mawdbotsonsolana/agentwallet

# Create config directories
RUN mkdir -p /sandbox/.clawd \
    /sandbox/.nemoclaw \
    /sandbox/.config/clawd \
    && chmod 700 /sandbox/.clawd \
    && chmod 700 /sandbox/.nemoclaw \
    && chmod 700 /sandbox/.config/clawd

# Create startup script
RUN echo '#!/bin/bash\n\
# solana-clawd startup script for OpenShell\n\
\necho "=== Solana Clawd Runtime ==="\necho "Initializing environment..."\n\
\n# Check for required environment variables\necho "HELIUS_API_KEY: ${HELIUS_API_KEY:+set}"\necho "XAI_API_KEY: ${XAI_API_KEY:+set}"\n\
# Never echo actual key values!\n\
if [ -z "$HELIUS_API_KEY" ]; then\n\
    echo "WARNING: HELIUS_API_KEY not set. Some features may not work."\n\
fi\n\
if [ -z "$XAI_API_KEY" ]; then\n\
    echo "WARNING: XAI_API_KEY not set. Grok features will be unavailable."\n\
fi\n\
\n# Initialize solana-clawd if not configured\nif [ ! -f ~/.clawd/configured ]; then\n\
    echo "Running solana-clawd initialization..."\n\
    clawd init --non-interactive || true\n\
    touch ~/.clawd/configured\n\
fi\n\
\necho "Solana Clawd Runtime ready!"\necho "Run: clawd go  # Start the agent"\necho "Run: nemoclaw launch  # Alternative launcher"\n\
\n# Start shell\n/bin/bash' > /usr/local/bin/solana-clawd-start && \
chmod +x /usr/local/bin/solana-clawd-start

# Expose ports
EXPOSE 18789 18790 9099

# Default command
CMD ["/usr/local/bin/solana-clawd-start"]
