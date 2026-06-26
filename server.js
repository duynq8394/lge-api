const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const admin = require('firebase-admin');

// Cấu hình Firebase đọc từ Render Secret File hoặc Local
const serviceAccountPath = process.env.FIREBASE_KEY_PATH || './firebase-key.json';
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
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
// API PROXY (LGE APP)
// ==========================================

// 1. LOGIN (CÓ KIỂM TRA WHITELIST)
app.post('/proxy-login', async (req, res) => {
    const { payload } = req.body;
    const requestUser = payload.username;

    try {
        // Kiểm tra Whitelist trên Firebase
        const testerDoc = await db.collection('testers').doc(requestUser).get();
        if (!testerDoc.exists) {
            return res.status(403).json({ 
                success: false, 
                error: "Tài khoản chưa được cấp quyền thử nghiệm (Beta). Vui lòng liên hệ Admin!" 
            });
        }

        // Vượt qua Whitelist -> Gọi LGE API
        const response = await axios.post('https://lge-api.sucbat.com.vn/users/login/', payload, { headers: getBaseHeaders(null) });
        res.status(response.status).json({ success: true, data: response.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({ success: false, error: error.response?.data || error.message });
    }
});

app.post('/proxy-upload', async (req, res) => {
    try {
        const response = await axios.post('https://lge-api.sucbat.com.vn/attendants/upload', req.body.payload, { headers: getBaseHeaders(req.body.token) });
        res.status(response.status).json({ success: true, data: response.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({ success: false, error: error.response?.data || error.message });
    }
});

app.post('/proxy-get-shops', async (req, res) => {
    try {
        const response = await axios.get('https://lge-api.sucbat.com.vn/shops/storemaintant', { headers: getBaseHeaders(req.body.token) });
        res.status(response.status).json({ success: true, data: response.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({ success: false, error: error.response?.data || error.message });
    }
});

app.post('/proxy-get-history', async (req, res) => {
    try {
        const customHeaders = getBaseHeaders(req.body.token);
        customHeaders['shopid'] = '0'; 
        customHeaders['attendantdate'] = req.body.date; 
        const response = await axios.get('https://lge-api.sucbat.com.vn/attendants/byshop', { headers: customHeaders });
        res.status(response.status).json({ success: true, data: response.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({ success: false, error: error.response?.data || error.message });
    }
});

// ==========================================
// API QUẢN TRỊ VIÊN (ADMIN PANEL)
// ==========================================

const verifyAdmin = async (req, res, next) => {
    const { admin_pass } = req.headers;
    const configDoc = await db.collection('admin_config').doc('settings').get();
    // Tạo sẵn 1 bản ghi admin_config/settings với field password trên Firebase
    if (!configDoc.exists || configDoc.data().password !== admin_pass) {
        return res.status(401).json({ success: false, error: "Sai mật khẩu quản trị viên!" });
    }
    next();
};

app.get('/admin/testers', verifyAdmin, async (req, res) => {
    try {
        const snapshot = await db.collection('testers').get();
        const testers = [];
        snapshot.forEach(doc => testers.push({ username: doc.id, ...doc.data() }));
        res.json({ success: true, data: testers });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/admin/testers', verifyAdmin, async (req, res) => {
    const { username, note } = req.body;
    if (!username) return res.status(400).json({ success: false, error: "Thiếu tên tài khoản!" });
    try {
        await db.collection('testers').doc(username).set({
            addedAt: new Date().toISOString(),
            note: note || "Tham gia Beta Test"
        });
        res.json({ success: true, message: `Đã cấp quyền cho ${username}` });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/admin/testers/:username', verifyAdmin, async (req, res) => {
    try {
        await db.collection('testers').doc(req.params.username).delete();
        res.json({ success: true, message: "Đã thu hồi quyền." });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.listen(PORT, () => console.log(`[SYSTEM] Máy chủ khởi chạy tại Port ${PORT}`));