// ============================================================
// server.js — LGE WebApp Proxy v4 (admin-driven + manual test)
// ============================================================
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { sign, prepareBody } = require('./signing');

// ---------- Firebase ----------
const serviceAccount = require(process.env.FIREBASE_KEY_PATH || './firebase-key.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ---------- Express ----------
const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors({ origin: true, credentials: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// DEFAULT CONFIG
// ============================================================
const DEFAULT_CONFIG = {
    appVersion: '1.4.3',
    buildNumber: '43',
    appId: '20H343',
    userAgent: null,
    bundleId: 'com.spiral.lgev2',
    appSigningIdentity: 'V24D3T799D.com.spiral.lgev2',
    signatureAlgorithm: 'ecdsa-p256-sha256',
    lgeBaseUrl: 'https://lgpg-sapi.sucbat.com.vn',
    deviceProfile: null
};

const DEFAULT_DEVICE_PROFILE = {
    powerState: { batteryState: 'unplugged', lowPowerMode: true, batteryLevel: 0.5 },
    getApiLevel: -1,
    getAndroidId: 'unknown',
    getApplicationName: 'LGE 2.0',
    getBatteryLevel: '50%',
    getBrand: 'Apple',
    isCameraPresent: false,
    getCarrier: '--',
    getDeviceId: 'iPhone10,5',
    getDeviceName: 'iPhone',
    getManufacturer: 'Apple',
    getModel: 'iPhone 8 Plus',
    getSystemName: 'iOS',
    getSystemVersion: '16.7.8',
    patchVersion: 'Store',
    isAirplaneMode: false,
    isLocationEnabled: true,
    getSerialNumber: 'unknown',
    getAvailableLocationProviders: {
        isRangingAvailable: true,
        locationServicesEnabled: true,
        significantLocationChangeMonitoringAvailable: true,
        headingAvailable: true
    },
    getFreeDiskStorage: 54077046784,
    getIpAddress: '192.168.1.47',
    getInstallerPackageName: 'Other',
    getMaxMemory: -1,
    getTotalDiskCapacity: 255968497664,
    getTotalMemory: 3118219264,
    getUsedMemory: 171835392,
    isLandscape: false,
    isHeadphonesConnected: false,
    isEmulator: false
};

let runtimeConfig = { ...DEFAULT_CONFIG };

const buildUserAgent = () => runtimeConfig.userAgent?.trim() ||
    `fieldforce/${runtimeConfig.buildNumber} CFNetwork/1410.1 Darwin/22.6.0`;

async function loadRuntimeConfig() {
    try {
        const doc = await db.collection('admin_config').doc('settings').get();
        const c = doc.exists ? doc.data() : {};

        runtimeConfig = {
            appVersion: c.appVersion || DEFAULT_CONFIG.appVersion,
            buildNumber: /^\d+$/.test(String(c.buildNumber || ''))
                ? String(c.buildNumber) : DEFAULT_CONFIG.buildNumber,
            appId: c.appId || DEFAULT_CONFIG.appId,
            userAgent: c.userAgent || null,
            bundleId: c.bundleId || DEFAULT_CONFIG.bundleId,
            appSigningIdentity: c.appSigningIdentity || DEFAULT_CONFIG.appSigningIdentity,
            signatureAlgorithm: c.signatureAlgorithm || DEFAULT_CONFIG.signatureAlgorithm,
            lgeBaseUrl: c.lgeBaseUrl || DEFAULT_CONFIG.lgeBaseUrl,
            deviceProfile: c.deviceProfile || null
        };
    } catch (e) {
        console.error('[loadRuntimeConfig]', e.message);
        runtimeConfig = { ...DEFAULT_CONFIG };
    }
}
loadRuntimeConfig();
setInterval(loadRuntimeConfig, 30_000).unref();

// ============================================================
// BASE HEADERS
// ============================================================
const getBaseHeaders = (token) => ({
    "Accept-Encoding": "gzip, deflate, br",
    "Accept": "application/json",
    "Accept-Language": "vi-VN,vi;q=0.9",
    "Authorization": token ? `Bearer ${token}` : '',
    "User-Agent": buildUserAgent(),
    "Connection": "keep-alive",
    "Content-Type": "application/json",
    "x-app-bundle-id": runtimeConfig.bundleId
});

// ============================================================
// HELPERS
// ============================================================
const normalizeIMEI = (raw) => {
    if (typeof raw !== 'string') return null;
    const c = raw.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (c.length !== 32) return null;
    return `${c.slice(0,8)}-${c.slice(8,12)}-${c.slice(12,16)}-${c.slice(16,20)}-${c.slice(20)}`;
};

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

// ============================================================
// RATE LIMITER
// ============================================================
const rlMap = new Map();
const RL_WIN = 15 * 60_000, RL_MAX = 10;
function loginRateLimiter(req, res, next) {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let e = rlMap.get(ip);
    if (!e || now > e.resetAt) e = { count: 0, resetAt: now + RL_WIN };
    if (e.count >= RL_MAX) {
        return res.status(429).json({ success: false, error: `Thử lại sau ${Math.ceil((e.resetAt-now)/60000)} phút.` });
    }
    e.count++; rlMap.set(ip, e); next();
}
setInterval(() => {
    const n = Date.now();
    for (const [k, e] of rlMap.entries()) if (n > e.resetAt + 60_000) rlMap.delete(k);
}, 5 * 60_000).unref();

// ============================================================
// SESSION
// ============================================================
async function createSession(username, token) {
    if (!token) return;
    await db.collection('sessions').doc(hashToken(token)).set({
        username: username.toLowerCase(),
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString()
    });
}
async function verifySession(username, token) {
    if (!username || !token) return false;
    const d = await db.collection('sessions').doc(hashToken(token)).get();
    return d.exists && d.data().username === username.toLowerCase();
}
const touchCache = new Map();
function touchSession(token) {
    if (!token) return;
    const h = hashToken(token);
    if (Date.now() - (touchCache.get(h) || 0) < 5 * 60_000) return;
    touchCache.set(h, Date.now());
    db.collection('sessions').doc(h).update({ lastSeenAt: new Date().toISOString() }).catch(() => {});
}

// ============================================================
// SIGNING KEYS — auto-regen khi bundleId thay đổi
// ============================================================
async function ensureSigningKeys(deviceRef, deviceData, token) {
    const hasKeys = deviceData?.privateKeyPem && deviceData?.installId
        && deviceData?.fingerprint && deviceData?.keyId;
    const bundleMatches = deviceData?.signedWithBundleId === runtimeConfig.bundleId;

    if (hasKeys && bundleMatches) return deviceData;
    if (hasKeys && !bundleMatches) {
        console.log(`[keys] Bundle changed for ${deviceRef.id} → regenerate`);
    }

    const { privateKey, publicKey: pubDer } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    const pointBytes = pubDer.subarray(pubDer.length - 65);
    const publicKeyBase64 = pointBytes.toString('base64');
    const fingerprint = crypto.createHash('sha256').update(pointBytes).digest('hex');
    const keyId = fingerprint;
    const installId = crypto.randomUUID();

    try {
        const regResp = await axios.post(runtimeConfig.lgeBaseUrl + '/security/registerpublickey', {
            appVersion: runtimeConfig.appVersion,
            algorithm: runtimeConfig.signatureAlgorithm,
            installId,
            type: 'register_public_key',
            appSigningIdentity: runtimeConfig.appSigningIdentity,
            appId: runtimeConfig.bundleId,
            keyId,
            platform: 'ios',
            deviceFingerprint: fingerprint,
            publicKey: publicKeyBase64
        }, { headers: getBaseHeaders(token) });
        console.log(`[registerpublickey] ${regResp.status} ${regResp.data?.messager || ''}`);
    } catch (e) {
        console.error('[registerpublickey] FAILED:', e.response?.data || e.message);
        throw e;
    }

    const updates = {
        installId, fingerprint, keyId,
        privateKeyPem: privateKey,
        publicKeyBase64,
        signedWithBundleId: runtimeConfig.bundleId,
        signingKeysCreatedAt: new Date().toISOString()
    };
    if (deviceData) await deviceRef.update(updates);
    else await deviceRef.set(updates, { merge: true });

    return { ...(deviceData || {}), ...updates };
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
const checkTesterAccess = async (req, res, next) => {
    const { request_user, token } = req.body;
    if (!request_user) return res.status(403).json({ success: false, error: 'Thiếu request_user', isExpired: true });
    if (!token) return res.status(403).json({ success: false, error: 'Thiếu token', isExpired: true });
    try {
        const norm = request_user.toLowerCase();
        const tDoc = await db.collection('testers').doc(norm).get();
        if (!tDoc.exists) return res.status(403).json({ success: false, error: 'Bị gỡ quyền', isExpired: true });
        const t = tDoc.data();
        if (t.expiresAt != null && Date.now() > t.expiresAt)
            return res.status(403).json({ success: false, error: 'Hết hạn', isExpired: true });
        if (!(await verifySession(norm, token)))
            return res.status(403).json({ success: false, error: 'Phiên không hợp lệ', isExpired: true });
        touchSession(token);
        req.deviceUser = norm;
        next();
    } catch (e) {
        console.error('[checkTesterAccess]', e);
        res.status(500).json({ success: false, error: 'Lỗi whitelist' });
    }
};

async function getDevice(user) {
    const doc = await db.collection('devices').doc(user).get();
    if (!doc.exists) throw new Error('Device chưa tồn tại');
    const d = doc.data();
    if (!d.privateKeyPem) throw new Error('Chưa có signing key');
    return d;
}

// ============================================================
// PUBLIC
// ============================================================
app.get('/api/version', (req, res) => res.json({
    success: true,
    data: {
        ...runtimeConfig,
        version: runtimeConfig.appVersion,
        versionId: runtimeConfig.buildNumber
    }
}));

app.get('/api/lge-appver', async (req, res) => {
    try {
        const r = await axios.get(runtimeConfig.lgeBaseUrl + '/public/appver', {
            headers: { 'Accept': 'application/json', 'User-Agent': buildUserAgent() },
            timeout: 8000
        });
        res.json({ success: true, version: r.data?.messager || null });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

// ============================================================
// LOGIN — lưu healthProbeToken cho admin test
// ============================================================
app.post('/proxy-login', loginRateLimiter, async (req, res) => {
    const { payload } = req.body;
    if (!payload?.username) return res.status(400).json({ success: false, error: 'Payload không hợp lệ' });
    const requestUser = payload.username.trim().toLowerCase();

    try {
        const tDoc = await db.collection('testers').doc(requestUser).get();
        if (!tDoc.exists) return res.status(403).json({ success: false, error: 'Chưa được cấp quyền' });
        const t = tDoc.data();
        let expireText = 'Vĩnh viễn';
        if (t.expiresAt != null) {
            if (Date.now() > t.expiresAt) return res.status(403).json({ success: false, error: 'Đã hết hạn' });
            expireText = `còn ${Math.max(0, Math.ceil((t.expiresAt - Date.now()) / 86400000))} ngày`;
        }

        const deviceRef = db.collection('devices').doc(requestUser);
        const dDoc = await deviceRef.get();
        let deviceData = dDoc.exists ? dDoc.data() : null;
        let imei = deviceData?.imei;
        let deviceToken = deviceData?.deviceToken;

        if (!imei) {
            const clientIMEI = normalizeIMEI(payload.IMEI);
            if (!clientIMEI) return res.status(400).json({
                success: false, needIMEI: true,
                error: 'Vui lòng nhập IMEI (UUID)'
            });
            imei = clientIMEI;
            deviceToken = deviceToken ||
                (crypto.randomUUID().replace(/-/g, '') + ':' + crypto.randomUUID().replace(/-/g, ''));
            await deviceRef.set({
                imei, deviceToken,
                createdAt: deviceData?.createdAt || new Date().toISOString(),
                imeiUpdatedAt: new Date().toISOString()
            }, { merge: true });
            deviceData = { ...(deviceData || {}), imei, deviceToken };
        }

        const lgePayload = {
            username: payload.username,
            client_time: payload.client_time,
            password: payload.password,
            DeviceToken: deviceToken,
            Platform: 'ios',
            IMEI: imei,
            AppId: runtimeConfig.appId,
            versionid: runtimeConfig.buildNumber
        };

        const resp = await axios.post(runtimeConfig.lgeBaseUrl + '/users/login', lgePayload, {
            headers: getBaseHeaders(null),
            timeout: 30000
        });

        if (!resp.data?.token) return res.status(resp.status).json({ success: false, error: resp.data });

        await createSession(requestUser, resp.data.token);

        // Lưu token cho admin test button.
        // ⚠️ Bảo mật: token này có quyền gọi API. Firestore phải được bảo vệ.
        // Nếu app mở rộng quy mô → mã hóa bằng key từ env hoặc chuyển sang TTL 7 ngày.
        try {
            await deviceRef.set({
                healthProbeToken: resp.data.token,
                healthProbeAt: new Date().toISOString()
            }, { merge: true });
        } catch (e) {
            console.warn(`[login] Không lưu được healthProbeToken cho ${requestUser}:`, e.message);
        }

        try {
            await ensureSigningKeys(deviceRef, deviceData, resp.data.token);
        } catch (e) {
            console.error(`[login] Key setup FAILED ${requestUser}:`, e.message);
        }

        res.json({
            success: true,
            data: resp.data,
            expireText,
            versionInfo: {
                appVersion: runtimeConfig.appVersion,
                buildNumber: runtimeConfig.buildNumber,
                appId: runtimeConfig.appId
            }
        });
    } catch (error) {
        console.error('[proxy-login]', error.message);
        res.status(error.response?.status || 500).json({
            success: false, error: error.response?.data || error.message
        });
    }
});

// ============================================================
// SIGNED PROXIES
// ============================================================
app.post('/proxy-checkdevice', checkTesterAccess, async (req, res) => {
    try {
        const device = await getDevice(req.deviceUser);
        const apiPath = '/employee/checkdevice';
        const profile = runtimeConfig.deviceProfile || DEFAULT_DEVICE_PROFILE;
        const now = new Date();
        const yesterday = new Date(now.getTime() - 86400_000);

        const info = {
            ...profile,
            deviceId: device.imei,
            getBuildNumber: runtimeConfig.buildNumber,
            getBundleId: runtimeConfig.bundleId,
            getVersion: runtimeConfig.appVersion,
            getFirstInstallTime: profile.getFirstInstallTime || yesterday.toISOString(),
            getLastUpdateTime: profile.getLastUpdateTime || yesterday.toISOString()
        };
        const bodyStr = prepareBody(info);
        const headers = { ...getBaseHeaders(req.body.token), ...sign(device, 'POST', apiPath, bodyStr, runtimeConfig) };
        const r = await axios.post(runtimeConfig.lgeBaseUrl + apiPath, bodyStr, { headers, timeout: 15000 });
        res.json({ success: true, data: r.data });
    } catch (e) {
        res.status(e.response?.status || 500).json({ success: false, error: e.response?.data || e.message });
    }
});

app.post('/proxy-plan', checkTesterAccess, async (req, res) => {
    try {
        const device = await getDevice(req.deviceUser);
        const apiPath = '/dashboard/lgplanbyplan';
        const d = req.body.planDate || new Date().toISOString().slice(0, 10);
        const bodyStr = prepareBody({ pageNum: 0, planDate: d });
        const headers = { ...getBaseHeaders(req.body.token), ...sign(device, 'POST', apiPath, bodyStr, runtimeConfig) };
        const r = await axios.post(runtimeConfig.lgeBaseUrl + apiPath, bodyStr, { headers, timeout: 30000 });
        res.json({ success: true, data: r.data });
    } catch (e) {
        res.status(e.response?.status || 500).json({ success: false, error: e.response?.data || e.message });
    }
});

app.post('/proxy-upload', checkTesterAccess, async (req, res) => {
    try {
        const device = await getDevice(req.deviceUser);
        const apiPath = '/attendants/upload';
        const bodyStr = prepareBody(req.body.payload);
        const headers = { ...getBaseHeaders(req.body.token), ...sign(device, 'POST', apiPath, bodyStr, runtimeConfig) };
        const r = await axios.post(runtimeConfig.lgeBaseUrl + apiPath, bodyStr, {
            headers, timeout: 60000, maxContentLength: 30 * 1024 * 1024
        });
        res.json({ success: true, data: r.data });
    } catch (e) {
        res.status(e.response?.status || 500).json({ success: false, error: e.response?.data || e.message });
    }
});

const makeSignedGet = (apiPath, extraHeadersFn) => async (req, res) => {
    try {
        const device = await getDevice(req.deviceUser);
        const headers = {
            ...getBaseHeaders(req.body.token),
            ...sign(device, 'GET', apiPath, null, runtimeConfig),
            ...(extraHeadersFn ? extraHeadersFn(req) : {})
        };
        const r = await axios.get(runtimeConfig.lgeBaseUrl + apiPath, {
            headers, timeout: 60000, maxContentLength: 20 * 1024 * 1024
        });
        res.json({ success: true, data: r.data });
    } catch (e) {
        res.status(e.response?.status || 500).json({ success: false, error: e.response?.data || e.message });
    }
};

app.post('/proxy-download-all', checkTesterAccess, makeSignedGet('/download/all'));
app.post('/proxy-download-menu', checkTesterAccess, makeSignedGet('/download/listMenu'));
app.post('/proxy-get-shops', checkTesterAccess, makeSignedGet('/shops/storemaintant'));
app.post('/proxy-get-history', checkTesterAccess, makeSignedGet('/attendants/byshop', (req) => ({
    'shopid': '0',
    'attendantdate': req.body.date
})));

app.post('/proxy-verify-session', checkTesterAccess, (req, res) => res.json({ success: true }));

// ============================================================
// ADMIN — AUTH
// ============================================================
const verifyAdmin = async (req, res, next) => {
    const pass = req.headers.admin_pass;
    if (!pass) return res.status(401).json({ success: false, error: 'Thiếu mật khẩu' });
    try {
        const d = await db.collection('admin_config').doc('settings').get();
        if (!d.exists || d.data().password !== pass)
            return res.status(401).json({ success: false, error: 'Sai mật khẩu' });
        next();
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

app.post('/admin/verify', async (req, res) => {
    try {
        const { admin_pass } = req.body;
        if (!admin_pass) return res.status(401).json({ success: false, error: 'Thiếu mật khẩu' });
        const d = await db.collection('admin_config').doc('settings').get();
        if (!d.exists || d.data().password !== admin_pass)
            return res.status(401).json({ success: false, error: 'Sai mật khẩu' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============================================================
// ADMIN — TEST SIGNING (NEW)
// ============================================================
app.post('/admin/test-signing', verifyAdmin, async (req, res) => {
    const t0 = Date.now();
    try {
        // 1) Xác định user để test
        let targetUser = (req.body?.username || '').trim().toLowerCase();

        if (!targetUser) {
            const snap = await db.collection('devices')
                .where('privateKeyPem', '!=', null)
                .limit(1).get();
            if (snap.empty) {
                return res.json({
                    success: false,
                    error: 'Không có user nào có signing key. Hãy login 1 user trước.'
                });
            }
            targetUser = snap.docs[0].id;
        }

        // 2) Lấy device info
        const deviceDoc = await db.collection('devices').doc(targetUser).get();
        if (!deviceDoc.exists) {
            return res.json({ success: false, error: `User "${targetUser}" không tồn tại trong devices` });
        }
        const device = deviceDoc.data();
        if (!device.privateKeyPem) {
            return res.json({ success: false, error: `User "${targetUser}" chưa có signing key — login lại user này` });
        }
        if (!device.healthProbeToken) {
            return res.json({
                success: false,
                error: `User "${targetUser}" chưa có probe token. Login lại user này 1 lần.`,
                hint: 'healthProbeToken được lưu tự động khi user đăng nhập'
            });
        }

        // 3) Chuẩn bị tests
        const planDate = new Date().toISOString().slice(0, 10);
        const planBody = prepareBody({ pageNum: 0, planDate });

        const tests = [
            {
                name: 'GET /download/listMenu',
                method: 'GET',
                path: '/download/listMenu',
                body: null,
                timeout: 15000
            },
            {
                name: 'POST /dashboard/lgplanbyplan',
                method: 'POST',
                path: '/dashboard/lgplanbyplan',
                body: planBody,
                timeout: 15000
            }
        ];

        const results = [];

        // 4) Chạy từng test
        for (const t of tests) {
            const st = Date.now();
            try {
                const headers = {
                    ...getBaseHeaders(device.healthProbeToken),
                    ...sign(device, t.method, t.path, t.body, runtimeConfig)
                };

                let r;
                if (t.method === 'GET') {
                    r = await axios.get(runtimeConfig.lgeBaseUrl + t.path, { headers, timeout: t.timeout });
                } else {
                    r = await axios.post(runtimeConfig.lgeBaseUrl + t.path, t.body, { headers, timeout: t.timeout });
                }

                results.push({
                    name: t.name,
                    ok: true,
                    status: r.status,
                    duration: Date.now() - st,
                    preview: (typeof r.data === 'object' ? JSON.stringify(r.data) : String(r.data)).slice(0, 120)
                });
            } catch (e) {
                const errData = e.response?.data;
                results.push({
                    name: t.name,
                    ok: false,
                    status: e.response?.status || 0,
                    duration: Date.now() - st,
                    error: typeof errData === 'object' ? JSON.stringify(errData).slice(0, 300) : String(errData || e.message).slice(0, 300)
                });
            }
        }

        const allOk = results.every(r => r.ok);
        const bundleMatch = device.signedWithBundleId === runtimeConfig.bundleId;

        // 5) Chẩn đoán
        let diagnosis = '';
        if (allOk) {
            if (!bundleMatch) {
                diagnosis = `Chữ ký hợp lệ NHƯNG device đang ký với bundleId "${device.signedWithBundleId || '(chưa track)'}" khác runtime "${runtimeConfig.bundleId}". Nên reset key user này để đồng bộ.`;
            } else {
                diagnosis = 'Chữ ký hợp lệ — mọi thứ OK.';
            }
        } else {
            const failed = results.filter(r => !r.ok);
            const status401 = failed.some(r => r.status === 401 || r.status === 403);
            const status404 = failed.some(r => r.status === 404);
            const noStatus = failed.some(r => r.status === 0);

            if (noStatus) {
                diagnosis = '🔌 Không kết nối được LGE. Kiểm tra LGE Base URL hoặc mạng.';
            } else if (status404) {
                diagnosis = '🌐 Endpoint không tồn tại — LGE có thể đã đổi path hoặc domain.';
            } else if (status401) {
                const errStr = failed.map(r => r.error || '').join(' ').toLowerCase();
                if (errStr.includes('signature')) {
                    diagnosis = '🚨 SIGNATURE INVALID — Format chữ ký có thể đã đổi, hoặc key không khớp. Kiểm tra body encoding (single vs double), field order, algorithm.';
                } else if (errStr.includes('expired') || errStr.includes('token')) {
                    diagnosis = '⏰ Token hết hạn — login lại user test để có healthProbeToken mới.';
                } else {
                    diagnosis = '🔑 Auth fail — kiểm tra bundleId/signingIdentity có khớp LGE không.';
                }
            } else {
                diagnosis = `⚠️ Lỗi phía LGE (HTTP ${failed[0].status}) — xem chi tiết bên dưới.`;
            }
        }

        res.json({
            success: allOk,
            user: targetUser,
            bundleId: runtimeConfig.bundleId,
            signedWith: device.signedWithBundleId || null,
            bundleMatch,
            installId: device.installId,
            algorithm: runtimeConfig.signatureAlgorithm,
            tests: results,
            diagnosis,
            totalDuration: Date.now() - t0
        });
    } catch (e) {
        console.error('[/admin/test-signing]', e);
        res.status(500).json({
            success: false,
            error: e.message,
            totalDuration: Date.now() - t0
        });
    }
});

// ============================================================
// ADMIN — VERSION CONFIG
// ============================================================
app.get('/admin/config/version', verifyAdmin, async (req, res) => {
    try {
        const d = await db.collection('admin_config').doc('settings').get();
        const c = d.exists ? d.data() : {};
        res.json({
            success: true,
            data: {
                appVersion: c.appVersion || '',
                buildNumber: c.buildNumber || '',
                appId: c.appId || '',
                userAgent: c.userAgent || '',
                runtime: { ...runtimeConfig, userAgent: buildUserAgent() },
                defaults: DEFAULT_CONFIG
            }
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/admin/config/version', verifyAdmin, async (req, res) => {
    try {
        const { appVersion, buildNumber, appId, userAgent } = req.body;
        const update = {};
        if (appVersion !== undefined) {
            const v = String(appVersion).trim();
            if (v && !/^\d+\.\d+\.\d+$/.test(v))
                return res.status(400).json({ success: false, error: 'App Version phải X.Y.Z' });
            update.appVersion = v || admin.firestore.FieldValue.delete();
        }
        if (buildNumber !== undefined) {
            const b = String(buildNumber).trim();
            if (b && !/^\d+$/.test(b))
                return res.status(400).json({ success: false, error: 'Build phải số nguyên' });
            update.buildNumber = b || admin.firestore.FieldValue.delete();
        }
        if (appId !== undefined) update.appId = String(appId).trim() || admin.firestore.FieldValue.delete();
        if (userAgent !== undefined) update.userAgent = String(userAgent).trim() || admin.firestore.FieldValue.delete();
        await db.collection('admin_config').doc('settings').set(update, { merge: true });
        await loadRuntimeConfig();
        res.json({ success: true, runtime: { ...runtimeConfig, userAgent: buildUserAgent() } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/admin/config/version/reset', verifyAdmin, async (req, res) => {
    try {
        await db.collection('admin_config').doc('settings').set({
            appVersion: admin.firestore.FieldValue.delete(),
            buildNumber: admin.firestore.FieldValue.delete(),
            appId: admin.firestore.FieldValue.delete(),
            userAgent: admin.firestore.FieldValue.delete()
        }, { merge: true });
        await loadRuntimeConfig();
        res.json({ success: true, runtime: { ...runtimeConfig, userAgent: buildUserAgent() } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/admin/config/version/lge', verifyAdmin, async (req, res) => {
    try {
        const r = await axios.get(runtimeConfig.lgeBaseUrl + '/public/appver', {
            headers: { 'Accept': 'application/json', 'User-Agent': buildUserAgent() },
            timeout: 8000
        });
        res.json({ success: true, data: { lgeVersion: r.data?.messager, raw: r.data } });
    } catch (e) { res.json({ success: false, error: e.message, hint: e.response?.data }); }
});

// ============================================================
// ADMIN — SIGNING CONFIG
// ============================================================
app.get('/admin/config/signing', verifyAdmin, async (req, res) => {
    try {
        const d = await db.collection('admin_config').doc('settings').get();
        const c = d.exists ? d.data() : {};
        res.json({
            success: true,
            data: {
                bundleId: c.bundleId || '',
                appSigningIdentity: c.appSigningIdentity || '',
                signatureAlgorithm: c.signatureAlgorithm || '',
                lgeBaseUrl: c.lgeBaseUrl || '',
                deviceProfile: c.deviceProfile || null,
                runtime: {
                    bundleId: runtimeConfig.bundleId,
                    appSigningIdentity: runtimeConfig.appSigningIdentity,
                    signatureAlgorithm: runtimeConfig.signatureAlgorithm,
                    lgeBaseUrl: runtimeConfig.lgeBaseUrl,
                    deviceProfile: runtimeConfig.deviceProfile
                },
                defaults: {
                    bundleId: DEFAULT_CONFIG.bundleId,
                    appSigningIdentity: DEFAULT_CONFIG.appSigningIdentity,
                    signatureAlgorithm: DEFAULT_CONFIG.signatureAlgorithm,
                    lgeBaseUrl: DEFAULT_CONFIG.lgeBaseUrl,
                    defaultDeviceProfile: DEFAULT_DEVICE_PROFILE
                }
            }
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/admin/config/signing', verifyAdmin, async (req, res) => {
    try {
        const { bundleId, appSigningIdentity, signatureAlgorithm, lgeBaseUrl } = req.body;
        const update = {};

        if (bundleId !== undefined) {
            const v = String(bundleId).trim();
            if (v && !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(v))
                return res.status(400).json({ success: false, error: 'Bundle ID không hợp lệ (vd: com.spiral.lgev2)' });
            update.bundleId = v || admin.firestore.FieldValue.delete();
        }
        if (appSigningIdentity !== undefined) {
            const v = String(appSigningIdentity).trim();
            if (v && !/^[A-Z0-9]{10}\.[a-z][a-z0-9.]*$/.test(v))
                return res.status(400).json({ success: false, error: 'App Signing Identity phải dạng XXXXXXXXXX.bundle.id' });
            update.appSigningIdentity = v || admin.firestore.FieldValue.delete();
        }
        if (signatureAlgorithm !== undefined) {
            const v = String(signatureAlgorithm).trim().toLowerCase();
            const allowed = ['ecdsa-p256-sha256'];
            if (v && !allowed.includes(v))
                return res.status(400).json({ success: false, error: `Algorithm phải là: ${allowed.join(', ')}` });
            update.signatureAlgorithm = v || admin.firestore.FieldValue.delete();
        }
        if (lgeBaseUrl !== undefined) {
            const v = String(lgeBaseUrl).trim();
            if (v && !/^https?:\/\/.+/.test(v))
                return res.status(400).json({ success: false, error: 'LGE Base URL phải dạng https://...' });
            update.lgeBaseUrl = v || admin.firestore.FieldValue.delete();
        }

        await db.collection('admin_config').doc('settings').set(update, { merge: true });
        await loadRuntimeConfig();

        const changedIdentity = update.bundleId !== undefined || update.appSigningIdentity !== undefined;
        res.json({
            success: true,
            runtime: {
                bundleId: runtimeConfig.bundleId,
                appSigningIdentity: runtimeConfig.appSigningIdentity,
                signatureAlgorithm: runtimeConfig.signatureAlgorithm,
                lgeBaseUrl: runtimeConfig.lgeBaseUrl
            },
            warning: changedIdentity
                ? 'Bundle ID / Signing Identity đã đổi → bấm "Reset toàn bộ Signing Keys" và yêu cầu user đăng nhập lại.'
                : null
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/admin/config/device-profile', verifyAdmin, async (req, res) => {
    try {
        const { deviceProfile } = req.body;
        if (deviceProfile === null) {
            await db.collection('admin_config').doc('settings').set({
                deviceProfile: admin.firestore.FieldValue.delete()
            }, { merge: true });
            await loadRuntimeConfig();
            return res.json({ success: true, message: 'Reset về iPhone 8 Plus mặc định' });
        }
        if (typeof deviceProfile !== 'object')
            return res.status(400).json({ success: false, error: 'deviceProfile phải là JSON object' });
        await db.collection('admin_config').doc('settings').set({ deviceProfile }, { merge: true });
        await loadRuntimeConfig();
        res.json({ success: true, runtime: runtimeConfig.deviceProfile });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/admin/signing/reset-all-keys', verifyAdmin, async (req, res) => {
    try {
        const snap = await db.collection('devices').get();
        let count = 0;
        for (const doc of snap.docs) {
            await doc.ref.update({
                privateKeyPem: admin.firestore.FieldValue.delete(),
                publicKeyBase64: admin.firestore.FieldValue.delete(),
                installId: admin.firestore.FieldValue.delete(),
                fingerprint: admin.firestore.FieldValue.delete(),
                keyId: admin.firestore.FieldValue.delete(),
                signedWithBundleId: admin.firestore.FieldValue.delete(),
                signingKeysCreatedAt: admin.firestore.FieldValue.delete()
            });
            count++;
        }
        res.json({ success: true, message: `Đã xoá signing keys của ${count} devices. User cần login lại.` });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/admin/signing/reset-user/:user', verifyAdmin, async (req, res) => {
    try {
        const norm = req.params.user.toLowerCase();
        await db.collection('devices').doc(norm).update({
            privateKeyPem: admin.firestore.FieldValue.delete(),
            publicKeyBase64: admin.firestore.FieldValue.delete(),
            installId: admin.firestore.FieldValue.delete(),
            fingerprint: admin.firestore.FieldValue.delete(),
            keyId: admin.firestore.FieldValue.delete(),
            signedWithBundleId: admin.firestore.FieldValue.delete(),
            signingKeysCreatedAt: admin.firestore.FieldValue.delete()
        });
        res.json({ success: true, message: `Đã reset keys của ${norm}` });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============================================================
// ADMIN — TESTERS
// ============================================================
app.get('/admin/testers', verifyAdmin, async (req, res) => {
    try {
        const snap = await db.collection('testers').get();
        const arr = await Promise.all(snap.docs.map(async (doc) => {
            const u = doc.data();
            const d = (await db.collection('devices').doc(doc.id).get()).data() || {};
            return {
                username: doc.id,
                note: u.note || '',
                addedAt: u.addedAt,
                expiresAt: u.expiresAt,
                imei: d.imei || '',
                deviceToken: d.deviceToken || '',
                deviceCreatedAt: d.createdAt || null,
                hasSigningKey: !!d.privateKeyPem,
                installId: d.installId || null,
                signedWithBundleId: d.signedWithBundleId || null,
                bundleMatch: d.signedWithBundleId === runtimeConfig.bundleId,
                hasProbeToken: !!d.healthProbeToken
            };
        }));
        arr.sort((a, b) => a.username.localeCompare(b.username));
        res.json({ success: true, data: arr, currentBundleId: runtimeConfig.bundleId });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/admin/testers', verifyAdmin, async (req, res) => {
    try {
        const { username, note, expiresAt, imei } = req.body;
        if (!username) return res.status(400).json({ success: false, error: 'Username rỗng' });
        const norm = String(username).trim().toLowerCase();
        const ref = db.collection('testers').doc(norm);
        if ((await ref.get()).exists) return res.status(409).json({ success: false, error: 'Đã tồn tại' });
        await ref.set({ note: note || '', expiresAt: expiresAt || null, addedAt: Date.now() });
        if (imei) {
            const clean = normalizeIMEI(imei);
            if (clean) {
                await db.collection('devices').doc(norm).set({
                    imei: clean,
                    deviceToken: crypto.randomUUID().replace(/-/g, '') + ':' + crypto.randomUUID().replace(/-/g, ''),
                    createdAt: new Date().toISOString()
                }, { merge: true });
            }
        }
        res.json({ success: true, message: `Đã thêm ${norm}` });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/admin/testers/:user', verifyAdmin, async (req, res) => {
    try {
        const norm = req.params.user.toLowerCase();
        const { note, expiresAt, imei } = req.body;
        const update = {};
        if (note !== undefined) update.note = note;
        if (expiresAt !== undefined) update.expiresAt = expiresAt;
        await db.collection('testers').doc(norm).set(update, { merge: true });
        if (imei) {
            const clean = normalizeIMEI(imei);
            if (clean) await db.collection('devices').doc(norm).set({
                imei: clean, imeiUpdatedAt: new Date().toISOString()
            }, { merge: true });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/admin/testers/:user', verifyAdmin, async (req, res) => {
    try {
        const norm = req.params.user.toLowerCase();
        await db.collection('testers').doc(norm).delete();
        await db.collection('devices').doc(norm).delete().catch(() => {});
        res.json({ success: true, message: `Đã xoá ${norm}` });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/admin/devices/:user', verifyAdmin, async (req, res) => {
    try {
        const norm = req.params.user.toLowerCase();
        await db.collection('devices').doc(norm).delete().catch(() => {});
        res.json({ success: true, message: `Đã reset device ${norm}` });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============================================================
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
    console.log(`[server] :${PORT}`);
});