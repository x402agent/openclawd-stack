// gateway/src/server.ts — adapted for payments.
//
// Diff summary vs the original:
//   + Import SandboxPayments
//   + Construct `payments` at startup, reading CLAWD_ROUTER_ORIGIN + owner info
//   + Pass `payments` into AgentSession.createSession so agent tool loops can
//     call pay() directly
//   + NEW route: POST /v1/x402/pay — agent-initiated paid fetch
//   + NEW route: GET  /v1/x402/spend — local spend meter for UI
//   + NEW route: GET  /v1/x402/mandate — returns the current mandate expiry for UI
//   + Everything else kept verbatim from the uploaded file.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { WebSocketServer, WebSocket } from 'ws';
import { parseArgs } from 'node:util';
import pino from 'pino';

import { verifyPrivyToken, type PrivySubject } from './privy-auth.js';
import { agentRegistry, AgentSession } from './agents/registry.js';
import { ClawdVault } from './memory/clawdvault.js';
import { attachTelegram } from './channels/telegram.js';
import { SandboxPayments } from './payments.js';

const log = pino({ level: process.env.CLAWD_LOG_LEVEL ?? 'info', name: 'clawd-gateway' });

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '18789' },
    auth: { type: 'string', default: 'privy' },
    workspace: { type: 'string', default: '/workspace' },
    vault: { type: 'string', default: '/vault' },
  },
});

const PORT = Number(args.port);
const AUTH_MODE = args.auth as 'privy' | 'token' | 'both';
const WORKSPACE = args.workspace!;
const VAULT_DIR = args.vault!;

const BEARER = process.env.CLAWD_GATEWAY_TOKEN ?? '';
const vault = new ClawdVault({ workspace: WORKSPACE, vaultDir: VAULT_DIR });

// Payments — one instance, scoped to the sandbox's single owner.
const payments = new SandboxPayments({
  vault,
  owner: process.env.CLAWD_OWNER_SUB ?? 'unknown',
  ownerWallet: process.env.CLAWD_OWNER_WALLET ?? null,
  gatewayOrigin: process.env.CLAWD_ROUTER_ORIGIN ?? 'https://solanaclawd.com',
});

const app = new Hono();
app.use('*', cors({ origin: '*' }));

app.get('/healthz', (c) => c.json({ ok: true, ts: Date.now() }));

app.get('/v1/agents', async (c) => {
  await requireAuth(c.req.header('authorization'), c.req.query('token'));
  return c.json({ agents: agentRegistry.list() });
});

app.post('/v1/sessions', async (c) => {
  const sub = await requireAuth(c.req.header('authorization'), c.req.query('token'));
  const body = await c.req.json<{ agent: string; model?: string; project?: string }>();
  const handler = agentRegistry.get(body.agent);
  if (!handler) return c.json({ error: 'unknown_agent' }, 400);

  const session = await handler.createSession({
    privySub: sub.sub,
    wallet: sub.wallet,
    model: body.model,
    project: body.project,
    vault,
    payments,
  });
  return c.json({ sessionId: session.id, agent: body.agent, model: session.model });
});

app.post('/v1/sessions/:id/messages', async (c) => {
  const sub = await requireAuth(c.req.header('authorization'), c.req.query('token'));
  const id = c.req.param('id');
  const body = await c.req.json<{ content: string }>();
  const session = AgentSession.get(id);
  if (!session || session.owner !== sub.sub) return c.json({ error: 'not_found' }, 404);
  const reply = await session.send(body.content);
  return c.json({ reply });
});

app.get('/v1/vault/:tier', async (c) => {
  const sub = await requireAuth(c.req.header('authorization'), c.req.query('token'));
  const tier = c.req.param('tier') as 'KNOWN' | 'LEARNED' | 'INFERRED';
  const entries = await vault.read(sub.sub, tier);
  return c.json({ tier, entries });
});

app.post('/v1/vault/snapshot', async (c) => {
  const sub = await requireAuth(c.req.header('authorization'), c.req.query('token'), {
    scope: 'orchestrator',
  });
  const snap = await vault.snapshot(sub.sub);
  return c.json(snap);
});

/* ——— NEW: payments endpoints ——— */

