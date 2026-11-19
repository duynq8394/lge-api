// ============================================================
// app.js — LGE WebApp Client v5 (iOS Text Overlay Watermark)
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

// Cache ảnh gốc & ảnh đã resize + đóng dấu watermark
let currentSourceImage = null;
let currentSourceFileSize = 0;
let currentResizedBase64 = null;
let currentResizeInfo = null;
let currentWatermarkText = "";

// ==================== CẤU HÌNH WATERMARK (iOS SPEC) ====================
const WATERMARK_CONFIG = {
    enabled: true,
    // Font family: System (iOS San Francisco)
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "San Francisco", "Helvetica Neue", Helvetica, Arial, sans-serif',
    fontWeight: '600',          // Font weight: 600
    fontSizePt: 10,             // Font size: 10 logical points
    color: '#EE3218',           // Màu chữ: #EE3218
    textAlign: 'left',          // Căn lề: Left (bên trái - góc dưới)
    widthPercent: 1.0,          // Chiều rộng vùng chữ: 100%
    paddingLeftPt: 12,          // Padding trái: 12 logical points
    paddingRightPt: 12,         // Padding phải: 12 logical points
    paddingTopPt: 8,            // Padding trên: 8 logical points
    paddingBottomPt: 8,         // Padding dưới: 8 logical points
    lineHeightRatio: 1.35,      // Khoảng cách dòng
    iosLogicalWidthPt: 375,     // Chiều rộng chuẩn iOS logical points (375pt)
    boxHeightPt: 300,           // Chiều cao vùng watermark: 300pt
    watermarkOpacity: 0.5,      // Opacity hình nền watermark (nếu có)
    watermarkBgImgUrl: null     // Kiểu hiển thị: Text overlay
};

let watermarkOverlayImg = null;
if (WATERMARK_CONFIG.watermarkBgImgUrl) {
    watermarkOverlayImg = new Image();
    watermarkOverlayImg.crossOrigin = "anonymous";
    watermarkOverlayImg.src = WATERMARK_CONFIG.watermarkBgImgUrl;
}

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

    // Avatar
    const photoPath = localStorage.getItem('lge_user_photo');
    const avatarImg = document.getElementById('userAvatarImg');
    const avatarFallback = document.getElementById('userAvatarFallback');
    if (avatarImg && photoPath && photoPath !== 'undefined' && photoPath !== 'null') {
        const baseUrl = API_BASE.replace(/\/$/, '');
        const path = photoPath.startsWith('/') ? photoPath : '/' + photoPath;
        avatarImg.onload = () => {
            avatarImg.style.display = 'block';
            if (avatarFallback) avatarFallback.style.display = 'none';
        };
        avatarImg.onerror = () => {
            avatarImg.style.display = 'none';
            if (avatarFallback) avatarFallback.style.display = 'flex';
        };
        avatarImg.src = baseUrl + path;
    } else if (avatarFallback) {
        avatarFallback.style.display = 'flex';
    }

    const savedAnchor = localStorage.getItem('lge_custom_anchor');
    if (savedAnchor && document.getElementById('customAnchorInput')) {
        document.getElementById('customAnchorInput').value = savedAnchor;
    }

    bindImagePreview();
    bindShopSelectListener();

    checkAppVersion();
    checkDeviceRegistered();
    verifySessionStillValid().catch(() => {});

    await Promise.all([
        loadPlan().catch(() => {}),
        syncMenu().catch(() => {}),
        loadShops().catch(() => {}),
        loadHistory().catch(() => {})
    ]);

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && token && !sessionKicked) verifySessionStillValid();
    });
});

