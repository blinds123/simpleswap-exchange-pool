/**
 * Mailosaur OTP Email Service
 *
 * Drop-in replacement for Mail.tm with better domain reputation
 * Mailosaur domains are NOT on disposable email blocklists
 *
 * USAGE:
 * import { createEmail, waitForOTP } from './mailosaur-otp.js';
 *
 * const email = createEmail('exchange123');
 * // ... use email in Mercuryo ...
 * const otp = await waitForOTP(email);
 */

import Mailosaur from 'mailosaur';

// Configuration - Update these with your Mailosaur credentials
const MAILOSAUR_API_KEY = process.env.MAILOSAUR_API_KEY || 'qgh1F7IUmlm4TCb5eGpSZa5P0ZkCxgnH';
const MAILOSAUR_SERVER_ID = process.env.MAILOSAUR_SERVER_ID || 'zgk5fexu';

// Initialize client
const client = new Mailosaur(MAILOSAUR_API_KEY);

/**
 * Create a unique email address for an exchange
 * @param {string} prefix - Optional prefix (e.g., exchange ID)
 * @returns {string} Email address like prefix-timestamp@serverid.mailosaur.net
 */
export function createEmail(prefix = 'exchange') {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${prefix}-${timestamp}-${random}@${MAILOSAUR_SERVER_ID}.mailosaur.net`;
}

/**
 * Wait for OTP email from Mercuryo and extract the 6-digit code
 * @param {string} email - The email address to check
 * @param {number} timeoutMs - How long to wait (default 120s)
 * @returns {Promise<string|null>} The 6-digit OTP code or null
 */
export async function waitForOTP(email, timeoutMs = 120000) {
    const startTime = Date.now();

    console.log(`[MAILOSAUR] Waiting for OTP email to ${email}...`);

    try {
        const message = await client.messages.get(MAILOSAUR_SERVER_ID, {
            sentTo: email
        }, {
            timeout: timeoutMs,
            receivedAfter: new Date(startTime - 5000) // Started just before
        });

        console.log(`[MAILOSAUR] Email received!`);
        console.log(`[MAILOSAUR] From: ${message.from[0]?.email || 'unknown'}`);
        console.log(`[MAILOSAUR] Subject: ${message.subject}`);

        // Method 1: Extract from subject line (most reliable for Mercuryo)
        // Mercuryo uses format: "Your verification code is 12345"
        if (message.subject) {
            const subjectMatch = message.subject.match(/code\s+is\s+(\d{5,6})/i) ||
                                message.subject.match(/(\d{5,6})/);
            if (subjectMatch) {
                console.log(`[MAILOSAUR] OTP (from subject): ${subjectMatch[1]}`);
                return subjectMatch[1];
            }
        }

        // Method 2: Use Mailosaur's automatic OTP extraction
        if (message.text?.codes && message.text.codes.length > 0) {
            const otpCode = message.text.codes[0].value;
            console.log(`[MAILOSAUR] OTP (auto-extracted): ${otpCode}`);
            return otpCode;
        }

        // Method 3: Extract from body - look for actual code pattern
        // Mercuryo format: "confirm the email address:12345"
        const bodyText = message.text?.body || '';
        const mercuryoMatch = bodyText.match(/email\s*address[:\s]*(\d{5,6})/i) ||
                             bodyText.match(/Here's your code[^:]*:\s*(\d{5,6})/i) ||
                             bodyText.match(/verification code[:\s]*(\d{5,6})/i);
        if (mercuryoMatch) {
            console.log(`[MAILOSAUR] OTP (body pattern): ${mercuryoMatch[1]}`);
            return mercuryoMatch[1];
        }

        // Method 4: Generic fallback - first 5-6 digit number in body
        const genericMatch = bodyText.match(/\b(\d{5,6})\b/);
        if (genericMatch) {
            console.log(`[MAILOSAUR] OTP (generic): ${genericMatch[1]}`);
            return genericMatch[1];
        }

        console.log('[MAILOSAUR] No OTP found in email');
        return null;

    } catch (e) {
        if (e.message.includes('timeout')) {
            console.log(`[MAILOSAUR] Timeout - no email received within ${timeoutMs / 1000}s`);
        } else {
            console.log(`[MAILOSAUR] Error: ${e.message}`);
        }
        return null;
    }
}

/**
 * Delete all messages for a specific email (cleanup)
 * @param {string} email - Email address to clean up
 */
export async function cleanupEmail(email) {
    try {
        const messages = await client.messages.list(MAILOSAUR_SERVER_ID, {
            sentTo: email
        });

        for (const msg of messages.items) {
            await client.messages.del(msg.id);
        }
        console.log(`[MAILOSAUR] Cleaned up ${messages.items.length} messages`);
    } catch (e) {
        // Ignore cleanup errors
    }
}

/**
 * Check connection to Mailosaur
 * @returns {Promise<boolean>} True if connected
 */
export async function testConnection() {
    try {
        const servers = await client.servers.list();
        const found = servers.items.find(s => s.id === MAILOSAUR_SERVER_ID);
        if (found) {
            console.log(`[MAILOSAUR] Connected! Server: ${found.name} (${found.id})`);
            return true;
        }
        return false;
    } catch (e) {
        console.log(`[MAILOSAUR] Connection failed: ${e.message}`);
        return false;
    }
}

// Export default object for convenience
export default {
    createEmail,
    waitForOTP,
    cleanupEmail,
    testConnection,
    API_KEY: MAILOSAUR_API_KEY,
    SERVER_ID: MAILOSAUR_SERVER_ID
};
