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
// HEADERS DÙNG CHUNG
// ==========================================================
const getBaseHeaders = (token) => ({
    "Accept-Encoding": "gzip, deflate, br",
    "Accept": "application/json",
    "Accept-Language": "vi-VN,vi;q=0.9",
    "Authorization": token ? `Bearer ${token}` : '',
    "Host": "lge-api.sucbat.com.vn",
    "User-Agent": "fieldforce/39 CFNetwork/1410.1 Darwin/22.6.0",
    "Connection": "keep-alive",
    "Content-Type": "application/json"
});

// ==========================================================
// RATE LIMITER CHO LOGIN (in-memory)
// ==========================================================
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 10;

function loginRateLimiter(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = rateLimitMap.get(ip);

    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    }
    if (entry.count >= RATE_LIMIT_MAX) {
        const remaining = Math.max(1, Math.ceil((entry.resetAt - now) / 60000));
        return res.status(429).json({
            success: false,
            error: `Quá nhiều lần thử đăng nhập. Vui lòng thử lại sau ${remaining} phút.`
        });
    }
    entry.count++;
    rateLimitMap.set(ip, entry);
    next();
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap.entries()) {
        if (now > entry.resetAt + 60_000) rateLimitMap.delete(ip);
    }
}, 5 * 60 * 1000).unref();

// ==========================================================
// SESSION MAP token ↔ username
// ==========================================================
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

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
    const tokenHash = hashToken(token);
    const doc = await db.collection('sessions').doc(tokenHash).get();
    if (!doc.exists) return false;
    return doc.data().username === username.trim().toLowerCase();
}

// Tối ưu: chỉ touch mỗi 5 phút
const sessionTouchCache = new Map();
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function touchSession(token) {
    if (!token) return;
    const tokenHash = hashToken(token);
    const now = Date.now();
    const last = sessionTouchCache.get(tokenHash) || 0;
    if (now - last < TOUCH_INTERVAL_MS) return;
    sessionTouchCache.set(tokenHash, now);
    db.collection('sessions').doc(tokenHash)
        .update({ lastSeenAt: new Date().toISOString() })
        .catch(() => { });
}

setInterval(() => {
    const now = Date.now();
    for (const [k, t] of sessionTouchCache.entries()) {
        if (now - t > TOUCH_INTERVAL_MS * 4) sessionTouchCache.delete(k);
    }
}, 10 * 60 * 1000).unref();

