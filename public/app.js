// ============================================================
// app.js — LGE WebApp Client
// ============================================================
const API_BASE = "https://lgpg-sapi.sucbat.com.vn";
let token = "";
let reqUser = "";
let nextPhotoType = "0";

let shopsCache = {};
let pendingAccuracy = null;
let lastFailedPayload = null;
let shopListenerBound = false;
let sessionKicked = false;

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', async () => {
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

    bindImagePreview();
    bindShopSelectListener();

    // --- Background checks (không block UI) ---
    checkAppVersion();
    checkDeviceRegistered();
    verifySessionStillValid().catch(() => {});

    // --- Data loaders ---
    await Promise.all([
        loadPlan().catch(() => {}),
        (async () => { await syncMenu().catch(() => {}); })(),
        (async () => { await loadShops().catch(() => {}); })(),
        (async () => { await loadHistory().catch(() => {}); })()
    ]);

    // --- Refresh on visibility ---
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && token && !sessionKicked) verifySessionStillValid();
    });
});

function bindImagePreview() {
    const imgInput = document.getElementById('imageInput');
    if (!imgInput) return;
    imgInput.addEventListener('change', function () {
        const display = document.getElementById('fileNameDisplay');
        const previewBox = document.getElementById('imagePreview');
        const previewImg = document.getElementById('previewImg');
        if (this.files && this.files.length > 0) {
            const file = this.files[0];
            display.innerHTML = `✅ Đã chọn: <span style="color:#333;">${file.name}</span> (${(file.size/1024).toFixed(0)} KB)`;
            const reader = new FileReader();
            reader.onload = (e) => {
                previewImg.src = e.target.result;
                previewBox.style.display = 'block';
            };
            reader.readAsDataURL(file);
            clearRetryState();
        } else {
            display.innerHTML = "";
            if (previewBox) previewBox.style.display = 'none';
            if (previewImg) previewImg.src = "";
        }
    });
}

// ==================== TOAST ====================
function showToast(msg, type = 'success') {
    const c = document.getElementById('toastContainer');
    if (!c) { console.log(`[${type}] ${msg}`); return; }
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.innerText = msg;
    c.appendChild(t);
    setTimeout(() => { t.classList.add('toast-out'); setTimeout(() => t.remove(), 350); }, 3200);
}

// ==================== SESSION ====================
function handleSessionExpired(msg) {
    if (sessionKicked) return;
    sessionKicked = true;
    showToast(msg || 'Phiên đăng nhập đã hết hạn.', 'error');
    setTimeout(() => { localStorage.clear(); window.location.href = 'login.html'; }, 1800);
}

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
    try { await proxyFetch('/proxy-verify-session', { token, request_user: reqUser }); }
    catch (e) { /* đã redirect nếu expired */ }
}

// ==================== BACKGROUND CHECKS ====================
async function checkAppVersion() {
    try {
        const r = await fetch('/api/lge-appver');
        const d = await r.json();
        if (d.success && d.version) {
            const local = localStorage.getItem('lge_app_version');
            if (local && local !== d.version) {
                showToast(`⚠️ LGE đã cập nhật v${d.version} (bạn đang dùng ${local})`, 'info');
            }
            localStorage.setItem('lge_app_version', d.version);
        }
    } catch { /* ignore */ }
}

async function checkDeviceRegistered() {
    try {
        const { result } = await proxyFetch('/proxy-checkdevice', { token, request_user: reqUser });
        if (result.success) {
            const reg = result.data?.data?.[0]?.isRegistered;
            if (reg !== 1) {
                showToast('⚠️ IMEI chưa được LGE đăng ký — liên hệ admin', 'error');
            }
        }
    } catch (e) { if (e.sessionExpired) return; }
}

// ==================== HELPERS ====================
function generateRealisticAccuracy() {
    const r = Math.random();
    if (r < 0.4) return 5 + Math.random() * 10;
    if (r < 0.7) return 15 + Math.random() * 15;
    if (r < 0.9) return 30 + Math.random() * 20;
    return 50 + Math.random() * 20;
}

