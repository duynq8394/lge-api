// ==========================================
// PHẦN 1: TỰ ĐỘNG GIẢI MÃ TOKEN (JWT DECODER)
// ==========================================
document.getElementById('token').addEventListener('input', function() {
    let token = this.value.trim();
    const displayDiv = document.getElementById('userInfoDisplay');
    
    if (token.toLowerCase().startsWith('bearer ')) {
        token = token.substring(7).trim();
    }
    
    if (!token) {
        displayDiv.style.display = 'none';
        return;
    }
    
    try {
        const parts = token.split('.');
        if (parts.length !== 3) throw new Error("Không phải định dạng JWT");
        
        const payloadBase64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(window.atob(payloadBase64).split('').map(function(c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        
        const payloadObj = JSON.parse(jsonPayload);
        const userInfo = JSON.parse(payloadObj.nameid);
        
        // Tính ngày hết hạn
        const expDate = new Date(payloadObj.exp * 1000);
        const formattedExpDate = expDate.toLocaleString('vi-VN', { 
            hour: '2-digit', minute:'2-digit', second:'2-digit', 
            day: '2-digit', month: '2-digit', year: 'numeric' 
        });
        
        displayDiv.style.display = 'block';
        displayDiv.className = 'info-box';
        displayDiv.innerHTML = `
            <h4>✅ Đã nhận diện thông tin tài khoản</h4>
            <ul>
                <li><b>Họ tên:</b> ${userInfo.EmployeeName || 'N/A'}</li>
                <li><b>Mã NV:</b> ${userInfo.EmployeeCode || 'N/A'}</li>
                <li><b>LoginName:</b> ${userInfo.LoginName || 'N/A'}</li>
                <li><b>Mobile:</b> ${userInfo.Mobile || 'N/A'}</li>
                <li><b>Địa chỉ:</b> ${userInfo.Address || 'N/A'}</li>
                <li><b>Ngày hết hạn Token:</b> <span class="highlight-red">${formattedExpDate}</span></li>
            </ul>
        `;
    } catch (error) {
        displayDiv.style.display = 'block';
        displayDiv.className = 'error-box';
        displayDiv.innerHTML = `❌ Token không hợp lệ hoặc bị lỗi định dạng.`;
    }
});

// ==========================================
// PHẦN 2: XỬ LÝ UPLOAD VÀ PROXY API
// ==========================================

// Hàm in log ra màn hình Terminal
function printLog(msg, isError = false) {
    const logBox = document.getElementById('logBox');
    const time = new Date().toLocaleTimeString();
    const color = isError ? 'color: #ff5555;' : '';
    logBox.innerHTML += `\n<span style="${color}">[${time}] ${msg}</span>`;
    logBox.scrollTop = logBox.scrollHeight;
}

// Hàm lấy thời gian thực format YYYYMMDD
function getRealTime() {
    const now = new Date();
    const pad = n => n.toString().padStart(2, '0');
    const yyyy = now.getFullYear(), mm = pad(now.getMonth() + 1), dd = pad(now.getDate());
    const HH = pad(now.getHours()), MM = pad(now.getMinutes()), ss = pad(now.getSeconds());
    return { date: parseInt(`${yyyy}${mm}${dd}`), time: `${yyyy}${mm}${dd}${HH}${MM}${ss}` };
}

// Hàm tạo nhiễu GPS tự nhiên (xê dịch khoảng 1-3 mét)
function addGpsJitter(coordinate) {
    // Tạo một số ngẫu nhiên từ -0.00002 đến +0.00002
    const jitter = (Math.random() - 0.5) * 0.00004;
    return coordinate + jitter;
}

// Hàm thực thi upload chính
async function executeUpload() {
    const token = document.getElementById('token').value.trim();
    const fileInput = document.getElementById('imageInput');
    
    if (!token) { printLog("LỖI: Thiếu Token xác thực!", true); return; }
    if (fileInput.files.length === 0) { printLog("LỖI: Chưa chọn ảnh!", true); return; }
    
    const btn = document.getElementById('btnSubmit');
    btn.disabled = true; 
    btn.innerText = "⏳ ĐANG XỬ LÝ VÀ TRUYỀN TẢI...";
    printLog("Đang mã hóa ảnh và chuẩn bị Payload ẩn danh...");
    
    const file = fileInput.files[0];
    const reader = new FileReader();
    
    reader.onload = async function(e) {
        try {
            const base64Data = e.target.result.split(',')[1];
            
            // 1. Lấy tọa độ gốc và chèn Nhiễu tự nhiên (Jitter)
            const baseLat = parseFloat(document.getElementById('lat').value);
            const baseLng = parseFloat(document.getElementById('lng').value);
            const finalLat = addGpsJitter(baseLat);
            const finalLng = addGpsJitter(baseLng);
            
            // 2. Random Accuracy (Độ chính xác GPS bắt sóng)
            const randAccuracy = 20 + Math.random() * 3; 
            
            // 3. Fake tên ảnh chuẩn của hệ điều hành iOS
            const fakePhotoName = crypto.randomUUID().toUpperCase() + ".jpg";
            const realTime = getRealTime();
            
            const payload = {
                "ShopId": parseInt(document.getElementById('shopId').value),
                "ShopCode": document.getElementById('shopCode').value,
                "PhotoName": fakePhotoName, // Đã fix: Tránh lộ tên file Screenshot
                "Latitude": finalLat,       // Đã fix: Dao động vị trí tự nhiên
                "Longitude": finalLng,      // Đã fix: Dao động vị trí tự nhiên
                "Accuracy": randAccuracy,
                "ReportId": 1, 
                "PhotoTime": realTime.time, 
                "PhotoType": "1",
                "PhotoDate": realTime.date, 
                "guid": crypto.randomUUID(), 
                "PhotoData": base64Data, 
                "WorkStatus": 1,
                "DataLocation": JSON.stringify({
                    "latitude": finalLat, 
                    "longitude": finalLng, 
                    "accuracy": randAccuracy,
                    "isFast": false, 
                    "usedHighAccuracy": true, 
                    "isLikelyPreciseFix": true
                })
            };
            
            printLog(`Tọa độ đã làm nhiễu: Lat ${finalLat.toFixed(6)}, Lng ${finalLng.toFixed(6)}`);
            printLog(`Tên ảnh giả mạo: ${fakePhotoName}`);
            printLog("Gửi yêu cầu tới Proxy Server...");
            
            const response = await fetch('/proxy-upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: token.replace('Bearer ', ''),
                    payload: payload
                })
            });
            const result = await response.json();
            
            if (response.ok && result.success) {
                printLog(`[THÀNH CÔNG] Server phản hồi: ${JSON.stringify(result.data)}`);
            } else {
                printLog(`[THẤT BẠI] Lỗi từ máy chủ: ${JSON.stringify(result.error)}`, true);
            }
        } catch (error) {
            printLog(`[LỖI MẠNG] ${error.message}`, true);
        } finally {
            btn.disabled = false; 
            btn.innerText = "🚀 THỰC THI GỬI LÊN MÁY CHỦ";
        }
    };
    reader.readAsDataURL(file);
}

// Gắn sự kiện click cho nút Gửi
document.getElementById('btnSubmit').addEventListener('click', executeUpload);