// ==========================================================
// PROXY LOGIN + DEVICE STABLE
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
            return res.status(403).json({ success: false, error: "Tài khoản của bạn chưa được cấp quyền thử nghiệm!" });
        }

        const userData = testerDoc.data();
        let expireText = "Vĩnh viễn";

        if (userData.expiresAt != null) {
            const now = Date.now();
            if (now > userData.expiresAt) {
                return res.status(403).json({ success: false, error: "Tài khoản thử nghiệm của bạn đã hết hạn sử dụng!" });
            }
            const daysLeft = Math.max(0, Math.ceil((userData.expiresAt - now) / (1000 * 60 * 60 * 24)));
            expireText = `còn ${daysLeft} ngày`;
        }

        const deviceRef = db.collection('devices').doc(requestUser);
        const deviceDoc = await deviceRef.get();

        let imei, deviceToken;

        if (!deviceDoc.exists) {
            imei = crypto.randomUUID().toUpperCase();
            deviceToken = crypto.randomUUID().replace(/-/g, '') + ":" + crypto.randomUUID().replace(/-/g, '');

            await db.runTransaction(async (tx) => {
                const fresh = await tx.get(deviceRef);
                if (!fresh.exists) {
                    tx.set(deviceRef, {
                        imei,
                        deviceToken,
                        createdAt: new Date().toISOString()
                    });
                } else {
                    const data = fresh.data();
                    imei = data.imei;
                    deviceToken = data.deviceToken;
                }
            });
        } else {
            const deviceData = deviceDoc.data();
            imei = deviceData.imei;
            deviceToken = deviceData.deviceToken;
        }

        payload.IMEI = imei;
        payload.DeviceToken = deviceToken;

        const response = await axios.post('https://lge-api.sucbat.com.vn/users/login/', payload, {
            headers: getBaseHeaders(null)
        });

        if (response.data && response.data.token) {
            await createSession(requestUser, response.data.token);
        }

        res.status(response.status).json({
            success: true,
            data: response.data,
            expireText
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
// MIDDLEWARE CHECK TESTER
// ==========================================================
const checkTesterAccess = async (req, res, next) => {
    const { request_user, token } = req.body;
    if (!request_user) {
        return res.status(403).json({ success: false, error: "Lỗi xác thực danh tính Tester.", isExpired: true });
    }
    if (!token) {
        return res.status(403).json({ success: false, error: "Thiếu token xác thực.", isExpired: true });
    }

    try {
        const normalizedUser = request_user.trim().toLowerCase();
        const testerDoc = await db.collection('testers').doc(normalizedUser).get();

        if (!testerDoc.exists) {
            return res.status(403).json({ success: false, error: "Tài khoản của bạn đã bị gỡ quyền truy cập nội bộ.", isExpired: true });
        }

        const userData = testerDoc.data();
        if (userData.expiresAt != null && Date.now() > userData.expiresAt) {
            return res.status(403).json({ success: false, error: "Tài khoản của bạn đã hết hạn truy cập hệ thống.", isExpired: true });
        }

        const valid = await verifySession(normalizedUser, token);
        if (!valid) {
            return res.status(403).json({
                success: false,
                error: "Phiên đăng nhập không hợp lệ hoặc đã bị thu hồi. Vui lòng đăng nhập lại.",
                isExpired: true
            });
        }

        touchSession(token);
        next();
    } catch (error) {
        console.error('[checkTesterAccess]', error);
        return res.status(500).json({ success: false, error: "Hệ thống kiểm tra Whitelist gặp sự cố." });
    }
};

// ==========================================================
// PROXY APIs
// ==========================================================
app.post('/proxy-upload', checkTesterAccess, async (req, res) => {
    try {
        const response = await axios.post('https://lge-api.sucbat.com.vn/attendants/upload', req.body.payload, {
            headers: getBaseHeaders(req.body.token)
        });
        res.status(response.status).json({ success: true, data: response.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({
            success: false,
            error: error.response?.data || error.message
        });
    }
});

app.post('/proxy-get-shops', checkTesterAccess, async (req, res) => {
    try {
        const response = await axios.get('https://lge-api.sucbat.com.vn/shops/storemaintant', {
            headers: getBaseHeaders(req.body.token)
        });
        res.status(response.status).json({ success: true, data: response.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({
            success: false,
            error: error.response?.data || error.message
        });
    }
});

app.post('/proxy-get-history', checkTesterAccess, async (req, res) => {
    try {
        const customHeaders = getBaseHeaders(req.body.token);
        customHeaders['shopid'] = '0';
        customHeaders['attendantdate'] = req.body.date;
        const response = await axios.get('https://lge-api.sucbat.com.vn/attendants/byshop', { headers: customHeaders });
        res.status(response.status).json({ success: true, data: response.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({
            success: false,
            error: error.response?.data || error.message
        });
    }
});

// Verify session (dùng cho tab-focus check phía client)
app.post('/proxy-verify-session', checkTesterAccess, (req, res) => {
    res.json({ success: true });
});

// ==========================================================
// ADMIN VERIFY
// ==========================================================
const verifyAdmin = async (req, res, next) => {
    try {
        const { admin_pass } = req.headers;
        if (!admin_pass) {
            return res.status(401).json({ success: false, error: "Thiếu mật khẩu quản trị viên!" });
        }
        const configDoc = await db.collection('admin_config').doc('settings').get();
        if (!configDoc.exists || configDoc.data().password !== admin_pass) {
            return res.status(401).json({ success: false, error: "Sai mật khẩu quản trị viên!" });
        }
        next();
    } catch (e) {
        console.error('[verifyAdmin]', e);
        return res.status(500).json({ success: false, error: "Lỗi xác thực admin: " + e.message });
    }
};

app.post('/admin/verify', async (req, res) => {
    try {
        const { admin_pass } = req.body;
        if (!admin_pass) return res.status(401).json({ success: false, error: "Thiếu mật khẩu." });

        const configDoc = await db.collection('admin_config').doc('settings').get();
        if (!configDoc.exists || configDoc.data().password !== admin_pass) {
            return res.status(401).json({ success: false, error: "Sai mật khẩu quản trị viên!" });
        }
        res.json({ success: true });
    } catch (e) {
        console.error('[admin/verify]', e);
        res.status(500).json({ success: false, error: e.message });
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
            const username = doc.id;
            const testerData = doc.data();

            const deviceDoc = await db.collection('devices').doc(username).get();
            const deviceData = deviceDoc.exists ? deviceDoc.data() : {};

            testers.push({
                username,
                ...testerData,
                imei: deviceData.imei || "",
                deviceToken: deviceData.deviceToken || "",
                deviceCreatedAt: deviceData.createdAt || ""
            });
        }
        res.json({ success: true, data: testers });
    } catch (e) {
        console.error('[GET /admin/testers]', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/admin/testers', verifyAdmin, async (req, res) => {
    try {
        const { username, note, expiresAt } = req.body;
        if (!username || !username.trim()) {
            return res.status(400).json({ success: false, error: "Username không được rỗng." });
        }

        const normalized = username.trim().toLowerCase();
        const testerRef = db.collection('testers').doc(normalized);
        const existing = await testerRef.get();
        if (existing.exists) {
            return res.status(409).json({ success: false, error: `Tester "${normalized}" đã tồn tại.` });
        }

        const doc = {
            username: normalized,
            note: note || "",
            addedAt: new Date().toISOString()
        };
        if (expiresAt != null && expiresAt !== "") {
            const ms = typeof expiresAt === 'number' ? expiresAt : new Date(expiresAt).getTime();
            if (isNaN(ms)) return res.status(400).json({ success: false, error: "Ngày hết hạn không hợp lệ." });
            doc.expiresAt = ms;
        }

        await testerRef.set(doc);
        res.json({ success: true, message: "Đã thêm tester thành công." });
    } catch (e) {
        console.error('[POST /admin/testers]', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.put('/admin/testers/:username', verifyAdmin, async (req, res) => {
    try {
        const normalized = req.params.username.trim().toLowerCase();
        const { note, expiresAt } = req.body;
        const testerRef = db.collection('testers').doc(normalized);
        const existing = await testerRef.get();
        if (!existing.exists) return res.status(404).json({ success: false, error: "Tester không tồn tại." });

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

        if (Object.keys(update).length === 0) {
            return res.status(400).json({ success: false, error: "Không có dữ liệu cập nhật." });
        }

        await testerRef.update(update);
        res.json({ success: true, message: "Cập nhật tester thành công." });
    } catch (e) {
        console.error('[PUT /admin/testers]', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/admin/testers/:username', verifyAdmin, async (req, res) => {
    try {
        const normalized = req.params.username.trim().toLowerCase();
        const testerRef = db.collection('testers').doc(normalized);
        const existing = await testerRef.get();
        if (!existing.exists) {
            return res.status(404).json({ success: false, error: "Tester không tồn tại." });
        }

        await testerRef.delete();
        await db.collection('devices').doc(normalized).delete().catch(() => { });
        res.json({ success: true, message: "Đã xóa tester và device." });
    } catch (e) {
        console.error('[DELETE /admin/testers]', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/admin/devices/:username', verifyAdmin, async (req, res) => {
    try {
        const normalized = req.params.username.trim().toLowerCase();
        await db.collection('devices').doc(normalized).delete();
        res.json({ success: true, message: "Đã reset Device thành công." });
    } catch (e) {
        console.error('[DELETE /admin/devices]', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================================
// HEALTH CHECK
// ==========================================================
app.get('/health', (req, res) => {
    res.json({ ok: true, uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// ==========================================================
// GLOBAL ERROR HANDLERS
// ==========================================================
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

app.listen(PORT, () => console.log(`[SYSTEM] Máy chủ WebApp LGE chạy ổn định tại Port ${PORT}`));