function switchTab(tabId, navElement) {
    document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    navElement.classList.add('active');
    // lazy load plan khi vào tab
    if (tabId === 'tab-plan' && document.getElementById('planList').innerText.includes('Đang tải')) {
        loadPlan();
    }
}
window.switchTab = switchTab;

function logout() { localStorage.clear(); window.location.href = 'login.html'; }
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
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
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
        date: parseInt(`${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`),
        time: `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    };
}

function updatePhotoTypeUI() {
    const display = document.getElementById('photoTypeDisplay');
    if (!display) return;
    const n = parseInt(nextPhotoType);
    const isCheckIn = n % 2 === 0;
    display.value = `${n} - ${isCheckIn ? 'Check-in (Vào ca)' : 'Check-out (Ra ca)'}`;
}

// ==================== SYNC MENU ====================
async function syncMenu() {
    try {
        const { result } = await proxyFetch('/proxy-download-menu', { token, request_user: reqUser });
        if (result.success) {
            localStorage.setItem('lge_menu', JSON.stringify(result.data));
            localStorage.setItem('lge_menu_at', Date.now().toString());
            printLog(`Menu: ${result.data.data?.length || 0} items`);
        }
    } catch (e) {
        if (e.sessionExpired) return;
        printLog(`Menu lỗi: ${e.message}`);
    }
}

// ==================== PLAN ====================
async function loadPlan() {
    const container = document.getElementById('planList');
    if (!container) return;
    container.innerHTML = "<div style='text-align:center;padding:20px;color:#666;'>⏳ Đang tải lịch...</div>";

    const d = new Date();
    const pad = n => n.toString().padStart(2, '0');
    const planDate = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

    try {
        const { result } = await proxyFetch('/proxy-plan', { token, request_user: reqUser, planDate });

        if (!result.success) {
            container.innerHTML = `<div style='text-align:center;padding:20px;color:#dc3545;'>Lỗi: ${JSON.stringify(result.error)}</div>`;
            return;
        }

        const rows = result.data?.data || [];
        if (!rows.length) {
            container.innerHTML = "<div style='text-align:center;padding:20px;color:#888;'>Chưa có lịch làm việc.</div>";
            return;
        }

        const today = planDate;
        container.innerHTML = rows.map(row => {
            const isToday = row.date === today;
            const isOff = row.target === 'OFF';
            const bg = isToday ? '#fff5f7' : '#fff';
            const border = isToday ? '2px solid #a50034' : '1px solid #eee';
            const statusColor = isOff ? '#dc3545' : '#059669';
            const statusText = isOff ? 'NGHỈ' : 'Ca ' + row.target;

            return `
                <div style="background:${bg};border:${border};border-radius:12px;padding:12px;margin-bottom:10px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <b style="font-size:14px;color:#a50034;">${row.dayName} — ${row.date}${isToday ? ' (Hôm nay)' : ''}</b>
                        <span style="background:${statusColor};color:#fff;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:700;">${statusText}</span>
                    </div>
                    <div style="font-size:12px;color:#555;line-height:1.8;">
                        <div>🕒 Vào ca: <b>${row.i || '—'}</b> · Ra ca: <b>${row.o || '—'}</b></div>
                        <div>✅ Thực tế: <b>${row.actual || '—'}</b></div>
                    </div>
                </div>`;
        }).join('');
    } catch (e) {
        if (e.sessionExpired) return;
        container.innerHTML = `<div style='text-align:center;padding:20px;color:#dc3545;'>Lỗi tải lịch: ${e.message}</div>`;
    }
}
window.loadPlan = loadPlan;

// ==================== SHOP LOAD ====================
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

    // Ưu tiên cache từ /download/all
    const cached = localStorage.getItem('lge_full_sync');
    if (cached) {
        try {
            const { storeList } = JSON.parse(cached);
            if (storeList?.length) {
                renderShopOptions(select, storeList);
                printLog(`Dùng cache: ${storeList.length} shops`);
                return;
            }
        } catch { /* ignore */ }
    }

    // Fallback /shops/storemaintant
    select.disabled = true;
    select.classList.add('loading');
    select.innerHTML = '<option value="">⏳ Đang tải từ LGE...</option>';
    if (btnReload) btnReload.style.display = 'none';

    try {
        const { result } = await proxyFetch('/proxy-get-shops', { token, request_user: reqUser });
        if (result.success && result.data?.data) {
            renderShopOptions(select, result.data.data);
            printLog(`Đã tải ${result.data.data.length} shops`);
        } else throw new Error(result.error || 'Dữ liệu rỗng');
    } catch (e) {
        if (e.sessionExpired) return;
        select.innerHTML = "<option value=''>❌ Không tải được shops</option>";
        select.classList.remove('loading');
        if (btnReload) btnReload.style.display = 'inline-block';
        printLog(`[LỖI] Shops: ${e.message}`);
    }
}
window.loadShops = loadShops;

function renderShopOptions(select, list) {
    select.innerHTML = "<option value=''>-- Chọn Cửa hàng --</option>";
    shopsCache = {};
    list.forEach(shop => {
        const lat = parseFloat(shop.latitude), lng = parseFloat(shop.longitude);
        shopsCache[shop.shopId] = { code: shop.shopCode, name: shop.shopName };
        const opt = document.createElement('option');
        opt.value = JSON.stringify({
            id: shop.shopId, code: shop.shopCode,
            lat: Number.isFinite(lat) ? lat : null,
            lng: Number.isFinite(lng) ? lng : null
        });
        opt.innerText = `[${shop.shopCode}] ${shop.shopName}`;
        select.appendChild(opt);
    });
    select.disabled = false;
    select.classList.remove('loading');
}

// ==================== ROTATE GPS ====================
document.getElementById('btnRandomGps')?.addEventListener('click', () => {
    const shopSelect = document.getElementById('shopSelect');
    if (!shopSelect || !shopSelect.value) return alert("Vui lòng chọn cửa hàng!");
    const shopData = JSON.parse(shopSelect.value);
    if (!Number.isFinite(shopData.lat) || !Number.isFinite(shopData.lng)) {
        return alert("Cửa hàng chưa có tọa độ hợp lệ. Dùng Điểm neo.");
    }

    let baseLat = shopData.lat, baseLng = shopData.lng;
    const customVal = document.getElementById('customAnchorInput').value.trim();
    if (customVal) {
        const parsed = parseCoords(customVal);
        if (!parsed) return alert("Điểm neo không hợp lệ!\nVD: 21.2099, 106.0939");
        baseLat = parsed.lat; baseLng = parsed.lng;
    }

    const noisy = addGpsNoise(baseLat, baseLng, 65);
    document.getElementById('lat').value = noisy.latitude;
    document.getElementById('lng').value = noisy.longitude;

    pendingAccuracy = generateRealisticAccuracy();
    updateAccuracyDisplay(pendingAccuracy);

    const dist = getDistanceMeters(noisy.latitude, noisy.longitude, shopData.lat, shopData.lng);
    const distDisplay = document.getElementById('distanceDisplay');
    if (dist > 150) {
        distDisplay.innerHTML = `⚠️ Cách shop: <span style="color:#dc3545;font-size:14px;">${dist.toFixed(1)}m</span><br><b style="color:#dc3545;">(> 150m — Submit sẽ bị chặn)</b>`;
    } else {
        distDisplay.innerHTML = `✅ Cách shop: <span style="color:#059669;font-size:14px;">${dist.toFixed(1)}m</span><br><b style="color:#059669;">(Hợp lệ: <150m)</b>`;
    }
    clearRetryState();
    printLog(`Xoay OK. Lệch: ${dist.toFixed(1)}m | Accuracy: ${pendingAccuracy.toFixed(1)}m`);
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
    el.innerHTML = `🎯 <b style="color:${color};font-size:14px;">${acc.toFixed(1)}m</b> <span style="color:#888;font-size:11px;">(sẽ gửi kèm)</span>`;
}

// ==================== HISTORY ====================
async function loadHistory() {
    const today = new Date();
    const pad = n => n.toString().padStart(2, '0');
    const dateStr = `${today.getFullYear()}${pad(today.getMonth()+1)}${pad(today.getDate())}`;
    const listDiv = document.getElementById('historyList');
    if (!listDiv) return;
    listDiv.innerHTML = "<div style='text-align:center;padding:20px;color:#666;'>⏳ Đang đồng bộ nhật ký...</div>";

    try {
        const { result } = await proxyFetch('/proxy-get-history', { token, request_user: reqUser, date: dateStr });

        listDiv.innerHTML = "";
        const items = result.data?.data;
        if (result.success && Array.isArray(items) && items.length > 0) {
            let maxType = -1;
            items.forEach(item => {
                const cur = parseInt(item.photoType);
                if (!Number.isNaN(cur) && cur > maxType) maxType = cur;
            });
            nextPhotoType = (maxType + 1).toString();
            updatePhotoTypeUI();

            const reversed = [...items].reverse();
            reversed.forEach(item => {
                const tn = parseInt(item.photoType);
                const isIn = tn % 2 === 0;
                const typeName = `${isIn ? 'Check-in' : 'Check-out'} lần ${Math.floor(tn/2)+1}`;
                const lat = parseFloat(item.latitude);
                const lng = parseFloat(item.longitude);
                const acc = parseFloat(item.accuracy);
                const latStr = Number.isFinite(lat) ? lat.toFixed(6) : 'N/A';
                const lngStr = Number.isFinite(lng) ? lng.toFixed(6) : 'N/A';
                const accStr = Number.isFinite(acc) ? acc.toFixed(1)+'m' : 'N/A';
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
                            <b>📍 GPS:</b> ${latStr}, ${lngStr}<br>
                            <b>🎯 Accuracy:</b> ${accStr}
                        </div>
                    </div>`;
            });
        } else {
            nextPhotoType = "0";
            updatePhotoTypeUI();
            listDiv.innerHTML = "<div style='text-align:center;padding:20px;color:#888;'>Chưa có báo cáo nào hôm nay.</div>";
        }
    } catch (e) {
        if (e.sessionExpired) return;
        listDiv.innerHTML = "<div style='text-align:center;padding:20px;color:#dc3545;'>Lỗi đồng bộ nhật ký!</div>";
    }
}
window.loadHistory = loadHistory;

