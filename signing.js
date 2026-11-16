// ============================================================
// signing.js — ECDSA P-256 / SHA-256 cho LGE (config-driven)
// ============================================================
const crypto = require('crypto');

function computeBodyHash(body) {
    let bytes;
    if (body == null) bytes = '';
    else if (typeof body === 'string') bytes = body;
    else bytes = JSON.stringify(JSON.stringify(body));
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function prepareBody(body) {
    if (body == null) return undefined;
    if (typeof body === 'string') return body;
    return JSON.stringify(JSON.stringify(body));
}

/**
 * @param device {installId, fingerprint, keyId, privateKeyPem}
 * @param method 'GET' | 'POST'
 * @param apiPath vd '/download/all'
 * @param body null | object | string
 * @param config {bundleId, appSigningIdentity, signatureAlgorithm}
 */
function sign(device, method, apiPath, body, config) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomUUID().toLowerCase();
    const bodyHash = computeBodyHash(body);

    const message = [
        method.toUpperCase(),
        apiPath,
        timestamp,
        nonce,
        bodyHash,
        device.installId,
        device.fingerprint,
        config.bundleId,
        config.appSigningIdentity
    ].join('\n');

    const s = crypto.createSign('SHA256');
    s.update(message);
    s.end();
    const der = s.sign({ key: device.privateKeyPem, dsaEncoding: 'der' });

    return {
        'x-app-bundle-id': config.bundleId,
        'x-app-signing-identity': config.appSigningIdentity,
        'x-device-fingerprint': device.fingerprint,
        'x-install-id': device.installId,
        'x-signature': der.toString('base64'),
        'x-signature-timestamp': timestamp,
        'x-signature-nonce': nonce,
        'x-signature-key-id': device.keyId,
        'x-signature-algorithm': config.signatureAlgorithm
    };
}

module.exports = { sign, computeBodyHash, prepareBody };