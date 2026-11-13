const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const admin = require('firebase-admin');
const crypto = require('crypto');

const serviceAccountPath = process.env.FIREBASE_KEY_PATH || './firebase-key.json';
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================================
// RUNTIME CONFIG (appVersion, buildNumber, appId, userAgent)
// ==========================================================
const DEFAULT_CONFIG = {
    appVersion: '1.4.3',
    buildNumber: '43',
    appId: '20H343',
    userAgent: null // null = auto-generate
};

let runtimeConfig = { ...DEFAULT_CONFIG };

function buildUserAgent() {
    if (runtimeConfig.userAgent && runtimeConfig.userAgent.trim()) {
        return runtimeConfig.userAgent.trim();
    }
    return `fieldforce/${runtimeConfig.buildNumber} CFNetwork/1410.1 Darwin/22.6.0`;
}

async function loadRuntimeConfig() {
    try {
        const doc = await db.collection('admin_config').doc('settings').get();
        if (doc.exists) {
            const c = doc.data();
            runtimeConfig = {
                appVersion: (c.appVersion && typeof c.appVersion === 'string') ? c.appVersion : DEFAULT_CONFIG.appVersion,
                buildNumber: (c.buildNumber && /^\d+$/.test(String(c.buildNumber).trim()))
                    ? String(c.buildNumber).trim()
                    : DEFAULT_CONFIG.buildNumber,
                appId: (c.appId && typeof c.appId === 'string') ? c.appId : DEFAULT_CONFIG.appId,
                userAgent: c.userAgent || null
            };
        } else {
            runtimeConfig = { ...DEFAULT_CONFIG };
        }
        console.log('[CONFIG] Runtime loaded:', runtimeConfig);
    } catch (e) {
        console.error('[loadRuntimeConfig]', e.message);
        runtimeConfig = { ...DEFAULT_CONFIG };
    }
}

// Initial load + periodic refresh (30s)
loadRuntimeConfig();
setInterval(loadRuntimeConfig, 30 * 1000).unref();

// ==========================================================
// HEADERS DÙNG CHUNG
// ==========================================================
const getBaseHeaders = (token) => ({
    "Accept-Encoding": "gzip, deflate, br",
    "Accept": "application/json",
    "Accept-Language": "vi-VN,vi;q=0.9",
    "Authorization": token ? `Bearer ${token}` : '',
    "Host": "lgpg-sapi.sucbat.com.vn",
    "User-Agent": buildUserAgent(),
    "Connection": "keep-alive",
    "Content-Type": "application/json"
});

// ==========================================================
// UTILS
// ==========================================================
const isValidIMEI = (str) =>
    typeof str === 'string' &&
    /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(str);

const normalizeIMEI = (raw) => {
    if (typeof raw !== 'string') return null;
    const cleaned = raw.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (cleaned.length !== 32) return null;
    return `${cleaned.slice(0, 8)}-${cleaned.slice(8, 12)}-${cleaned.slice(12, 16)}-${cleaned.slice(16, 20)}-${cleaned.slice(20)}`;
};

// ==========================================================
// RATE LIMITER
// ==========================================================
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 10;

function loginRateLimiter(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    if (entry.count >= RATE_LIMIT_MAX) {
        const remaining = Math.max(1, Math.ceil((entry.resetAt - now) / 60000));
        return res.status(429).json({ success: false, error: `Quá nhiều lần thử đăng nhập. Thử lại sau ${remaining} phút.` });
    }
    entry.count++;
    rateLimitMap.set(ip, entry);
    next();
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap.entries()) if (now > entry.resetAt + 60_000) rateLimitMap.delete(ip);
}, 5 * 60 * 1000).unref();

// ==========================================================
// SESSION MAP
// ==========================================================
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function createSession(username, token) {
    if (!token) return;
    const tokenHash = hashToken(token);
    await db.collection('sessions').doc(tokenHash).set({
        username: username.trim().toLowerCase(),
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString()
    });
}

async function verifySession(username, token) {
    if (!username || !token) return false;
    const doc = await db.collection('sessions').doc(hashToken(token)).get();
    return doc.exists && doc.data().username === username.trim().toLowerCase();
}

