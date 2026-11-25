'use strict';
// Yönetici giriş sayfası (src/adminAuth.js loginPage): OTP iste / doğrula. Belirteç yalnız HttpOnly çerezde;
// bu dosya hiçbir şeyi localStorage'a ya da URL'ye yazmaz.
(function () {
  var msg = document.getElementById('msg');
  var userId = '';
  var digits = function (v, min, max) { return v.length >= min && v.length <= max && Array.prototype.every.call(v, function (c) { return c >= '0' && c <= '9'; }); };

  async function post(path, data) {
    var r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(data) });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok || !d.ok) throw new Error(d.error || 'İşlem tamamlanamadı.');
    return d;
  }

  async function requestCode() {
    var id = document.getElementById('tgid').value.trim();
    if (!digits(id, 5, 20)) { msg.textContent = 'Geçerli Telegram kullanıcı ID girin.'; return; }
    var b = document.getElementById('send');
    b.disabled = true; msg.textContent = 'İstek gönderiliyor…';
    try {
      await post('/api/auth/request-code', { userId: id });
      userId = id;
      document.getElementById('step1').classList.remove('active');
      document.getElementById('step2').classList.add('active');
      msg.textContent = 'Hesap yetkiliyse kod Telegram özel mesajınıza gönderildi. Spam klasörünü de kontrol edin.';
    } catch (e) { msg.textContent = e.message; } finally { b.disabled = false; }
  }

  async function verifyCode() {
    var code = document.getElementById('otp').value.trim();
    var b = document.getElementById('verify');
    if (!digits(code, 6, 6)) { msg.textContent = '6 haneli kodu girin.'; return; }
    b.disabled = true; msg.textContent = 'Kod doğrulanıyor…';
    try {
      await post('/api/auth/verify', { userId: userId, code: code });
      location.href = '/';
    } catch (e) { msg.textContent = e.message; } finally { b.disabled = false; }
  }

  function back() {
    document.getElementById('step2').classList.remove('active');
    document.getElementById('step1').classList.add('active');
    document.getElementById('otp').value = ''; msg.textContent = '';
  }

  document.getElementById('send').addEventListener('click', requestCode);
  document.getElementById('verify').addEventListener('click', verifyCode);
  document.getElementById('back').addEventListener('click', back);
  document.getElementById('tgid').addEventListener('keydown', function (e) { if (e.key === 'Enter') requestCode(); });
  document.getElementById('otp').addEventListener('keydown', function (e) { if (e.key === 'Enter') verifyCode(); });
})();
