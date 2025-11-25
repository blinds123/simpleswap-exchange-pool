# Claude Code Context - SimpleSwap Exchange Pool

This file provides immediate context for AI assistants working on this project.

## REQUIRED: Price Points Configuration

**IMPORTANT:** Before deploying, you MUST ask the user for their price points if not specified.

**Ask the user:**
> "What USD price points do you need exchange pools for? Each price point will have 5 pre-created exchanges ready for instant delivery. Example: 25,35,50 for $25, $35, and $50 pools."

Then configure `PRICE_POINTS` in the `.env` file accordingly.

## What This System Does

Pre-creates cryptocurrency exchanges on simpleswap.io and serves them instantly via a pool server. Uses BrightData Scraping Browser to bypass Cloudflare protection.

**Scope:** Exchange creation only. No email verification or OTP handling required.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Frontend      │────▶│   Pool Server   │────▶│   SimpleSwap    │
│   (Netlify)     │     │   (Render)      │     │   (via BrightData)
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Multi-Pool Design:**
- Each configured price point has its own pool
- Each pool maintains 5 exchanges (configurable)
- Automatic replenishment when pool falls below minimum

## Configuration

### Environment Variables (.env)

```bash
# REQUIRED - BrightData credentials
BRIGHTDATA_CUSTOMER_ID=hl_9d12e57c
BRIGHTDATA_ZONE=scraping_browser1
BRIGHTDATA_PASSWORD=your_password_here

# REQUIRED - Merchant wallet
MERCHANT_WALLET=0x1372Ad41B513b9d6eC008086C03d69C635bAE578

# REQUIRED - Price points (comma-separated USD amounts)
PRICE_POINTS=25,35,50

# Optional - Pool configuration
POOL_SIZE_PER_PRICE=5
MIN_POOL_SIZE=3
ALLOWED_ORIGINS=https://your-site.netlify.app,http://localhost:3000
PORT=3000
```

## Quick Commands

```bash
# Check pool status
curl https://your-server.onrender.com/stats

# Get exchange from specific pool
curl -X POST https://your-server.onrender.com/buy-now \
  -H "Content-Type: application/json" \
  -d '{"amountUSD": 25}'

# Initialize all pools
curl -X POST https://your-server.onrender.com/admin/init-pool

# Initialize specific price point pool
curl -X POST https://your-server.onrender.com/admin/init-pool \
  -H "Content-Type: application/json" \
  -d '{"pricePoint": 35}'

# Add single exchange to pool
curl -X POST https://your-server.onrender.com/admin/add-one \
  -H "Content-Type: application/json" \
  -d '{"pricePoint": 25}'

# Fill specific pool sequentially
curl -X POST https://your-server.onrender.com/admin/fill-sequential \
  -H "Content-Type: application/json" \
  -d '{"pricePoint": 50}'
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Server status, all pools info |
| `/health` | GET | Health check |
| `/stats` | GET | Detailed pool statistics |
| `/buy-now` | POST | Get exchange from pool (requires `amountUSD`) |
| `/admin/add-one` | POST | Add single exchange (optional `pricePoint`) |
| `/admin/init-pool` | POST | Initialize pools (optional `pricePoint`) |
| `/admin/fill-sequential` | POST | Fill pool one-by-one (optional `pricePoint`) |

## Key Files

| File | Purpose |
|------|---------|
| `pool-server.js` | Main Express server (multi-pool support) |
| `package.json` | Dependencies |
| `.env.example` | Environment variables template |

## Credentials Reference

### BrightData Scraping Browser
- Customer ID: `hl_9d12e57c`
- Zone: `scraping_browser1`
- Password: Set in Render env vars
- CDP Endpoint: `wss://brd-customer-hl_9d12e57c-zone-scraping_browser1:{PASSWORD}@brd.superproxy.io:9222`

### Merchant Wallet (Polygon)
- Address: `0x1372Ad41B513b9d6eC008086C03d69C635bAE578`

## Technical Details

### Exchange Creation Flow
1. Connect to BrightData CDP endpoint
2. Navigate to SimpleSwap with amount preset
3. Fill merchant wallet address
4. Wait for quote calculation
5. Click "Create Exchange" button
6. Capture exchange ID from redirect URL

### Memory-First Architecture
- All pools stored in memory for <50ms response time
- Periodic disk sync every 5 seconds
- Atomic writes prevent corruption
- Per-pool replenishment locks prevent race conditions

## Deployment Checklist

1. [ ] Clone repository
2. [ ] Copy `.env.example` to `.env`
3. [ ] **ASK USER FOR PRICE POINTS** and set `PRICE_POINTS`
4. [ ] Set BrightData password
5. [ ] Set merchant wallet address
6. [ ] Configure CORS origins for your frontend
7. [ ] Run `npm install`
8. [ ] Run `npx playwright install chromium`
9. [ ] Deploy to Render
10. [ ] Initialize pools via `/admin/init-pool`

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Exchange creation fails | Check BrightData password, increase timeouts |
| Button stays disabled | Wait for quote calculation (30s timeout) |
| Pool empty | Run `/admin/init-pool` or `/admin/add-one` |
| Invalid amount error | Check PRICE_POINTS env var configuration |
| Slow response | Check if pool is being replenished |

## Dependencies

```json
{
  "cors": "^2.8.5",
  "dotenv": "^16.3.1",
  "express": "^4.18.2",
  "playwright": "^1.40.0"
}
```
