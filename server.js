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

// ==========================================
// PROXY LOGIN + DEVICE IDENTITY STABLE
// ==========================================
app.post('/proxy-login', async (req, res) => {
    const { payload } = req.body;
    const requestUser = payload.username.trim().toLowerCase();

    try {
        const testerDoc = await db.collection('testers').doc(requestUser).get();
        if (!testerDoc.exists) {
            return res.status(403).json({ success: false, error: "Tài khoản của bạn chưa được cấp quyền thử nghiệm!" });
        }

        const userData = testerDoc.data();
        let expireText = "Vĩnh viễn";

        if (userData.expiresAt) {
            const now = new Date().getTime();
            if (now > userData.expiresAt) {
                return res.status(403).json({ success: false, error: "Tài khoản thử nghiệm của bạn đã hết hạn sử dụng!" });
            }
            const daysLeft = Math.ceil((userData.expiresAt - now) / (1000 * 60 * 60 * 24));
            expireText = `còn ${daysLeft} ngày`;
        }

        // ===============================
        // DEVICE IDENTITY STABLE LAYER
        // ===============================
        const deviceRef = db.collection('devices').doc(requestUser);
        const deviceDoc = await deviceRef.get();

        let imei;
        let deviceToken;

        if (!deviceDoc.exists) {
            imei = crypto.randomUUID().toUpperCase();
            deviceToken = crypto.randomUUID().replace(/-/g, '') + ":" + crypto.randomUUID().replace(/-/g, '');
            await deviceRef.set({
                imei: imei,
                deviceToken: deviceToken,
                createdAt: new Date().toISOString()
            });
        } else {
            const deviceData = deviceDoc.data();
            imei = deviceData.imei;
            deviceToken = deviceData.deviceToken;
        }

        payload.IMEI = imei;
        payload.DeviceToken = deviceToken;

        const response = await axios.post('https://lge-api.sucbat.com.vn/users/login/', payload, { headers: getBaseHeaders(null) });

        res.status(response.status).json({
            success: true,
            data: response.data,
            expireText: expireText
        });

    } catch (error) {
        res.status(error.response?.status || 500).json({ success: false, error: error.response?.data || error.message });
    }
});

// ==========================================
// MIDDLEWARE CHECK TESTER
// ==========================================
const checkTesterAccess = async (req, res, next) => {
    const { request_user } = req.body;
    if (!request_user) return res.status(403).json({ success: false, error: "Lỗi xác thực danh tính Tester.", isExpired: true });

    try {
        const testerDoc = await db.collection('testers').doc(request_user.trim().toLowerCase()).get();
        if (!testerDoc.exists) {
            return res.status(403).json({ success: false, error: "Tài khoản của bạn đã bị gỡ quyền truy cập nội bộ.", isExpired: true });
        }

        const userData = testerDoc.data();
        if (userData.expiresAt && new Date().getTime() > userData.expiresAt) {
            return res.status(403).json({ success: false, error: "Tài khoản của bạn đã hết hạn truy cập hệ thống.", isExpired: true });
        }
        next();
    } catch (error) {
        return res.status(500).json({ success: false, error: "Hệ thống kiểm tra Whitelist gặp sự cố." });
    }
};

// ================== PROXY APIs ==================
app.post('/proxy-upload', checkTesterAccess, async (req, res) => {
    try {
        const response = await axios.post(
            'https://lge-api.sucbat.com.vn/attendants/upload',
            req.body.payload,
            { headers: getBaseHeaders(req.body.token) }
        );
        res.status(response.status).json({ success: true, data: response.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({ success: false, error: error.response?.data || error.message });
    }
});

app.post('/proxy-get-shops', checkTesterAccess, async (req, res) => {
    try {
        const response = await axios.get(
            'https://lge-api.sucbat.com.vn/shops/storemaintant',
            { headers: getBaseHeaders(req.body.token) }
        );
        res.status(response.status).json({ success: true, data: response.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({ success: false, error: error.response?.data || error.message });
    }
});

app.post('/proxy-get-history', checkTesterAccess, async (req, res) => {
    try {
        const customHeaders = getBaseHeaders(req.body.token);
        customHeaders['shopid'] = '0';
        customHeaders['attendantdate'] = req.body.date;

        const response = await axios.get(
            'https://lge-api.sucbat.com.vn/attendants/byshop',
            { headers: customHeaders }
        );
        res.status(response.status).json({ success: true, data: response.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({ success: false, error: error.response?.data || error.message });
    }
});

app.listen(PORT, () => console.log(`[SYSTEM] Máy chủ WebApp LGE chạy ổn định tại Port ${PORT}`));