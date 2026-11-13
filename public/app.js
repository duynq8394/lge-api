const API_BASE = "https://lge-api.sucbat.com.vn";
let token = "";
let reqUser = "";
let nextPhotoType = "0";

// FIX #25: cache shop list để enrich history
let shopsCache = {};          // shopId -> { code, name }
// FIX #28: accuracy sinh sẵn khi rotate
let pendingAccuracy = null;
// FIX #26: giữ payload khi upload fail để retry
let lastFailedPayload = null;
let shopListenerBound = false;
let sessionKicked = false;

// ================== INIT ==================
document.addEventListener('DOMContentLoaded', () => {
    token = localStorage.getItem('lge_token');
    const empName = localStorage.getItem('lge_emp_name') || 'Nhân viên';
    const expireText = localStorage.getItem('lge_expire_text');
    reqUser = localStorage.getItem('lge_username');

    if (!token) { window.location.href = 'login.html'; return; }

    const nameDisplay = document.getElementById('empNameDisplay');
    if (nameDisplay) {
        let displayName = empName;
        if (expireText && expireText !== 'undefined') displayName += ` (${expireText})`;
        nameDisplay.innerText = displayName;
    }

    const savedAnchor = localStorage.getItem('lge_custom_anchor');
    if (savedAnchor && document.getElementById('customAnchorInput')) {
        document.getElementById('customAnchorInput').value = savedAnchor;
    }

    bindShopSelectListener();
    loadShops();
    loadHistory();

    // FIX #23: preview ảnh
    const imgInput = document.getElementById('imageInput');
    if (imgInput) {
        imgInput.addEventListener('change', function () {
            const display = document.getElementById('fileNameDisplay');
            const previewBox = document.getElementById('imagePreview');
            const previewImg = document.getElementById('previewImg');

            if (this.files && this.files.length > 0) {
                const file = this.files[0];
                display.innerHTML = `✅ Đã chọn: <span style="color:#333;">${file.name}</span> (${(file.size / 1024).toFixed(0)} KB)`;
                const reader = new FileReader();
                reader.onload = (e) => {
                    previewImg.src = e.target.result;
                    previewBox.style.display = 'block';
                };
                reader.readAsDataURL(file);
                // FIX #26: chọn ảnh mới → hủy trạng thái retry
                clearRetryState();
            } else {
                display.innerHTML = "";
                if (previewBox) previewBox.style.display = 'none';
                if (previewImg) previewImg.src = "";
            }
        });
    }

    // FIX #29: check session khi tab được focus lại
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && token && !sessionKicked) verifySessionStillValid();
    });
});

// ================== TOAST ==================
function showToast(msg, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) { console.log(`[${type}] ${msg}`); return; }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 350);
    }, 3200);
}

