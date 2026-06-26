const API_BASE = "https://lge-api.sucbat.com.vn";
let token = "";
let reqUser = "";

document.addEventListener('DOMContentLoaded', () => {
    token = localStorage.getItem('lge_token');
    const empName = localStorage.getItem('lge_emp_name');
    const expireText = localStorage.getItem('lge_expire_text');
    reqUser = localStorage.getItem('lge_username');

    if (!token) { window.location.href = 'login.html'; return; }
    
    const nameDisplay = document.getElementById('empNameDisplay');
    if(nameDisplay) {
        let displayName = empName;
        if (expireText) displayName += ` (Hạn: ${expireText})`;
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

function addGpsJitter(coord) { return coord + ((Math.random() - 0.5) * 0.00004); }
function getRealTime() {
    const now = new Date(); const pad = n => n.toString().padStart(2, '0');
    return { 
        date: parseInt(`${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`), 
        time: `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` 
    };
}

// Xử lý lỗi từ server, nếu isExpired thì đá văng ra ngoài
function handleMiddlewareError(result) {
    if (result.isExpired) {
        alert(result.error);
        logout();
        return true;
    }
    return false;
}

async function loadShops() {
    try {
        const res = await fetch('/proxy-get-shops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token, request_user: reqUser }) });
        const result = await res.json();
        if(handleMiddlewareError(result)) return;

        if (result.success && result.data?.data) {
            const select = document.getElementById('shopSelect');
            if(!select) return;
            select.innerHTML = ""; 
            result.data.data.forEach(shop => {
                const opt = document.createElement('option');
                opt.value = JSON.stringify({ id: shop.shopId, code: shop.shopCode });
                opt.innerText = `[${shop.shopCode}] ${shop.shopName}`;
                select.appendChild(opt);
            });
            printLog("Tải danh sách cửa hàng thành công.");
        }
    } catch (e) { printLog("Lỗi mạng khi tải cửa hàng."); }
}

async function loadHistory() {
    const today = new Date(); const pad = n => n.toString().padStart(2, '0');
    const dateStr = `${today.getFullYear()}${pad(today.getMonth()+1)}${pad(today.getDate())}`;
    const listDiv = document.getElementById('historyList');
    if(!listDiv) return;
    listDiv.innerHTML = "<div style='text-align:center; padding: 20px; color: #666;'>⏳ Đang tải dữ liệu...</div>";

    try {
        const res = await fetch('/proxy-get-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token, request_user: reqUser, date: dateStr }) });
        const result = await res.json();
        if(handleMiddlewareError(result)) return;

        listDiv.innerHTML = "";
        if (result.success && result.data?.data?.length > 0) {
            const historyData = result.data.data.reverse(); 
            historyData.forEach(item => {
                let typeName = `Check-in/out lần ${parseInt(item.photoType) + 1}`;
                let imgUrl = API_BASE + item.photoPath;
                let timeOnly = item.photoFullTime.split(' ')[1] || item.photoFullTime;
                listDiv.innerHTML += `
                    <div class="history-card">
                        <img src="${imgUrl}" alt="Photo" onerror="this.src='https://via.placeholder.com/80?text=No+Image'">
                        <div class="history-info">
                            <span class="badge">${typeName}</span><br>
                            <b>🕒 Giờ:</b> ${timeOnly}<br>
                            <b>📍 GPS:</b> ${item.latitude.toFixed(5)}, ${item.longitude.toFixed(5)}<br>
                            <b>🎯 Sai số:</b> ${item.accuracy.toFixed(1)}m
                        </div>
                    </div>`;
            });
        } else { listDiv.innerHTML = "<div style='text-align:center; padding: 20px; color: #888;'>Chưa có báo cáo hôm nay.</div>"; }
    } catch (e) { listDiv.innerHTML = "<div style='text-align:center; padding: 20px; color:#dc3545;'>Lỗi tải lịch sử!</div>"; }
}

const btnSubmit = document.getElementById('btnSubmit');
if (btnSubmit) {
    btnSubmit.addEventListener('click', () => {
        const fileInput = document.getElementById('imageInput');
        const shopVal = document.getElementById('shopSelect').value;

        if (!shopVal) { alert("Vui lòng đợi tải cửa hàng!"); return; }
        if (fileInput.files.length === 0) { alert("Bạn chưa chọn ảnh!"); return; }

        const shopData = JSON.parse(shopVal);
        btnSubmit.disabled = true; btnSubmit.innerText = "⏳ ĐANG XỬ LÝ ẢNH...";

        const file = fileInput.files[0];
        const reader = new FileReader();

        reader.onload = function(e) {
            const img = new Image();
            img.onload = async function() {
                // XÓA EXIF METADATA QUA CANVAS
                const canvas = document.createElement('canvas');
                canvas.width = img.width; canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                const cleanBase64Data = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];

                try {
                    const finalLat = addGpsJitter(parseFloat(document.getElementById('lat').value));
                    const finalLng = addGpsJitter(parseFloat(document.getElementById('lng').value));
                    const randAccuracy = 20 + Math.random() * 3; 
                    const fakePhotoName = crypto.randomUUID().toUpperCase() + ".jpg";
                    const realTime = getRealTime();

                    const payload = {
                        "ShopId": shopData.id, "ShopCode": shopData.code, "PhotoName": fakePhotoName, 
                        "Latitude": finalLat, "Longitude": finalLng, "Accuracy": randAccuracy,
                        "ReportId": 1, "PhotoTime": realTime.time, "PhotoType": "1", "PhotoDate": realTime.date, 
                        "guid": crypto.randomUUID(), "PhotoData": cleanBase64Data, "WorkStatus": 1,
                        "DataLocation": JSON.stringify({
                            latitude: finalLat, longitude: finalLng, accuracy: randAccuracy,
                            isFast: false, usedHighAccuracy: true, isLikelyPreciseFix: true
                        })
                    };

                    printLog("Đang đẩy dữ liệu lên máy chủ...");
                    const response = await fetch('/proxy-upload', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ token: token, request_user: reqUser, payload: payload })
                    });
                    const result = await response.json();
                    
                    if(handleMiddlewareError(result)) return;

                    if (response.ok && result.success) {
                        printLog(`[THÀNH CÔNG] Dữ liệu đã được ghi nhận.`);
                        fileInput.value = ""; document.getElementById('fileNameDisplay').innerHTML = "";
                        setTimeout(() => {
                            loadHistory();
                            const historyTabNav = document.querySelectorAll('.nav-item')[1]; 
                            if(historyTabNav) switchTab('tab-history', historyTabNav);
                        }, 1500); 
                    } else {
                        printLog(`[THẤT BẠI] Lỗi: ${JSON.stringify(result.error)}`);
                    }
                } catch (error) { printLog(`[LỖI MẠNG] ${error.message}`); } 
                finally { btnSubmit.disabled = false; btnSubmit.innerText = "🚀 GỬI BÁO CÁO"; }
            };
            img.src = e.target.result; 
        };
        reader.readAsDataURL(file);
    });
}