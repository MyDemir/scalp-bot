'use strict';

const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Web panel adresini ortam değişkenlerinden akıllıca belirler.
 * Sırayla:
 *   1. WEB_PANEL_URL veya APP_URL (özel alan adı, ör: https://panel.mydomain.com)
 *   2. FLY_APP_NAME (Fly.io otomatik: https://<app>.fly.dev)
 *   3. RENDER_EXTERNAL_URL (Render.com)
 *   4. RAILWAY_STATIC_URL (Railway)
 *   5. VERCEL_URL / PUBLIC_URL
 *   6. Yerel geliştirme portu (http://localhost:3000)
 */
function getWebPanelUrl() {
  if (process.env.WEB_PANEL_URL) return process.env.WEB_PANEL_URL.replace(/\/+$/, '');
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  if (process.env.FLY_APP_NAME) return `https://${process.env.FLY_APP_NAME}.fly.dev`;
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '');
  if (process.env.RAILWAY_STATIC_URL) return `https://${process.env.RAILWAY_STATIC_URL.replace(/\/+$/, '')}`;
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}

/**
 * Dağıtımın yapıldığı ortamı tespit eder (Fly.io, Render, Railway vb.)
 */
function getDeployPlatformInfo() {
  if (process.env.FLY_APP_NAME) {
    const region = (process.env.FLY_REGION || 'fra').toUpperCase();
    return `✈️ <b>Platform:</b> Fly.io (Bölge: <code>${region}</code> · Uygulama: <code>${process.env.FLY_APP_NAME}</code>)`;
  }
  if (process.env.RENDER_SERVICE_ID) {
    return '🟣 <b>Platform:</b> Render.com';
  }
  if (process.env.RAILWAY_SERVICE_NAME) {
    return '🚂 <b>Platform:</b> Railway.app';
  }
  return '🖥 <b>Platform:</b> Canlı Node.js Sunucusu';
}

/**
 * Panel adresini yöneticilere özelden iletir; gruba/kanala yalnızca broadcastToGroup=true ile açıkça talep edilirse gönderir.
 *
 * @param {object} telegram - telegram modülü
 * @param {object} [options]
 * @param {string} [options.note] - Durum / sürüm notu (varsayılan: 'Dağıtım Başarılı & Hazır')
 * @param {string} [options.triggeredBy] - Tetikleyen kaynak ('Sistem Başlatıcı', 'Web Paneli', 'Yönetici Komutu')
 * @param {string} [options.thread] - Hedef konu ID'si (opsiyonel)
 * @param {boolean} [options.broadcastToGroup=false] - Gruba/kanala panel bağlantısını yalnızca açık yönetici talebiyle gönder
 * @returns {Promise<{ ok: boolean, url: string, sentToGroup: boolean, adminCount: number, dmSuccessCount: number }>}
 */
async function notifyWebPanelToAdmins(telegram, { note: rawNote = 'Dağıtım Başarılı & Hazır', triggeredBy: rawTriggeredBy = 'Deploy / Sistem Başlatıcı', thread = null, broadcastToGroup = false } = {}) {
  // Not ve tetikleyen (ör. Telegram kullanıcı adı) dışarıdan gelebilir; HTML parse_mode için kaçışlanır.
  const note = escHtml(rawNote);
  const triggeredBy = escHtml(rawTriggeredBy);
  const rawUrl = getWebPanelUrl();
  const url = escHtml(rawUrl);
  const platform = getDeployPlatformInfo();
  const now = new Date().toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const keyboard = [
    [{ text: '🌐 Web Panelini Aç', url: rawUrl }],
    [{ text: '⚡ Sinyal & Motor Durumu', callback_data: 'g:main' }]
  ];

  const groupText =
    `🚀 <b>Scalp Terminal & Web Paneli Devrede!</b>\n\n` +
    `🌐 <b>Canlı Panel:</b> <a href="${url}">${url}</a>\n\n` +
    `${platform}\n` +
    `🕒 <b>Zaman:</b> ${now} TSİ\n` +
    `📌 <b>Durum:</b> ${note}\n` +
    `👤 <b>Kaynak:</b> ${triggeredBy}\n\n` +
    `<b>Panel Yetenekleri:</b>\n` +
    `• Canlı Sinyal Akışı & RSI/SFP/Seviye Kartları\n` +
    `• Multi-Bot Hub (Tüm Telegram Botlarını Bağlama)\n` +
    `• Hata & Sistem Teşhis Havuzu (Anlık Filtreli)\n` +
    `• Motor Ayarları & Durum Görüntüleme (salt okunur)\n\n` +
    `<i>💡 İpucu: Telegram sohbetinde <code>/panel</code> yazarak bu adrese her an ulaşabilirsiniz.</i>`;

  let sentToGroup = false;
  if (broadcastToGroup) {
    try {
      telegram.sendCard({ text: groupText, keyboard, thread });
      sentToGroup = true;
      console.log('[WEB-URL] Yönetici talebiyle web paneli bildirimi Telegram grubuna gönderildi.');
    } catch (err) {
      console.warn('[WEB-URL] Gruba panel bildirimi gönderilemedi:', err?.message || err);
    }
  }

  // 2. Yöneticilere özelden DM ilet
  let adminIds = [];
  try {
    if (typeof telegram.getChatAdminIds === 'function') {
      adminIds = await telegram.getChatAdminIds();
    } else {
      adminIds = String(process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    }
  } catch {
    adminIds = String(process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  const dmText =
    `👑 <b>[Yönetici Bildirimi] Scalp Bot Web Paneli</b>\n\n` +
    `Sayın Yönetici, bot son deploy ile başarıyla çalışmaya başladı:\n\n` +
    `🔗 <b>Doğrudan Erişim:</b> <a href="${url}">${url}</a>\n\n` +
    `${platform}\n` +
    `🕒 <b>Saat:</b> ${now} TSİ\n` +
    `📌 <b>Not:</b> ${note}\n` +
    `👤 <b>Tetikleyen:</b> ${triggeredBy}\n\n` +
    `<i>Web paneli botunuzun canlı durumunu, sinyallerini, ayarlarını ve diğer botlarınızı salt okunur olarak yansıtır; ayarlar Telegram komutlarıyla değiştirilir.</i>`;

  const dmKeyboard = [[{ text: '🌐 Web Paneline Git', url: rawUrl }]];

  let dmSuccessCount = 0;
  for (const adminId of adminIds) {
    try {
      const ok = await telegram.sendPrivate(adminId, dmText, dmKeyboard);
      if (ok) {
        dmSuccessCount++;
      }
    } catch (err) {
      console.warn(`[WEB-URL] Admin ${adminId} özel mesaj iletilemedi:`, err?.message || err);
    }
  }

  if (adminIds.length > 0) {
    console.log(`[WEB-URL] Web paneli ${adminIds.length} yöneticiden ${dmSuccessCount} kişiye özel DM ile iletildi.`);
  }

  return {
    ok: true,
    url: rawUrl,
    sentToGroup,
    adminCount: adminIds.length,
    dmSuccessCount
  };
}

module.exports = { getWebPanelUrl, getDeployPlatformInfo, notifyWebPanelToAdmins };
