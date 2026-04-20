/**
 * E2B Solana Clawd Deployment Script
 * 
 * Deploys Solana Clawd Runtime to E2B cloud sandboxes
 * Uses E2B SDK v2 API with default Ubuntu template
 */

import { Sandbox } from 'e2b';
import type { SandboxOpts } from 'e2b';

interface DeployConfig {
  apiKey: string;
  metadata?: Record<string, string>;
}

interface SandboxInstance {
  sandboxId: string;
  hostname: string;
  port: number;
  status: string;
}

/**
 * Deploy Solana Clawd to E2B with Ubuntu base template
 */
async function deploy(config: DeployConfig): Promise<SandboxInstance> {
  console.log('[E2B Deploy] Starting deployment...');
  
  const templateName = 'ubuntu';
  
  // Create sandbox from Ubuntu template
  console.log('[E2B Deploy] Creating sandbox from Ubuntu template...');
  
  const sandboxOpts: SandboxOpts = {
    template: templateName,
    metadata: config.metadata || {},
  };
  
  const sandbox = await Sandbox.create(sandboxOpts, {
    apiKey: config.apiKey,
  });
  
  console.log(`[E2B Deploy] Sandbox created: ${sandbox.sandboxId}`);
  
  // Install Node.js
  console.log('[E2B Deploy] Installing Node.js...');
  await sandbox.commands.run('curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs 2>&1 | tail -5');
  
  // Install solana-clawd globally
  console.log('[E2B Deploy] Installing solana-clawd...');
  await sandbox.commands.run('npm install -g solana-clawd 2>&1 | tail -5');
  
  // Install nemoClawd
  console.log('[E2B Deploy] Installing nemoClawd...');
  await sandbox.commands.run('npm install -g @mawdbotsonsolana/nemoclaw 2>&1 | tail -5');
  
  // Install agentwallet
  console.log('[E2B Deploy] Installing agentwallet...');
  await sandbox.commands.run('npm install -g @mawdbotsonsolana/agentwallet 2>&1 | tail -5');
  
  // Set up directories
  console.log('[E2B Deploy] Setting up directories...');
  await sandbox.commands.run('mkdir -p ~/.clawd ~/.config/clawd && chmod 700 ~/.clawd ~/.config/clawd');
  
  // Set environment variables
  console.log('[E2B Deploy] Setting environment variables...');
  const envSetup = `
cat >> ~/.bashrc << 'EOF'
export HELIUS_API_KEY="${process.env.HELIUS_API_KEY || ''}"
export HELIUS_RPC_URL="${process.env.HELIUS_RPC_URL || ''}"
export PRIVY_APP_ID="${process.env.PRIVY_APP_ID || ''}"
export XAI_API_KEY="${process.env.XAI_API_KEY || ''}"
EOF
echo "Environment configured"
`.trim();
  
  await sandbox.commands.run(envSetup);
  
  // Initialize clawd
  console.log('[E2B Deploy] Initializing solana-clawd...');
  const initResult = await sandbox.commands.run('clawd init --non-interactive 2>/dev/null || echo "Already initialized"');
  console.log('[E2B Deploy] Init result:', initResult.stdout);
  
  // Verify installations
  console.log('[E2B Deploy] Verifying installations...');
  const whichResult = await sandbox.commands.run('echo "Checking installations..." && (which clawd || echo "clawd: not found") && (which nemoclaw || echo "nemoclaw: not found") && (which agentwallet || echo "agentwallet: not found")');
  console.log('[E2B Deploy] Verification result:', whichResult.stdout);
  
  // Get sandbox info
  const info = sandbox.getInfo();
  
  return {
    sandboxId: sandbox.sandboxId,
    hostname: info?.hostname || 'localhost',
    port: info?.port || 9090,
    status: 'running',
  };
}

/**
 * Execute command in sandbox
 */
async function execInSandbox(
  sandboxId: string,
  command: string,
  apiKey: string
): Promise<string> {
  const sandbox = await Sandbox.connect(sandboxId, {
    apiKey,
  });
  
  const result = await sandbox.commands.run(command);
  return result.stdout;
}

/**
 * Get sandbox status
 */
async function getStatus(
  sandboxId: string,
  apiKey: string
): Promise<string> {
  const sandbox = await Sandbox.connect(sandboxId, {
    apiKey,
  });
  
  const info = sandbox.getInfo();
  return info?.metadata?.status || 'unknown';
}

/**
 * Destroy sandbox
 */
async function destroy(
  sandboxId: string,
  apiKey: string
): Promise<void> {
  const sandbox = await Sandbox.connect(sandboxId, {
    apiKey,
  });
  await sandbox.kill();
  console.log(`[E2B Deploy] Sandbox ${sandboxId} destroyed`);
}

/**
 * Main deployment function
 */
async function main() {
  const apiKey = process.env.E2B_API_KEY;
  
  if (!apiKey) {
    console.error('[E2B Deploy] Error: E2B_API_KEY not set');
    console.error('Get your API key at https://e2b.dev');
    process.exit(1);
  }
  
  const heliusKey = process.env.HELIUS_API_KEY;
  
  if (!heliusKey) {
    console.error('[E2B Deploy] Error: HELIUS_API_KEY not set');
    process.exit(1);
  }
  
  console.log('[E2B Deploy] Deploying Solana Clawd Runtime to E2B...');
  console.log(`[E2B Deploy] Helius: ${heliusKey ? 'configured' : 'missing'}`);
  
  try {
    const instance = await deploy({
      apiKey,
      metadata: {
        runtime: 'solana-clawd',
        helius: heliusKey ? 'configured' : 'missing',
        deployedAt: new Date().toISOString(),
      },
    });
    
    console.log('\n=== Deployment Complete ===');
    console.log(`Sandbox ID: ${instance.sandboxId}`);
    console.log(`Hostname: ${instance.hostname}`);
    console.log(`Port: ${instance.port}`);
    console.log(`Status: ${instance.status}`);
    console.log('\nConnect to sandbox:');
    console.log(`  e2b sandbox connect ${instance.sandboxId}`);
    
    // Example: Run a command
    console.log('\nTesting sandbox...');
    const testResult = await execInSandbox(
      instance.sandboxId,
      'echo "Solana Clawd Runtime ready!" && whoami && node --version',
      apiKey
    );
    console.log('Result:', testResult);
    
    // Cleanup after testing (uncomment to auto-destroy)
    // await destroy(instance.sandboxId, apiKey);
    
  } catch (error) {
    console.error('[E2B Deploy] Deployment failed:', error);
    process.exit(1);
  }
}

// Export functions for programmatic use
export {
  deploy,
  execInSandbox,
  getStatus,
  destroy,
  type DeployConfig,
  type SandboxInstance,
};

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
