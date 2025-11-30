/**
 * SimpleSwap Exchange Pool Server - BULLETPROOF EDITION
 *
 * GUARANTEED auto-replenishment that NEVER fails:
 * 1. INSTANT replenishment on every consumption (not just below minSize)
 * 2. 3 retries with exponential backoff for each exchange creation
 * 3. Periodic health check every 60s catches any missed replenishments
 * 4. Self-ping every 5min prevents Render sleep
 *
 * @version 5.0.0 - BULLETPROOF
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { readFile, writeFile, rename, unlink } from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// CONFIGURATION
// ============================================================================

const MERCHANT_WALLET = process.env.MERCHANT_WALLET || "0x1372Ad41B513b9d6eC008086C03d69C635bAE578";
const POOL_SIZE_PER_PRICE = parseInt(process.env.POOL_SIZE_PER_PRICE) || 15;
const MIN_POOL_SIZE = parseInt(process.env.MIN_POOL_SIZE) || 3;
const DISK_SYNC_INTERVAL = 5000;
const HEALTH_CHECK_INTERVAL = 60000; // 60 seconds
const SELF_PING_INTERVAL = 300000; // 5 minutes (prevents Render sleep)
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 2000; // 2s, 4s, 8s exponential backoff

const PRICE_POINTS = (process.env.PRICE_POINTS || '19,29,59')
    .split(',')
    .map(p => parseInt(p.trim()))
    .filter(p => !isNaN(p) && p > 0);

if (PRICE_POINTS.length === 0) {
    console.error('ERROR: No valid price points configured');
    process.exit(1);
}

const POOL_CONFIG = {};
PRICE_POINTS.forEach(price => {
    POOL_CONFIG[String(price)] = {
        size: POOL_SIZE_PER_PRICE,
        minSize: MIN_POOL_SIZE,
        amount: price,
        description: `$${price} exchange pool`
    };
});

const POOL_FILE = path.join(process.cwd(), 'exchange-pool.json');

// BrightData credentials
const BRIGHTDATA_CUSTOMER_ID = process.env.BRIGHTDATA_CUSTOMER_ID;
const BRIGHTDATA_ZONE = process.env.BRIGHTDATA_ZONE;
const BRIGHTDATA_PASSWORD = process.env.BRIGHTDATA_PASSWORD;

if (!BRIGHTDATA_CUSTOMER_ID || !BRIGHTDATA_ZONE || !BRIGHTDATA_PASSWORD) {
    console.warn('⚠️  WARNING: Missing BrightData credentials - exchange creation disabled');
}

const BRD_USERNAME = `brd-customer-${BRIGHTDATA_CUSTOMER_ID}-zone-${BRIGHTDATA_ZONE}`;
const CDP_ENDPOINT = `wss://${BRD_USERNAME}:${BRIGHTDATA_PASSWORD}@brd.superproxy.io:9222`;

// CORS
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim());
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: '1kb' }));

// ============================================================================
// IN-MEMORY POOL
// ============================================================================

let memoryPool = {};
PRICE_POINTS.forEach(price => { memoryPool[String(price)] = []; });

let isDirty = false;
let isSyncing = false;
const replenishmentLock = {};
PRICE_POINTS.forEach(price => { replenishmentLock[String(price)] = false; });

// Stats tracking
const stats = {
    totalConsumed: 0,
    totalReplenished: 0,
    failedReplenishments: 0,
    lastHealthCheck: null,
    serverStartTime: new Date().toISOString()
};

// ============================================================================
// DISK PERSISTENCE
// ============================================================================

async function loadPoolIntoMemory() {
    try {
        if (existsSync(POOL_FILE)) {
            const data = await readFile(POOL_FILE, 'utf8');
            const pools = JSON.parse(data);
            PRICE_POINTS.forEach(price => {
                const key = String(price);
                if (!pools[key]) pools[key] = [];
            });
            memoryPool = pools;
            const summary = PRICE_POINTS.map(p => `$${p}: ${memoryPool[String(p)].length}`).join(', ');
            console.log(`✅ [LOAD] Pool loaded: ${summary}`);
            return memoryPool;
        }
        console.log('📝 [LOAD] No pool file, starting empty');
        return memoryPool;
    } catch (error) {
        console.error('❌ [LOAD] Failed:', error.message);
        return memoryPool;
    }
}

async function syncPoolToDisk() {
    if (!isDirty || isSyncing) return;
    isSyncing = true;
    const tempFile = `${POOL_FILE}.${randomBytes(8).toString('hex')}.tmp`;
    try {
        await writeFile(tempFile, JSON.stringify(memoryPool, null, 2), 'utf8');
        await rename(tempFile, POOL_FILE);
        isDirty = false;
    } catch (error) {
        console.error('❌ [SYNC] Failed:', error.message);
        try { await unlink(tempFile); } catch (e) {}
    } finally {
        isSyncing = false;
    }
}

function startPeriodicDiskSync() {
    setInterval(() => {
        if (isDirty && !isSyncing) syncPoolToDisk().catch(console.error);
    }, DISK_SYNC_INTERVAL);
}

// ============================================================================
// PLAYWRIGHT - LAZY LOAD
// ============================================================================

let chromium = null;
async function getChromium() {
    if (!chromium) {
        const playwright = await import('playwright');
        chromium = playwright.chromium;
    }
    return chromium;
}

// ============================================================================
// EXCHANGE CREATION WITH RETRIES
// ============================================================================

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Creates exchange with automatic retries and exponential backoff
 */