app.post('/v1/x402/pay', async (c) => {
  await requireAuth(c.req.header('authorization'), c.req.query('token'));
  const body = await c.req.json<{
    url: string;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    protocol?: 'x402' | 'mpp' | 'ap2';
    maxAmountBaseUnits?: string;
  }>();

  try {
    const result = await payments.pay({
      url: body.url,
      method: body.method,
      body: body.body,
      headers: body.headers,
      protocol: body.protocol,
      maxAmountBaseUnits: body.maxAmountBaseUnits ? BigInt(body.maxAmountBaseUnits) : undefined,
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 402);
  }
});

app.get('/v1/x402/spend', async (c) => {
  await requireAuth(c.req.header('authorization'), c.req.query('token'));
  return c.json(payments.localSpend());
});

app.get('/v1/x402/mandate', async (c) => {
  await requireAuth(c.req.header('authorization'), c.req.query('token'));
  const jwt = payments.currentMandate();
  if (!jwt) return c.json({ present: false });
  // Decode without verification — we only need the claims for display.
  try {
    const [, payload] = jwt.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      exp: number;
      maxAmount: string;
      resource: string;
    };
    return c.json({
      present: true,
      exp: claims.exp,
      maxAmount: claims.maxAmount,
      resource: claims.resource,
    });
  } catch {
    return c.json({ present: true });
  }
});

app.post('/v1/telegram/approve', async (c) => {
  await requireAuth(c.req.header('authorization'), c.req.query('token'), { scope: 'orchestrator' });
  const body = await c.req.json<{ code: string; privySub: string; agent?: string }>();
  const telegram = (globalThis as { __clawdTelegram?: {
    approve: (code: string, privySub: string, agent?: string) => { uid: number; agent: string };
  } }).__clawdTelegram;
  if (!telegram) return c.json({ error: 'telegram_channel_not_attached' }, 503);
  try {
    const result = telegram.approve(body.code, body.privySub, body.agent);
    return c.json({ ok: true, ...result });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

const server = serve(
  { fetch: app.fetch, port: PORT, hostname: '0.0.0.0' },
  (info) => log.info({ port: info.port }, 'gateway listening'),
);

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const authHeader = req.headers.authorization;
    const sub = await requireAuth(authHeader, token ?? undefined);
    wss.handleUpgrade(req, socket, head, (ws) => handleWS(ws, sub, url));
  } catch (err) {
    log.warn({ err: String(err) }, 'ws auth rejected');
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  }
});

function handleWS(ws: WebSocket, sub: PrivySubject, url: URL) {
  const sessionId = url.searchParams.get('session');
  const session = sessionId ? AgentSession.get(sessionId) : null;
  if (!session || session.owner !== sub.sub) {
    ws.close(1008, 'session_not_found');
    return;
  }
  const unsub = session.subscribe((event) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  });
  ws.on('message', async (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; content?: string };
      if (msg.type === 'message' && msg.content) await session.send(msg.content);
      if (msg.type === 'interrupt') session.interrupt();
    } catch (err) {
      log.warn({ err: String(err) }, 'bad ws frame');
    }
  });
  ws.on('close', () => unsub());
}

if (process.env.TELEGRAM_BOT_TOKEN) {
  attachTelegram({
    token: process.env.TELEGRAM_BOT_TOKEN,
    vault,
    payments, // NEW: telegram channel gets payments for /balance, /pay commands
    allowChatIds: (process.env.TELEGRAM_ALLOW_CHAT_IDS ?? '-1003338091119')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  });
  log.info('telegram channel attached');
}

async function requireAuth(
  authorization: string | undefined,
  queryToken?: string,
  opts: { scope?: 'user' | 'orchestrator' } = {},
): Promise<PrivySubject> {
  const authHeader = authorization ?? '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : queryToken;

  if ((AUTH_MODE === 'token' || AUTH_MODE === 'both') && bearer && bearer === BEARER) {
    return { sub: 'local:token', wallet: null, scopes: ['*'] };
  }

  if (AUTH_MODE === 'privy' || AUTH_MODE === 'both') {
    if (!bearer) throw new Error('missing_token');
    return await verifyPrivyToken(bearer, opts);
  }

  throw new Error('unauthorized');
}

process.on('SIGTERM', async () => {
  log.info('SIGTERM — flushing vault');
  await vault.flushAll();
  process.exit(0);
});
