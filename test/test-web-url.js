'use strict';

const assert = require('assert');
const { getWebPanelUrl, getDeployPlatformInfo, notifyWebPanelToAdmins } = require('../src/webUrl');

async function testWebUrl() {
  const origEnv = { ...process.env };

  try {
    // 1. Yerel varsayılan
    delete process.env.WEB_PANEL_URL;
    delete process.env.APP_URL;
    delete process.env.FLY_APP_NAME;
    delete process.env.RENDER_EXTERNAL_URL;
    delete process.env.RAILWAY_STATIC_URL;
    delete process.env.PUBLIC_URL;
    process.env.PORT = '3000';
    assert.strictEqual(getWebPanelUrl(), 'http://localhost:3000');

    // 2. Fly.io ortam değişkeni
    process.env.FLY_APP_NAME = 'scalp-bot-demo';
    assert.strictEqual(getWebPanelUrl(), 'https://scalp-bot-demo.fly.dev');
    assert.ok(getDeployPlatformInfo().includes('Fly.io'));

    // 3. Özel alan adı önceliği
    process.env.WEB_PANEL_URL = 'https://panel.example.com/';
    assert.strictEqual(getWebPanelUrl(), 'https://panel.example.com');

    // 4. notifyWebPanelToAdmins testi (Mock Telegram)
    const cardsSent = [];
    const privatesSent = [];

    const mockTelegram = {
      sendCard: (opts) => {
        cardsSent.push(opts);
        return true;
      },
      getChatAdminIds: async () => ['1001', '1002'],
      sendPrivate: async (userId, text, keyboard) => {
        privatesSent.push({ userId, text, keyboard });
        return true;
      }
    };

    const res = await notifyWebPanelToAdmins(mockTelegram, {
      note: 'Test Dağıtımı',
      triggeredBy: 'Birim Testi'
    });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.sentToGroup, false);
    assert.strictEqual(cardsSent.length, 0);

    assert.strictEqual(res.adminCount, 2);
    assert.strictEqual(res.dmSuccessCount, 2);
    assert.strictEqual(privatesSent.length, 2);
    assert.strictEqual(privatesSent[0].userId, '1001');
    assert.strictEqual(privatesSent[1].userId, '1002');
    assert.ok(privatesSent[0].text.includes('https://panel.example.com'));
    assert.ok(privatesSent[0].keyboard[0][0].url.includes('https://panel.example.com'));

    const broadcast = await notifyWebPanelToAdmins(mockTelegram, {
      note: 'Yönetici Talebi',
      triggeredBy: 'Test Yönetici',
      broadcastToGroup: true
    });
    assert.strictEqual(broadcast.sentToGroup, true);
    assert.strictEqual(cardsSent.length, 1);
    assert.ok(cardsSent[0].text.includes('https://panel.example.com'));
    assert.ok(cardsSent[0].text.includes('Yönetici Talebi'));

    console.log('✅ test-web-url tüm testleri başarıyla geçti.');
  } finally {
    process.env = origEnv;
  }
}

testWebUrl().catch(err => {
  console.error('❌ test-web-url başarısız:', err);
  process.exit(1);
});