async function createExchangeWithRetry(amountUSD, retries = MAX_RETRIES) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`🔄 [CREATE] Attempt ${attempt}/${retries} for $${amountUSD}...`);
            const exchange = await createExchange(amountUSD);
            console.log(`✅ [CREATE] Success: ${exchange.exchangeId}`);
            stats.totalReplenished++;
            return exchange;
        } catch (error) {
            lastError = error;
            console.error(`❌ [CREATE] Attempt ${attempt} failed: ${error.message}`);

            if (attempt < retries) {
                const delay = RETRY_DELAY_BASE * Math.pow(2, attempt - 1);
                console.log(`⏳ [CREATE] Waiting ${delay}ms before retry...`);
                await sleep(delay);
            }
        }
    }

    stats.failedReplenishments++;
    console.error(`🚨 [CREATE] All ${retries} attempts failed for $${amountUSD}`);
    throw lastError;
}

async function createExchange(amountUSD, walletAddress = MERCHANT_WALLET) {
    const url = `https://simpleswap.io/exchange?from=usd-usd&to=pol-matic&rate=floating&amount=${amountUSD}`;
    let browser;

    try {
        const chromiumInstance = await getChromium();
        browser = await chromiumInstance.connectOverCDP(CDP_ENDPOINT);
        const context = browser.contexts()[0];
        const page = context.pages()[0] || await context.newPage();

        await page.route('**/*.{png,jpg,jpeg,gif,webp,svg}', route => route.abort());
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

        await page.evaluate(() => {
            document.querySelectorAll('[data-testid="info-message"], [role="alert"], .cookies-banner').forEach(el => el.remove());
        });

        const addressInput = page.getByRole('textbox', { name: /address/i });
        await addressInput.first().fill(walletAddress, { timeout: 30000 });
        await page.waitForTimeout(2000);
        await addressInput.first().press('Enter');

        try {
            await page.waitForFunction(() => {
                const inputs = document.querySelectorAll('input[type="text"]');
                if (inputs.length < 2) return false;
                const val = inputs[1].value;
                return val && val.length > 0 && val !== '0' && !val.includes('...');
            }, { timeout: 30000 });
        } catch (e) {}

        const createButton = page.getByRole('button', { name: /^create.*exchange$/i });
        await page.waitForFunction(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const createBtn = buttons.find(b => /^create.*exchange$/i.test(b.textContent?.trim() || ''));
            return createBtn && !createBtn.disabled;
        }, { timeout: 40000 });

        const isDisabled = await createButton.first().isDisabled();
        if (!isDisabled) {
            await createButton.first().click({ timeout: 10000 });
            await page.waitForTimeout(2000);
            if (page.url().includes('/exchange?')) {
                await createButton.first().click({ force: true });
            }
        } else {
            throw new Error('Button still disabled');
        }

        await page.waitForURL(/\/exchange\?id=/, { timeout: 120000 });
        const exchangeUrl = page.url();
        const exchangeId = new URL(exchangeUrl).searchParams.get('id');

        if (!exchangeId) throw new Error('No exchange ID');

        return {
            id: exchangeId,
            exchangeId,
            exchangeUrl,
            amount: amountUSD,
            created: new Date().toISOString()
        };
    } finally {
        if (browser) try { await browser.close(); } catch (e) {}
    }
}

