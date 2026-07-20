const API_BASE = "https://lge-api.sucbat.com.vn";
let token = "";
let reqUser = "";
let nextPhotoType = "0"; 

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

    // NÂNG CẤP: Tự động khôi phục điểm neo cũ từ bộ nhớ máy người dùng
    const savedAnchor = localStorage.getItem('lge_custom_anchor');
    if (savedAnchor && document.getElementById('customAnchorInput')) {
        document.getElementById('customAnchorInput').value = savedAnchor;
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
// ACCURACY PHÂN BỐ TỰ NHIÊN (≤ 70m)
function generateRealisticAccuracy() {
    const rand = Math.random();

    if (rand < 0.4) return 5 + Math.random() * 10;       // 5–15m
    if (rand < 0.7) return 15 + Math.random() * 15;      // 15–30m
    if (rand < 0.9) return 30 + Math.random() * 20;      // 30–50m
    return 50 + Math.random() * 20;                      // 50–70m
}
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

// THUẬT TOÁN ĐỘ NHIỄU GPS HÌNH TRÒN PHÂN BỐ ĐỀU CHUẨN XÁC TOÁN HỌC
function addGpsNoise(lat, lng, maxMeters = 65) {
    const r = 1 + Math.random() * (maxMeters - 1); 
    const theta = Math.random() * 2 * Math.PI; 

    const dLat = (r * Math.cos(theta)) / 111320;
    const dLng = (r * Math.sin(theta)) / (111320 * Math.cos(lat * Math.PI / 180));

    return {
        latitude: lat + dLat,
        longitude: lng + dLng
    };
}

// THUẬT TOÁN HAVERSINE: Tính khoảng cách chính xác theo mét giữa 2 cặp tọa độ toàn cầu
function getDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Bán kính Trái Đất theo mét
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; 
}

// Trích xuất làm sạch chuỗi tọa độ được dán từ Google Maps (hỗ trợ cả dấu phẩy, dấu ngoặc)
function parseCoords(text) {
    if (!text) return null;
    const clean = text.replace(/[()]/g, '').trim();
    const parts = clean.split(/[,]+/);
    if (parts.length >= 2) {
        const lat = parseFloat(parts[0].replace(/,/g, '.').trim());
        const lng = parseFloat(parts[1].replace(/,/g, '.').trim());
        if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
    }
    return null;
}

function getRealTime() {
    const now = new Date(); const pad = n => n.toString().padStart(2, '0');
    return { 
        date: parseInt(`${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`), 
        time: `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` 
    };
}

function handleMiddlewareError(result) {
    if (result.isExpired) {
        alert("THÔNG BÁO HỆ THỐNG:\n" + result.error);
        logout();
        return true;
    }
    return false;
}

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
                opt.value = JSON.stringify({ id: shop.shopId, code: shop.shopCode, lat: shop.latitude, lng: shop.longitude });
                opt.innerText = `[${shop.shopCode}] ${shop.shopName}`;
                select.appendChild(opt);
            });

            select.addEventListener('change', function() {
                document.getElementById('lat').value = "";
                document.getElementById('lng').value = "";
                document.getElementById('distanceDisplay').innerHTML = "Vừa đổi shop, vui lòng bấm nút <b style='color:#a50034;'>[Xoay vị trí]</b>";
            });

            printLog("Tải thành công danh sách Cửa hàng điều hành.");
        }
    } catch (e) { printLog("Không thể nạp danh sách cửa hàng."); }
}

