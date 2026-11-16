// ============================================================
// server.js — LGE WebApp Proxy + Signing + Admin
// ============================================================
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { sign, prepareBody, CONFIG } = require('./signing');

// ---------- Firebase ----------
const serviceAccount = require(process.env.FIREBASE_KEY_PATH || './firebase-key.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ---------- Express ----------
const app = express();
const PORT = process.env.PORT || 3000;
const LGE_BASE = 'https://lgpg-sapi.sucbat.com.vn';

app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors({ origin: true, credentials: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// RUNTIME CONFIG
// ============================================================
const DEFAULT_CONFIG = { appVersion: '1.4.3', buildNumber: '43', appId: '20H343', userAgent: null };
let runtimeConfig = { ...DEFAULT_CONFIG };

const buildUserAgent = () => runtimeConfig.userAgent?.trim() ||
    `fieldforce/${runtimeConfig.buildNumber} CFNetwork/1410.1 Darwin/22.6.0`;

async function loadRuntimeConfig() {
    try {
        const doc = await db.collection('admin_config').doc('settings').get();
        if (doc.exists) {
            const c = doc.data();
            runtimeConfig = {
                appVersion: typeof c.appVersion === 'string' ? c.appVersion : DEFAULT_CONFIG.appVersion,
                buildNumber: /^\d+$/.test(String(c.buildNumber || '')) ? String(c.buildNumber) : DEFAULT_CONFIG.buildNumber,
                appId: typeof c.appId === 'string' ? c.appId : DEFAULT_CONFIG.appId,
                userAgent: c.userAgent || null
            };
        } else {
            runtimeConfig = { ...DEFAULT_CONFIG };
        }
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
    "x-app-bundle-id": CONFIG.bundleId
});

// ============================================================
// UTILS
// ============================================================
const isValidIMEI = (s) =>
    typeof s === 'string' && /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(s);

const normalizeIMEI = (raw) => {
    if (typeof raw !== 'string') return null;
    const c = raw.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (c.length !== 32) return null;
    return `${c.slice(0,8)}-${c.slice(8,12)}-${c.slice(12,16)}-${c.slice(16,20)}-${c.slice(20)}`;
};

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

// ============================================================
// RATE LIMITER (login)
// ============================================================
const rateLimitMap = new Map();
const RL_WINDOW = 15 * 60_000, RL_MAX = 10;

function loginRateLimiter(req, res, next) {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let e = rateLimitMap.get(ip);
    if (!e || now > e.resetAt) e = { count: 0, resetAt: now + RL_WINDOW };
    if (e.count >= RL_MAX) {
        return res.status(429).json({
            success: false,
            error: `Quá nhiều lần thử đăng nhập. Thử lại sau ${Math.ceil((e.resetAt - now)/60000)} phút.`
        });
    }
    e.count++;
    rateLimitMap.set(ip, e);
    next();
}
setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of rateLimitMap.entries())
        if (now > e.resetAt + 60_000) rateLimitMap.delete(ip);
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
setInterval(() => {
    const now = Date.now();
    for (const [k, t] of touchCache.entries()) if (now - t > 20 * 60_000) touchCache.delete(k);
}, 10 * 60_000).unref();

// ============================================================
// SIGNING KEY MANAGEMENT
// ============================================================
async function ensureSigningKeys(deviceRef, deviceData, token) {
    if (deviceData?.privateKeyPem && deviceData?.installId
        && deviceData?.fingerprint && deviceData?.keyId) {
        return deviceData;
    }

    const { privateKey, publicKey: pubDer } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    // SPKI DER = 26 header + 65 uncompressed point → lấy 65 byte cuối
    const pointBytes = pubDer.subarray(pubDer.length - 65);
    const publicKeyBase64 = pointBytes.toString('base64');
    const fingerprint = crypto.createHash('sha256').update(pointBytes).digest('hex');
    const keyId = fingerprint;
    const installId = crypto.randomUUID();

    try {
        const regResp = await axios.post(LGE_BASE + '/security/registerpublickey', {
            appVersion: runtimeConfig.appVersion,
            algorithm: CONFIG.algorithm,
            installId,
            type: 'register_public_key',
            appSigningIdentity: CONFIG.appSigningIdentity,
            appId: CONFIG.bundleId,
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
        const testerDoc = await db.collection('testers').doc(norm).get();
        if (!testerDoc.exists) {
            return res.status(403).json({ success: false, error: 'Tài khoản bị gỡ quyền', isExpired: true });
        }
        const t = testerDoc.data();
        if (t.expiresAt != null && Date.now() > t.expiresAt) {
            return res.status(403).json({ success: false, error: 'Tài khoản hết hạn', isExpired: true });
        }
        if (!(await verifySession(norm, token))) {
            return res.status(403).json({ success: false, error: 'Phiên không hợp lệ', isExpired: true });
        }
        touchSession(token);
        req.deviceUser = norm;
        next();
    } catch (e) {
        console.error('[checkTesterAccess]', e);
        res.status(500).json({ success: false, error: 'Lỗi whitelist' });
    }
};

async function getDevice(requestUser) {
    const doc = await db.collection('devices').doc(requestUser).get();
    if (!doc.exists) throw new Error('Device chưa tồn tại — đăng nhập lại');
    const device = doc.data();
    if (!device.privateKeyPem) throw new Error('Chưa có signing key — đăng nhập lại');
    return device;
}

// ============================================================
// PUBLIC: /api/version, /api/lge-appver
// ============================================================
app.get('/api/version', (req, res) => {
    res.json({
        success: true,
        data: {
            ...runtimeConfig,
            version: runtimeConfig.appVersion,
            versionId: runtimeConfig.buildNumber
        }
    });
});

app.get('/api/lge-appver', async (req, res) => {
    try {
        const r = await axios.get(LGE_BASE + '/public/appver', {
            headers: { 'Accept': 'application/json', 'User-Agent': buildUserAgent() },
            timeout: 8000
        });
        res.json({ success: true, version: r.data?.messager || null });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ============================================================
// 1. LOGIN
// ============================================================
app.post('/proxy-login', loginRateLimiter, async (req, res) => {
    const { payload } = req.body;
    if (!payload?.username) {
        return res.status(400).json({ success: false, error: 'Payload không hợp lệ' });
    }
    const requestUser = payload.username.trim().toLowerCase();

    try {
        // 1) Kiểm tra whitelist + hạn dùng
        const tDoc = await db.collection('testers').doc(requestUser).get();
        if (!tDoc.exists) {
            return res.status(403).json({ success: false, error: 'Tài khoản chưa được cấp quyền!' });
        }
        const t = tDoc.data();
        let expireText = 'Vĩnh viễn';
        if (t.expiresAt != null) {
            if (Date.now() > t.expiresAt) {
                return res.status(403).json({ success: false, error: 'Tài khoản đã hết hạn!' });
            }
            const daysLeft = Math.max(0, Math.ceil((t.expiresAt - Date.now()) / 86400000));
            expireText = `còn ${daysLeft} ngày`;
        }

        // 2) IMEI / DeviceToken
        const deviceRef = db.collection('devices').doc(requestUser);
        const dDoc = await deviceRef.get();
        let deviceData = dDoc.exists ? dDoc.data() : null;
        let imei = deviceData?.imei;
        let deviceToken = deviceData?.deviceToken;

        if (!imei) {
            const clientIMEI = normalizeIMEI(payload.IMEI);
            if (!clientIMEI) {
                return res.status(400).json({
                    success: false, needIMEI: true,
                    error: 'Vui lòng nhập IMEI (định dạng C6598981-5CDA-4819-A0C1-C9D8128F335F)'
                });
            }
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

        // 3) Chuẩn bị payload gửi LGE — CHỈ các field có trong request thật
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

        console.log(`[login] ${requestUser} | v${runtimeConfig.appVersion}(${runtimeConfig.buildNumber})`);

        // 4) Gọi LGE
        const resp = await axios.post(LGE_BASE + '/users/login', lgePayload, {
            headers: getBaseHeaders(null),
            timeout: 30000
        });

        if (!resp.data?.token) {
            return res.status(resp.status).json({ success: false, error: resp.data });
        }

        // 5) Tạo session
        await createSession(requestUser, resp.data.token);

        // 6) Sinh key + register (best-effort)
        try {
            await ensureSigningKeys(deviceRef, deviceData, resp.data.token);
            console.log(`[login] Signing keys OK for ${requestUser}`);
        } catch (e) {
            console.error(`[login] Key setup FAILED for ${requestUser}:`, e.message);
            // Không fail login (login không cần chữ ký), nhưng API khác sẽ fail
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
            success: false,
            error: error.response?.data || error.message
        });
    }
});

// ============================================================
// 2. CHECK DEVICE (POST, signed, double-encode body)
// ============================================================
app.post('/proxy-checkdevice', checkTesterAccess, async (req, res) => {
    try {
        const device = await getDevice(req.deviceUser);
        const apiPath = '/employee/checkdevice';

        const now = new Date();
        const yesterday = new Date(now.getTime() - 86400_000);

        const deviceInfo = {
            deviceId: device.imei,
            powerState: { batteryState: 'unplugged', lowPowerMode: true, batteryLevel: 0.5 },
            getApiLevel: -1,
            getAndroidId: 'unknown',
            getApplicationName: 'LGE 2.0',
            getBatteryLevel: '50%',
            getBrand: 'Apple',
            getBuildNumber: runtimeConfig.buildNumber,
            getBundleId: CONFIG.bundleId,
            isCameraPresent: false,
            getCarrier: '--',
            getDeviceId: 'iPhone10,5',
            getDeviceName: 'iPhone',
            getFirstInstallTime: yesterday.toISOString(),
            getLastUpdateTime: yesterday.toISOString(),
            getManufacturer: 'Apple',
            getModel: 'iPhone 8 Plus',
            getSystemName: 'iOS',
            getSystemVersion: '16.7.8',
            getVersion: runtimeConfig.appVersion,
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

        const bodyStr = prepareBody(deviceInfo);
        const headers = {
            ...getBaseHeaders(req.body.token),
            ...sign(device, 'POST', apiPath, bodyStr)
        };

        const r = await axios.post(LGE_BASE + apiPath, bodyStr, { headers, timeout: 15000 });
        res.json({ success: true, data: r.data });
    } catch (e) {
        console.error('[/proxy-checkdevice]', e.response?.data || e.message);
        res.status(e.response?.status || 500).json({
            success: false,
            error: e.response?.data || e.message
        });
    }
});

// ============================================================
// 3. PLAN (POST, signed, double-encode body)
// ============================================================
app.post('/proxy-plan', checkTesterAccess, async (req, res) => {
    try {
        const device = await getDevice(req.deviceUser);
        const apiPath = '/dashboard/lgplanbyplan';

        // Client gửi req.body.planDate = "YYYY-MM-DD"
        const d = req.body.planDate || new Date().toISOString().slice(0, 10);
        const innerObj = { pageNum: 0, planDate: d };

        // double-encode: JSON.stringify(JSON.stringify(obj)) → content-length 45
        const bodyStr = prepareBody(innerObj);
        const headers = {
            ...getBaseHeaders(req.body.token),
            ...sign(device, 'POST', apiPath, bodyStr)
        };

        const r = await axios.post(LGE_BASE + apiPath, bodyStr, { headers, timeout: 30000 });
        res.json({ success: true, data: r.data });
    } catch (e) {
        console.error('[/proxy-plan]', e.response?.data || e.message);
        res.status(e.response?.status || 500).json({
            success: false,
            error: e.response?.data || e.message
        });
    }
});

// ============================================================
// 4. DOWNLOAD FULL (GET)
// ============================================================
app.post('/proxy-download-all', checkTesterAccess, async (req, res) => {
    try {
        const device = await getDevice(req.deviceUser);
        const apiPath = '/download/all';
        const headers = {
            ...getBaseHeaders(req.body.token),
            ...sign(device, 'GET', apiPath, null)
        };
        const r = await axios.get(LGE_BASE + apiPath, {
            headers,
            timeout: 90000,
            maxContentLength: 20 * 1024 * 1024
        });
        res.json({ success: true, data: r.data });
    } catch (e) {
        console.error('[/proxy-download-all]', e.response?.data || e.message);
        res.status(e.response?.status || 500).json({
            success: false,
            error: e.response?.data || e.message
        });
    }
});

// ============================================================
// 5. DOWNLOAD MENU (GET)
// ============================================================
app.post('/proxy-download-menu', checkTesterAccess, async (req, res) => {
    try {
        const device = await getDevice(req.deviceUser);
        const apiPath = '/download/listMenu';
        const headers = {
            ...getBaseHeaders(req.body.token),
            ...sign(device, 'GET', apiPath, null)
        };
        const r = await axios.get(LGE_BASE + apiPath, { headers, timeout: 15000 });
        res.json({ success: true, data: r.data });
    } catch (e) {
        console.error('[/proxy-download-menu]', e.response?.data || e.message);
        res.status(e.response?.status || 500).json({
            success: false,
            error: e.response?.data || e.message
        });
    }
});

// ============================================================
// 6. SHOPS (GET)
// ============================================================
app.post('/proxy-get-shops', checkTesterAccess, async (req, res) => {
    try {
        const device = await getDevice(req.deviceUser);
        const apiPath = '/shops/storemaintant';
        const headers = {
            ...getBaseHeaders(req.body.token),
            ...sign(device, 'GET', apiPath, null)
        };
        const r = await axios.get(LGE_BASE + apiPath, { headers, timeout: 30000 });
        res.json({ success: true, data: r.data });
    } catch (e) {
        console.error('[/proxy-get-shops]', e.response?.data || e.message);
        res.status(e.response?.status || 500).json({
            success: false,
            error: e.response?.data || e.message
        });
    }
});

// ============================================================
// 7. HISTORY (GET, headers shopid + attendantdate)
// ============================================================
app.post('/proxy-get-history', checkTesterAccess, async (req, res) => {
    try {
        const device = await getDevice(req.deviceUser);
        const apiPath = '/attendants/byshop';
        const headers = {
            ...getBaseHeaders(req.body.token),
            ...sign(device, 'GET', apiPath, null),
            'shopid': '0',
            'attendantdate': req.body.date      // "YYYYMMDD"
        };
        const r = await axios.get(LGE_BASE + apiPath, { headers, timeout: 30000 });
        res.json({ success: true, data: r.data });
    } catch (e) {
        console.error('[/proxy-get-history]', e.response?.data || e.message);
        res.status(e.response?.status || 500).json({
            success: false,
            error: e.response?.data || e.message
        });
    }
});

// ============================================================
// 8. UPLOAD (POST, signed) — chờ xác nhận body thật
// ============================================================
app.post('/proxy-upload', checkTesterAccess, async (req, res) => {
    try {
        const device = await getDevice(req.deviceUser);
        const apiPath = '/attendants/upload';

        // ⚠️ Khi có request /attendants/upload thật, kiểm tra lại:
        //   - single-encode hay double-encode?
        //   - thứ tự field có ảnh hưởng không?
        // Hiện dùng double-encode (theo pattern các POST signed khác)
        const bodyStr = prepareBody(req.body.payload);
        const headers = {
            ...getBaseHeaders(req.body.token),
            ...sign(device, 'POST', apiPath, bodyStr)
        };
        const r = await axios.post(LGE_BASE + apiPath, bodyStr, {
            headers,
            timeout: 60000,
            maxContentLength: 30 * 1024 * 1024
        });
        res.json({ success: true, data: r.data });
    } catch (e) {
        console.error('[/proxy-upload]', e.response?.data || e.message);
        res.status(e.response?.status || 500).json({
            success: false,
            error: e.response?.data || e.message
        });
    }
});

// ============================================================
// 9. VERIFY SESSION (dùng khi tab focus lại)
// ============================================================
app.post('/proxy-verify-session', checkTesterAccess, (req, res) => res.json({ success: true }));

// ============================================================
// ADMIN — verify + tester CRUD + version config
// ============================================================
const verifyAdmin = async (req, res, next) => {
    const pass = req.headers.admin_pass;
    if (!pass) return res.status(401).json({ success: false, error: 'Thiếu mật khẩu' });
    try {
        const d = await db.collection('admin_config').doc('settings').get();
        if (!d.exists || d.data().password !== pass) {
            return res.status(401).json({ success: false, error: 'Sai mật khẩu' });
        }
        next();
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

app.post('/admin/verify', async (req, res) => {
    try {
        const { admin_pass } = req.body;
        if (!admin_pass) return res.status(401).json({ success: false, error: 'Thiếu mật khẩu' });
        const d = await db.collection('admin_config').doc('settings').get();
        if (!d.exists || d.data().password !== admin_pass) {
            return res.status(401).json({ success: false, error: 'Sai mật khẩu' });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

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
        if (appId !== undefined)
            update.appId = String(appId).trim() || admin.firestore.FieldValue.delete();
        if (userAgent !== undefined)
            update.userAgent = String(userAgent).trim() || admin.firestore.FieldValue.delete();

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
        const r = await axios.get(LGE_BASE + '/public/appver', {
            headers: { 'Accept': 'application/json', 'User-Agent': buildUserAgent() },
            timeout: 8000
        });
        res.json({ success: true, data: { lgeVersion: r.data?.messager, raw: r.data } });
    } catch (e) {
        res.json({ success: false, error: e.message, hint: e.response?.data });
    }
});

const toMillis = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { const n = Number(v); return isNaN(n) ? new Date(v).getTime() : n; }
    if (v._seconds != null) return v._seconds * 1000;
    if (v.seconds != null) return v.seconds * 1000;
    if (typeof v.toMillis === 'function') return v.toMillis();
    return null;
};

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
                installId: d.installId || null
            };
        }));
        arr.sort((a, b) => a.username.localeCompare(b.username));
        res.json({ success: true, data: arr });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/admin/testers', verifyAdmin, async (req, res) => {
    try {
        const { username, note, expiresAt, imei } = req.body;
        if (!username) return res.status(400).json({ success: false, error: 'Username rỗng' });
        const norm = String(username).trim().toLowerCase();
        const ref = db.collection('testers').doc(norm);
        if ((await ref.get()).exists) return res.status(409).json({ success: false, error: 'Đã tồn tại' });

        await ref.set({
            note: note || '',
            expiresAt: expiresAt || null,
            addedAt: Date.now()
        });

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
            if (clean) {
                await db.collection('devices').doc(norm).set({
                    imei: clean,
                    imeiUpdatedAt: new Date().toISOString()
                }, { merge: true });
            }
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
// HEALTH + START
// ============================================================
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
    console.log(`[server] Listening on :${PORT}`);
    console.log(`[server] Bundle: ${CONFIG.bundleId} | v${runtimeConfig.appVersion}(${runtimeConfig.buildNumber})`);
});