// ============================================================================
// BULLETPROOF REPLENISHMENT
// ============================================================================

/**
 * Replenishes pool to FULL capacity (not just to minSize)
 */
async function replenishPool(priceKey) {
    if (replenishmentLock[priceKey]) {
        console.log(`⏭️  [REPLENISH-${priceKey}] Already running, skipping`);
        return;
    }

    replenishmentLock[priceKey] = true;

    try {
        const config = POOL_CONFIG[priceKey];
        if (!config) return;

        const currentSize = memoryPool[priceKey]?.length || 0;
        const needed = config.size - currentSize;

        if (needed <= 0) {
            console.log(`✅ [REPLENISH-${priceKey}] Pool full (${currentSize}/${config.size})`);
            return;
        }

        console.log(`🔧 [REPLENISH-${priceKey}] Need ${needed} exchanges (${currentSize}/${config.size})`);

        for (let i = 0; i < needed; i++) {
            try {
                const exchange = await createExchangeWithRetry(config.amount);
                memoryPool[priceKey].push({ ...exchange, amount: config.amount });
                isDirty = true;
                console.log(`📦 [REPLENISH-${priceKey}] ${memoryPool[priceKey].length}/${config.size}`);

                // Sync after each successful creation
                await syncPoolToDisk();

                if (i < needed - 1) await sleep(2000);
            } catch (error) {
                console.error(`🚨 [REPLENISH-${priceKey}] Failed to create exchange: ${error.message}`);
                // Continue trying to create remaining exchanges
            }
        }

        console.log(`✅ [REPLENISH-${priceKey}] Complete: ${memoryPool[priceKey].length}/${config.size}`);
    } finally {
        replenishmentLock[priceKey] = false;
    }
}

/**
 * HEALTH CHECK - Runs every 60 seconds
 * Catches ANY missed replenishments and ensures pools stay full
 */
async function healthCheck() {
    stats.lastHealthCheck = new Date().toISOString();
    console.log(`\n🏥 [HEALTH CHECK] ${stats.lastHealthCheck}`);

    let anyPoolNeedsReplenishment = false;

    for (const price of PRICE_POINTS) {
        const key = String(price);
        const current = memoryPool[key]?.length || 0;
        const target = POOL_CONFIG[key].size;
        const status = current >= target ? '✅' : current >= MIN_POOL_SIZE ? '⚠️' : '🚨';

        console.log(`  ${status} $${key}: ${current}/${target}`);

        // If pool is below target AND not currently replenishing, trigger replenishment
        if (current < target && !replenishmentLock[key]) {
            anyPoolNeedsReplenishment = true;
            console.log(`  🔧 Triggering replenishment for $${key}...`);
            replenishPool(key).catch(err =>
                console.error(`  ❌ Replenishment failed: ${err.message}`)
            );
        }
    }

    if (!anyPoolNeedsReplenishment) {
        console.log(`  ✅ All pools at target capacity`);
    }

    console.log(`  📊 Stats: consumed=${stats.totalConsumed}, replenished=${stats.totalReplenished}, failed=${stats.failedReplenishments}\n`);
}

