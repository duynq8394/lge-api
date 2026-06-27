const API_BASE = "https://lge-api.sucbat.com.vn";
let token = "";
let reqUser = "";
let nextPhotoType = "0"; // Lưu trữ loại báo cáo tự động tính toán tiếp theo

document.addEventListener('DOMContentLoaded', () => {
    token = localStorage.getItem('lge_token');
    const empName = localStorage.getItem('lge_emp_name');
    const expireText = localStorage.getItem('lge_expire_text');
    reqUser = localStorage.getItem('lge_username');

    if (!token) { window.location.href = 'login.html'; return; }
    
    const nameDisplay = document.getElementById('empNameDisplay');
    if(nameDisplay) {
        let displayName = empName;
        if (expireText) displayName += ` (${expireText})`;
        nameDisplay.innerText = displayName;
    }

    loadShops(); loadHistory();

    const imgInput = document.getElementById('imageInput');
    if (imgInput) {
        imgInput.addEventListener('change', function() {
            const display = document.getElementById('fileNameDisplay');
            if (this.files && this.files.length > 0) {
                display.innerHTML = `✅ Đã chọn: <span style="color:#333;">${this.files[0].name}</span>`;
            } else { display.innerHTML = ""; }
        });
    }
});

function switchTab(tabId, navElement) {
    document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    navElement.classList.add('active');
}

function logout() {
    localStorage.clear();
    window.location.href = 'login.html';
}

function printLog(msg) {
    const logBox = document.getElementById('logBox');
    if(!logBox) return;
    logBox.innerHTML += `\n[${new Date().toLocaleTimeString()}] ${msg}`;
    logBox.scrollTop = logBox.scrollHeight;
}

// THUẬT TOÁN ĐỘ NHIỄU GPS HÌNH TRÒN PHÂN BỐ ĐỀU (BÁN KÍNH 1m - 45m AN TOÀN TUYỆT ĐỐI)
function addGpsNoise(lat, lng, maxMeters = 45) {
    const r = 1 + Math.random() * (maxMeters - 1); 
    const theta = Math.random() * 2 * Math.PI; 

    const dLat = (r * Math.cos(theta)) / 111320;
    const dLng = (r * Math.sin(theta)) / (111320 * Math.cos(lat * Math.PI / 180));

    return {
        latitude: lat + dLat,
        longitude: lng + dLng
    };
}

function getRealTime() {
    const now = new Date(); const pad = n => n.toString().padStart(2, '0');
    return { 
        date: parseInt(`${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`), 
        time: `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` 
    };
}

// CƠ CHẾ QUÉT MIDDLEWARE: Đuổi và xóa sạch phiên nếu tài khoản hết hạn/bị xóa trên Firebase
function handleMiddlewareError(result) {
    if (result.isExpired) {
        alert("THÔNG BÁO HỆ THỐNG:\n" + result.error);
        logout();
        return true;
    }
    return false;
}

// Tự động phân tách nội suy chữ hiển thị Chẵn (Check-in) / Lẻ (Check-out)
function updatePhotoTypeUI() {
    const display = document.getElementById('photoTypeDisplay');
    if (!display) return;
    
    const typeNum = parseInt(nextPhotoType);
    const isCheckIn = typeNum % 2 === 0;
    
    display.value = `${typeNum} - ${isCheckIn ? 'Check-in (Vào ca)' : 'Check-out (Ra ca)'}`;
}

