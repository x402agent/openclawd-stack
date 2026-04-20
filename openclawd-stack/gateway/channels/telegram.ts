// Runs inside the sandbox. Long-polls the Telegram Bot API and routes messages
// into agent sessions. Mirrors the openclawd channel contract so you can keep
// the `openclawd pairing approve` UX.
//
// Payment commands:
//   /spend                   — show spend vs mandate
//   /mandate                 — show active mandate expiry + cap
//   /pay <url>               — trigger a paid fetch from chat
//   /pay-agent <privy-sub>   — convenience: pay a user's ClawdRouter agent
//   /earnings                — stubbed, surfaces that this queries the gateway

import type { ClawdVault } from '../memory/clawdvault.js';
import { agentRegistry, AgentSession } from '../agents/registry.js';
import type { SandboxPayments } from '../payments.js';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
  };
}

interface AttachArgs {
  token: string;
  vault: ClawdVault;
  payments: SandboxPayments;
  allowChatIds: string[];
  defaultAgent?: string;
}

interface PairingRecord {
  privySub: string;
  agent: string;
  sessionId: string;
}

const pairings = new Map<number, PairingRecord>();
const pendingCodes = new Map<string, number>();

export function attachTelegram({
  token,
  vault,
  payments,
  allowChatIds,
  defaultAgent = 'vibe-coder',
}: AttachArgs) {
  const api = (method: string, body?: unknown) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then((r) => r.json() as Promise<{ ok: boolean; result?: unknown }>);

  const allow = new Set(allowChatIds.map((x) => String(x)));

  let offset = 0;
  const loop = async () => {
    while (true) {
      try {
        const res = (await api('getUpdates', { offset, timeout: 25 })) as {
          ok: boolean;
          result: TelegramUpdate[];
        };
        for (const u of res.result ?? []) {
          offset = u.update_id + 1;
          await handleUpdate(u);
        }
      } catch (err) {
        console.error('[telegram] poll error', err);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };

  const handleUpdate = async (u: TelegramUpdate) => {
    const msg = u.message;
    if (!msg?.text) return;
    const chatId = String(msg.chat.id);
    const tgUserId = msg.from?.id;

    if (!allow.has(chatId)) {
      await api('sendMessage', {
        chat_id: msg.chat.id,
        text: `Clawd: this chat is not on the allowlist.\nChat id: ${chatId}`,
      });
      return;
    }

    if (!tgUserId) return;

    const paired = pairings.get(tgUserId);
    const text = msg.text.trim();

    /* ——— payment commands — always available, no pairing needed ——— */

    if (text === '/spend') {
      const spend = payments.localSpend();
      await api('sendMessage', {
        chat_id: msg.chat.id,
        text: `Clawd: spent ${fmtUsdc(spend.spent)} ${spend.asset} this mandate.`,
      });
      return;
    }

    if (text === '/mandate') {
      const jwt = payments.currentMandate();
      if (!jwt) {
        await api('sendMessage', {
          chat_id: msg.chat.id,
          text: 'Clawd: no active payment mandate. Re-launch with monetize=true to mint one.',
        });
        return;
      }
      try {
        const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()) as {
          exp: number;
          maxAmount: string;
          resource: string;
        };
        const remaining = payload.exp * 1000 - Date.now();
        await api('sendMessage', {
          chat_id: msg.chat.id,
          text:
            `Clawd mandate\n` +
            `cap: ${fmtUsdc(payload.maxAmount)} USDC\n` +
            `resource: ${payload.resource}\n` +
            `expires in: ${Math.max(0, Math.round(remaining / 60000))} min`,
        });
      } catch {
        await api('sendMessage', {
          chat_id: msg.chat.id,
          text: 'Clawd: mandate present but unreadable.',
        });
      }
      return;
    }

    if (text.startsWith('/pay ')) {
      const url = text.slice('/pay '.length).trim();
      try {
        const res = await payments.pay({ url });
        await api('sendMessage', {
          chat_id: msg.chat.id,
          text:
            `Paid ${fmtUsdc(res.amountPaid ?? '0')} ${res.asset ?? 'USDC'} → HTTP ${res.status}\n` +
            (res.signature ? `sig: ${res.signature.slice(0, 16)}…\n` : '') +
            (res.receiptCid ? `receipt: ipfs://${res.receiptCid}\n` : '') +
            `\n${res.body.slice(0, 400)}`,
        });
      } catch (err) {
        await api('sendMessage', {
          chat_id: msg.chat.id,
          text: `Clawd: payment failed — ${(err as Error).message}`,
        });
      }
      return;
    }

    if (text.startsWith('/pay-agent ')) {
      const sub = text.slice('/pay-agent '.length).trim();
      const url = payments.agentUrlForPrivySub(sub);
      try {
        const res = await payments.pay({ url, method: 'POST' });
        await api('sendMessage', {
          chat_id: msg.chat.id,
          text: `Called agent ${sub.slice(0, 10)} → ${res.status}\n${res.body.slice(0, 400)}`,
        });
      } catch (err) {
        await api('sendMessage', {
          chat_id: msg.chat.id,
          text: `Clawd: ${(err as Error).message}`,
        });
      }
      return;
    }

    /* ——— pairing + default agent chat path ——— */

    if (text.startsWith('/pair ')) {
      const code = text.slice('/pair '.length).trim().toUpperCase();
      const uid = pendingCodes.get(code);
      if (!uid) {
        await api('sendMessage', {
          chat_id: msg.chat.id,
          text: `Clawd: unknown pair code ${code}. Ask the operator to approve.`,
        });
      }
      return;
    }

    if (!paired) {
      const code = Math.random().toString(36).slice(2, 10).toUpperCase();
      pendingCodes.set(code, tgUserId);
      await api('sendMessage', {
        chat_id: msg.chat.id,
        text:
          `Clawd: access not configured.\n\n` +
          `Telegram user id: ${tgUserId}\n` +
          `Pairing code: ${code}\n\n` +
          `Ask the bot owner to approve with:\n` +
          `  solana-clawd pairing approve --channel telegram ${code}`,
      });
      return;
    }

    let session = AgentSession.get(paired.sessionId);
    if (!session) {
      const handler = agentRegistry.get(paired.agent) ?? agentRegistry.get(defaultAgent);
      if (!handler) return;
      session = await handler.createSession({
        privySub: paired.privySub,
        wallet: null,
        vault,
        payments,
      });
      paired.sessionId = session.id;
    }
    const reply = await session.send(text);
    await api('sendMessage', { chat_id: msg.chat.id, text: reply || '(no reply)' });
  };

  // Exposed so the orchestrator / CLI can approve pending pairings remotely.
  (globalThis as { __clawdTelegram?: unknown }).__clawdTelegram = {
    listPending: () =>
      Array.from(pendingCodes.entries()).map(([code, uid]) => ({ code, uid })),
    approve: (code: string, privySub: string, agent = defaultAgent) => {
      const uid = pendingCodes.get(code);
      if (!uid) throw new Error('unknown_pair_code');
      pendingCodes.delete(code);
      pairings.set(uid, { privySub, agent, sessionId: '' });
      return { uid, agent };
    },
  };

  loop().catch((err) => console.error('[telegram] fatal', err));
}

function fmtUsdc(baseUnits: string): string {
  try {
    const n = BigInt(baseUnits);
    const whole = n / 1_000_000n;
    const frac = n % 1_000_000n;
    return `${whole}.${frac.toString().padStart(6, '0').slice(0, 2)}`;
  } catch {
    return baseUnits;
  }
}
