// ==========================================
// CẤU HÌNH & KHỞI TẠO APP
// ==========================================
const API_BASE = "https://lge-api.sucbat.com.vn";
let token = "";

// Kiểm tra trạng thái đăng nhập khi vừa mở App
document.addEventListener('DOMContentLoaded', () => {
    token = localStorage.getItem('lge_token');
    const empName = localStorage.getItem('lge_emp_name');

    // Nếu chưa đăng nhập, đá về trang Login
    if (!token) {
        window.location.href = 'login.html';
        return;
    }
    
    // Hiển thị tên nhân viên lên Header
    const nameDisplay = document.getElementById('empNameDisplay');
    if(nameDisplay) nameDisplay.innerText = empName;

    // Tự động tải danh sách Shop và Lịch sử ngầm bên dưới
    loadShops();
    loadHistory();

    // Bắt sự kiện khi người dùng chọn ảnh để hiển thị tên ảnh
    const imgInput = document.getElementById('imageInput');
    if (imgInput) {
        imgInput.addEventListener('change', function() {
            const display = document.getElementById('fileNameDisplay');
            if (this.files && this.files.length > 0) {
                display.innerHTML = `✅ Đã chọn: <span style="color:#333;">${this.files[0].name}</span>`;
            } else {
                display.innerHTML = "";
            }
        });
    }
});

// ==========================================
// LOGIC GIAO DIỆN & CÔNG CỤ (UI & UTILS)
// ==========================================

// Hàm chuyển Tab (Bottom Navigation)
function switchTab(tabId, navElement) {
    // Ẩn tất cả Tab Content
    document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
    // Bỏ màu xanh của tất cả các nút dưới đáy
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    
    // Bật Tab và nút được chọn
    document.getElementById(tabId).classList.add('active');
    navElement.classList.add('active');
}

// Đăng xuất
function logout() {
    localStorage.removeItem('lge_token');
    localStorage.removeItem('lge_emp_name');
    window.location.href = 'login.html';
}

// In log ra màn hình Tab Upload
function printLog(msg) {
    const logBox = document.getElementById('logBox');
    if(!logBox) return;
    logBox.innerHTML += `\n[${new Date().toLocaleTimeString()}] ${msg}`;
    logBox.scrollTop = logBox.scrollHeight;
}

// Tạo nhiễu GPS (sai số 1-3 mét tự nhiên)
function addGpsJitter(coord) { 
    return coord + ((Math.random() - 0.5) * 0.00004); 
}

// Lấy thời gian thực chuẩn hệ thống
function getRealTime() {
    const now = new Date(); 
    const pad = n => n.toString().padStart(2, '0');
    return { 
        date: parseInt(`${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`), 
        time: `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` 
    };
}

// ==========================================
// KẾT NỐI API (LOAD SHOPS & HISTORY)
// ==========================================

// 1. Lấy danh sách cửa hàng đổ vào Dropdown
async function loadShops() {
    try {
        const res = await fetch('/proxy-get-shops', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token })
        });
        const result = await res.json();
        
        if (result.success && result.data && result.data.data) {
            const select = document.getElementById('shopSelect');
            if(!select) return;
            
            select.innerHTML = ""; // Xóa dòng "Đang tải..."
            
            result.data.data.forEach(shop => {
                const opt = document.createElement('option');
                opt.value = JSON.stringify({ id: shop.shopId, code: shop.shopCode });
                opt.innerText = `[${shop.shopCode}] ${shop.shopName}`;
                select.appendChild(opt);
            });
            printLog("Tải danh sách cửa hàng thành công.");
        }
    } catch (e) {
        printLog("Lỗi mạng khi tải danh sách cửa hàng.");
    }
}

