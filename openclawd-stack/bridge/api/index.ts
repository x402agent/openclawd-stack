/**
 * E2B Sandbox Creator API
 * 
 * Vercel Serverless Function for creating E2B sandboxes
 */

import { Sandbox } from 'e2b';

const E2B_API_KEY = process.env.E2B_API_KEY;

export default async function handler(req: any, res: any) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!E2B_API_KEY) {
    return res.status(500).json({ error: 'E2B_API_KEY not configured' });
  }

  try {
    const userId = req.body?.userId || `anon-${Date.now()}`;

    console.log(`[API] Creating sandbox for user: ${userId}`);

    // Create sandbox
    const sandbox = await Sandbox.create({
      template: 'ubuntu',
      metadata: {
        userId: userId,
        createdBy: 'cloud-clawd-bridge',
      },
    } as any, {
      apiKey: E2B_API_KEY,
    });

    const expiresAt = new Date(Date.now() + 3600000).toISOString();

    console.log(`[API] Sandbox created: ${sandbox.sandboxId}`);

    // Return connection info
    return res.status(200).json({
      sandboxId: sandbox.sandboxId,
      wsUrl: `wss://sockets.e2b.dev/${sandbox.sandboxId}`,
      apiUrl: `https://api.e2b.dev/v1/sandboxes/${sandbox.sandboxId}`,
      expiresAt,
      message: 'Sandbox created! Use the wsUrl to connect your terminal.',
    });

  } catch (error: any) {
    console.error('[API] Error creating sandbox:', error);
    return res.status(500).json({ 
      error: error.message || 'Failed to create sandbox' 
    });
  }
}