const sessionTouchCache = new Map();
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function touchSession(token) {
    if (!token) return;
    const th = hashToken(token);
    const now = Date.now();
    if (now - (sessionTouchCache.get(th) || 0) < TOUCH_INTERVAL_MS) return;
    sessionTouchCache.set(th, now);
    db.collection('sessions').doc(th).update({ lastSeenAt: new Date().toISOString() }).catch(() => {});
}

setInterval(() => {
    const now = Date.now();
    for (const [k, t] of sessionTouchCache.entries()) if (now - t > TOUCH_INTERVAL_MS * 4) sessionTouchCache.delete(k);
}, 10 * 60 * 1000).unref();

// ==========================================================
// PUBLIC VERSION ENDPOINT (cho client optional fetch)
// ==========================================================
app.get('/api/version', (req, res) => {
    res.json({
        success: true,
        data: {
            appVersion: runtimeConfig.appVersion,
            buildNumber: runtimeConfig.buildNumber,
            appId: runtimeConfig.appId,
            version: runtimeConfig.appVersion,      // backward compat
            versionId: runtimeConfig.buildNumber    // backward compat
        }
    });
});

// ==========================================================
// PROXY LOGIN
// ==========================================================
app.post('/proxy-login', loginRateLimiter, async (req, res) => {
    const { payload } = req.body;
    if (!payload || !payload.username) {
        return res.status(400).json({ success: false, error: "Payload không hợp lệ." });
    }
    const requestUser = payload.username.trim().toLowerCase();

    try {
        const testerDoc = await db.collection('testers').doc(requestUser).get();
        if (!testerDoc.exists) {
            return res.status(403).json({ success: false, error: "Tài khoản chưa được cấp quyền thử nghiệm!" });
        }

        const userData = testerDoc.data();
        let expireText = "Vĩnh viễn";
        if (userData.expiresAt != null) {
            const now = Date.now();
            if (now > userData.expiresAt) {
                return res.status(403).json({ success: false, error: "Tài khoản đã hết hạn sử dụng!" });
            }
            const daysLeft = Math.max(0, Math.ceil((userData.expiresAt - now) / 86400000));
            expireText = `còn ${daysLeft} ngày`;
        }

        // ========== IMEI FLOW ==========
        const deviceRef = db.collection('devices').doc(requestUser);
        const deviceDoc = await deviceRef.get();
        const deviceData = deviceDoc.exists ? deviceDoc.data() : null;

        let imei, deviceToken;

        if (!deviceData || !deviceData.imei) {
            const clientIMEI = normalizeIMEI(payload.IMEI);
            if (!clientIMEI) {
                return res.status(400).json({
                    success: false,
                    needIMEI: true,
                    error: "Vui lòng nhập IMEI thiết bị (định dạng: C6598981-5CDA-4819-A0C1-C9D8128F335F)"
                });
            }

            imei = clientIMEI;
            deviceToken = deviceData?.deviceToken ||
                (crypto.randomUUID().replace(/-/g, '') + ":" + crypto.randomUUID().replace(/-/g, ''));

            await db.runTransaction(async (tx) => {
                const fresh = await tx.get(deviceRef);
                if (!fresh.exists) {
                    tx.set(deviceRef, {
                        imei, deviceToken,
                        createdAt: new Date().toISOString(),
                        imeiUpdatedAt: new Date().toISOString()
                    });
                } else {
                    tx.update(deviceRef, {
                        imei, deviceToken,
                        imeiUpdatedAt: new Date().toISOString()
                    });
                }
            });
        } else {
            imei = deviceData.imei;
            deviceToken = deviceData.deviceToken;
        }

        payload.IMEI = imei;
        payload.DeviceToken = deviceToken;

        // ========== VERSION INJECTION (từ runtimeConfig) ==========
        payload.getVersion = runtimeConfig.appVersion;
        payload.versionid = runtimeConfig.buildNumber;
        payload.AppId = runtimeConfig.appId;

        console.log(`[LOGIN] ${requestUser} | UA: ${buildUserAgent()} | v${runtimeConfig.appVersion} (${runtimeConfig.buildNumber})`);

        const response = await axios.post('https://lgpg-sapi.sucbat.com.vn/users/login/', payload, {
            headers: getBaseHeaders(null)
        });

        if (response.data && response.data.token) {
            await createSession(requestUser, response.data.token);
        }

        res.status(response.status).json({
            success: true,
            data: response.data,
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

// ==========================================================
// CHECK TESTER ACCESS
// ==========================================================
const checkTesterAccess = async (req, res, next) => {
    const { request_user, token } = req.body;
    if (!request_user) return res.status(403).json({ success: false, error: "Lỗi xác thực danh tính.", isExpired: true });
    if (!token) return res.status(403).json({ success: false, error: "Thiếu token xác thực.", isExpired: true });

    try {
        const normUser = request_user.trim().toLowerCase();
        const testerDoc = await db.collection('testers').doc(normUser).get();
        if (!testerDoc.exists) {
            return res.status(403).json({ success: false, error: "Tài khoản đã bị gỡ quyền truy cập.", isExpired: true });
        }
        const userData = testerDoc.data();
        if (userData.expiresAt != null && Date.now() > userData.expiresAt) {
            return res.status(403).json({ success: false, error: "Tài khoản đã hết hạn.", isExpired: true });
        }
        if (!(await verifySession(normUser, token))) {
            return res.status(403).json({ success: false, error: "Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.", isExpired: true });
        }
        touchSession(token);
        next();
    } catch (e) {
        console.error('[checkTesterAccess]', e);
        res.status(500).json({ success: false, error: "Hệ thống kiểm tra Whitelist gặp sự cố." });
    }
};

// ==========================================================
// PROXY APIs
// ==========================================================
app.post('/proxy-upload', checkTesterAccess, async (req, res) => {
    try {
        const r = await axios.post('https://lgpg-sapi.sucbat.com.vn/attendants/upload', req.body.payload, { headers: getBaseHeaders(req.body.token) });
        res.status(r.status).json({ success: true, data: r.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({ success: false, error: error.response?.data || error.message });
    }
});

app.post('/proxy-get-shops', checkTesterAccess, async (req, res) => {
    try {
        const r = await axios.get('https://lgpg-sapi.sucbat.com.vn/shops/storemaintant', { headers: getBaseHeaders(req.body.token) });
        res.status(r.status).json({ success: true, data: r.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({ success: false, error: error.response?.data || error.message });
    }
});

app.post('/proxy-get-history', checkTesterAccess, async (req, res) => {
    try {
        const h = getBaseHeaders(req.body.token);
        h['shopid'] = '0';
        h['attendantdate'] = req.body.date;
        const r = await axios.get('https://lgpg-sapi.sucbat.com.vn/attendants/byshop', { headers: h });
        res.status(r.status).json({ success: true, data: r.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({ success: false, error: error.response?.data || error.message });
    }
});

app.post('/proxy-verify-session', checkTesterAccess, (req, res) => res.json({ success: true }));

// ==========================================================
// ADMIN VERIFY
// ==========================================================
const verifyAdmin = async (req, res, next) => {
    try {
        const { admin_pass } = req.headers;
        if (!admin_pass) return res.status(401).json({ success: false, error: "Thiếu mật khẩu." });
        const doc = await db.collection('admin_config').doc('settings').get();
        if (!doc.exists || doc.data().password !== admin_pass) {
            return res.status(401).json({ success: false, error: "Sai mật khẩu quản trị viên!" });
        }
        next();
    } catch (e) {
        console.error('[verifyAdmin]', e);
        res.status(500).json({ success: false, error: "Lỗi xác thực admin: " + e.message });
    }
};

app.post('/admin/verify', async (req, res) => {
    try {
        const { admin_pass } = req.body;
        if (!admin_pass) return res.status(401).json({ success: false, error: "Thiếu mật khẩu." });
        const doc = await db.collection('admin_config').doc('settings').get();
        if (!doc.exists || doc.data().password !== admin_pass) {
            return res.status(401).json({ success: false, error: "Sai mật khẩu!" });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ==========================================================
// ADMIN CONFIG — VERSION & BUILD
// ==========================================================
app.get('/admin/config/version', verifyAdmin, async (req, res) => {
    try {
        const doc = await db.collection('admin_config').doc('settings').get();
        const c = doc.exists ? doc.data() : {};
        res.json({
            success: true,
            data: {
                appVersion: c.appVersion || '',
                buildNumber: c.buildNumber || '',
                appId: c.appId || '',
                userAgent: c.userAgent || '',
                // Runtime actual values
                runtime: {
                    appVersion: runtimeConfig.appVersion,
                    buildNumber: runtimeConfig.buildNumber,
                    appId: runtimeConfig.appId,
                    userAgent: buildUserAgent()
                },
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
            if (v && !/^\d+\.\d+\.\d+$/.test(v)) {
                return res.status(400).json({ success: false, error: "App Version phải có dạng X.Y.Z (VD: 1.4.3)" });
            }
            update.appVersion = v || admin.firestore.FieldValue.delete();
        }

        if (buildNumber !== undefined) {
            const b = String(buildNumber).trim();
            if (b && !/^\d+$/.test(b)) {
                return res.status(400).json({ success: false, error: "Build Number phải là số nguyên (VD: 43)" });
            }
            update.buildNumber = b || admin.firestore.FieldValue.delete();
        }

        if (appId !== undefined) {
            const a = String(appId).trim();
            update.appId = a || admin.firestore.FieldValue.delete();
        }

        if (userAgent !== undefined) {
            const ua = String(userAgent).trim();
            update.userAgent = ua || admin.firestore.FieldValue.delete();
        }

        if (Object.keys(update).length === 0) {
            return res.status(400).json({ success: false, error: "Không có dữ liệu cập nhật." });
        }

        await db.collection('admin_config').doc('settings').set(update, { merge: true });
        await loadRuntimeConfig(); // reload ngay

        res.json({
            success: true,
            message: "Đã cập nhật cấu hình version.",
            runtime: {
                appVersion: runtimeConfig.appVersion,
                buildNumber: runtimeConfig.buildNumber,
                appId: runtimeConfig.appId,
                userAgent: buildUserAgent()
            }
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Reset về default hardcode
app.post('/admin/config/version/reset', verifyAdmin, async (req, res) => {
    try {
        await db.collection('admin_config').doc('settings').set({
            appVersion: admin.firestore.FieldValue.delete(),
            buildNumber: admin.firestore.FieldValue.delete(),
            appId: admin.firestore.FieldValue.delete(),
            userAgent: admin.firestore.FieldValue.delete()
        }, { merge: true });
        await loadRuntimeConfig();
        res.json({ success: true, message: "Đã reset về giá trị mặc định.", runtime: runtimeConfig });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Check version từ LGE (reference only — không ảnh hưởng runtime)
app.get('/admin/config/version/lge', verifyAdmin, async (req, res) => {
    try {
        const r = await axios.get('https://lgpg-sapi.sucbat.com.vn/public/appver', {
            headers: { ...getBaseHeaders(null), 'Host': 'lgpg-sapi.sucbat.com.vn' },
            timeout: 5000
        });
        res.json({
            success: true,
            data: {
                lgeVersion: r.data?.messager || null,
                raw: r.data
            }
        });
    } catch (e) {
        res.json({
            success: false,
            error: e.message,
            hint: "Không fetch được /public/appver — có thể endpoint không tồn tại hoặc network bị chặn."
        });
    }
});

// ==========================================================
// ADMIN TESTERS CRUD
// ==========================================================
app.get('/admin/testers', verifyAdmin, async (req, res) => {
    try {
        const snapshot = await db.collection('testers').get();
        const testers = [];
        for (const doc of snapshot.docs) {
            const deviceDoc = await db.collection('devices').doc(doc.id).get();
            const dd = deviceDoc.exists ? deviceDoc.data() : {};
            testers.push({
                username: doc.id,
                ...doc.data(),
                imei: dd.imei || "",
                deviceToken: dd.deviceToken || "",
                deviceCreatedAt: dd.createdAt || "",
                imeiUpdatedAt: dd.imeiUpdatedAt || ""
            });
        }
        res.json({ success: true, data: testers });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/admin/testers', verifyAdmin, async (req, res) => {
    try {
        const { username, note, expiresAt, imei } = req.body;
        if (!username?.trim()) return res.status(400).json({ success: false, error: "Username không được rỗng." });

        const normalized = username.trim().toLowerCase();
        const testerRef = db.collection('testers').doc(normalized);
        if ((await testerRef.get()).exists) {
            return res.status(409).json({ success: false, error: `Tester "${normalized}" đã tồn tại.` });
        }

        const doc = { username: normalized, note: note || "", addedAt: new Date().toISOString() };
        if (expiresAt != null && expiresAt !== "") {
            const ms = typeof expiresAt === 'number' ? expiresAt : new Date(expiresAt).getTime();
            if (isNaN(ms)) return res.status(400).json({ success: false, error: "Ngày hết hạn không hợp lệ." });
            doc.expiresAt = ms;
        }
        await testerRef.set(doc);

        if (imei) {
            const normalizedIMEI = normalizeIMEI(imei);
            if (!normalizedIMEI) {
                return res.status(400).json({ success: false, error: "IMEI không đúng định dạng UUID." });
            }
            const deviceToken = crypto.randomUUID().replace(/-/g, '') + ":" + crypto.randomUUID().replace(/-/g, '');
            await db.collection('devices').doc(normalized).set({
                imei: normalizedIMEI,
                deviceToken,
                createdAt: new Date().toISOString(),
                imeiUpdatedAt: new Date().toISOString()
            });
        }

        res.json({ success: true, message: "Đã thêm tester." });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.put('/admin/testers/:username', verifyAdmin, async (req, res) => {
    try {
        const normalized = req.params.username.trim().toLowerCase();
        const { note, expiresAt, imei } = req.body;
        const testerRef = db.collection('testers').doc(normalized);
        if (!(await testerRef.get()).exists) {
            return res.status(404).json({ success: false, error: "Tester không tồn tại." });
        }

        const update = {};
        if (note !== undefined) update.note = note;
        if (expiresAt !== undefined) {
            if (expiresAt === null || expiresAt === "") {
                update.expiresAt = admin.firestore.FieldValue.delete();
            } else {
                const ms = typeof expiresAt === 'number' ? expiresAt : new Date(expiresAt).getTime();
                if (isNaN(ms)) return res.status(400).json({ success: false, error: "Ngày hết hạn không hợp lệ." });
                update.expiresAt = ms;
            }
        }
        if (Object.keys(update).length > 0) await testerRef.update(update);

        if (imei !== undefined && imei !== "") {
            const normalizedIMEI = normalizeIMEI(imei);
            if (!normalizedIMEI) {
                return res.status(400).json({ success: false, error: "IMEI không đúng định dạng UUID." });
            }
            const deviceRef = db.collection('devices').doc(normalized);
            const existing = await deviceRef.get();
            if (existing.exists) {
                await deviceRef.update({ imei: normalizedIMEI, imeiUpdatedAt: new Date().toISOString() });
            } else {
                const deviceToken = crypto.randomUUID().replace(/-/g, '') + ":" + crypto.randomUUID().replace(/-/g, '');
                await deviceRef.set({
                    imei: normalizedIMEI,
                    deviceToken,
                    createdAt: new Date().toISOString(),
                    imeiUpdatedAt: new Date().toISOString()
                });
            }
        }

        res.json({ success: true, message: "Cập nhật tester thành công." });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/admin/testers/:username', verifyAdmin, async (req, res) => {
    try {
        const normalized = req.params.username.trim().toLowerCase();
        const testerRef = db.collection('testers').doc(normalized);
        if (!(await testerRef.get()).exists) {
            return res.status(404).json({ success: false, error: "Tester không tồn tại." });
        }
        await testerRef.delete();
        await db.collection('devices').doc(normalized).delete().catch(() => {});
        res.json({ success: true, message: "Đã xóa tester và device." });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/admin/devices/:username', verifyAdmin, async (req, res) => {
    try {
        const normalized = req.params.username.trim().toLowerCase();
        await db.collection('devices').doc(normalized).delete();
        res.json({ success: true, message: "Đã reset Device (IMEI sẽ phải nhập lại khi login)." });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ==========================================================
// HEALTH
// ==========================================================
app.get('/health', (req, res) => res.json({
    ok: true,
    uptime: process.uptime(),
    runtimeConfig: {
        appVersion: runtimeConfig.appVersion,
        buildNumber: runtimeConfig.buildNumber,
        userAgent: buildUserAgent()
    }
}));

process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

app.listen(PORT, () => console.log(`[SYSTEM] Máy chủ WebApp LGE chạy tại Port ${PORT}`));