// ==================== WATERMARK & RESIZE HELPER ====================
// Tạo đúng chuỗi định dạng: [EASV6483]- [09:27:01 19-tháng 11]
function getWatermarkLines(customTimeObj = null) {
    const now = customTimeObj || new Date();
    const pad = n => n.toString().padStart(2, '0');

    // Định dạng: HH:mm:ss DD-tháng M (VD: 09:27:01 19-tháng 11)
    const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${pad(now.getDate())}-tháng ${now.getMonth() + 1}`;

    let shopCode = 'SHOP';
    const shopSelect = document.getElementById('shopSelect');
    if (shopSelect && shopSelect.value) {
        try {
            const shopData = JSON.parse(shopSelect.value);
            if (shopData && shopData.code) {
                shopCode = shopData.code;
            }
        } catch { /* ignore */ }
    }

    const text = `[${shopCode}]- [${timeStr}]`;
    currentWatermarkText = text;
    return [text];
}

// Tự động xuống dòng khi câu dài vượt quá 100% chiều rộng vùng chữ
function wrapCanvasText(ctx, text, maxWidth) {
    const words = String(text).split(' ');
    const lines = [];
    let currentLine = words[0] || '';

    for (let i = 1; i < words.length; i++) {
        const word = words[i];
        const width = ctx.measureText(currentLine + " " + word).width;
        if (width <= maxWidth) {
            currentLine += " " + word;
        } else {
            lines.push(currentLine);
            currentLine = word;
        }
    }
    if (currentLine) lines.push(currentLine);
    return lines;
}

// Vẽ Text Overlay Watermark chuẩn thông số iOS Logical Points
function drawWatermarkOnCanvas(ctx, outW, outH, customTimeObj = null) {
    if (!WATERMARK_CONFIG.enabled) return;

    // Quy đổi từ Logical Points (pt) sang Pixels (px) trên Canvas
    const ptToPx = outW / WATERMARK_CONFIG.iosLogicalWidthPt;

    const fontSize = Math.max(10, Math.round(WATERMARK_CONFIG.fontSizePt * ptToPx));
    const lineHeight = Math.round(fontSize * WATERMARK_CONFIG.lineHeightRatio);
    const padLeft = Math.round(WATERMARK_CONFIG.paddingLeftPt * ptToPx);
    const padRight = Math.round(WATERMARK_CONFIG.paddingRightPt * ptToPx);
    const padTop = Math.round(WATERMARK_CONFIG.paddingTopPt * ptToPx);
    const padBottom = Math.round(WATERMARK_CONFIG.paddingBottomPt * ptToPx);
    const wmBoxHeight = Math.round(WATERMARK_CONFIG.boxHeightPt * ptToPx);

    ctx.save();

    // Nếu có cấu hình ảnh watermark nền (opacity 0.5, cao 300pt, rộng 100%)
    if (watermarkOverlayImg && watermarkOverlayImg.complete && watermarkOverlayImg.naturalWidth > 0) {
        ctx.globalAlpha = WATERMARK_CONFIG.watermarkOpacity;
        ctx.drawImage(watermarkOverlayImg, 0, outH - wmBoxHeight, outW, wmBoxHeight);
    }

    // Thiết lập Text Overlay: San Francisco, 600, 10pt, #EE3218, Left
    ctx.globalAlpha = 1.0;
    ctx.font = `${WATERMARK_CONFIG.fontWeight} ${fontSize}px ${WATERMARK_CONFIG.fontFamily}`;
    ctx.fillStyle = WATERMARK_CONFIG.color;
    ctx.textAlign = WATERMARK_CONFIG.textAlign;
    ctx.textBaseline = 'bottom';

    // Chiều rộng vùng chữ 100% trừ đi padding 2 bên
    const maxTextWidth = (outW * WATERMARK_CONFIG.widthPercent) - padLeft - padRight;

    const rawLines = getWatermarkLines(customTimeObj);
    const wrappedLines = [];
    rawLines.forEach(line => {
        const subLines = wrapCanvasText(ctx, line, maxTextWidth);
        wrappedLines.push(...subLines);
    });

    // Tính vị trí Y để chữ nằm ở góc dưới bên trái (cách đáy paddingBottom, cách trái paddingLeft)
    const totalTextHeight = wrappedLines.length * lineHeight;
    let startY = outH - padBottom - totalTextHeight + lineHeight;

    const minTopY = padTop + fontSize;
    if (startY < minTopY) startY = minTopY;

    wrappedLines.forEach((line, index) => {
        const y = startY + (index * lineHeight);
        ctx.fillText(line, padLeft, y);
    });

    ctx.restore();
}

// Khớp cấu hình FieldForce:
//   Box 1080×1920 | contain | quality 80 | JPEG + Đóng dấu Text Overlay Watermark
function resizeImageToBase64(img, targetW = 1080, targetH = 1920, quality = 0.80, customTimeObj = null) {
    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (!srcW || !srcH) throw new Error('Ảnh chưa load xong');

    const scale = Math.min(targetW / srcW, targetH / srcH);
    const outW = Math.max(1, Math.round(srcW * scale));
    const outH = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // JPEG không có alpha → nền trắng
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(img, 0, 0, outW, outH);

    // Vẽ lớp Text Overlay Watermark
    drawWatermarkOnCanvas(ctx, outW, outH, customTimeObj);

    return {
        base64: canvas.toDataURL('image/jpeg', quality).split(',')[1],
        width: outW,
        height: outH,
        sourceWidth: srcW,
        sourceHeight: srcH,
        sourceBytes: currentSourceFileSize || 0
    };
}

// Làm mới lại ảnh preview & base64 khi đổi Shop hoặc cập nhật thời gian trước khi gửi
function refreshWatermarkedImage(customTimeObj = null) {
    if (!currentSourceImage) return null;

    const previewBox = document.getElementById('imagePreview');
    const previewImg = document.getElementById('previewImg');
    const resizeInfoBox = document.getElementById('resizeInfoBox');
    const resizeInfo = document.getElementById('resizeInfo');

    const resized = resizeImageToBase64(currentSourceImage, 1080, 1920, 0.80, customTimeObj);
    currentResizedBase64 = resized.base64;
    currentResizeInfo = resized;

    if (previewImg) previewImg.src = 'data:image/jpeg;base64,' + resized.base64;
    if (previewBox) previewBox.style.display = 'block';

    const origKB = (resized.sourceBytes / 1024).toFixed(0);
    const newKB = Math.round(resized.base64.length * 0.75 / 1024);
    const b64KB = Math.round(resized.base64.length / 1024);

    if (resizeInfo) {
        resizeInfo.innerHTML = `
            <div>📷 <b>Gốc:</b> ${resized.sourceWidth}×${resized.sourceHeight} — ${origKB} KB</div>
            <div>✂️ <b>Resize:</b> ${resized.width}×${resized.height} — ${newKB} KB (JPEG q=0.80)</div>
            <div>🏷️ <b>Watermark:</b> <span style="color:#EE3218;font-weight:700;">${currentWatermarkText}</span></div>
            <div>📦 <b>Base64:</b> ${b64KB} KB <span style="color:#888;">(tăng ~33% so với binary)</span></div>
        `;
    }
    if (resizeInfoBox) resizeInfoBox.style.display = 'block';

    return resized;
}

// ==================== IMAGE PICKER ====================
function bindImagePreview() {
    const imgInput = document.getElementById('imageInput');
    if (!imgInput) return;
    imgInput.addEventListener('change', function () {
        const display = document.getElementById('fileNameDisplay');
        const previewBox = document.getElementById('imagePreview');
        const previewImg = document.getElementById('previewImg');
        const resizeInfoBox = document.getElementById('resizeInfoBox');

        if (!this.files || this.files.length === 0) {
            display.innerHTML = "";
            if (previewBox) previewBox.style.display = 'none';
            if (previewImg) previewImg.src = "";
            if (resizeInfoBox) resizeInfoBox.style.display = 'none';
            currentSourceImage = null;
            currentSourceFileSize = 0;
            currentResizedBase64 = null;
            currentResizeInfo = null;
            currentWatermarkText = "";
            return;
        }

        const file = this.files[0];
        display.innerHTML = `✅ Đã chọn: <span style="color:#333;">${file.name}</span> (${(file.size/1024).toFixed(0)} KB)`;

        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                try {
                    currentSourceImage = img;
                    currentSourceFileSize = file.size;
                    refreshWatermarkedImage();
                } catch (err) {
                    showToast('Lỗi xử lý ảnh: ' + err.message, 'error');
                    currentSourceImage = null;
                    currentResizedBase64 = null;
                    currentResizeInfo = null;
                }
            };
            img.onerror = () => showToast('Không đọc được ảnh', 'error');
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
        clearRetryState();
    });
}

// ==================== BUILD PAYLOAD ====================
// Dùng chung cho Submit và Preview
function buildUploadPayload(shopData, finalLat, finalLng) {
    const now = new Date();
    const rt = getRealTime(now);

    // Vẽ lại watermark với thời gian thực khớp 100% với PhotoTime trong Payload
    if (currentSourceImage) {
        refreshWatermarkedImage(now);
    }

    if (!currentResizedBase64) throw new Error('Chưa có ảnh đã resize');

    const accuracy = pendingAccuracy ?? generateRealisticAccuracy();
    const fakeName = crypto.randomUUID().toUpperCase() + ".jpg";

    // DataLocation — khớp 100% sample 17/11/2026
    const dataLocation = {
        latitude: finalLat,
        longitude: finalLng,
        accuracy: accuracy,
        timestamp: Date.now() + Math.random(),
        mocked: false,
        isFast: false,
        usedHighAccuracy: true,
        isLikelyPreciseFix: false   // luôn false
    };

    // Thứ tự field BẮT BUỘC giữ nguyên
    return {
        ShopId: shopData.id,
        ShopCode: shopData.code,
        PhotoName: fakeName,
        Latitude: finalLat,
        Longitude: finalLng,
        Accuracy: accuracy,
        ReportId: 1,
        PhotoTime: rt.time,
        PhotoType: nextPhotoType,
        PhotoDate: rt.date,
        guid: crypto.randomUUID(),
        PhotoData: currentResizedBase64,
        WorkStatus: 1,
        DataLocation: JSON.stringify(dataLocation)
    };
}

// ==================== PREVIEW MODAL ====================
function previewPayload() {
    const shopVal = document.getElementById('shopSelect').value;
    if (!shopVal) return alert("Vui lòng chọn cửa hàng!");
    const latStr = document.getElementById('lat').value;
    const lngStr = document.getElementById('lng').value;
    if (!latStr || !lngStr) return alert("Bấm [Xoay vị trí] trước!");
    if (!currentResizedBase64 && !currentSourceImage) return alert("Chọn ảnh trước!");

    const finalLat = parseFloat(latStr);
    const finalLng = parseFloat(lngStr);
    if (!Number.isFinite(finalLat) || !Number.isFinite(finalLng)) return alert("Tọa độ không hợp lệ");
    const shopData = JSON.parse(shopVal);
    if (!Number.isFinite(shopData.lat) || !Number.isFinite(shopData.lng)) return alert("Shop chưa có tọa độ");

    let payload;
    try {
        payload = buildUploadPayload(shopData, finalLat, finalLng);
    } catch (err) {
        return alert(err.message);
    }

    // Tạo bản preview (truncate PhotoData)
    const preview = { ...payload };
    preview.PhotoData = preview.PhotoData.slice(0, 60) + '...[TRUNCATED ' +
        (preview.PhotoData.length - 60) + ' chars]';

    const bodyStr = JSON.stringify(payload);
    const bodyBytes = new Blob([bodyStr]).size;

    const info = document.getElementById('previewInfo');
    info.innerHTML = `
        <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12px;">
            <b>ShopId:</b><span>${payload.ShopId} (${payload.ShopCode})</span>
            <b>GPS:</b><span>${payload.Latitude.toFixed(6)}, ${payload.Longitude.toFixed(6)}</span>
            <b>Accuracy:</b><span>${payload.Accuracy.toFixed(1)}m</span>
            <b>PhotoType:</b><span>${payload.PhotoType} (${parseInt(payload.PhotoType)%2===0?'Check-in':'Check-out'})</span>
            <b>PhotoTime:</b><span>${payload.PhotoTime}</span>
            <b>PhotoDate:</b><span>${payload.PhotoDate}</span>
            <b>Ảnh gốc:</b><span>${currentResizeInfo.sourceWidth}×${currentResizeInfo.sourceHeight} (${(currentResizeInfo.sourceBytes/1024).toFixed(0)} KB)</span>
            <b>Ảnh resize:</b><span>${currentResizeInfo.width}×${currentResizeInfo.height} (${Math.round(currentResizedBase64.length*0.75/1024)} KB)</span>
            <b>PhotoData b64:</b><span>${Math.round(currentResizedBase64.length/1024)} KB (${currentResizedBase64.length} chars)</span>
            <b>Body JSON:</b><span>${bodyStr.length} chars ≈ ${bodyBytes} bytes</span>
            <b>Watermark:</b><span style="color:#EE3218;font-weight:700;">${currentWatermarkText}</span>
            <b>Encoding:</b><span style="color:#059669;font-weight:700;">SINGLE (không double)</span>
        </div>
    `;

    document.getElementById('previewJson').textContent = JSON.stringify(preview, null, 2);

    // Lưu để "Gửi luôn" dùng
    document.getElementById('previewPayloadModal').dataset.payload = JSON.stringify(payload);
    document.getElementById('previewPayloadModal').classList.add('active');
}
window.previewPayload = previewPayload;

function closePreviewModal() {
    document.getElementById('previewPayloadModal').classList.remove('active');
}
window.closePreviewModal = closePreviewModal;

async function sendFromPreview() {
    const modal = document.getElementById('previewPayloadModal');
    try {
        const payload = JSON.parse(modal.dataset.payload || 'null');
        if (!payload) return alert('Không có payload');
        closePreviewModal();
        await doUpload(payload);
    } catch (e) {
        alert('Lỗi: ' + e.message);
    }
}
window.sendFromPreview = sendFromPreview;

// ==================== TOAST ====================
function showToast(msg, type = 'success') {
    const c = document.getElementById('toastContainer');
    if (!c) { console.log(`[${type}] ${msg}`); return; }
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.innerText = msg;
    c.appendChild(t);
    setTimeout(() => { t.classList.add('toast-out'); setTimeout(() => t.remove(), 350); }, 4000);
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
    catch (e) { /* redirect */ }
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
            if (reg !== 1) showToast('⚠️ IMEI chưa được LGE đăng ký', 'error');
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
    if (tabId === 'tab-plan' && document.getElementById('planList')?.innerText.includes('Đang tải')) loadPlan();
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

function getRealTime(customDate = null) {
    const now = customDate || new Date();
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
        }
    } catch (e) { if (e.sessionExpired) return; }
}

// ==================== PLAN ====================
async function loadPlan() {
    const container = document.getElementById('planList');
    if (!container) return;
    container.innerHTML = "<div style='text-align:center;padding:20px;color:#666;'>⏳ Đang tải...</div>";

    const d = new Date();
    const pad = n => n.toString().padStart(2, '0');
    const planDate = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

    try {
        const { result } = await proxyFetch('/proxy-plan', { token, request_user: reqUser, planDate });
        if (!result.success) {
            container.innerHTML = `<div style='color:#dc3545;text-align:center;padding:20px;'>Lỗi: ${JSON.stringify(result.error)}</div>`;
            return;
        }
        const rows = result.data?.data || [];
        if (!rows.length) {
            container.innerHTML = "<div style='text-align:center;padding:20px;color:#888;'>Chưa có lịch.</div>";
            return;
        }
        const today = planDate;
        container.innerHTML = rows.map(row => {
            const isToday = row.date === today;
            const isOff = row.target === 'OFF';
            return `
                <div style="background:${isToday?'#fff5f7':'#fff'};border:${isToday?'2px solid #a50034':'1px solid #eee'};border-radius:12px;padding:12px;margin-bottom:10px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                        <b style="font-size:14px;color:#a50034;">${row.dayName} — ${row.date}${isToday?' (Hôm nay)':''}</b>
                        <span style="background:${isOff?'#dc3545':'#059669'};color:#fff;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:700;">${isOff?'NGHỈ':'Ca '+row.target}</span>
                    </div>
                    <div style="font-size:12px;color:#555;line-height:1.8;">
                        <div>🕒 Vào: <b>${row.i || '—'}</b> · Ra: <b>${row.o || '—'}</b></div>
                        <div>✅ Thực tế: <b>${row.actual || '—'}</b></div>
                    </div>
                </div>`;
        }).join('');
    } catch (e) {
        if (e.sessionExpired) return;
        container.innerHTML = `<div style='color:#dc3545;text-align:center;padding:20px;'>Lỗi: ${e.message}</div>`;
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

        // Cập nhật lại mã [ShopCode] trên watermark nếu đã chọn ảnh
        if (currentSourceImage) refreshWatermarkedImage();
    });
    shopListenerBound = true;
}

async function loadShops() {
    const select = document.getElementById('shopSelect');
    const btnReload = document.getElementById('btnReloadShops');
    if (!select) return;

    const cached = localStorage.getItem('lge_full_sync');
    if (cached) {
        try {
            const { storeList } = JSON.parse(cached);
            if (storeList?.length) { renderShopOptions(select, storeList); return; }
        } catch { /* ignore */ }
    }

    select.disabled = true;
    select.classList.add('loading');
    select.innerHTML = '<option value="">⏳ Đang tải...</option>';
    if (btnReload) btnReload.style.display = 'none';
    try {
        const { result } = await proxyFetch('/proxy-get-shops', { token, request_user: reqUser });
        if (result.success && result.data?.data) renderShopOptions(select, result.data.data);
        else throw new Error(result.error || 'Dữ liệu rỗng');
    } catch (e) {
        if (e.sessionExpired) return;
        select.innerHTML = "<option value=''>❌ Không tải được</option>";
        select.classList.remove('loading');
        if (btnReload) btnReload.style.display = 'inline-block';
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
        return alert("Cửa hàng chưa có tọa độ. Dùng Điểm neo.");
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
        distDisplay.innerHTML = `⚠️ Cách shop: <span style="color:#dc3545;font-size:14px;">${dist.toFixed(1)}m</span> <b style="color:#dc3545;">(> 150m — sẽ bị chặn)</b>`;
    } else {
        distDisplay.innerHTML = `✅ Cách shop: <span style="color:#059669;font-size:14px;">${dist.toFixed(1)}m</span> <b style="color:#059669;">(Hợp lệ)</b>`;
    }
    clearRetryState();
    printLog(`Xoay OK. Lệch: ${dist.toFixed(1)}m | Acc: ${pendingAccuracy.toFixed(1)}m`);
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
    el.innerHTML = `🎯 <b style="color:${color};font-size:14px;">${acc.toFixed(1)}m</b>`;
}

// ==================== HISTORY ====================
async function loadHistory() {
    const today = new Date();
    const pad = n => n.toString().padStart(2, '0');
    const dateStr = `${today.getFullYear()}${pad(today.getMonth()+1)}${pad(today.getDate())}`;
    const listDiv = document.getElementById('historyList');
    if (!listDiv) return;
    listDiv.innerHTML = "<div style='text-align:center;padding:20px;color:#666;'>⏳ Đang đồng bộ...</div>";

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
                            ${shopLabel ? `<b>🏪</b> ${shopLabel}<br>` : ''}
                            <b>🕒</b> ${timeOnly}<br>
                            <b>📍</b> ${latStr}, ${lngStr}<br>
                            <b>🎯</b> ${accStr}
                        </div>
                    </div>`;
            });
        } else {
            nextPhotoType = "0";
            updatePhotoTypeUI();
            listDiv.innerHTML = "<div style='text-align:center;padding:20px;color:#888;'>Chưa có báo cáo hôm nay.</div>";
        }
    } catch (e) {
        if (e.sessionExpired) return;
        listDiv.innerHTML = "<div style='color:#dc3545;text-align:center;padding:20px;'>Lỗi đồng bộ!</div>";
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

// ==================== SUBMIT ====================
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
        const shopVal = document.getElementById('shopSelect').value;
        if (!shopVal) return alert("Vui lòng chọn cửa hàng!");
        const latStr = document.getElementById('lat').value;
        const lngStr = document.getElementById('lng').value;
        if (!latStr || !lngStr) return alert("Bấm [Xoay vị trí] trước!");
        const finalLat = parseFloat(latStr);
        const finalLng = parseFloat(lngStr);
        if (!Number.isFinite(finalLat) || !Number.isFinite(finalLng)) return alert("Tọa độ lỗi.");
        if (!currentResizedBase64 && !currentSourceImage) return alert("Chọn ảnh trước!");
        const shopData = JSON.parse(shopVal);
        if (!Number.isFinite(shopData.lat) || !Number.isFinite(shopData.lng)) return alert("Shop chưa có tọa độ.");

        const dist = getDistanceMeters(finalLat, finalLng, shopData.lat, shopData.lng);
        if (dist > 150) return alert(`Cách shop ${dist.toFixed(1)}m (>150m).`);

        let payload;
        try {
            payload = buildUploadPayload(shopData, finalLat, finalLng);
        } catch (err) {
            return alert(err.message);
        }

        localStorage.setItem('lge_custom_anchor',
            document.getElementById('customAnchorInput').value.trim());

        btnSubmit.disabled = true;
        btnSubmit.innerText = "⏳ ĐANG GỬI...";
        await doUpload(payload);
    });
}

