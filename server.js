const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Headers gốc của thiết bị iOS
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

// 1. PROXY LOGIN
app.post('/proxy-login', async (req, res) => {
    try {
        const response = await axios.post('https://lge-api.sucbat.com.vn/users/login/', req.body.payload, { 
            headers: getBaseHeaders(null) 
        });
        res.status(response.status).json({ success: true, data: response.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({ success: false, error: error.response?.data || error.message });
    }
});

// 2. PROXY UPLOAD
app.post('/proxy-upload', async (req, res) => {
    try {
        const response = await axios.post('https://lge-api.sucbat.com.vn/attendants/upload', req.body.payload, { 
            headers: getBaseHeaders(req.body.token) 
        });
        res.status(response.status).json({ success: true, data: response.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({ success: false, error: error.response?.data || error.message });
    }
});

// 3. PROXY GET SHOPS
app.post('/proxy-get-shops', async (req, res) => {
    try {
        const response = await axios.get('https://lge-api.sucbat.com.vn/shops/storemaintant', { 
            headers: getBaseHeaders(req.body.token) 
        });
        res.status(response.status).json({ success: true, data: response.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({ success: false, error: error.response?.data || error.message });
    }
});

// 4. PROXY GET HISTORY
app.post('/proxy-get-history', async (req, res) => {
    try {
        const customHeaders = getBaseHeaders(req.body.token);
        customHeaders['shopid'] = '0'; // Giữ nguyên 0 theo thống nhất
        customHeaders['attendantdate'] = req.body.date; // Ngày YYYYMMDD

        const response = await axios.get('https://lge-api.sucbat.com.vn/attendants/byshop', { 
            headers: customHeaders 
        });
        res.status(response.status).json({ success: true, data: response.data });
    } catch (error) {
        res.status(error.response?.status || 500).json({ success: false, error: error.response?.data || error.message });
    }
});

app.listen(PORT, () => console.log(`[SYSTEM] Khởi động thành công tại Port ${PORT}`));