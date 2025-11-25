import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { readFile, writeFile, rename, unlink } from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { completeMercuryoVerification, createVerifiedExchange } from './mercuryo-otp-verification.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const MERCHANT_WALLET = process.env.MERCHANT_WALLET || "0x1372Ad41B513b9d6eC008086C03d69C635bAE578";
const POOL_SIZE = parseInt(process.env.POOL_SIZE) || 5;
const MIN_POOL_SIZE = parseInt(process.env.MIN_POOL_SIZE) || 3;
const DISK_SYNC_INTERVAL = 5000; // 5 seconds

// Persistent storage file
const POOL_FILE = path.join(process.cwd(), 'exchange-pool.json');

// Single-pool configuration for Sparkle Hoodie ($25)
const POOL_CONFIG = {
    '25': {
        size: POOL_SIZE,
        minSize: MIN_POOL_SIZE,
        amount: 25,
        description: 'Sparkle Hoodie ($25 base, accepts $25-$35)'
    }
};

// BrightData credentials
const BRIGHTDATA_CUSTOMER_ID = process.env.BRIGHTDATA_CUSTOMER_ID;
const BRIGHTDATA_ZONE = process.env.BRIGHTDATA_ZONE;
const BRIGHTDATA_PASSWORD = process.env.BRIGHTDATA_PASSWORD;

if (!BRIGHTDATA_CUSTOMER_ID || !BRIGHTDATA_ZONE || !BRIGHTDATA_PASSWORD) {
    console.warn('⚠️  Missing BrightData credentials - on-demand creation will not work');
}

const BRD_USERNAME = `brd-customer-${BRIGHTDATA_CUSTOMER_ID}-zone-${BRIGHTDATA_ZONE}`;
const CDP_ENDPOINT = `wss://${BRD_USERNAME}:${BRIGHTDATA_PASSWORD}@brd.superproxy.io:9222`;

// Middleware - CORS configured for Netlify frontend
app.use(cors({
    origin: [
        'https://sparkle-hoodie-shop.netlify.app',
        'http://localhost:3000',
        'http://localhost:5500'
    ],
    credentials: true
}));
app.use(express.json());

// ============================================================================
// IN-MEMORY POOL CACHE - PERFORMANCE OPTIMIZATION
// ============================================================================

// Single source of truth during runtime (no file I/O for reads)
let memoryPool = { '25': [] };
let isDirty = false;
let isSyncing = false;

/**
 * Loads pool from disk into memory on startup
 * This is the ONLY time we read from disk during normal operation
 */
async function loadPoolIntoMemory() {
    try {
        if (existsSync(POOL_FILE)) {
            const data = await readFile(POOL_FILE, 'utf8');
            const pools = JSON.parse(data);
            if (!pools['25']) pools['25'] = [];
            memoryPool = pools;
            console.log(`[MEMORY-POOL] Loaded ${memoryPool['25'].length} exchanges from disk`);
            return memoryPool;
        } else {
            console.log('[MEMORY-POOL] No existing pool file, starting with empty pool');
            memoryPool = { '25': [] };
            return memoryPool;
        }
    } catch (error) {
        console.error('[MEMORY-POOL] Failed to load pool:', error.message);
        memoryPool = { '25': [] };
        return memoryPool;
    }
}

/**
 * Syncs in-memory pool to disk asynchronously
 * Uses atomic writes to prevent corruption
 * Only syncs if pool has been modified (isDirty flag)
 */
