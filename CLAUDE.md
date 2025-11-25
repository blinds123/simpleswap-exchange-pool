# Claude Code Context - SimpleSwap Exchange Pool

This file provides immediate context for AI assistants working on this project.

## What This System Does

Pre-creates cryptocurrency exchanges on simpleswap.io and serves them instantly to customers via a pool server on Render. Uses BrightData Scraping Browser to bypass Cloudflare.

## Live Endpoints

```
Pool Server: https://sparkle-hoodie-pool.onrender.com
Frontend: https://sparkle-hoodie-shop.netlify.app
```

## Quick Commands

```bash
# Check pool status
curl https://sparkle-hoodie-pool.onrender.com/stats | jq '.pools["25"].size'

# Create new exchange
curl -X POST https://sparkle-hoodie-pool.onrender.com/admin/add-one

# Get exchange (removes from pool)
curl -X POST https://sparkle-hoodie-pool.onrender.com/buy-now -H "Content-Type: application/json" -d '{"amountUSD": 25}'

# Full pool reset
curl -X POST https://sparkle-hoodie-pool.onrender.com/admin/init-pool
```

## All Credentials

### BrightData Scraping Browser
- Customer ID: `hl_9d12e57c`
- Zone: `scraping_browser1`
- Password: Set in Render env vars
- CDP: `wss://brd-customer-hl_9d12e57c-zone-scraping_browser1:{PASSWORD}@brd.superproxy.io:9222`

### Mailosaur (Email OTP)
- API Key: `qgh1F7IUmlm4TCb5eGpSZa5P0ZkCxgnH`
- Server ID: `zgk5fexu`
- Email format: `{anything}@zgk5fexu.mailosaur.net`
- OTP is in subject: "Your verification code is XXXXX" (5 digits)

### Merchant Wallet
- Polygon: `0x1372Ad41B513b9d6eC008086C03d69C635bAE578`

## Key Files

| File | Purpose |
|------|---------|
| `pool-server.js` | Main Express server with all endpoints |
| `mailosaur-otp.js` | Reusable module for email OTP |
| `package.json` | Dependencies |
| `.env.example` | Environment variables template |

## Critical Technical Knowledge

### React Input Handling (Mercuryo Widget)
Standard Playwright `.fill()` doesn't work. Use:
```javascript
await input.click();
await page.keyboard.press('Meta+a');
await input.type(value, { delay: 30 });
await page.keyboard.press('Tab'); // Triggers validation
```

### Exchange Creation via BrightData
```javascript
const CDP_ENDPOINT = `wss://brd-customer-${CUSTOMER_ID}-zone-${ZONE}:${PASSWORD}@brd.superproxy.io:9222`;
const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
```

### Mailosaur OTP Extraction
```javascript
import Mailosaur from 'mailosaur';
const client = new Mailosaur('qgh1F7IUmlm4TCb5eGpSZa5P0ZkCxgnH');

const message = await client.messages.get('zgk5fexu', {
    sentTo: email
}, {
    timeout: 120000,
    receivedAfter: new Date(Date.now() - 5000)
});

// OTP in subject line
const otp = message.subject.match(/code\s+is\s+(\d{5})/i)?.[1];
```

## Common Tasks

### Add Exchange to Pool
```bash
curl -X POST https://sparkle-hoodie-pool.onrender.com/admin/add-one
```

### Replace Used Exchange
```bash
# Consume one
curl -X POST https://sparkle-hoodie-pool.onrender.com/buy-now -H "Content-Type: application/json" -d '{"amountUSD": 25}'
# Add new one
curl -X POST https://sparkle-hoodie-pool.onrender.com/admin/add-one
```

### View All Exchange URLs
```bash
curl https://sparkle-hoodie-pool.onrender.com/stats | jq '.pools["25"].exchanges[].exchangeUrl'
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Exchange creation fails | Check BrightData password, increase timeouts |
| OTP not received | Check Mailosaur credentials, verify email format |
| Button stays disabled | Use Tab after input to trigger React validation |
| Pool empty | Run `/admin/init-pool` or `/admin/add-one` |

## Dependencies

```json
{
  "cors": "^2.8.5",
  "dotenv": "^16.3.1",
  "express": "^4.18.2",
  "mailosaur": "^9.0.0",
  "playwright": "^1.40.0"
}
```