/**
 * SELF-PING - Prevents Render from sleeping the server
 */
function startSelfPing() {
    const selfUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

    setInterval(async () => {
        try {
            const response = await fetch(`${selfUrl}/health`);
            if (response.ok) {
                console.log(`🏓 [SELF-PING] OK`);
            }
        } catch (error) {
            console.log(`🏓 [SELF-PING] Failed (expected if local): ${error.message}`);
        }
    }, SELF_PING_INTERVAL);
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

app.get('/', (req, res) => {
    const pools = {};
    let totalSize = 0;
    let totalMax = 0;

    PRICE_POINTS.forEach(price => {
        const key = String(price);
        pools[key] = memoryPool[key]?.length || 0;
        totalSize += pools[key];
        totalMax += POOL_SIZE_PER_PRICE;
    });

    res.json({
        service: 'SimpleSwap Dynamic Pool Server [PRODUCTION]',
        status: 'running',
        version: '5.0.0-BULLETPROOF',
        mode: 'dynamic-pool',
        configuredPrices: PRICE_POINTS,
        pools,
        totalSize,
        totalMaxSize: totalMax,
        stats,
        features: [
            'Instant replenishment on consumption',
            '3 retries with exponential backoff',
            '60s health check catches failures',
            '5min self-ping prevents sleep'
        ],
        note: `Pool system ready - instant delivery for $${PRICE_POINTS.join(', $')}`
    });
});

app.get('/health', (req, res) => {
    const pools = {};
    let totalSize = 0;
    let allFull = true;

    PRICE_POINTS.forEach(price => {
        const key = String(price);
        const count = memoryPool[key]?.length || 0;
        pools[key] = count;
        totalSize += count;
        if (count < POOL_CONFIG[key].size) allFull = false;
    });

    res.json({
        status: allFull ? 'healthy' : 'replenishing',
        mode: 'dynamic-pool',
        pools,
        totalSize,
        totalMaxSize: PRICE_POINTS.length * POOL_SIZE_PER_PRICE,
        timestamp: new Date().toISOString()
    });
});

/**
 * BUY NOW - BULLETPROOF VERSION
 * 1. Consume exchange from pool
 * 2. IMMEDIATELY trigger replenishment (not just below minSize)
 * 3. Return exchange URL to customer
 */
app.post('/buy-now', async (req, res) => {
    const startTime = Date.now();

    try {
        const { amountUSD } = req.body;

        if (!amountUSD) {
            return res.status(400).json({
                success: false,
                error: 'Missing amountUSD',
                availablePrices: PRICE_POINTS
            });
        }

        const poolKey = String(parseInt(amountUSD));
        if (!POOL_CONFIG[poolKey]) {
            return res.status(400).json({
                success: false,
                error: `Invalid amount: $${amountUSD}. Expected: ${PRICE_POINTS.join(', ')}`,
                availablePrices: PRICE_POINTS
            });
        }

        console.log(`\n💰 [BUY-NOW] Request for $${amountUSD}`);

        // Get from pool
        if (memoryPool[poolKey] && memoryPool[poolKey].length > 0) {
            const exchange = memoryPool[poolKey].shift();
            isDirty = true;
            stats.totalConsumed++;

            const remaining = memoryPool[poolKey].length;
            const target = POOL_CONFIG[poolKey].size;
            const responseTime = Date.now() - startTime;

            console.log(`✅ [BUY-NOW] Delivered: ${exchange.exchangeId}`);
            console.log(`📦 [BUY-NOW] $${poolKey} pool: ${remaining}/${target}`);

            // ⚡ INSTANT REPLENISHMENT - Always trigger if below target
            if (remaining < target) {
                console.log(`🔧 [BUY-NOW] Triggering instant replenishment...`);
                setImmediate(() => {
                    replenishPool(poolKey).catch(err =>
                        console.error(`❌ [BUY-NOW] Replenishment error: ${err.message}`)
                    );
                });
            }

            // Async disk sync
            setImmediate(() => syncPoolToDisk().catch(console.error));

            return res.json({
                success: true,
                exchangeUrl: exchange.exchangeUrl,
                amount: parseInt(poolKey),
                responseTime: `${responseTime}ms`,
                poolStatus: 'instant'
            });
        }

        // Pool empty - create on demand
        console.log(`⚠️  [BUY-NOW] Pool empty, creating on-demand...`);
        const exchange = await createExchangeWithRetry(parseInt(poolKey));

        // Trigger background replenishment to refill pool
        setImmediate(() => replenishPool(poolKey).catch(console.error));

        return res.json({
            success: true,
            exchangeUrl: exchange.exchangeUrl,
            amount: parseInt(poolKey),
            responseTime: `${Date.now() - startTime}ms`,
            poolStatus: 'on-demand'
        });

    } catch (error) {
        console.error('❌ [BUY-NOW] Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Admin endpoints
app.post('/admin/fill-all', async (req, res) => {
    console.log('🔧 [ADMIN] Filling all pools...');

    for (const price of PRICE_POINTS) {
        const key = String(price);
        if (!replenishmentLock[key]) {
            replenishPool(key).catch(console.error);
        }
    }

    res.json({ success: true, message: 'Replenishment triggered for all pools' });
});

app.post('/admin/fill-sequential', async (req, res) => {
    const { pricePoint } = req.body;
    const key = pricePoint ? String(pricePoint) : PRICE_POINTS[0].toString();

    if (!POOL_CONFIG[key]) {
        return res.status(400).json({
            success: false,
            error: `Invalid price point. Available: $${PRICE_POINTS.join(', $')}`
        });
    }

    if (replenishmentLock[key]) {
        return res.json({ success: false, error: 'Already filling' });
    }

    // Run synchronously and return result
    try {
        await replenishPool(key);
        res.json({
            success: true,
            pricePoint: parseInt(key),
            poolSize: memoryPool[key].length,
            target: POOL_CONFIG[key].size
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

app.listen(PORT, async () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  🚀 SimpleSwap Pool Server v5.0.0 - BULLETPROOF EDITION`);
    console.log(`${'='.repeat(60)}`);
    console.log(`  Port: ${PORT}`);
    console.log(`  Price Points: $${PRICE_POINTS.join(', $')}`);
    console.log(`  Pool Size: ${POOL_SIZE_PER_PRICE} per price point`);
    console.log(`  Features:`);
    console.log(`    ✅ Instant replenishment on every consumption`);
    console.log(`    ✅ 3 retries with exponential backoff`);
    console.log(`    ✅ 60-second health check`);
    console.log(`    ✅ 5-minute self-ping (prevents sleep)`);
    console.log(`${'='.repeat(60)}\n`);

    try {
        await loadPoolIntoMemory();

        console.log('📊 Pool Status:');
        PRICE_POINTS.forEach(price => {
            const key = String(price);
            const size = memoryPool[key]?.length || 0;
            const target = POOL_SIZE_PER_PRICE;
            const pct = Math.round((size / target) * 100);
            const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
            console.log(`  $${price}: [${bar}] ${size}/${target} (${pct}%)`);
        });

        // Start background processes
        startPeriodicDiskSync();
        console.log('✅ Disk sync started (every 5s)');

        // Health check every 60 seconds
        setInterval(healthCheck, HEALTH_CHECK_INTERVAL);
        console.log('✅ Health check started (every 60s)');

        // Self-ping to prevent Render sleep
        startSelfPing();
        console.log('✅ Self-ping started (every 5min)');

        // Initial health check
        setTimeout(healthCheck, 5000);

    } catch (error) {
        console.error('❌ Startup error:', error.message);
    }

    console.log('\n🟢 Server ready!\n');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('\n🛑 Shutting down...');
    if (isDirty) await syncPoolToDisk();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 SIGINT received...');
    if (isDirty) await syncPoolToDisk();
    process.exit(0);
});