async function loadShops() {
    try {
        const res = await fetch('/proxy-get-shops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token, request_user: reqUser }) });
        const result = await res.json();
        if(handleMiddlewareError(result)) return;

        if (result.success && result.data?.data) {
            const select = document.getElementById('shopSelect');
            if(!select) return;
            select.innerHTML = "<option value=''>-- Chạm vào để chọn Cửa hàng --</option>"; 
            
            result.data.data.forEach(shop => {
                const opt = document.createElement('option');
                opt.value = JSON.stringify({ 
                    id: shop.shopId, 
                    code: shop.shopCode,
                    lat: shop.latitude,
                    lng: shop.longitude 
                });
                opt.innerText = `[${shop.shopCode}] ${shop.shopName}`;
                select.appendChild(opt);
            });

            // TỰ ĐỘNG ĐỒNG BỘ ĐIỀN TỌA ĐỘ GỐC CỦA SHOP KHI CÓ THAY ĐỔI LỰA CHỌN
            select.addEventListener('change', function() {
                if(!this.value) {
                    document.getElementById('lat').value = "";
                    document.getElementById('lng').value = "";
                    return;
                }
                const selectedData = JSON.parse(this.value);
                if(selectedData.lat && selectedData.lng) {
                    document.getElementById('lat').value = selectedData.lat;
                    document.getElementById('lng').value = selectedData.lng;
                }
            });

            printLog("Tải thành công danh sách Cửa hàng điều hành.");
        }
    } catch (e) { printLog("Không thể nạp danh sách cửa hàng."); }
}

async function loadHistory() {
    const today = new Date(); const pad = n => n.toString().padStart(2, '0');
    const dateStr = `${today.getFullYear()}${pad(today.getMonth()+1)}${pad(today.getDate())}`;
    const listDiv = document.getElementById('historyList');
    if(!listDiv) return;
    listDiv.innerHTML = "<div style='text-align:center; padding: 20px; color: #666;'>⏳ Đang đồng bộ nhật ký...</div>";

    try {
        const res = await fetch('/proxy-get-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token, request_user: reqUser, date: dateStr }) });
        const result = await res.json();
        if(handleMiddlewareError(result)) return;

        listDiv.innerHTML = "";
        if (result.success && result.data?.data?.length > 0) {
            // TÌM PHẦN TỬ PHOTO_TYPE LỚN NHẤT ĐỂ TỰ ĐỘNG NỘI SUY PHOTO_TYPE TIẾP THEO
            let maxType = -1;
            result.data.data.forEach(item => {
                const currentType = parseInt(item.photoType);
                if (!isNaN(currentType) && currentType > maxType) maxType = currentType;
            });
            nextPhotoType = (maxType + 1).toString();
            updatePhotoTypeUI();

            const historyData = result.data.data.reverse(); 
            historyData.forEach(item => {
                const typeNum = parseInt(item.photoType);
                const isCheckIn = typeNum % 2 === 0;
                let typeName = `${isCheckIn ? 'Check-in' : 'Check-out'} lần ${Math.floor(typeNum / 2) + 1}`;
                
                let imgUrl = API_BASE + item.photoPath;
                let timeOnly = item.photoFullTime.split(' ')[1] || item.photoFullTime;
                listDiv.innerHTML += `
                    <div class="history-card">
                        <img src="${imgUrl}" alt="Photo" onerror="this.src='https://via.placeholder.com/80?text=No+Image'">
                        <div class="history-info">
                            <span class="badge">${typeName}</span><br>
                            <b>🕒 Thời gian:</b> ${timeOnly}<br>
                            <b>📍 Tọa độ GPS:</b> ${item.latitude.toFixed(6)}, ${item.longitude.toFixed(6)}<br>
                            <b>🎯 Độ chính xác:</b> ${item.accuracy.toFixed(1)}m
                        </div>
                    </div>`;
            });
        } else { 
            nextPhotoType = "0"; // Reset về 0 (Check-in đầu ngày) nếu chưa có lịch sử
            updatePhotoTypeUI();
            listDiv.innerHTML = "<div style='text-align:center; padding: 20px; color: #888;'>Chưa ghi nhận dữ liệu báo cáo nào hôm nay.</div>"; 
        }
    } catch (e) { listDiv.innerHTML = "<div style='text-align:center; padding: 20px; color:#dc3545;'>Lỗi đồng bộ nhật ký từ LGE!</div>"; }
}

const btnSubmit = document.getElementById('btnSubmit');
if (btnSubmit) {
    btnSubmit.addEventListener('click', () => {
        const fileInput = document.getElementById('imageInput');
        const shopVal = document.getElementById('shopSelect').value;

        if (!shopVal) { alert("Vui lòng lựa chọn Cửa hàng báo cáo trước!"); return; }
        if (fileInput.files.length === 0) { alert("Vui lòng cung cấp hình ảnh báo cáo!"); return; }

        const shopData = JSON.parse(shopVal);
        btnSubmit.disabled = true; btnSubmit.innerText = "⏳ ĐANG XỬ LÝ CANVAS (KHỬ EXIF)...";

        const file = fileInput.files[0];
        const reader = new FileReader();

        reader.onload = function(e) {
            const img = new Image();
            img.onload = async function() {
                // TIẾN HÀNH VẼ LẠI ẢNH QUA CANVAS ĐỂ LỘT BỎ TOÀN BỘ SIÊU DỮ LIỆU GỐC (EXIF/METADATA)
                const canvas = document.createElement('canvas');
                canvas.width = img.width; canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                const cleanBase64Data = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];

                try {
                    // Trích xuất tọa độ gốc của Cửa hàng từ giao diện
                    const rawLat = parseFloat(document.getElementById('lat').value);
                    const rawLng = parseFloat(document.getElementById('lng').value);
                    
                    // Trộn nhiễu GPS vòng tròn toán học ngẫu nhiên 1-45 mét cực kỳ an toàn
                    const gps = addGpsNoise(rawLat, rawLng, 45);
                    const finalLat = gps.latitude;
                    const finalLng = gps.longitude;

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
                        "PhotoType": nextPhotoType, 
                        "PhotoDate": realTime.date, 
                        "guid": crypto.randomUUID(), 
                        "PhotoData": cleanBase64Data, 
                        "WorkStatus": 1,
                        "DataLocation": JSON.stringify({
                            latitude: finalLat, longitude: finalLng, accuracy: randAccuracy,
                            isFast: false, usedHighAccuracy: true, isLikelyPreciseFix: true
                        })
                    };

                    printLog("Đang mã hóa & đẩy gói dữ liệu sang LGE...");
                    const response = await fetch('/proxy-upload', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ token: token, request_user: reqUser, payload: payload })
                    });
                    const result = await response.json();
                    
                    if(handleMiddlewareError(result)) return;

                    if (response.ok && result.success) {
                        printLog(`[THÀNH CÔNG] Dữ liệu chấm công đã được ghi nhận.`);
                        fileInput.value = ""; document.getElementById('fileNameDisplay').innerHTML = "";
                        // Tự động chuyển tab sau 1.5 giây để hệ thống máy chủ LGE render kịp ảnh
                        setTimeout(() => {
                            loadHistory();
                            const historyTabNav = document.querySelectorAll('.nav-item')[1]; 
                            if(historyTabNav) switchTab('tab-history', historyTabNav);
                        }, 1500); 
                    } else {
                        printLog(`[THẤT BẠI] Máy chủ từ chối: ${JSON.stringify(result.error)}`);
                    }
                } catch (error) { printLog(`[LỖI MẠNG] Không thể kết nối cổng proxy: ${error.message}`); } 
                finally { btnSubmit.disabled = false; btnSubmit.innerText = "🚀 GỬI DỮ LIỆU LÊN MÁY CHỦ"; }
            };
            img.src = e.target.result; 
        };
        reader.readAsDataURL(file);
    });
}