// ================== SESSION EXPIRED (FIX #29) ==================
function handleSessionExpired(msg) {
    if (sessionKicked) return;
    sessionKicked = true;
    showToast(msg || 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', 'error');
    setTimeout(() => {
        localStorage.clear();
        window.location.href = 'login.html';
    }, 1800);
}

/**
 * Wrapper tập trung cho mọi proxy call — tự bắt isExpired.
 * Trả về { res, result } hoặc throw { sessionExpired: true }.
 */
async function proxyFetch(endpoint, body) {
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    let result;
    try { result = await res.json(); }
    catch { throw new Error(`Response không phải JSON (status ${res.status})`); }

    if (result && result.isExpired) {
        handleSessionExpired(result.error);
        const e = new Error('SESSION_EXPIRED');
        e.sessionExpired = true;
        throw e;
    }
    return { res, result };
}

async function verifySessionStillValid() {
    try {
        await proxyFetch('/proxy-verify-session', { token, request_user: reqUser });
    } catch (e) { /* đã redirect nếu expired */ }
}

// ================== HELPERS ==================
function generateRealisticAccuracy() {
    const rand = Math.random();
    if (rand < 0.4) return 5 + Math.random() * 10;
    if (rand < 0.7) return 15 + Math.random() * 15;
    if (rand < 0.9) return 30 + Math.random() * 20;
    return 50 + Math.random() * 20;
}

function switchTab(tabId, navElement) {
    document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    navElement.classList.add('active');
}
window.switchTab = switchTab;

function logout() {
    localStorage.clear();
    window.location.href = 'login.html';
}
window.logout = logout;

function printLog(msg) {
    const logBox = document.getElementById('logBox');
    if (!logBox) return;
    logBox.innerHTML += `\n[${new Date().toLocaleTimeString()}] ${msg}`;
    logBox.scrollTop = logBox.scrollHeight;
}

function addGpsNoise(lat, lng, maxMeters = 65) {
    const r = 1 + Math.random() * (maxMeters - 1);
    const theta = Math.random() * 2 * Math.PI;
    const dLat = (r * Math.cos(theta)) / 111320;
    const dLng = (r * Math.sin(theta)) / (111320 * Math.cos(lat * Math.PI / 180));
    return { latitude: lat + dLat, longitude: lng + dLng };
}

function getDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseCoords(text) {
    if (!text) return null;
    const clean = text.replace(/[()]/g, '').trim();
    const parts = clean.split(/[,]+/);
    if (parts.length >= 2) {
        const lat = parseFloat(parts[0].replace(/,/g, '.').trim());
        const lng = parseFloat(parts[1].replace(/,/g, '.').trim());
        if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
    return null;
}

function getRealTime() {
    const now = new Date();
    const pad = n => n.toString().padStart(2, '0');
    return {
        date: parseInt(`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`),
        time: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    };
}

function updatePhotoTypeUI() {
    const display = document.getElementById('photoTypeDisplay');
    if (!display) return;
    const typeNum = parseInt(nextPhotoType);
    const isCheckIn = typeNum % 2 === 0;
    display.value = `${typeNum} - ${isCheckIn ? 'Check-in (Vào ca)' : 'Check-out (Ra ca)'}`;
}

// ================== SHOP LOAD (FIX #24) ==================
function bindShopSelectListener() {
    if (shopListenerBound) return;
    const select = document.getElementById('shopSelect');
    if (!select) return;
    select.addEventListener('change', function () {
        document.getElementById('lat').value = "";
        document.getElementById('lng').value = "";
        pendingAccuracy = null;
        updateAccuracyDisplay(null);
        const d = document.getElementById('distanceDisplay');
        if (d) d.innerHTML = "Vừa đổi shop, vui lòng bấm <b style='color:#a50034;'>[Xoay vị trí]</b>";
        clearRetryState();
    });
    shopListenerBound = true;
}

async function loadShops() {
    const select = document.getElementById('shopSelect');
    const btnReload = document.getElementById('btnReloadShops');
    if (!select) return;

    // Loading state
    select.disabled = true;
    select.classList.add('loading');
    select.innerHTML = '<option value="">⏳ Đang tải danh sách từ LGE...</option>';
    if (btnReload) btnReload.style.display = 'none';

    try {
        const { result } = await proxyFetch('/proxy-get-shops', { token, request_user: reqUser });

        if (result.success && result.data?.data) {
            select.innerHTML = "<option value=''>-- Chạm vào để chọn Cửa hàng --</option>";
            shopsCache = {};

            result.data.data.forEach(shop => {
                const lat = parseFloat(shop.latitude);
                const lng = parseFloat(shop.longitude);
                shopsCache[shop.shopId] = { code: shop.shopCode, name: shop.shopName };

                const opt = document.createElement('option');
                opt.value = JSON.stringify({
                    id: shop.shopId,
                    code: shop.shopCode,
                    lat: Number.isFinite(lat) ? lat : null,
                    lng: Number.isFinite(lng) ? lng : null
                });
                opt.innerText = `[${shop.shopCode}] ${shop.shopName}`;
                select.appendChild(opt);
            });

            select.disabled = false;
            select.classList.remove('loading');
            printLog(`Đã tải ${result.data.data.length} cửa hàng.`);
        } else {
            throw new Error(result.error || 'Dữ liệu rỗng');
        }
    } catch (e) {
        if (e.sessionExpired) return;
        select.innerHTML = "<option value=''>❌ Không tải được danh sách cửa hàng</option>";
        select.classList.remove('loading');
        if (btnReload) btnReload.style.display = 'inline-block';
        printLog(`[LỖI] Nạp danh sách cửa hàng: ${e.message}`);
    }
}
window.loadShops = loadShops;

// ================== ROTATE GPS (FIX #28) ==================
document.getElementById('btnRandomGps')?.addEventListener('click', () => {
    const shopSelect = document.getElementById('shopSelect');
    if (!shopSelect || !shopSelect.value) return alert("Vui lòng lựa chọn cửa hàng mục tiêu trước!");

    const shopData = JSON.parse(shopSelect.value);
    if (!Number.isFinite(shopData.lat) || !Number.isFinite(shopData.lng)) {
        return alert("Cửa hàng này chưa có tọa độ hợp lệ. Vui lòng dùng Điểm neo tùy chỉnh.");
    }

    let baseLat = shopData.lat;
    let baseLng = shopData.lng;

    const customVal = document.getElementById('customAnchorInput').value.trim();
    if (customVal) {
        const parsed = parseCoords(customVal);
        if (!parsed) return alert("Định dạng Điểm neo không hợp lệ!\nVí dụ: 21.2099, 106.0939");
        baseLat = parsed.lat;
        baseLng = parsed.lng;
    }

    const noisyGps = addGpsNoise(baseLat, baseLng, 65);
    document.getElementById('lat').value = noisyGps.latitude;
    document.getElementById('lng').value = noisyGps.longitude;

    // FIX #28: sinh & hiển thị accuracy ngay
    pendingAccuracy = generateRealisticAccuracy();
    updateAccuracyDisplay(pendingAccuracy);

    const distance = getDistanceMeters(noisyGps.latitude, noisyGps.longitude, shopData.lat, shopData.lng);
    const distDisplay = document.getElementById('distanceDisplay');
    if (distance > 150) {
        distDisplay.innerHTML = `⚠️ Cách cửa hàng gốc: <span style="color:#dc3545; font-size:14px;">${distance.toFixed(1)} mét</span><br><b style="color:#dc3545;">(Vượt mốc 150m — Submit sẽ bị chặn)</b>`;
    } else {
        distDisplay.innerHTML = `✅ Cách cửa hàng gốc: <span style="color:#059669; font-size:14px;">${distance.toFixed(1)} mét</span><br><b style="color:#059669;">(Hợp lệ: &lt;150m)</b>`;
    }

    clearRetryState();
    printLog(`Xoay vị trí OK. Lệch: ${distance.toFixed(1)}m | Accuracy: ${pendingAccuracy.toFixed(1)}m`);
});

function updateAccuracyDisplay(acc) {
    const el = document.getElementById('accuracyDisplay');
    if (!el) return;
    if (acc == null) {
        el.innerHTML = `<span style="color:#888;">Bấm <b>[Xoay vị trí]</b> để sinh Accuracy</span>`;
        return;
    }
    let color = '#059669';
    if (acc > 50) color = '#dc3545';
    else if (acc > 30) color = '#d97706';
    el.innerHTML = `🎯 <b style="color:${color}; font-size:14px;">${acc.toFixed(1)}m</b> <span style="color:#888; font-size:11px;">(sẽ gửi cùng báo cáo)</span>`;
}

// ================== HISTORY (FIX #25 + #31) ==================
async function loadHistory() {
    const today = new Date();
    const pad = n => n.toString().padStart(2, '0');
    const dateStr = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
    const listDiv = document.getElementById('historyList');
    if (!listDiv) return;
    listDiv.innerHTML = "<div style='text-align:center; padding: 20px; color: #666;'>⏳ Đang đồng bộ nhật ký...</div>";

    try {
        const { result } = await proxyFetch('/proxy-get-history', { token, request_user: reqUser, date: dateStr });

        listDiv.innerHTML = "";
        const items = result.data?.data;
        if (result.success && Array.isArray(items) && items.length > 0) {
            let maxType = -1;
            items.forEach(item => {
                const currentType = parseInt(item.photoType);
                if (!Number.isNaN(currentType) && currentType > maxType) maxType = currentType;
            });
            nextPhotoType = (maxType + 1).toString();
            updatePhotoTypeUI();

            const historyData = [...items].reverse();
            historyData.forEach(item => {
                const typeNum = parseInt(item.photoType);
                const isCheckIn = typeNum % 2 === 0;
                const typeName = `${isCheckIn ? 'Check-in' : 'Check-out'} lần ${Math.floor(typeNum / 2) + 1}`;

                const lat = parseFloat(item.latitude);
                const lng = parseFloat(item.longitude);
                const acc = parseFloat(item.accuracy);
                const latStr = Number.isFinite(lat) ? lat.toFixed(6) : 'N/A';
                const lngStr = Number.isFinite(lng) ? lng.toFixed(6) : 'N/A';
                const accStr = Number.isFinite(acc) ? acc.toFixed(1) + 'm' : 'N/A';

                // FIX #25: hiển thị shop — thử nhiều field name
                const shopLabel = resolveShopLabel(item);

                const imgUrl = API_BASE + (item.photoPath || '');
                const fullTime = String(item.photoFullTime || '');
                const timeOnly = fullTime.split(' ')[1] || fullTime || 'N/A';

                listDiv.innerHTML += `
                    <div class="history-card">
                        <img src="${imgUrl}" alt="Photo" onerror="this.src='https://via.placeholder.com/80?text=No+Image'">
                        <div class="history-info">
                            <span class="badge">${typeName}</span><br>
                            ${shopLabel ? `<b>🏪 Cửa hàng:</b> ${shopLabel}<br>` : ''}
                            <b>🕒 Thời gian:</b> ${timeOnly}<br>
                            <b>📍 Tọa độ GPS:</b> ${latStr}, ${lngStr}<br>
                            <b>🎯 Độ chính xác:</b> ${accStr}
                        </div>
                    </div>`;
            });
        } else {
            nextPhotoType = "0";
            updatePhotoTypeUI();
            listDiv.innerHTML = "<div style='text-align:center; padding: 20px; color: #888;'>Chưa ghi nhận dữ liệu báo cáo nào hôm nay.</div>";
        }
    } catch (e) {
        if (e.sessionExpired) return;
        listDiv.innerHTML = "<div style='text-align:center; padding: 20px; color:#dc3545;'>Lỗi đồng bộ nhật ký!</div>";
    }
}
window.loadHistory = loadHistory;

// FIX #25: resolve shop label đa dạng field name
function resolveShopLabel(item) {
    const shopId = item.shopId ?? item.ShopId;
    const shopCode = item.shopCode ?? item.ShopCode;
    const shopName = item.shopName ?? item.ShopName;

    if (shopCode) return `[${shopCode}] ${shopName || ''}`.trim();
    if (shopId != null && shopsCache[shopId]) {
        return `[${shopsCache[shopId].code}] ${shopsCache[shopId].name}`;
    }
    if (shopId != null) return `Shop #${shopId}`;
    return '';
}

// ================== SUBMIT + RETRY (FIX #26, #28, #31) ==================
const btnSubmit = document.getElementById('btnSubmit');
const btnRetry = document.getElementById('btnRetry');

function clearRetryState() {
    lastFailedPayload = null;
    if (btnRetry) btnRetry.style.display = 'none';
}

function showRetryUI() {
    if (btnRetry) btnRetry.style.display = 'inline-block';
}

if (btnSubmit) {
    btnSubmit.addEventListener('click', async () => {
        const fileInput = document.getElementById('imageInput');
        const shopVal = document.getElementById('shopSelect').value;

        if (!shopVal) return alert("Vui lòng lựa chọn Cửa hàng báo cáo trước!");

        const finalLatStr = document.getElementById('lat').value;
        const finalLngStr = document.getElementById('lng').value;
        if (!finalLatStr || !finalLngStr) {
            return alert("Vui lòng nhấn nút [Xoay vị trí] để phê duyệt tọa độ!");
        }

        const finalLat = parseFloat(finalLatStr);
        const finalLng = parseFloat(finalLngStr);
        if (!Number.isFinite(finalLat) || !Number.isFinite(finalLng)) {
            return alert("Tọa độ không hợp lệ, vui lòng bấm [Xoay vị trí] lại.");
        }

        if (!fileInput.files || fileInput.files.length === 0) {
            return alert("Vui lòng cung cấp hình ảnh báo cáo!");
        }

        const shopData = JSON.parse(shopVal);
        if (!Number.isFinite(shopData.lat) || !Number.isFinite(shopData.lng)) {
            return alert("Cửa hàng chưa có tọa độ hợp lệ, vui lòng dùng Điểm neo tùy chỉnh.");
        }

        const distToShop = getDistanceMeters(finalLat, finalLng, shopData.lat, shopData.lng);
        if (distToShop > 150) {
            return alert(`Vị trí cách cửa hàng ${distToShop.toFixed(1)}m, vượt quá 150m.\nVui lòng [Xoay vị trí] lại.`);
        }

        btnSubmit.disabled = true;
        btnSubmit.innerText = "⏳ ĐANG XỬ LÝ CANVAS...";

        const file = fileInput.files[0];
        const reader = new FileReader();

        reader.onload = function (e) {
            const img = new Image();
            img.onload = async function () {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                canvas.getContext('2d').drawImage(img, 0, 0);
                const cleanBase64Data = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];

                const accuracy = pendingAccuracy ?? generateRealisticAccuracy();
                const fakePhotoName = crypto.randomUUID().toUpperCase() + ".jpg";
                const realTime = getRealTime();

                const payload = {
                    ShopId: shopData.id, ShopCode: shopData.code, PhotoName: fakePhotoName,
                    Latitude: finalLat, Longitude: finalLng, Accuracy: accuracy,
                    ReportId: 1, PhotoTime: realTime.time, PhotoType: nextPhotoType, PhotoDate: realTime.date,
                    guid: crypto.randomUUID(), PhotoData: cleanBase64Data, WorkStatus: 1,
                    DataLocation: JSON.stringify({
                        latitude: finalLat, longitude: finalLng, accuracy,
                        isFast: false, usedHighAccuracy: true, isLikelyPreciseFix: true
                    })
                };

                const currentAnchorVal = document.getElementById('customAnchorInput').value.trim();
                localStorage.setItem('lge_custom_anchor', currentAnchorVal);

                await doUpload(payload);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// FIX #26: upload tách riêng để có thể gọi lại từ Retry
async function doUpload(payload) {
    try {
        printLog("Đang mã hóa & đẩy gói dữ liệu sang LGE...");
        const { res, result } = await proxyFetch('/proxy-upload', {
            token, request_user: reqUser, payload
        });

        if (res.ok && result.success) {
            showToast('✅ Gửi báo cáo thành công!', 'success');
            printLog('[THÀNH CÔNG] Dữ liệu đã được ghi nhận.');
            clearImage();
            clearRetryState();
            pendingAccuracy = null;
            updateAccuracyDisplay(null);

            // FIX #31: refresh history ngay, không chờ
            const historyNav = document.querySelectorAll('.nav-item')[1];
            if (historyNav) switchTab('tab-history', historyNav);
            await loadHistory();

            // Nếu LGE chưa kịp trả về data → thử lại 1 lần
            const listDiv = document.getElementById('historyList');
            if (listDiv && listDiv.innerText.includes('Chưa ghi nhận')) {
                setTimeout(() => loadHistory(), 1000);
            }
        } else {
            const errMsg = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
            printLog(`[THẤT BẠI] ${errMsg}`);
            showToast('❌ Gửi thất bại. Bấm [Thử lại] bên dưới.', 'error');
            lastFailedPayload = payload;
            showRetryUI();
        }
    } catch (e) {
        if (e.sessionExpired) return;
        printLog(`[LỖI MẠNG] ${e.message}`);
        showToast('❌ Lỗi kết nối. Bấm [Thử lại] để gửi lại.', 'error');
        lastFailedPayload = payload;
        showRetryUI();
    } finally {
        if (btnSubmit) {
            btnSubmit.disabled = false;
            btnSubmit.innerText = "🚀 GỬI DỮ LIỆU LÊN MÁY CHỦ";
        }
    }
}

// FIX #26: nút retry — không cần chọn lại ảnh
btnRetry?.addEventListener('click', async () => {
    if (!lastFailedPayload) return;
    btnRetry.disabled = true;
    btnRetry.innerText = "⏳ Đang thử lại...";
    const backup = lastFailedPayload;
    lastFailedPayload = null;
    await doUpload(backup);
    btnRetry.disabled = false;
    btnRetry.innerText = "🔄 Thử Lại Gửi Dữ Liệu";
});

// ================== IMAGE CLEAR ==================
function clearImage() {
    const imgInput = document.getElementById('imageInput');
    if (imgInput) imgInput.value = "";
    const display = document.getElementById('fileNameDisplay');
    if (display) display.innerHTML = "";
    const previewBox = document.getElementById('imagePreview');
    if (previewBox) previewBox.style.display = 'none';
    const previewImg = document.getElementById('previewImg');
    if (previewImg) previewImg.src = "";
}
window.clearImage = clearImage;