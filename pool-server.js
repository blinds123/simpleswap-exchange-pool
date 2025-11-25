/**
 * SimpleSwap Exchange Pool Server
 *
 * Pre-creates cryptocurrency exchanges on simpleswap.io and serves them instantly.
 * Uses BrightData Scraping Browser to bypass Cloudflare protection.
 *
 * CONFIGURABLE PRICE POINTS: Set PRICE_POINTS env var (e.g., "25,35,50")
 * Each price point maintains its own pool of 5 exchanges.
 *
 * @version 4.0.0
 * @description Multi-pool exchange server with configurable price points
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
// CONFIGURATION - CONFIGURABLE PRICE POINTS
// ============================================================================

const MERCHANT_WALLET = process.env.MERCHANT_WALLET || "0x1372Ad41B513b9d6eC008086C03d69C635bAE578";
const POOL_SIZE_PER_PRICE = parseInt(process.env.POOL_SIZE_PER_PRICE) || 5;
const MIN_POOL_SIZE = parseInt(process.env.MIN_POOL_SIZE) || 3;
const DISK_SYNC_INTERVAL = 5000; // 5 seconds

// Parse price points from environment variable
// Format: PRICE_POINTS=25,35,50 (comma-separated USD amounts)
const PRICE_POINTS = (process.env.PRICE_POINTS || '25')
    .split(',')
    .map(p => parseInt(p.trim()))
    .filter(p => !isNaN(p) && p > 0);

if (PRICE_POINTS.length === 0) {
    console.error('ERROR: No valid price points configured. Set PRICE_POINTS env var (e.g., "25,35,50")');
    process.exit(1);
}

// Build pool configuration dynamically from price points
const POOL_CONFIG = {};
PRICE_POINTS.forEach(price => {
    POOL_CONFIG[String(price)] = {
        size: POOL_SIZE_PER_PRICE,
        minSize: MIN_POOL_SIZE,
        amount: price,
        description: `$${price} exchange pool`
    };
});

// Persistent storage file
const POOL_FILE = path.join(process.cwd(), 'exchange-pool.json');

// BrightData credentials
const BRIGHTDATA_CUSTOMER_ID = process.env.BRIGHTDATA_CUSTOMER_ID;
const BRIGHTDATA_ZONE = process.env.BRIGHTDATA_ZONE;
const BRIGHTDATA_PASSWORD = process.env.BRIGHTDATA_PASSWORD;

if (!BRIGHTDATA_CUSTOMER_ID || !BRIGHTDATA_ZONE || !BRIGHTDATA_PASSWORD) {
    console.warn('WARNING: Missing BrightData credentials - exchange creation will not work');
}

const BRD_USERNAME = `brd-customer-${BRIGHTDATA_CUSTOMER_ID}-zone-${BRIGHTDATA_ZONE}`;
const CDP_ENDPOINT = `wss://${BRD_USERNAME}:${BRIGHTDATA_PASSWORD}@brd.superproxy.io:9222`;

// CORS - allow configured origins
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5500')
    .split(',')
    .map(o => o.trim());

app.use(cors({
    origin: ALLOWED_ORIGINS,
    credentials: true
}));
app.use(express.json({ limit: '1kb' }));

// ============================================================================
// IN-MEMORY POOL CACHE - MULTI-PRICE-POINT SUPPORT
// ============================================================================

// Initialize memory pool with all configured price points
let memoryPool = {};
PRICE_POINTS.forEach(price => {
    memoryPool[String(price)] = [];
});

let isDirty = false;
let isSyncing = false;

// Per-pool replenishment locks
const replenishmentLock = {};
PRICE_POINTS.forEach(price => {
    replenishmentLock[String(price)] = false;
});

/**
 * Loads pool from disk into memory on startup
 */
