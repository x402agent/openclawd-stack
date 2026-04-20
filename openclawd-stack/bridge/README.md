# Cloud Clawd Bridge

> WebSocket bridge server connecting browser terminals to E2B sandboxes

## Quick Start

### 1. Clone and Install

```bash
cd bridge
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env and add your E2B API key
```

### 3. Run Locally

```bash
npm run dev
```

### 4. Deploy

Choose your preferred platform:

#### Vercel (Recommended)

```bash
# Set environment variable
vercel env add E2B_API_KEY

# Deploy
vercel --prod
```

#### Railway

```bash
# Connect repo to Railway
railway init
railway up
railway variables set E2B_API_KEY=your_key
```

#### Fly.io

```bash
fly launch
fly secrets set E2B_API_KEY=your_key
fly deploy
```

#### Docker

```bash
docker build -t cloud-clawd-bridge .
docker run -p 8080:8080 -e E2B_API_KEY=your_key cloud-clawd-bridge
```

## API Endpoints

### Create Sandbox

```bash
curl https://your-bridge.com/create?userId=user-123
```

Response:
```json
{
  "sandboxId": "abc123xyz",
  "wsUrl": "/terminal/abc123xyz",
  "expiresAt": "2024-01-01T12:00:00Z"
}
```

### Connect Terminal

```
wss://your-bridge.com/terminal/abc123xyz
```

Send commands as text, receive output as text.

### Health Check

```bash
curl https://your-bridge.com/health
```

Response:
```json
{
  "status": "ok",
  "connections": 5,
  "uptime": 3600
}
```

## Architecture

```
┌─────────────┐     WebSocket      ┌─────────────┐     E2B API      ┌─────────────┐
│   Browser   │ ←────────────────→ │   Bridge    │ ←───────────────→ │    E2B     │
│  Terminal   │                    │   Server    │                   │  Sandboxes  │
└─────────────┘                    └─────────────┘                   └─────────────┘
                                            ↑
                                     REST API
                                     /create
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `E2B_API_KEY` | Yes | - | E2B API key |
| `SANDBOX_TIMEOUT` | No | 3600 | Sandbox timeout (seconds) |
| `PORT` | No | 8080 | Server port |

## Security

- Sandbox isolation via E2B
- API key never exposed to client
- Rate limiting recommended (add nginx/cloudflare)
- WebSocket connections authenticated via token

## Monitoring

```bash
# List active sandboxes
curl https://your-bridge.com/admin/sandboxes
```

## Pricing

| Platform | Free Tier | Notes |
|----------|-----------|-------|
| Vercel | 100GB bandwidth | Perfect for dev |
| Railway | $5/month minimum | Easy deployment |
| Fly.io | $1.67/month | Pay-as-you-go |
| Docker | Self-hosted | Full control |

## License

MIT
