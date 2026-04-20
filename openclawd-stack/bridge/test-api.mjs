import { Sandbox } from 'e2b';

const E2B_API_KEY = process.env.E2B_API_KEY;

async function handler(req, res) {
  console.log('Request received:', req.method);
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!E2B_API_KEY) {
    console.log('E2B_API_KEY not found!');
    return res.status(500).json({ error: 'E2B_API_KEY not configured' });
  }

  try {
    const userId = req.body?.userId || `anon-${Date.now()}`;
    console.log(`Creating sandbox for: ${userId}`);

    const sandbox = await Sandbox.create({
      template: 'ubuntu',
      metadata: {
        userId: userId,
        createdBy: 'cloud-clawd-bridge',
      },
    });

    console.log(`Sandbox created: ${sandbox.sandboxId}`);

    return res.status(200).json({
      sandboxId: sandbox.sandboxId,
      wsUrl: `wss://sockets.e2b.dev/${sandbox.sandboxId}`,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      message: 'Sandbox created!',
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ 
      error: error.message || 'Failed to create sandbox' 
    });
  }
}

// Test locally
handler({ method: 'POST', body: { userId: 'local-test' } }, {
  status: (code) => ({
    json: (data) => console.log(code, JSON.stringify(data, null, 2))
  })
});
