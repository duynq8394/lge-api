const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();

// Cấu hình Render Port
const PORT = process.env.PORT || 3000;

// Cho phép body chứa ảnh Base64 lên tới 50MB
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());

// Phục vụ file giao diện (index.html)
app.use(express.static(path.join(__dirname, 'public')));

// API Proxy nội bộ (Chỉ có web của bạn mới gọi được)
app.post('/proxy-upload', async (req, res) => {
    const { token, payload } = req.body;
    const targetUrl = 'https://lge-api.sucbat.com.vn/attendants/upload';

    // 🛡️ BỘ GIÁP ANTI-DETECT (Giả mạo hoàn toàn 1 chiếc iPhone đang dùng App)
    const headers = {
        "Accept-Encoding": "gzip, deflate, br",
        "Accept": "application/json",
        "Accept-Language": "vi-VN,vi;q=0.9",
        "Authorization": `Bearer ${token}`,
        "Host": "lge-api.sucbat.com.vn",
        "User-Agent": "fieldforce/39 CFNetwork/1494.0.7 Darwin/23.4.0",
        "Connection": "keep-alive",
        "Content-Type": "application/json"
    };

    try {
        // Sử dụng axios đẩy data thẳng sang server đích
        const response = await axios.post(targetUrl, payload, { headers: headers });
        
        // Trả kết quả thành công về cho Web App
        res.status(response.status).json({
            success: true,
            data: response.data
        });
    } catch (error) {
        // Xử lý lỗi nếu server đích từ chối (401, 500...)
        const statusCode = error.response ? error.response.status : 500;
        const errorData = error.response ? error.response.data : error.message;
        
        res.status(statusCode).json({
            success: false,
            error: errorData
        });
    }
});

// Lắng nghe cổng
app.listen(PORT, () => {
    console.log(`[SYSTEM] Khởi động thành công tại Port ${PORT}`);
});