// ==================== DO UPLOAD ====================
async function doUpload(payload) {
    try {
        printLog("Đang gửi báo cáo lên LGE...");
        const { res, result } = await proxyFetch('/proxy-upload', {
            token, request_user: reqUser, payload
        });

        // LGE upload: {"status":100,"messeger":"..."} — KHÁC statusId:200
        const lgeStatus = result.data?.status;
        const lgeMsg = result.data?.messeger;

        if (res.ok && result.success && lgeStatus === 100) {
            const successMsg = lgeMsg || 'Gửi báo cáo thành công!';
            showToast('✅ ' + successMsg, 'success');
            printLog('[OK] ' + successMsg);

            clearImage();
            clearRetryState();
            pendingAccuracy = null;
            updateAccuracyDisplay(null);

            const historyNav = document.querySelectorAll('.nav-item')[2];
            if (historyNav) switchTab('tab-history', historyNav);
            await loadHistory();

            const listDiv = document.getElementById('historyList');
            if (listDiv && listDiv.innerText.includes('Chưa ghi nhận')) {
                setTimeout(() => loadHistory(), 1000);
            }
        } else {
            const errMsg = lgeMsg
                || (typeof result.error === 'string' ? result.error : JSON.stringify(result.error || {}));
            printLog(`[THẤT BẠI] status=${lgeStatus ?? 'N/A'} | ${errMsg}`);
            showToast('❌ ' + (lgeMsg || 'Gửi thất bại. Bấm [Thử lại].'), 'error');
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
        if (btnSubmit) { btnSubmit.disabled = false; btnSubmit.innerText = "🚀 GỬI DỮ LIỆU LÊN MÁY CHỦ"; }
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
    const rib = document.getElementById('resizeInfoBox'); if (rib) rib.style.display = 'none';
    currentSourceImage = null;
    currentSourceFileSize = 0;
    currentResizedBase64 = null;
    currentResizeInfo = null;
    currentWatermarkText = "";
}
window.clearImage = clearImage;