// 2. Lấy Lịch sử Check-in/out hôm nay
async function loadHistory() {
    const today = new Date();
    const pad = n => n.toString().padStart(2, '0');
    const dateStr = `${today.getFullYear()}${pad(today.getMonth()+1)}${pad(today.getDate())}`;
    
    const listDiv = document.getElementById('historyList');
    if(!listDiv) return;
    listDiv.innerHTML = "<div style='text-align:center; padding: 20px; font-size: 13px; color: #666;'>⏳ Đang tải dữ liệu...</div>";

    try {
        const res = await fetch('/proxy-get-history', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token, date: dateStr })
        });
        const result = await res.json();
        
        listDiv.innerHTML = "";
        if (result.success && result.data && result.data.data && result.data.data.length > 0) {
            // Đảo mảng để thẻ mới nhất (check in/out gần nhất) nhảy lên đầu trang
            const historyData = result.data.data.reverse(); 

            historyData.forEach(item => {
                let typeName = `Check-in/out lần ${parseInt(item.photoType) + 1}`;
                let imgUrl = API_BASE + item.photoPath;
                // Cắt chỉ lấy Giờ:Phút:Giây (VD: từ "2026-06-26 08:48:01" -> "08:48:01")
                let timeOnly = item.photoFullTime.split(' ')[1] || item.photoFullTime;

                const card = `
                    <div class="history-card">
                        <img src="${imgUrl}" alt="Photo" onerror="this.src='https://via.placeholder.com/80?text=No+Image'">
                        <div class="history-info">
                            <span class="badge">${typeName}</span><br>
                            <b>🕒 Giờ:</b> ${timeOnly}<br>
                            <b>📍 GPS:</b> ${item.latitude.toFixed(5)}, ${item.longitude.toFixed(5)}<br>
                            <b>🎯 Sai số:</b> ${item.accuracy.toFixed(1)}m
                        </div>
                    </div>
                `;
                listDiv.innerHTML += card;
            });
            printLog("Đã đồng bộ lịch sử hôm nay.");
        } else {
            listDiv.innerHTML = "<div style='text-align:center; padding: 20px; font-size: 13px; color: #888;'>Chưa có dữ liệu báo cáo nào trong hôm nay.</div>";
        }
    } catch (e) {
        listDiv.innerHTML = "<div style='text-align:center; padding: 20px; color:#dc3545; font-size: 13px;'>Lỗi kết nối khi tải lịch sử!</div>";
    }
}

// ==========================================
// THỰC THI UPLOAD (GỬI BÁO CÁO)
// ==========================================
const btnSubmit = document.getElementById('btnSubmit');

if (btnSubmit) {
    btnSubmit.addEventListener('click', () => {
        const fileInput = document.getElementById('imageInput');
        const shopVal = document.getElementById('shopSelect').value;

        // Validation cơ bản
        if (!shopVal) { alert("Vui lòng đợi tải danh sách cửa hàng!"); return; }
        if (fileInput.files.length === 0) { alert("Bạn chưa chọn ảnh báo cáo!"); return; }

        const shopData = JSON.parse(shopVal);
        btnSubmit.disabled = true; 
        btnSubmit.innerText = "⏳ ĐANG XỬ LÝ DỮ LIỆU...";

        const file = fileInput.files[0];
        const reader = new FileReader();

        reader.onload = async (e) => {
            try {
                const base64Data = e.target.result.split(',')[1];
                
                // Trộn nhiễu GPS và đóng gói thông số ẩn danh
                const finalLat = addGpsJitter(parseFloat(document.getElementById('lat').value));
                const finalLng = addGpsJitter(parseFloat(document.getElementById('lng').value));
                const randAccuracy = 20 + Math.random() * 3; 
                const fakePhotoName = crypto.randomUUID().toUpperCase() + ".jpg";
                const realTime = getRealTime();

                const payload = {
                    "ShopId": shopData.id, 
                    "ShopCode": shopData.code,
                    "PhotoName": fakePhotoName, 
                    "Latitude": finalLat, 
                    "Longitude": finalLng, 
                    "Accuracy": randAccuracy,
                    "ReportId": 1, 
                    "PhotoTime": realTime.time, 
                    "PhotoType": "1", 
                    "PhotoDate": realTime.date, 
                    "guid": crypto.randomUUID(), 
                    "PhotoData": base64Data, 
                    "WorkStatus": 1,
                    "DataLocation": JSON.stringify({
                        latitude: finalLat, longitude: finalLng, accuracy: randAccuracy,
                        isFast: false, usedHighAccuracy: true, isLikelyPreciseFix: true
                    })
                };

                printLog("Đang đẩy dữ liệu lên máy chủ...");
                
                const response = await fetch('/proxy-upload', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: token, payload: payload })
                });
                const result = await response.json();
                
                if (response.ok && result.success) {
                    printLog(`[THÀNH CÔNG] Dữ liệu đã được ghi nhận.`);
                    
                    // Xóa ảnh đã chọn trên form để chuẩn bị cho lần sau
                    fileInput.value = "";
                    document.getElementById('fileNameDisplay').innerHTML = "";
                    
                    // Tự động chuyển qua Tab Lịch Sử và Load lại ảnh mới sau 1.5s
                    setTimeout(() => {
                        loadHistory();
                        const historyTabNav = document.querySelectorAll('.nav-item')[1]; // Lấy nút thứ 2 (Lịch Sử)
                        if(historyTabNav) switchTab('tab-history', historyTabNav);
                    }, 1500); 

                } else {
                    printLog(`[THẤT BẠI] Máy chủ từ chối: ${JSON.stringify(result.error)}`);
                    alert("Có lỗi khi upload. Vui lòng xem log bên dưới.");
                }
            } catch (error) {
                printLog(`[LỖI MẠNG] ${error.message}`);
            } finally {
                btnSubmit.disabled = false; 
                btnSubmit.innerText = "🚀 GỬI BÁO CÁO";
            }
        };
        
        // Đọc file dưới dạng Base64
        reader.readAsDataURL(file);
    });
}