async function loadPoolIntoMemory() {
    try {
        if (existsSync(POOL_FILE)) {
            const data = await readFile(POOL_FILE, 'utf8');
            const pools = JSON.parse(data);

            // Ensure all configured price points exist in loaded data
            PRICE_POINTS.forEach(price => {
                const key = String(price);
                if (!pools[key]) pools[key] = [];
            });

            memoryPool = pools;

            const summary = PRICE_POINTS.map(p => `$${p}: ${memoryPool[String(p)].length}`).join(', ');
            console.log(`[MEMORY-POOL] Loaded from disk: ${summary}`);
            return memoryPool;
        } else {
            console.log('[MEMORY-POOL] No existing pool file, starting with empty pools');
            return memoryPool;
        }
    } catch (error) {
        console.error('[MEMORY-POOL] Failed to load pool:', error.message);
        return memoryPool;
    }
}

/**
 * Syncs in-memory pool to disk asynchronously (atomic writes)
 */
async function syncPoolToDisk() {
    if (!isDirty || isSyncing) return;

    isSyncing = true;
    const tempFile = `${POOL_FILE}.${randomBytes(8).toString('hex')}.tmp`;

    try {
        await writeFile(tempFile, JSON.stringify(memoryPool, null, 2), 'utf8');
        await rename(tempFile, POOL_FILE);
        isDirty = false;

        const summary = PRICE_POINTS.map(p => `$${p}: ${memoryPool[String(p)].length}`).join(', ');
        console.log(`[DISK-SYNC] Synced: ${summary}`);
    } catch (error) {
        console.error('[DISK-SYNC] Failed:', error.message);
        try { await unlink(tempFile); } catch (e) {}
    } finally {
        isSyncing = false;
    }
}

/**
 * Periodic disk sync - runs every 5 seconds if pool is dirty
 */
function startPeriodicDiskSync() {
    setInterval(() => {
        if (isDirty && !isSyncing) {
            syncPoolToDisk().catch(err =>
                console.error('[PERIODIC-SYNC] Failed:', err.message)
            );
        }
    }, DISK_SYNC_INTERVAL);
}

// ============================================================================
// LAZY-LOAD PLAYWRIGHT
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
// EXCHANGE CREATION - SUPPORTS ANY PRICE POINT
// ============================================================================

/**
 * Creates a SimpleSwap exchange for specified amount
 * @param {number} amountUSD - The USD amount for the exchange
 * @param {string} walletAddress - Destination wallet address
 */
