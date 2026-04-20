// Orchestrator entry point. Standalone Hono server that fronts the OpenClawd
// lifecycle — mount the /api/v1 routes from routes.ts and serve.

import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { app as apiRoutes } from './routes.js';

const PORT = Number(process.env.ORCHESTRATOR_PORT ?? 8787);

const root = new Hono();
root.get('/healthz', (c) => c.json({ ok: true, ts: Date.now() }));
root.route('/api', apiRoutes);

serve({ fetch: root.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`[orchestrator] listening on :${info.port}`);
});