async function syncPoolToDisk() {
    if (!isDirty || isSyncing) return;

    isSyncing = true;
    const tempFile = `${POOL_FILE}.${randomBytes(8).toString('hex')}.tmp`;

    try {
        await writeFile(tempFile, JSON.stringify(memoryPool, null, 2), 'utf8');
        await rename(tempFile, POOL_FILE);
        isDirty = false;
        console.log('[DISK-SYNC] Pool synced to disk:', { '25': memoryPool['25'].length });
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
// EXCHANGE CREATION (unchanged, but used async)
// ============================================================================

/**
 * Creates a SimpleSwap exchange on-demand
 * Uses BrightData Scraping Browser with production fixes
 */
async function createExchange(amountUSD = 25, walletAddress = MERCHANT_WALLET) {
    console.log(`[CREATE-EXCHANGE] Creating exchange for $${amountUSD}...`);

    const url = `https://simpleswap.io/exchange?from=usd-usd&to=pol-matic&rate=floating&amount=${amountUSD}`;

    let browser;
    try {
        const chromiumInstance = await getChromium();

        console.log(`[${new Date().toISOString()}] Connecting to BrightData CDP...`);
        browser = await chromiumInstance.connectOverCDP(CDP_ENDPOINT);

        const context = browser.contexts()[0];
        const page = context.pages()[0] || await context.newPage();

        // OPTIMIZATION: Block heavy resources for Render 0.5 CPU
        await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,css,woff,woff2}', route => route.abort());

        // Set a robust timeout for navigation (120s for Render Starter CPU)
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
        console.log(`[${new Date().toISOString()}] Page loaded`);

        // Remove popups/banners
        await page.evaluate(() => {
            document.querySelectorAll('[data-testid="info-message"], [role="alert"], .cookies-banner').forEach(el => el.remove());
        });

        // Fill Wallet using accessibility locator (PRODUCTION FIX: use .fill() for React)
        console.log(`[${new Date().toISOString()}] Filling wallet using getByRole...`);
        const addressInput = page.getByRole('textbox', { name: /address/i });
        await addressInput.first().fill(walletAddress, { timeout: 30000 });
        console.log(`[${new Date().toISOString()}] ✓ Address filled`);

        await page.waitForTimeout(2000);
        await addressInput.first().press('Enter');

        // Wait for Quote calculation
        console.log(`[${new Date().toISOString()}] Waiting for quote calculation...`);
        try {
            await page.waitForFunction(() => {
                const inputs = document.querySelectorAll('input[type="text"]');
                if (inputs.length < 2) return false;
                const val = inputs[1].value;
                return val && val.length > 0 && val !== '0' && !val.includes('...');
            }, { timeout: 30000 });
            console.log(`[${new Date().toISOString()}] Quote received!`);
        } catch (e) {
            console.log(`[${new Date().toISOString()}] ⚠️ Warning: Quote timeout (might still work)`);
        }

        // Wait for button to be enabled (PRODUCTION FIX: waitForFunction)
        console.log(`[${new Date().toISOString()}] Waiting for button to be enabled...`);
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
        console.log(`[${new Date().toISOString()}] Button disabled: ${isDisabled}`);

        if (!isDisabled) {
            await createButton.first().click({ timeout: 10000 });
            console.log(`[${new Date().toISOString()}] ✓ Button clicked`);

            // Double click strategy for reliability
            await page.waitForTimeout(2000);
            if (page.url().includes('/exchange?')) {
                console.log(`[${new Date().toISOString()}] Still on page, clicking again...`);
                await createButton.first().click({ force: true });
            }
        } else {
            throw new Error('Button still disabled after waiting');
        }

        console.log(`[${new Date().toISOString()}] Waiting for redirect...`);
        await page.waitForURL(/\/exchange\?id=/, { timeout: 120000 });

        const exchangeUrl = page.url();
        const exchangeId = new URL(exchangeUrl).searchParams.get('id');

        if (!exchangeId) throw new Error('No exchange ID in URL');

        console.log(`[CREATE-EXCHANGE] ✓ Created: ${exchangeId} for $${amountUSD}`);

        return {
            id: exchangeId,
            exchangeId,
            exchangeUrl,
            amount: amountUSD,
            created: new Date().toISOString()
        };

    } catch (error) {
        console.error(`[${new Date().toISOString()}] ✗ Failed:`, error.message);
        throw error;
    } finally {
        if (browser) await browser.close();
    }
}

// ============================================================================
// POOL MANAGEMENT - OPTIMIZED FOR IN-MEMORY
// ============================================================================

const replenishmentLock = { '25': false };

/**
 * Replenishes pool by creating exchanges in parallel
 * Updates in-memory pool and marks for disk sync
 */
async function replenishPool() {
    if (replenishmentLock['25']) {
        console.log('[REPLENISH] Already replenishing, skipping');
        return;
    }

    replenishmentLock['25'] = true;
    console.log('[REPLENISH] Starting replenishment...');

    try {
        const config = POOL_CONFIG['25'];
        const needed = config.size - memoryPool['25'].length;

        if (needed <= 0) {
            console.log('[REPLENISH] Pool already full');
            return;
        }

        console.log(`[REPLENISH] Creating ${needed} exchanges in parallel`);

        const promises = [];
        for (let i = 0; i < needed; i++) {
            promises.push(
                createExchange(25)
                    .then(exchange => ({ ...exchange, amount: 25 }))
                    .catch(error => {
                        console.error(`[REPLENISH] Failed ${i+1}/${needed}:`, error.message);
                        return null;
                    })
            );
        }

        const results = await Promise.all(promises);
        const validExchanges = results.filter(e => e !== null);

        console.log(`[REPLENISH] Created ${validExchanges.length}/${needed} exchanges`);

        if (validExchanges.length > 0) {
            // Direct memory update - NO FILE LOCKING
            memoryPool['25'].push(...validExchanges);
            isDirty = true;

            // Immediate disk sync after replenishment
            await syncPoolToDisk();

            console.log(`[REPLENISH] Pool now has ${memoryPool['25'].length}/${config.size} exchanges`);
        }
    } catch (error) {
        console.error('[REPLENISH] Failed:', error.message);
    } finally {
        replenishmentLock['25'] = false;
    }
}

/**
 * Normalizes amount - accepts $25 or $35 (with order bump), both use $25 pool
 */
function normalizeAmount(amountUSD) {
    const amount = parseInt(amountUSD);
    if (amount === 25 || amount === 35) return '25';
    throw new Error(`Invalid amount: $${amount}. Expected: 25 or 35`);
}

// ============================================================================
// API ENDPOINTS - OPTIMIZED FOR MEMORY READS
// ============================================================================

/**
 * Root endpoint - instant response from memory
 */
app.get('/', (req, res) => {
    const poolSize = memoryPool['25']?.length || 0;

    res.json({
        service: 'Sparkle Hoodie Pool Server (Optimized)',
        status: 'running',
        version: '2.0.0-memory-cache',
        mode: 'single-pool-in-memory',
        pool: {
            '25': poolSize
        },
        totalSize: poolSize,
        maxSize: POOL_SIZE,
        performance: {
            cacheHit: true,
            avgResponseTime: '<50ms',
            diskSync: `Every ${DISK_SYNC_INTERVAL/1000}s or on change`
        },
        note: poolSize > 0
            ? 'Pool ready - instant delivery from memory (<50ms)'
            : 'Use POST /admin/init-pool to initialize'
    });
});

/**
 * Health check - instant memory read
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        mode: 'single-pool-memory-optimized',
        timestamp: new Date().toISOString()
    });
});

/**
 * Pool health details - instant memory read
 */
app.get('/health/pools', (req, res) => {
    try {
        const config = POOL_CONFIG['25'];
        const poolSize = memoryPool['25']?.length || 0;
        const status = poolSize >= config.minSize ? 'healthy' : poolSize > 0 ? 'low' : 'empty';

        res.json({
            status: status === 'healthy' ? 'healthy' : 'degraded',
            pools: {
                '25': {
                    status,
                    size: poolSize,
                    target: config.size,
                    minSize: config.minSize,
                    description: config.description
                }
            },
            isReplenishing: replenishmentLock['25'],
            performance: {
                source: 'memory',
                isDirty,
                isSyncing
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

/**
 * Stats endpoint - instant memory read
 */
app.get('/stats', (req, res) => {
    const config = POOL_CONFIG['25'];

    res.json({
        pools: {
            '25': {
                description: config.description,
                size: memoryPool['25']?.length || 0,
                maxSize: config.size,
                minSize: config.minSize,
                exchanges: memoryPool['25'] || []
            }
        },
        totalSize: memoryPool['25']?.length || 0,
        totalMaxSize: config.size,
        performance: {
            source: 'memory',
            diskSyncInterval: `${DISK_SYNC_INTERVAL/1000}s`
        }
    });
});

/**
 * BUY NOW ENDPOINT - OPTIMIZED FOR INSTANT DELIVERY
 *
 * Performance optimizations:
 * 1. NO file locking - direct memory access
 * 2. Immediate response - async replenishment
 * 3. <50ms response time target
 */
app.post('/buy-now', async (req, res) => {
    const startTime = Date.now();

    try {
        const { amountUSD } = req.body;

        if (!amountUSD) {
            return res.status(400).json({
                success: false,
                error: 'Missing required parameter: amountUSD'
            });
        }

        const amount = parseInt(amountUSD);
        if (isNaN(amount) || ![25, 35].includes(amount)) {
            return res.status(400).json({
                success: false,
                error: `Invalid amount: $${amountUSD}. Expected: 25 or 35`
            });
        }

        console.log(`[BUY-NOW] Request for $${amountUSD}`);

        const poolKey = normalizeAmount(amountUSD);

        // FAST PATH: Direct memory access - NO FILE I/O
        if (memoryPool[poolKey] && memoryPool[poolKey].length > 0) {
            const exchange = memoryPool[poolKey].shift();
            isDirty = true;

            const responseTime = Date.now() - startTime;
            console.log(`[BUY-NOW] ✓ Delivered from memory: ${exchange.exchangeId || exchange.id} (${responseTime}ms)`);
            console.log(`[BUY-NOW] Remaining: ${memoryPool[poolKey].length}`);

            // Async replenishment check - doesn't block response
            if (memoryPool[poolKey].length < POOL_CONFIG[poolKey].minSize) {
                console.log('[BUY-NOW] Pool below minimum, triggering async replenishment');
                setImmediate(() => {
                    replenishPool().catch(err =>
                        console.error('[BUY-NOW] Replenishment failed:', err.message)
                    );
                });
            }

            // Async disk sync - doesn't block response
            setImmediate(() => {
                syncPoolToDisk().catch(err =>
                    console.error('[BUY-NOW] Disk sync failed:', err.message)
                );
            });

            return res.json({
                success: true,
                exchangeUrl: exchange.exchangeUrl,
                poolStatus: 'instant',
                responseTime: `${responseTime}ms`,
                source: 'memory-pool'
            });
        }

        // SLOW PATH: Pool empty, create on-demand
        console.log('[BUY-NOW] Pool empty, creating on-demand');
        const exchange = await createExchange(25);

        // Trigger async replenishment
        setImmediate(() => {
            replenishPool().catch(err =>
                console.error('[BUY-NOW] Background replenishment failed:', err.message)
            );
        });

        const responseTime = Date.now() - startTime;
        return res.json({
            success: true,
            exchangeUrl: exchange.exchangeUrl,
            poolStatus: 'on-demand',
            responseTime: `${responseTime}ms`,
            source: 'created-live'
        });

    } catch (error) {
        console.error('[BUY-NOW] Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Admin: Initialize pool
 * Populates memory pool and syncs to disk
 */
app.post('/admin/init-pool', async (req, res) => {
    try {
        if (replenishmentLock['25']) {
            return res.json({
                success: false,
                error: 'Pool already initializing'
            });
        }

        console.log('[INIT-POOL] Starting initialization...');
        replenishmentLock['25'] = true;

        const config = POOL_CONFIG['25'];
        memoryPool = { '25': [] };

        console.log(`[INIT-POOL] Creating ${config.size} exchanges...`);

        const promises = [];
        for (let i = 0; i < config.size; i++) {
            promises.push(
                createExchange(25)
                    .then(exchange => {
                        memoryPool['25'].push({ ...exchange, amount: 25 });
                        console.log(`[INIT-POOL] Created ${memoryPool['25'].length}/${config.size}`);
                        return { success: true };
                    })
                    .catch(error => {
                        console.error(`[INIT-POOL] Failed:`, error.message);
                        return { success: false, error };
                    })
            );
        }

        const results = await Promise.all(promises);
        const successes = results.filter(r => r.success).length;
        const failures = results.filter(r => !r.success).length;

        if (successes === 0) {
            replenishmentLock['25'] = false;
            return res.status(500).json({
                success: false,
                error: 'No exchanges created'
            });
        }

        // Sync to disk
        isDirty = true;
        await syncPoolToDisk();

        replenishmentLock['25'] = false;

        console.log('[INIT-POOL] Complete!');

        res.json({
            success: true,
            pools: { '25': memoryPool['25'].length },
            totalCreated: successes,
            totalFailed: failures,
            message: `Pool initialized with ${successes} exchanges in memory`
        });
    } catch (error) {
        replenishmentLock['25'] = false;
        console.error('[INIT-POOL] Failed:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Admin: Add single exchange to pool (sequential, no rate limiting)
 * Does NOT wipe existing pool - just adds one more
 */
app.post('/admin/add-one', async (req, res) => {
    try {
        const config = POOL_CONFIG['25'];
        const currentSize = memoryPool['25']?.length || 0;

        if (currentSize >= config.size) {
            return res.json({
                success: false,
                error: `Pool already full (${currentSize}/${config.size})`,
                poolSize: currentSize
            });
        }

        console.log(`[ADD-ONE] Creating 1 exchange (current: ${currentSize}/${config.size})...`);

        const exchange = await createExchange(25);
        memoryPool['25'].push({ ...exchange, amount: 25 });
        isDirty = true;
        await syncPoolToDisk();

        const newSize = memoryPool['25'].length;
        console.log(`[ADD-ONE] ✓ Success! Pool now: ${newSize}/${config.size}`);

        res.json({
            success: true,
            exchangeId: exchange.exchangeId,
            poolSize: newSize,
            target: config.size,
            message: `Added 1 exchange. Pool: ${newSize}/${config.size}`
        });
    } catch (error) {
        console.error('[ADD-ONE] Failed:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            poolSize: memoryPool['25']?.length || 0
        });
    }
});

/**
 * Admin: Fill pool sequentially (one at a time, reliable)
 * Does NOT wipe existing pool - fills to target
 */
app.post('/admin/fill-sequential', async (req, res) => {
    try {
        if (replenishmentLock['25']) {
            return res.json({
                success: false,
                error: 'Already filling pool'
            });
        }

        replenishmentLock['25'] = true;
        const config = POOL_CONFIG['25'];
        const startSize = memoryPool['25']?.length || 0;
        const needed = config.size - startSize;

        if (needed <= 0) {
            replenishmentLock['25'] = false;
            return res.json({
                success: true,
                message: `Pool already full (${startSize}/${config.size})`,
                poolSize: startSize
            });
        }

        console.log(`[FILL-SEQ] Creating ${needed} exchanges sequentially...`);

        let created = 0;
        let failed = 0;

        // Create one at a time (sequential, not parallel)
        for (let i = 0; i < needed; i++) {
            try {
                console.log(`[FILL-SEQ] Creating ${i + 1}/${needed}...`);
                const exchange = await createExchange(25);
                memoryPool['25'].push({ ...exchange, amount: 25 });
                isDirty = true;
                created++;
                console.log(`[FILL-SEQ] ✓ Created ${created}/${needed}`);

                // Small delay between creations to avoid rate limiting
                if (i < needed - 1) {
                    await new Promise(r => setTimeout(r, 2000));
                }
            } catch (error) {
                console.error(`[FILL-SEQ] Failed ${i + 1}/${needed}:`, error.message);
                failed++;
            }
        }

        // Sync to disk
        await syncPoolToDisk();
        replenishmentLock['25'] = false;

        const finalSize = memoryPool['25'].length;
        console.log(`[FILL-SEQ] Complete! ${created} created, ${failed} failed. Pool: ${finalSize}/${config.size}`);

        res.json({
            success: true,
            created,
            failed,
            poolSize: finalSize,
            target: config.size,
            message: `Created ${created}, failed ${failed}. Pool: ${finalSize}/${config.size}`
        });
    } catch (error) {
        replenishmentLock['25'] = false;
        console.error('[FILL-SEQ] Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================================
// MERCURYO OTP VERIFICATION ENDPOINTS
// ============================================================================

/**
 * Admin: Test Mercuryo OTP verification on an existing exchange
 * Uses BrightData to complete the email verification flow
 */
app.post('/admin/test-mercuryo-otp', async (req, res) => {
    const { exchangeId } = req.body;

    if (!exchangeId) {
        return res.status(400).json({
            success: false,
            error: 'Missing required parameter: exchangeId'
        });
    }

    if (!BRIGHTDATA_PASSWORD || BRIGHTDATA_PASSWORD === 'your_password_here') {
        return res.status(500).json({
            success: false,
            error: 'BrightData credentials not configured'
        });
    }

    console.log(`[MERCURYO-OTP-TEST] Testing verification for ${exchangeId}`);

    try {
        const chromiumInstance = await getChromium();
        const result = await completeMercuryoVerification(
            chromiumInstance,
            CDP_ENDPOINT,
            exchangeId
        );

        res.json({
            success: result.success,
            exchangeId,
            email: result.email,
            otp: result.otp,
            error: result.error,
            diagnostics: result.diagnostics,
            message: result.success
                ? 'Mercuryo OTP verification completed successfully'
                : 'Verification failed or status unclear'
        });
    } catch (error) {
        console.error('[MERCURYO-OTP-TEST] Error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message,
            exchangeId
        });
    }
});

/**
 * Admin: Create a verified exchange (with Mercuryo OTP completed)
 * This creates an exchange AND completes the email verification
 */
app.post('/admin/create-verified-exchange', async (req, res) => {
    if (!BRIGHTDATA_PASSWORD || BRIGHTDATA_PASSWORD === 'your_password_here') {
        return res.status(500).json({
            success: false,
            error: 'BrightData credentials not configured'
        });
    }

    console.log('[CREATE-VERIFIED] Starting verified exchange creation...');

    try {
        const chromiumInstance = await getChromium();
        const exchange = await createVerifiedExchange(
            chromiumInstance,
            CDP_ENDPOINT,
            createExchange,
            25,
            MERCHANT_WALLET
        );

        // Add to pool if verified
        if (exchange.verified) {
            memoryPool['25'].push({ ...exchange, amount: 25 });
            isDirty = true;
            await syncPoolToDisk();
            console.log('[CREATE-VERIFIED] Added verified exchange to pool');
        }

        res.json({
            success: true,
            exchange,
            addedToPool: exchange.verified,
            poolSize: memoryPool['25'].length,
            message: exchange.verified
                ? 'Verified exchange created and added to pool'
                : 'Exchange created but verification unclear'
        });
    } catch (error) {
        console.error('[CREATE-VERIFIED] Error:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================================================
// SERVER STARTUP - LOAD INTO MEMORY & START PERIODIC SYNC
// ============================================================================

app.listen(PORT, async () => {
    console.log(`\n🚀 Sparkle Hoodie Pool Server v2.0.0 (Memory-Optimized)`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Mode: SINGLE-POOL IN-MEMORY ($25)`);
    console.log(`   Wallet: ${MERCHANT_WALLET}`);
    console.log(`   Storage: ${POOL_FILE}`);
    console.log(`   Disk Sync: Every ${DISK_SYNC_INTERVAL/1000}s or on change`);

    try {
        // Load pool into memory on startup
        await loadPoolIntoMemory();
        const poolSize = memoryPool['25']?.length || 0;

        console.log(`\n📊 Pool Status: ${poolSize}/${POOL_SIZE} exchanges (in memory)`);

        if (poolSize > 0) {
            console.log(`✅ Pool ready - instant delivery enabled (<50ms response time)`);
        } else {
            console.log(`⚠️  Pool empty - use POST /admin/init-pool`);
        }

        // Start periodic disk sync
        startPeriodicDiskSync();
        console.log(`🔄 Periodic disk sync started (every ${DISK_SYNC_INTERVAL/1000}s)`);

    } catch (error) {
        console.log(`\n⚠️  Could not load pool status:`, error.message);
    }
    console.log('');
});

// Graceful shutdown - sync to disk before exit
process.on('SIGTERM', async () => {
    console.log('\n⏹ Shutting down gracefully...');
    if (isDirty) {
        console.log('💾 Syncing pool to disk before exit...');
        await syncPoolToDisk();
    }
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('\n⏹ Received SIGINT, shutting down...');
    if (isDirty) {
        console.log('💾 Syncing pool to disk before exit...');
        await syncPoolToDisk();
    }
    process.exit(0);
});
