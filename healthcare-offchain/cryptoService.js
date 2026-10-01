'use strict';

const crypto = require('crypto');

// Default 256-bit encryption key (can be overridden via HEALTHCARE_SECRET_KEY env var)
const DEFAULT_SECRET_KEY = process.env.HEALTHCARE_SECRET_KEY
    ? Buffer.from(process.env.HEALTHCARE_SECRET_KEY, 'hex')
    : crypto.createHash('sha256').update('healthcare-fabric-secret-key-salt-2026').digest();

/**
 * Encrypt sensitive plain text using AES-256-GCM.
 * @param {string} text
 * @param {Buffer} [key]
 * @returns {string} Encrypted bundle in format: iv:authTag:ciphertext (hex)
 */
function encrypt(text, key = DEFAULT_SECRET_KEY) {
    if (text === null || text === undefined) {
        return '';
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(String(text), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt ciphertext using AES-256-GCM.
 * @param {string} encryptedBundle - iv:authTag:ciphertext (hex)
 * @param {Buffer} [key]
 * @returns {string} Plaintext
 */
function decrypt(encryptedBundle, key = DEFAULT_SECRET_KEY) {
    if (!encryptedBundle || typeof encryptedBundle !== 'string') {
        return '';
    }
    const parts = encryptedBundle.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted bundle format, expected iv:authTag:ciphertext');
    }

    const [ivHex, authTagHex, ciphertextHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

/**
 * Compute standard SHA-256 hex hash of any object or string.
 * @param {string|Object} data
 * @returns {string} 64-character SHA-256 hex string
 */
function sha256(data) {
    const content = typeof data === 'object' ? JSON.stringify(data) : String(data);
    return crypto.createHash('sha256').update(content).digest('hex');
}

module.exports = {
    DEFAULT_SECRET_KEY,
    encrypt,
    decrypt,
    sha256
};