function resolveShopLabel(item) {
    const shopId = item.shopId ?? item.ShopId;
    const shopCode = item.shopCode ?? item.ShopCode;
    const shopName = item.shopName ?? item.ShopName;
    if (shopCode) return `[${shopCode}] ${shopName || ''}`.trim();
    if (shopId != null && shopsCache[shopId]) return `[${shopsCache[shopId].code}] ${shopsCache[shopId].name}`;
    if (shopId != null) return `Shop #${shopId}`;
    return '';
}

// ==================== UPLOAD ====================
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
        if (!shopVal) return alert("Vui lòng chọn cửa hàng!");
        const latStr = document.getElementById('lat').value;
        const lngStr = document.getElementById('lng').value;
        if (!latStr || !lngStr) return alert("Bấm [Xoay vị trí] trước!");
        const finalLat = parseFloat(latStr);
        const finalLng = parseFloat(lngStr);
        if (!Number.isFinite(finalLat) || !Number.isFinite(finalLng)) return alert("Tọa độ lỗi.");
        if (!fileInput.files || !fileInput.files.length) return alert("Chọn ảnh!");
        const shopData = JSON.parse(shopVal);
        if (!Number.isFinite(shopData.lat) || !Number.isFinite(shopData.lng)) return alert("Shop chưa có tọa độ.");

        const dist = getDistanceMeters(finalLat, finalLng, shopData.lat, shopData.lng);
        if (dist > 150) return alert(`Vị trí cách shop ${dist.toFixed(1)}m (>150m).`);

        btnSubmit.disabled = true;
        btnSubmit.innerText = "⏳ ĐANG XỬ LÝ...";

        const reader = new FileReader();
        reader.onload = function (e) {
            const img = new Image();
            img.onload = async function () {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                canvas.getContext('2d').drawImage(img, 0, 0);
                const cleanBase64 = canvas.toDataURL('image/jpeg', 0.9).split(',')[1];

                const accuracy = pendingAccuracy ?? generateRealisticAccuracy();
                const fakeName = crypto.randomUUID().toUpperCase() + ".jpg";
                const rt = getRealTime();

                const payload = {
                    ShopId: shopData.id, ShopCode: shopData.code, PhotoName: fakeName,
                    Latitude: finalLat, Longitude: finalLng, Accuracy: accuracy,
                    ReportId: 1, PhotoTime: rt.time, PhotoType: nextPhotoType,
                    PhotoDate: rt.date, guid: crypto.randomUUID(),
                    PhotoData: cleanBase64, WorkStatus: 1,
                    DataLocation: JSON.stringify({
                        latitude: finalLat, longitude: finalLng, accuracy,
                        isFast: false, usedHighAccuracy: true, isLikelyPreciseFix: true
                    })
                };

                localStorage.setItem('lge_custom_anchor',
                    document.getElementById('customAnchorInput').value.trim());

                await doUpload(payload);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(fileInput.files[0]);
    });
}