// XỬ LÝ SỰ KIỆN NÚT XOAY VỊ TRÍ (RANDOM GPS VÀ TÍNH KHOẢNG CÁCH)
document.getElementById('btnRandomGps').addEventListener('click', () => {
    const shopSelect = document.getElementById('shopSelect');
    if (!shopSelect.value) return alert("Vui lòng lựa chọn cửa hàng mục tiêu trước!");

    const shopData = JSON.parse(shopSelect.value);
    
    // Quyết định điểm gốc (Nếu có dán điểm neo tùy chỉnh thì dùng điểm neo, ngược lại dùng tọa độ shop)
    let baseLat = shopData.lat;
    let baseLng = shopData.lng;
    
    const customAnchorVal = document.getElementById('customAnchorInput').value.trim();
    if (customAnchorVal) {
        const parsed = parseCoords(customAnchorVal);
        if (parsed) {
            baseLat = parsed.lat;
            baseLng = parsed.lng;
        } else {
            return alert("Định dạng Điểm neo dán vào không hợp lệ!\nVui lòng nhập dạng chuỗi vĩ độ, kinh độ (VD: 21.2099, 106.0939)");
        }
    }

    // Tiến hành xoay tạo nhiễu ngẫu nhiên trong bán kính hình tròn an toàn (max 65 mét)
    const noisyGps = addGpsNoise(baseLat, baseLng, 65);
    
    // Khóa dữ liệu hiển thị cố định lên ô Input màn hình cho Tester kiểm tra duyệt qua
    document.getElementById('lat').value = noisyGps.latitude;
    document.getElementById('lng').value = noisyGps.longitude;

    // Tính toán chênh lệch khoảng cách hình học so với cửa hàng gốc thực tế của LGE
    const distance = getDistanceMeters(noisyGps.latitude, noisyGps.longitude, shopData.lat, shopData.lng);
    const distDisplay = document.getElementById('distanceDisplay');
    
    if (distance > 150) {
        distDisplay.innerHTML = `⚠️ Cách cửa hàng gốc: <span style="color:#dc3545; font-size:14px;">${distance.toFixed(1)} mét</span><br><b style="color:#dc3545;">(Nguy hiểm: Vượt mốc cho phép >150m của LGE)</b>`;
    } else {
        distDisplay.innerHTML = `✅ Cách cửa hàng gốc: <span style="color:#059669; font-size:14px;">${distance.toFixed(1)} mét</span><br><b style="color:#059669;">(Hợp lệ: Đã khóa vị trí an toàn &lt;150m)</b>`;
    }
    
    printLog(`Đã xoay vị trí ngẫu nhiên. Khoảng cách lệch gốc: ${distance.toFixed(1)}m`);
});

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
            nextPhotoType = "0"; 
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

        if (!shopVal) return alert("Vui lòng lựa chọn Cửa hàng báo cáo trước!");
        
        // KIỂM TRA ĐIỀU KIỆN ĐÃ ẤN XOAY VỊ TRÍ CHƯA
        const finalLatStr = document.getElementById('lat').value;
        const finalLngStr = document.getElementById('lng').value;
        if (!finalLatStr || !finalLngStr) return alert("Vui lòng nhấn nút [Xoay vị trí] để phê duyệt tọa độ trước khi gửi dữ liệu!");

        if (fileInput.files.length === 0) return alert("Vui lòng cung cấp hình ảnh báo cáo!");

        const shopData = JSON.parse(shopVal);
        btnSubmit.disabled = true; btnSubmit.innerText = "⏳ ĐANG XỬ LÝ CANVAS (KHỬ EXIF)...";

        const file = fileInput.files[0];
        const reader = new FileReader();

        reader.onload = function(e) {
            const img = new Image();
            img.onload = async function() {
                const canvas = document.createElement('canvas');
                canvas.width = img.width; canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                const cleanBase64Data = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];

                try {
                    // LẤY ĐÚNG TỌA ĐỘ NGẪU NHIÊN MÀ USER ĐÃ XEM VÀ ĐỒNG Ý TRÊN MÀN HÌNH
                    const finalLat = parseFloat(finalLatStr);
                    const finalLng = parseFloat(finalLngStr);

                    const randAccuracy = generateRealisticAccuracy();
                    const fakePhotoName = crypto.randomUUID().toUpperCase() + ".jpg";
                    const realTime = getRealTime();

                    const payload = {
                        "ShopId": shopData.id, "ShopCode": shopData.code, "PhotoName": fakePhotoName, 
                        "Latitude": finalLat, "Longitude": finalLng, "Accuracy": randAccuracy,
                        "ReportId": 1, "PhotoTime": realTime.time, "PhotoType": nextPhotoType, "PhotoDate": realTime.date, 
                        "guid": crypto.randomUUID(), "PhotoData": cleanBase64Data, "WorkStatus": 1,
                        "DataLocation": JSON.stringify({
                            latitude: finalLat, longitude: finalLng, accuracy: randAccuracy,
                            isFast: false, usedHighAccuracy: true, isLikelyPreciseFix: true
                        })
                    };

                    // NÂNG CẤP BẢO MẬT: Lưu trữ lại điểm neo tùy chỉnh vào máy người dùng trước khi gửi đi thành công
                    const currentAnchorVal = document.getElementById('customAnchorInput').value.trim();
                    localStorage.setItem('lge_custom_anchor', currentAnchorVal);

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