async function createExchange(amountUSD, walletAddress = MERCHANT_WALLET) {
    console.log(`[CREATE-EXCHANGE] Creating exchange for $${amountUSD}...`);

    const url = `https://simpleswap.io/exchange?from=usd-usd&to=pol-matic&rate=floating&amount=${amountUSD}`;

    let browser;
    try {
        const chromiumInstance = await getChromium();

        console.log(`[${new Date().toISOString()}] Connecting to BrightData CDP...`);
        browser = await chromiumInstance.connectOverCDP(CDP_ENDPOINT);

        const context = browser.contexts()[0];
        const page = context.pages()[0] || await context.newPage();

        // Block heavy resources for performance
        await page.route('**/*.{png,jpg,jpeg,gif,webp,svg}', route => route.abort());

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        console.log(`[${new Date().toISOString()}] Page loaded`);

        // Remove popups/banners
        await page.evaluate(() => {
            document.querySelectorAll('[data-testid="info-message"], [role="alert"], .cookies-banner').forEach(el => el.remove());
        });

        // Fill wallet address
        console.log(`[${new Date().toISOString()}] Filling wallet...`);
        const addressInput = page.getByRole('textbox', { name: /address/i });
        await addressInput.first().fill(walletAddress, { timeout: 30000 });
        console.log(`[${new Date().toISOString()}] Address filled`);

        await page.waitForTimeout(2000);
        await addressInput.first().press('Enter');

        // Wait for quote calculation
        console.log(`[${new Date().toISOString()}] Waiting for quote...`);
        try {
            await page.waitForFunction(() => {
                const inputs = document.querySelectorAll('input[type="text"]');
                if (inputs.length < 2) return false;
                const val = inputs[1].value;
                return val && val.length > 0 && val !== '0' && !val.includes('...');
            }, { timeout: 30000 });
            console.log(`[${new Date().toISOString()}] Quote received`);
        } catch (e) {
            console.log(`[${new Date().toISOString()}] Quote timeout (continuing anyway)`);
        }

        // Wait for button to be enabled
        console.log(`[${new Date().toISOString()}] Waiting for button...`);
        const createButton = page.getByRole('button', { name: /^create.*exchange$/i });

        await page.waitForFunction(
            () => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const createBtn = buttons.find(b => /^create.*exchange$/i.test(b.textContent?.trim() || ''));
                return createBtn && !createBtn.disabled;
            },
            { timeout: 40000 }
        );

        const isDisabled = await createButton.first().isDisabled();
        if (!isDisabled) {
            await createButton.first().click({ timeout: 10000 });
            console.log(`[${new Date().toISOString()}] Button clicked`);

            // Double click strategy for reliability
            await page.waitForTimeout(2000);
            if (page.url().includes('/exchange?')) {
                await createButton.first().click({ force: true });
            }
        } else {
            throw new Error('Button still disabled after waiting');
        }

        // Wait for redirect to exchange page
        console.log(`[${new Date().toISOString()}] Waiting for redirect...`);
        await page.waitForURL(/\/exchange\?id=/, { timeout: 120000 });

        const exchangeUrl = page.url();
        const exchangeId = new URL(exchangeUrl).searchParams.get('id');

        if (!exchangeId) throw new Error('No exchange ID in URL');

        console.log(`[CREATE-EXCHANGE] Created: ${exchangeId} for $${amountUSD}`);

        return {
            id: exchangeId,
            exchangeId,
            exchangeUrl,
            amount: amountUSD,
            created: new Date().toISOString()
        };

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Failed:`, error.message);
        throw error;
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) {}
        }
    }
}

// ============================================================================
// POOL MANAGEMENT - MULTI-PRICE-POINT SUPPORT
// ============================================================================

/**
 * Replenishes a specific price point pool
 * @param {string} priceKey - The price point key (e.g., "25")
 */
async function replenishPool(priceKey) {
    if (replenishmentLock[priceKey]) {
        console.log(`[REPLENISH-${priceKey}] Already replenishing, skipping`);
        return;
    }

    replenishmentLock[priceKey] = true;
    console.log(`[REPLENISH-${priceKey}] Starting replenishment...`);

    try {
        const config = POOL_CONFIG[priceKey];
        if (!config) {
            console.error(`[REPLENISH-${priceKey}] Invalid price point`);
            return;
        }

        const currentSize = memoryPool[priceKey]?.length || 0;
        const needed = config.size - currentSize;

        if (needed <= 0) {
            console.log(`[REPLENISH-${priceKey}] Pool already full`);
            return;
        }

        console.log(`[REPLENISH-${priceKey}] Creating ${needed} exchanges...`);

        // Create sequentially to avoid overwhelming BrightData
        let created = 0;
        for (let i = 0; i < needed; i++) {
            try {
                const exchange = await createExchange(config.amount);
                memoryPool[priceKey].push({ ...exchange, amount: config.amount });
                isDirty = true;
                created++;
                console.log(`[REPLENISH-${priceKey}] Created ${created}/${needed}`);

                // Small delay between creations
                if (i < needed - 1) {
                    await new Promise(r => setTimeout(r, 2000));
                }
            } catch (error) {
                console.error(`[REPLENISH-${priceKey}] Failed ${i + 1}/${needed}:`, error.message);
            }
        }

        if (created > 0) {
            await syncPoolToDisk();
            console.log(`[REPLENISH-${priceKey}] Pool now: ${memoryPool[priceKey].length}/${config.size}`);
        }
    } catch (error) {
        console.error(`[REPLENISH-${priceKey}] Failed:`, error.message);
    } finally {
        replenishmentLock[priceKey] = false;
    }
}

/**
 * Gets the pool key for an amount (exact match required)
 */
function getPoolKey(amountUSD) {
    const amount = parseInt(amountUSD);
    const key = String(amount);
    if (POOL_CONFIG[key]) return key;
    return null;
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

/**
 * Root endpoint - shows all pools status
 */
app.get('/', (req, res) => {
    const pools = {};
    let totalSize = 0;
    let totalMax = 0;

    PRICE_POINTS.forEach(price => {
        const key = String(price);
        const size = memoryPool[key]?.length || 0;
        pools[key] = size;
        totalSize += size;
        totalMax += POOL_SIZE_PER_PRICE;
    });

    res.json({
        service: 'SimpleSwap Exchange Pool Server',
        status: 'running',
        version: '4.0.0',
        mode: 'multi-pool',
        pricePoints: PRICE_POINTS,
        pools,
        totalSize,
        maxSize: totalMax,
        poolSizePerPrice: POOL_SIZE_PER_PRICE,
        performance: {
            avgResponseTime: '<50ms',
            diskSync: `Every ${DISK_SYNC_INTERVAL / 1000}s`
        },
        note: totalSize > 0
            ? 'Pool ready - instant delivery from memory'
            : 'Use POST /admin/init-pool to initialize'
    });
});

/**
 * Health check
 */
app.get('/health', (req, res) => {
    const allHealthy = PRICE_POINTS.every(price => {
        const key = String(price);
        return (memoryPool[key]?.length || 0) >= MIN_POOL_SIZE;
    });

    res.json({
        status: allHealthy ? 'healthy' : 'degraded',
        pricePoints: PRICE_POINTS,
        timestamp: new Date().toISOString()
    });
});

/**
 * Detailed pool stats
 */
app.get('/stats', (req, res) => {
    const pools = {};
    let totalSize = 0;

    PRICE_POINTS.forEach(price => {
        const key = String(price);
        const config = POOL_CONFIG[key];
        pools[key] = {
            description: config.description,
            size: memoryPool[key]?.length || 0,
            maxSize: config.size,
            minSize: config.minSize,
            exchanges: memoryPool[key] || []
        };
        totalSize += memoryPool[key]?.length || 0;
    });

    res.json({
        pricePoints: PRICE_POINTS,
        pools,
        totalSize,
        totalMaxSize: PRICE_POINTS.length * POOL_SIZE_PER_PRICE
    });
});

/**
 * BUY NOW - Get exchange from pool
 */
app.post('/buy-now', async (req, res) => {
    const startTime = Date.now();

    try {
        const { amountUSD } = req.body;

        if (!amountUSD) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameter: amountUSD',
                availablePrices: PRICE_POINTS
            });
        }

        const poolKey = getPoolKey(amountUSD);
        if (!poolKey) {
            return res.status(400).json({
                success: false,
                error: `Invalid amount: $${amountUSD}. Available: $${PRICE_POINTS.join(', $')}`,
                availablePrices: PRICE_POINTS
            });
        }

        console.log(`[BUY-NOW] Request for $${amountUSD}`);

        // FAST PATH: Get from memory pool
        if (memoryPool[poolKey] && memoryPool[poolKey].length > 0) {
            const exchange = memoryPool[poolKey].shift();
            isDirty = true;

            const responseTime = Date.now() - startTime;
            console.log(`[BUY-NOW] Delivered: ${exchange.exchangeId} (${responseTime}ms)`);
            console.log(`[BUY-NOW] $${poolKey} remaining: ${memoryPool[poolKey].length}`);

            // Async replenishment if below minimum
            if (memoryPool[poolKey].length < POOL_CONFIG[poolKey].minSize) {
                setImmediate(() => {
                    replenishPool(poolKey).catch(err =>
                        console.error('[BUY-NOW] Replenishment failed:', err.message)
                    );
                });
            }

            // Async disk sync
            setImmediate(() => {
                syncPoolToDisk().catch(err =>
                    console.error('[BUY-NOW] Disk sync failed:', err.message)
                );
            });

            return res.json({
                success: true,
                exchangeUrl: exchange.exchangeUrl,
                amount: parseInt(poolKey),
                responseTime: `${responseTime}ms`,
                source: 'pool'
            });
        }

        // SLOW PATH: Create on-demand
        console.log(`[BUY-NOW] Pool empty for $${poolKey}, creating on-demand...`);
        const exchange = await createExchange(parseInt(poolKey));

        // Trigger async replenishment
        setImmediate(() => {
            replenishPool(poolKey).catch(err =>
                console.error('[BUY-NOW] Background replenishment failed:', err.message)
            );
        });

        const responseTime = Date.now() - startTime;
        return res.json({
            success: true,
            exchangeUrl: exchange.exchangeUrl,
            amount: parseInt(poolKey),
            responseTime: `${responseTime}ms`,
            source: 'on-demand'
        });

    } catch (error) {
        console.error('[BUY-NOW] Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Admin: Initialize all pools
 */
app.post('/admin/init-pool', async (req, res) => {
    const { pricePoint } = req.body;

    // If specific price point requested
    if (pricePoint) {
        const key = String(pricePoint);
        if (!POOL_CONFIG[key]) {
            return res.status(400).json({
                success: false,
                error: `Invalid price point: $${pricePoint}. Available: $${PRICE_POINTS.join(', $')}`
            });
        }

        if (replenishmentLock[key]) {
            return res.json({ success: false, error: `$${key} pool already initializing` });
        }

        replenishmentLock[key] = true;
        memoryPool[key] = [];

        try {
            const config = POOL_CONFIG[key];
            console.log(`[INIT-POOL] Initializing $${key} pool with ${config.size} exchanges...`);

            for (let i = 0; i < config.size; i++) {
                try {
                    const exchange = await createExchange(config.amount);
                    memoryPool[key].push({ ...exchange, amount: config.amount });
                    console.log(`[INIT-POOL] $${key}: ${memoryPool[key].length}/${config.size}`);
                    if (i < config.size - 1) await new Promise(r => setTimeout(r, 2000));
                } catch (error) {
                    console.error(`[INIT-POOL] $${key} failed:`, error.message);
                }
            }

            isDirty = true;
            await syncPoolToDisk();
            replenishmentLock[key] = false;

            return res.json({
                success: true,
                pricePoint: parseInt(key),
                created: memoryPool[key].length,
                target: config.size
            });
        } catch (error) {
            replenishmentLock[key] = false;
            return res.status(500).json({ success: false, error: error.message });
        }
    }

    // Initialize all pools
    const results = {};
    for (const price of PRICE_POINTS) {
        const key = String(price);
        if (replenishmentLock[key]) {
            results[key] = { skipped: true, reason: 'already initializing' };
            continue;
        }

        replenishmentLock[key] = true;
        memoryPool[key] = [];

        const config = POOL_CONFIG[key];
        console.log(`[INIT-POOL] Initializing $${key}...`);

        let created = 0;
        for (let i = 0; i < config.size; i++) {
            try {
                const exchange = await createExchange(config.amount);
                memoryPool[key].push({ ...exchange, amount: config.amount });
                created++;
                console.log(`[INIT-POOL] $${key}: ${created}/${config.size}`);
                if (i < config.size - 1) await new Promise(r => setTimeout(r, 2000));
            } catch (error) {
                console.error(`[INIT-POOL] $${key} failed:`, error.message);
            }
        }

        results[key] = { created, target: config.size };
        replenishmentLock[key] = false;
    }

    isDirty = true;
    await syncPoolToDisk();

    res.json({
        success: true,
        results,
        message: 'All pools initialized'
    });
});

/**
 * Admin: Add single exchange to specific pool
 */
app.post('/admin/add-one', async (req, res) => {
    const { pricePoint } = req.body;
    const key = pricePoint ? String(pricePoint) : PRICE_POINTS[0].toString();

    if (!POOL_CONFIG[key]) {
        return res.status(400).json({
            success: false,
            error: `Invalid price point: $${key}. Available: $${PRICE_POINTS.join(', $')}`
        });
    }

    try {
        const config = POOL_CONFIG[key];
        const currentSize = memoryPool[key]?.length || 0;

        if (currentSize >= config.size) {
            return res.json({
                success: false,
                error: `$${key} pool already full (${currentSize}/${config.size})`
            });
        }

        console.log(`[ADD-ONE] Creating exchange for $${key}...`);
        const exchange = await createExchange(config.amount);
        memoryPool[key].push({ ...exchange, amount: config.amount });
        isDirty = true;
        await syncPoolToDisk();

        res.json({
            success: true,
            pricePoint: parseInt(key),
            exchangeId: exchange.exchangeId,
            poolSize: memoryPool[key].length,
            target: config.size
        });
    } catch (error) {
        console.error('[ADD-ONE] Failed:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Admin: Fill specific pool sequentially
 */
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
        return res.json({ success: false, error: 'Already filling pool' });
    }

    replenishmentLock[key] = true;

    try {
        const config = POOL_CONFIG[key];
        const startSize = memoryPool[key]?.length || 0;
        const needed = config.size - startSize;

        if (needed <= 0) {
            replenishmentLock[key] = false;
            return res.json({
                success: true,
                message: `$${key} pool already full`,
                poolSize: startSize
            });
        }

        console.log(`[FILL-SEQ] $${key}: Creating ${needed} exchanges...`);

        let created = 0;
        for (let i = 0; i < needed; i++) {
            try {
                const exchange = await createExchange(config.amount);
                memoryPool[key].push({ ...exchange, amount: config.amount });
                isDirty = true;
                created++;
                console.log(`[FILL-SEQ] $${key}: ${created}/${needed}`);
                if (i < needed - 1) await new Promise(r => setTimeout(r, 2000));
            } catch (error) {
                console.error(`[FILL-SEQ] Failed:`, error.message);
            }
        }

        await syncPoolToDisk();
        replenishmentLock[key] = false;

        res.json({
            success: true,
            pricePoint: parseInt(key),
            created,
            poolSize: memoryPool[key].length,
            target: config.size
        });
    } catch (error) {
        replenishmentLock[key] = false;
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

app.listen(PORT, async () => {
    console.log(`\n====================================================`);
    console.log(`  SimpleSwap Exchange Pool Server v4.0.0`);
    console.log(`====================================================`);
    console.log(`  Port: ${PORT}`);
    console.log(`  Price Points: $${PRICE_POINTS.join(', $')}`);
    console.log(`  Pool Size Per Price: ${POOL_SIZE_PER_PRICE}`);
    console.log(`  Wallet: ${MERCHANT_WALLET}`);
    console.log(`====================================================\n`);

    try {
        await loadPoolIntoMemory();

        console.log(`Pool Status:`);
        PRICE_POINTS.forEach(price => {
            const key = String(price);
            const size = memoryPool[key]?.length || 0;
            const status = size >= POOL_SIZE_PER_PRICE ? 'FULL' : size > 0 ? 'PARTIAL' : 'EMPTY';
            console.log(`  $${price}: ${size}/${POOL_SIZE_PER_PRICE} [${status}]`);
        });

        startPeriodicDiskSync();
        console.log(`\nPeriodic disk sync started (every ${DISK_SYNC_INTERVAL / 1000}s)`);

    } catch (error) {
        console.error('Startup error:', error.message);
    }
    console.log('');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('\nShutting down...');
    if (isDirty) {
        console.log('Syncing to disk...');
        await syncPoolToDisk();
    }
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT...');
    if (isDirty) {
        console.log('Syncing to disk...');
        await syncPoolToDisk();
    }
    process.exit(0);
});
