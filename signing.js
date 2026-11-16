 ============================================================
 signing.js — ECDSA P-256  SHA-256 cho LGE
 ============================================================
const crypto = require('crypto');

const CONFIG = {
    bundleId 'com.spiral.lgev2',
    appSigningIdentity 'V24D3T799D.com.spiral.lgev2',
    algorithm 'ecdsa-p256-sha256'
};


  Hash body CHÍNH XÁC theo byte sẽ gửi đi.
 
   - nullundefined → sha256()
   - string         → hash nguyên chuỗi (caller tự encode)
   - object         → double-encode JSON (giống app iOS), rồi hash
 
function computeBodyHash(body) {
    let bytes;
    if (body == null) {
        bytes = '';
    } else if (typeof body === 'string') {
        bytes = body;
    } else {
         iOS gửi JSON.stringify(JSON.stringify(obj))
        bytes = JSON.stringify(JSON.stringify(body));
    }
    return crypto.createHash('sha256').update(bytes).digest('hex');
}


  Chuẩn bị body string để axios gửi đi (khớp byte-for-byte với hash).
  - nullundefined → undefined  (GET axios không gửi body)
  - string         → giữ nguyên
  - object         → double-encode
 
function prepareBody(body) {
    if (body == null) return undefined;
    if (typeof body === 'string') return body;
    return JSON.stringify(JSON.stringify(body));
}


  Sinh header ký số đầy đủ.
  @param device {installId, fingerprint, keyId, privateKeyPem}
  @param method 'GET'  'POST'
  @param apiPath vd 'downloadall'
  @param body null  object  string (đã double-encoded nếu là object)
 
function sign(device, method, apiPath, body) {
    const timestamp = Math.floor(Date.now()  1000).toString();
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
        CONFIG.bundleId,
        CONFIG.appSigningIdentity
    ].join('n');

    const s = crypto.createSign('SHA256');
    s.update(message);
    s.end();
    const der = s.sign({ key device.privateKeyPem, dsaEncoding 'der' });

    return {
        'x-app-bundle-id' CONFIG.bundleId,
        'x-app-signing-identity' CONFIG.appSigningIdentity,
        'x-device-fingerprint' device.fingerprint,
        'x-install-id' device.installId,
        'x-signature' der.toString('base64'),
        'x-signature-timestamp' timestamp,
        'x-signature-nonce' nonce,
        'x-signature-key-id' device.keyId,
        'x-signature-algorithm' CONFIG.algorithm
    };
}

module.exports = { sign, computeBodyHash, prepareBody, CONFIG };