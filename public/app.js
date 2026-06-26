const API_BASE = "https://lge-api.sucbat.com.vn";
let token = "";

// KHỞI TẠO: Kiểm tra đăng nhập và Tải dữ liệu
document.addEventListener('DOMContentLoaded', () => {
    token = localStorage.getItem('lge_token');
    const empName = localStorage.getItem('lge_emp_name');

    if (!token) {
        window.location.href = 'login.html';
        return;
    }
    
    document.getElementById('empNameDisplay').innerText = empName;
    loadShops();
    loadHistory();
});

function logout() {
    localStorage.removeItem('lge_token');
    localStorage.removeItem('lge_emp_name');
    window.location.href = 'login.html';
}

function printLog(msg) {
    const logBox = document.getElementById('logBox');
    logBox.innerHTML += `\n[${new Date().toLocaleTimeString()}] ${msg}`;
    logBox.scrollTop = logBox.scrollHeight;
}

// 1. TẢI DANH SÁCH CỬA HÀNG
async function loadShops() {
    try {
        const res = await fetch('/proxy-get-shops', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token })
        });
        const result = await res.json();
        
        if (result.success && result.data && result.data.data) {
            const select = document.getElementById('shopSelect');
            select.innerHTML = ""; // Xóa placeholder
            
            result.data.data.forEach(shop => {
                const opt = document.createElement('option');
                // Lưu value dưới dạng chuỗi JSON chứa cả Id và Code
                opt.value = JSON.stringify({ id: shop.shopId, code: shop.shopCode });
                opt.innerText = `[${shop.shopCode}] ${shop.shopName}`;
                select.appendChild(opt);
            });
            printLog("Tải danh sách cửa hàng thành công.");
        }
    } catch (e) {
        printLog("Lỗi tải danh sách cửa hàng.");
    }
}

// 2. TẢI LỊCH SỬ HÔM NAY
async function loadHistory() {
    const today = new Date();
    const dateStr = `${today.getFullYear()}${(today.getMonth()+1).toString().padStart(2,'0')}${today.getDate().toString().padStart(2,'0')}`;
    const listDiv = document.getElementById('historyList');
    listDiv.innerHTML = "<div style='text-align:center;'>Đang tải...</div>";

    try {
        const res = await fetch('/proxy-get-history', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token, date: dateStr })
        });
        const result = await res.json();
        
        listDiv.innerHTML = "";
        if (result.success && result.data && result.data.data && result.data.data.length > 0) {
            // Đảo ngược mảng để ảnh mới nhất lên đầu
            const historyData = result.data.data.reverse(); 

            historyData.forEach(item => {
                // Map PhotoType
                let typeName = `Check-in/out lần ${parseInt(item.photoType) + 1}`;
                let imgUrl = API_BASE + item.photoPath;

                const card = `
                    <div class="history-card">
                        <img src="${imgUrl}" alt="Photo" onerror="this.src='https://via.placeholder.com/80?text=No+Image'">
                        <div class="history-info">
                            <span class="badge">${typeName}</span><br>
                            <b>🕒 Giờ:</b> ${item.photoFullTime}<br>
                            <b>📍 Tọa độ:</b> ${item.latitude.toFixed(5)}, ${item.longitude.toFixed(5)}<br>
                            <b>🎯 Accuracy:</b> ${item.accuracy.toFixed(2)}m
                        </div>
                    </div>
                `;
                listDiv.innerHTML += card;
            });
            printLog("Đã cập nhật lịch sử làm việc.");
        } else {
            listDiv.innerHTML = "<div style='text-align:center;'>Chưa có dữ liệu hôm nay.</div>";
        }
    } catch (e) {
        listDiv.innerHTML = "<div style='text-align:center; color:red;'>Lỗi tải lịch sử!</div>";
    }
}

// 3. UPLOAD ẢNH (Hàm Jitter & Đóng gói)
function addGpsJitter(coord) { return coord + ((Math.random() - 0.5) * 0.00004); }
function getRealTime() {
    const now = new Date(); const pad = n => n.toString().padStart(2, '0');
    return { 
        date: parseInt(`${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`), 
        time: `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` 
    };
}

document.getElementById('btnSubmit').addEventListener('click', () => {
    const fileInput = document.getElementById('imageInput');
    const shopVal = document.getElementById('shopSelect').value;

    if (!shopVal) { alert("Vui lòng đợi tải danh sách cửa hàng!"); return; }
    if (fileInput.files.length === 0) { alert("Chưa chọn ảnh!"); return; }

    const shopData = JSON.parse(shopVal);
    const btn = document.getElementById('btnSubmit');
    btn.disabled = true; btn.innerText = "⏳ ĐANG UPLOAD...";

    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = async (e) => {
        try {
            const base64Data = e.target.result.split(',')[1];
            const finalLat = addGpsJitter(parseFloat(document.getElementById('lat').value));
            const finalLng = addGpsJitter(parseFloat(document.getElementById('lng').value));
            const randAccuracy = 20 + Math.random() * 3; 
            const fakePhotoName = crypto.randomUUID().toUpperCase() + ".jpg";
            const realTime = getRealTime();

            const payload = {
                "ShopId": shopData.id, "ShopCode": shopData.code,
                "PhotoName": fakePhotoName, "Latitude": finalLat, "Longitude": finalLng, "Accuracy": randAccuracy,
                "ReportId": 1, "PhotoTime": realTime.time, "PhotoType": "1", "PhotoDate": realTime.date, 
                "guid": crypto.randomUUID(), "PhotoData": base64Data, "WorkStatus": 1,
                "DataLocation": JSON.stringify({
                    latitude: finalLat, longitude: finalLng, accuracy: randAccuracy,
                    isFast: false, usedHighAccuracy: true, isLikelyPreciseFix: true
                })
            };

            printLog("Đang gửi báo cáo...");
            const response = await fetch('/proxy-upload', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: token, payload: payload })
            });
            const result = await response.json();
            
            if (response.ok && result.success) {
                printLog(`[THÀNH CÔNG] Đã lưu dữ liệu.`);
                // Tự động Load lại lịch sử sau 1.5 giây để server kịp xử lý ảnh
                setTimeout(loadHistory, 1500); 
            } else {
                printLog(`[THẤT BẠI] Lỗi: ${JSON.stringify(result.error)}`);
            }
        } catch (error) {
            printLog(`[LỖI MẠNG] ${error.message}`);
        } finally {
            btn.disabled = false; btn.innerText = "🚀 GỬI BÁO CÁO";
        }
    };
    reader.readAsDataURL(file);
});