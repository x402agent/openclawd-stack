# Deploy Solana Clawd to E2B

> Browser-based cloud IDE powered by E2B sandboxes

## Overview

Turn your website into a fully functional Solana trading terminal. Users get instant access to a cloud sandbox with solana-clawd, nemoClawd, and agentic wallets - no installation required.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Your Website                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │
│  │  Terminal   │  │  Monaco     │  │  Status Panel   │   │
│  │  Component  │  │  Editor     │  │  & Controls     │   │
│  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘   │
│         │                 │                  │             │
│         └─────────────────┼──────────────────┘             │
│                           │                                │
│                    ┌──────▼──────┐                         │
│                    │  E2B SDK   │                         │
│                    │  Bridge    │                         │
│                    └──────┬──────┘                         │
└───────────────────────────┼────────────────────────────────┘
                            │ WebSocket
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    E2B Sandbox                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │
│  │ solana-    │  │  nemoClawd  │  │  agentwallet   │   │
│  │ clawd CLI  │  │  (31 MCP)   │  │  (Privy)      │   │
│  └─────────────┘  └─────────────┘  └─────────────────┘   │
│                                                             │
│  OS: Ubuntu 24.04 | Node.js v20 | RAM: 4GB               │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Deploy Template

```typescript
// deploy.ts
import { Sandbox } from 'e2b';

const sandbox = await Sandbox.create({
  template: 'solana-clawd-v1',
  metadata: { userId: 'user-123' }
});
```

### 2. Embed Terminal

```tsx
// TerminalEmbed.tsx
import { E2BTerminal } from '@solana-clawd/terminal';

export function TradingTerminal({ sandboxId }) {
  return (
    <E2BTerminal
      sandboxId={sandboxId}
      height="600px"
      theme="dark"
      onCommand={(cmd) => executeInSandbox(sandboxId, cmd)}
    />
  );
}
```

### 3. WebSocket Bridge

```typescript
// ws-bridge.ts
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });

wss.on('connection', async (ws, req) => {
  const sandboxId = req.url.split('/').pop();
  const sandbox = await Sandbox.connect(sandboxId);
  
  // Stream terminal output
  sandbox.commands.stream('bash', (data) => {
    ws.send(data);
  });
  
  // Handle user input
  ws.on('message', (cmd) => {
    sandbox.commands.run(cmd.toString());
  });
});
```

## Terminal Component

```tsx
import { useEffect, useRef, useState } from 'react';

interface E2BTerminalProps {
  sandboxId: string;
  apiKey: string;
  height?: string;
  theme?: 'dark' | 'light';
}

export function E2BTerminal({ sandboxId, apiKey, height = '500px', theme = 'dark' }: E2BTerminalProps) {
  const [output, setOutput] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const terminalRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    // Connect to E2B sandbox via WebSocket
    const ws = new WebSocket(`wss://api.yoursite.com/terminal/${sandboxId}`);
    
    ws.onmessage = (event) => {
      setOutput(prev => [...prev, event.data]);
    };
    
    return () => ws.close();
  }, [sandboxId]);
  
  const handleCommand = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && input.trim()) {
      setOutput(prev => [...prev, `$ ${input}`]);
      ws.send(input);
      setInput('');
    }
  };
  
  return (
    <div 
      ref={terminalRef}
      style={{ 
        height, 
        background: theme === 'dark' ? '#1a1a1a' : '#f5f5f5',
        color: theme === 'dark' ? '#00ff00' : '#333',
        fontFamily: 'monospace',
        padding: '16px',
        overflow: 'auto',
        borderRadius: '8px'
      }}
    >
      {output.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
      <div style={{ display: 'flex' }}>
        <span>$ </span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleCommand}
          autoFocus
        />
      </div>
    </div>
  );
}
```

## Deployment Options

### Option 1: Static Single Tenant
- Each user gets their own sandbox
- Sandboxes auto-destroy after inactivity
- Best for: Paid tiers, high-security

### Option 2: Shared Pool
- Pool of pre-warmed sandboxes
- Users connect to available sandbox
- Best for: Free tier, quick access

### Option 3: Per-Session
- Create sandbox on demand
- Destroy after session ends
- Best for: One-time use, demos

## API Endpoints

```typescript
// /api/sandbox/create
POST /api/sandbox/create
{
  userId: string;
  plan: 'free' | 'pro' | 'enterprise';
}
Response: { sandboxId: string; wsUrl: string; expiresAt: string; }

// /api/sandbox/status
GET /api/sandbox/status/:sandboxId
Response: { status: 'booting' | 'ready' | 'running' | 'stopped'; }

// /api/sandbox/extend
POST /api/sandbox/extend
{
  sandboxId: string;
  minutes: number;
}
Response: { newExpiresAt: string; }
```

## Security

- Sandbox isolation via E2B
- API key never exposed to client
- Rate limiting per user
- Command logging for abuse prevention
- Optional: VPC peering for private keys

## Pricing Estimate

| Tier | Sandboxes | RAM | Cost/hour |
|------|-----------|-----|-----------|
| Free | 10 pool | 2GB | $0.02 |
| Pro | 50 pool | 4GB | $0.08 |
| Enterprise | Dedicated | 8GB | $0.20 |

## Getting Started

1. Get E2B API key at [e2b.dev](https://e2b.dev)
2. Deploy bridge server
3. Embed terminal component
4. Start earning from cloud terminals!

## Next Steps

- [Monetization Guide](./MONETIZATION.md)
- [WebSocket Bridge Implementation](./WS_BRIDGE.md)
- [Example Landing Page](./EXAMPLE_LANDING.md)
