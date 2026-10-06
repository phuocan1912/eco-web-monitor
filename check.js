// Bot kiểm tra website và báo lỗi qua Telegram
// Chạy: node check.js  (cần biến môi trường TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID)

const { chromium } = require('playwright');
const fs = require('fs');

// ====== CẤU HÌNH (sửa ở đây nếu cần) ======
const SITE_URL = process.env.SITE_URL || 'https://ecopharma.com.vn/';
// Bot báo lỗi nếu thấy một trong các dòng chữ này xuất hiện trên trang
const ERROR_TEXTS = ['Có lỗi xảy ra khi thực hiện thao tác'];
// Chỉ tính lỗi API thuộc tên miền này (bỏ qua quảng cáo, tracking của bên thứ ba)
const API_DOMAIN = 'ecopharma.com.vn';
// Thời gian chờ thông báo lỗi xuất hiện sau khi trang tải xong (mili giây)
const WAIT_MS = 15000;
// ===========================================

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = 'state/status.txt';

function now() {
  return new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

async function telegram(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    body,
    headers: body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram từ chối: ${data.description}`);
}

async function sendText(text) {
  await telegram('sendMessage', JSON.stringify({ chat_id: CHAT_ID, text }));
}

async function sendPhoto(buffer, caption) {
  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('caption', caption.slice(0, 1000));
  form.append('photo', new Blob([buffer], { type: 'image/png' }), 'loi.png');
  await telegram('sendPhoto', form);
}

// Mở trang như người dùng thật, trả về danh sách vấn đề và ảnh chụp màn hình
async function checkOnce() {
  const problems = [];
  const failedApis = new Set();
  let screenshot = null;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, locale: 'vi-VN' });

    page.on('response', (res) => {
      try {
        const type = res.request().resourceType();
        const host = new URL(res.url()).hostname;
        if ((type === 'xhr' || type === 'fetch') && host.endsWith(API_DOMAIN) && res.status() >= 500) {
          failedApis.add(`${res.status()} ${res.url().split('?')[0]}`);
        }
      } catch (_) {}
    });

    let response;
    try {
      response = await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      problems.push(`Không mở được trang (${e.message.split('\n')[0]})`);
      return { problems, screenshot };
    }

    if (!response || response.status() >= 400) {
      problems.push(`Trang trả về mã lỗi ${response ? response.status() : 'không xác định'}`);
    }

    // Chờ xem thông báo lỗi có bung ra không
    for (const text of ERROR_TEXTS) {
      try {
        await page.getByText(text).first().waitFor({ state: 'visible', timeout: WAIT_MS });
        const count = await page.getByText(text).count();
        problems.push(`Trang hiện ${count} thông báo: "${text}"`);
      } catch (_) {
        // Không thấy thông báo lỗi = tốt
      }
    }

    if (failedApis.size > 0) {
      problems.push('API lỗi:\n' + [...failedApis].slice(0, 5).map((a) => '  • ' + a).join('\n'));
    }

    if (problems.length > 0) {
      screenshot = await page.screenshot({ type: 'png' });
    }
  } finally {
    await browser.close();
  }
  return { problems, screenshot };
}

async function main() {
  if (!TOKEN || !CHAT_ID) {
    console.error('Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID');
    process.exit(1);
  }

  // Chế độ gửi thử để kiểm tra bot đã nối đúng chưa
  if (process.env.SEND_TEST === 'true') {
    await sendText(`✅ Bot giám sát ${SITE_URL} đã kết nối thành công (${now()})`);
    console.log('Đã gửi tin nhắn thử');
    return;
  }

  // Kiểm tra, nếu lỗi thì thử lại 1 lần sau 20 giây để tránh báo nhầm
  let result = await checkOnce();
  if (result.problems.length > 0) {
    console.log('Lần 1 phát hiện lỗi, thử lại...');
    await new Promise((r) => setTimeout(r, 20000));
    result = await checkOnce();
  }

  const previous = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8').trim() : 'ok';
  const current = result.problems.length > 0 ? 'error' : 'ok';
  console.log(`Trạng thái trước: ${previous} | hiện tại: ${current}`);
  result.problems.forEach((p) => console.log(' - ' + p));

  if (current === 'error' && previous !== 'error') {
    const message = `🔴 WEBSITE ĐANG LỖI\n${SITE_URL}\n${now()}\n\n${result.problems.join('\n')}`;
    if (result.screenshot) await sendPhoto(result.screenshot, message);
    else await sendText(message);
  } else if (current === 'ok' && previous === 'error') {
    await sendText(`🟢 Website đã hoạt động lại\n${SITE_URL}\n${now()}`);
  }

  fs.mkdirSync('state', { recursive: true });
  fs.writeFileSync(STATE_FILE, current);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