async function doUpload(payload) {
    try {
        printLog("Đang gửi báo cáo lên LGE...");
        const { res, result } = await proxyFetch('/proxy-upload', {
            token, request_user: reqUser, payload
        });

        if (res.ok && result.success) {
            showToast('✅ Gửi báo cáo thành công!', 'success');
            printLog('[OK] Đã ghi nhận.');
            clearImage();
            clearRetryState();
            pendingAccuracy = null;
            updateAccuracyDisplay(null);

            const historyNav = document.querySelectorAll('.nav-item')[2]; // Plan, Report, History
            if (historyNav) switchTab('tab-history', historyNav);
            await loadHistory();
        } else {
            const errMsg = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
            printLog(`[FAIL] ${errMsg}`);
            showToast('❌ Gửi thất bại. Bấm [Thử lại].', 'error');
            lastFailedPayload = payload;
            showRetryUI();
        }
    } catch (e) {
        if (e.sessionExpired) return;
        printLog(`[MẠNG] ${e.message}`);
        showToast('❌ Lỗi kết nối. Bấm [Thử lại].', 'error');
        lastFailedPayload = payload;
        showRetryUI();
    } finally {
        if (btnSubmit) { btnSubmit.disabled = false; btnSubmit.innerText = "🚀 GỬI DỮ LIỆU"; }
    }
}

btnRetry?.addEventListener('click', async () => {
    if (!lastFailedPayload) return;
    btnRetry.disabled = true;
    btnRetry.innerText = "⏳ Đang thử lại...";
    const backup = lastFailedPayload;
    lastFailedPayload = null;
    await doUpload(backup);
    btnRetry.disabled = false;
    btnRetry.innerText = "🔄 Thử Lại";
});

function clearImage() {
    const i = document.getElementById('imageInput'); if (i) i.value = "";
    const d = document.getElementById('fileNameDisplay'); if (d) d.innerHTML = "";
    const pb = document.getElementById('imagePreview'); if (pb) pb.style.display = 'none';
    const pi = document.getElementById('previewImg'); if (pi) pi.src = "";
}
window.clearImage = clearImage;