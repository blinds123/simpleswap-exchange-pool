# SimpleSwap Exchange Pool System

Pre-warmed cryptocurrency exchange pool for instant customer checkout.

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/YOUR_USERNAME/simpleswap-pool.git
cd simpleswap-pool
npm install

# 2. Set environment variables (copy .env.example to .env)
cp .env.example .env
# Edit .env with your credentials

# 3. Start server locally
npm start

# 4. Initialize pool
curl -X POST http://localhost:3000/admin/init-pool
```

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Netlify Site   │────▶│  Render Server   │────▶│   SimpleSwap    │
│  (Product Page) │     │  (Pool Server)   │     │   (Exchanges)   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │    BrightData    │
                        │ Scraping Browser │
                        └──────────────────┘
```

## Core Components

| Component | Purpose | File |
|-----------|---------|------|
| Pool Server | Express API serving exchanges | `pool-server.js` |
| Mailosaur OTP | Email verification for Mercuryo | `mailosaur-otp.js` |
| BrightData | Cloudflare bypass via CDP | Built into pool-server |

## Credentials

### BrightData Scraping Browser
```
Customer ID: hl_9d12e57c
Zone: scraping_browser1
Password: [SET IN ENV]
CDP Endpoint: wss://brd-customer-hl_9d12e57c-zone-scraping_browser1:{PASSWORD}@brd.superproxy.io:9222
```

### Mailosaur (Email OTP)
```
API Key: qgh1F7IUmlm4TCb5eGpSZa5P0ZkCxgnH
Server ID: zgk5fexu
Email Format: {anything}@zgk5fexu.mailosaur.net
```

### Merchant Wallet (Polygon)
```
Address: 0x1372Ad41B513b9d6eC008086C03d69C635bAE578
```

### Render Deployment
```
URL: https://sparkle-hoodie-pool.onrender.com
```

## API Endpoints

### Public
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Server status |
| GET | `/stats` | Pool details with exchange URLs |
| GET | `/health/pools` | Pool health check |
| POST | `/buy-now` | Get exchange from pool |

### Admin
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/admin/init-pool` | Initialize pool (5 exchanges) |
| POST | `/admin/add-one` | Add single exchange |
| POST | `/admin/fill-sequential` | Fill pool sequentially |

## Common Operations

```bash
# Check pool status
curl https://sparkle-hoodie-pool.onrender.com/stats | jq '.pools["25"].exchanges[].exchangeUrl'

# Get exchange for customer (removes from pool)
curl -X POST https://sparkle-hoodie-pool.onrender.com/buy-now \
  -H "Content-Type: application/json" \
  -d '{"amountUSD": 25}'

# Add one new exchange
curl -X POST https://sparkle-hoodie-pool.onrender.com/admin/add-one

# Initialize fresh pool (clears and creates 5 new)
curl -X POST https://sparkle-hoodie-pool.onrender.com/admin/init-pool
```

## Technical Details

### Exchange Creation Flow
1. Connect to BrightData CDP (bypasses Cloudflare)
2. Navigate to: `https://simpleswap.io/exchange?from=usd-usd&to=pol-matic&rate=floating&amount=25`
3. Fill wallet using `getByRole('textbox', {name: /address/i})`
4. Wait for "Create Exchange" button to be enabled
5. Click and wait for redirect to `/exchange?id={exchangeId}`

### Mercuryo OTP Verification Flow
1. Navigate to exchange URL
2. Wait for Mercuryo iframe
3. Select "Credit or debit card"
4. Enter Mailosaur email
5. Fetch OTP from Mailosaur API (in email subject)
6. Enter 5-digit OTP

### React Input Handling
Mercuryo uses React - standard `.fill()` doesn't work:
```javascript
// Correct approach:
await input.click();
await page.keyboard.press('Meta+a');
await input.type(value, { delay: 30 });
await page.keyboard.press('Tab');
```

### Mailosaur OTP Extraction
```javascript
// OTP is in subject: "Your verification code is 12345"
const subjectMatch = message.subject.match(/code\s+is\s+(\d{5})/i);
```

## Environment Variables

```bash
# BrightData
BRIGHTDATA_CUSTOMER_ID=hl_9d12e57c
BRIGHTDATA_ZONE=scraping_browser1
BRIGHTDATA_PASSWORD=your_password

# Merchant
MERCHANT_WALLET=0x1372Ad41B513b9d6eC008086C03d69C635bAE578

# Pool
POOL_SIZE=5
MIN_POOL_SIZE=3
PORT=3000
```

## Deployment

### Render
1. Create new Web Service
2. Connect GitHub repo
3. Set environment variables
4. Deploy

### Required Render Environment Variables
- `BRIGHTDATA_CUSTOMER_ID`
- `BRIGHTDATA_ZONE`
- `BRIGHTDATA_PASSWORD`
- `MERCHANT_WALLET`
- `POOL_SIZE`
- `MIN_POOL_SIZE`

## Troubleshooting

### Exchange creation fails
- Check BrightData credentials
- Increase timeouts for Render's slow CPU
- Check SimpleSwap isn't rate-limiting

### OTP not received
- Verify Mailosaur credentials
- Check email wasn't sent to wrong address
- Mercuryo may rate-limit rapid requests

### Button stays disabled
- React validation needs Tab/blur after input
- Wait for `waitForFunction` to confirm enabled state
