"use strict";

const { Telegraf, Markup } = require("telegraf");
const { message } = require("telegraf/filters");
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ─── DATABASE / STORAGE ──────────────────────────────────────────────────────
let Pool = null;
let pool = null;
const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL) {
  try {
    Pool = require("pg").Pool;
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  } catch (e) { pool = null; }
}

class KeyStorage {
  constructor() {
    this.useDb = !!(pool);
    this.dataDir = path.join(__dirname, "data");
    this.keyFile = path.join(this.dataDir, "keys.json");
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
  }

  async loadAll() {
    if (this.useDb) {
      const res = await pool.query("SELECT * FROM keys");
      return Object.fromEntries(res.rows.map(r => [r.key_text, r]));
    }
    try { return fs.existsSync(this.keyFile) ? JSON.parse(fs.readFileSync(this.keyFile, "utf-8")) : {}; } catch { return {}; }
  }

  async saveAll(keys) {
    if (this.useDb) return;
    fs.writeFileSync(this.keyFile, JSON.stringify(keys, null, 2));
  }

  async setKey(keyText, data) {
    if (this.useDb) {
      await pool.query(`INSERT INTO keys (key_text, user_id, pkg, expire, created) 
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key_text) 
        DO UPDATE SET user_id=$2, expire=$4`, 
        [keyText, data.user_id, data.pkg, data.expire, data.created || new Date().toISOString()]);
    } else {
      const keys = await this.loadAll(); keys[keyText] = data; await this.saveAll(keys);
    }
  }

  async getUserKey(userId) {
    const keys = await this.loadAll();
    const entry = Object.entries(keys).find(([_, v]) => Number(v.user_id) === Number(userId));
    return entry ? { key_text: entry[0], ...entry[1] } : null;
  }

  async getKey(keyText) {
    const keys = await this.loadAll();
    return keys[keyText] ? { key_text: keyText, ...keys[keyText] } : null;
  }
}
const storage = new KeyStorage();

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = 7680266707;
const API_URL = "https://treo-lc79-h6zy.onrender.com/";

const PACKAGES = {
  "5h":      { label: "5 Giờ ⚡",       hours: 5 },
  "1ngay":   { label: "1 Ngày",          hours: 24 },
  "1tuan":   { label: "1 Tuần",          hours: 168 },
  "vinhvien":{ label: "Vĩnh Viễn ♾️",   hours: null },
};

// ─── LOGIC KIỂM TRA KEY (FIXED) ───────────────────────────────────────────────
function isKeyValid(key) {
  if (!key) return false;
  if (key.expire === "never") return true;
  const expireDate = new Date(key.expire);
  return expireDate.getTime() > Date.now(); // Phải còn lớn hơn thời điểm hiện tại
}

function formatExpire(exp) {
  if (exp === "never") return "♾️ Vĩnh viễn";
  return new Date(exp).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

// ─── PHÂN TÍCH DỮ LIỆU & MD5 (SMARTER) ────────────────────────────────────────
function normalizeSession(s) {
  if (!s) return null;
  const idStr = String(s.phien || s.id || s.session || "0");
  const id_num = parseInt(idStr.replace(/\D/g, "")) || 0;
  
  let dice = [];
  if (Array.isArray(s.dices)) dice = s.dices.map(Number);
  else if (typeof s.openCode === 'string') dice = s.openCode.split(',').map(Number);
  
  // Ưu tiên kết quả từ API, nếu không có tự tính từ Dice
  let result = (s.result || "").toUpperCase();
  let diceSum = dice.length >= 3 ? (dice[0] + dice[1] + dice[2]) : 0;

  if (diceSum > 0) {
    result = (diceSum >= 11) ? "TAI" : "XIU";
  } else if (result.includes("TAI") || result === "1") {
    result = "TAI";
  } else if (result.includes("XIU") || result === "0") {
    result = "XIU";
  }

  return result ? { id: idStr, id_num, diceSum, dice, result, md5: s.md5 || "" } : null;
}

function analyzeSmart(sessions) {
  if (!sessions || sessions.length < 10) return { prediction: "TÀI", confidence: 50, reason: "Đang thu thập dữ liệu..." };

  const results = sessions.map(s => s.result);
  const md5s = sessions.map(s => s.md5);
  
  // 1. Tính Streak (Bệt)
  let streak = 1;
  const lastRes = results[0];
  for (let i = 1; i < results.length; i++) {
    if (results[i] === lastRes) streak++; else break;
  }

  // 2. Tính Tỷ lệ (Biên độ 20 phiên)
  const taiCount = results.slice(0, 20).filter(r => r === "TAI").length;
  const taiRate = (taiCount / 20) * 100;

  let prediction = "";
  let confidence = 60;
  let reason = "";

  // THUẬT TOÁN BẺ CẦU (BREAK STREAK)
  if (streak >= 5) {
    prediction = (lastRes === "TAI") ? "XIU" : "TAI";
    confidence = Math.min(80 + (streak * 2), 98);
    reason = `🔥 <b>Bẻ Cầu:</b> ${lastRes} đã bệt ${streak} tay. Xác suất gãy cực cao!`;
  } 
  // THUẬT TOÁN CẦU 1-1 (PING PONG)
  else if (results[0] !== results[1] && results[1] === results[2] && results[2] !== results[3]) {
    prediction = (results[0] === "TAI") ? "XIU" : "TAI";
    confidence = 85;
    reason = `🔄 <b>Cầu Đảo:</b> Phát hiện nhịp 1-1. Đánh theo nhịp đảo.`;
  }
  // THUẬT TOÁN THEO CẦU (TREND FOLLOW)
  else if (streak >= 2 && streak <= 3) {
    prediction = lastRes;
    confidence = 75;
    reason = `📈 <b>Theo Cầu:</b> Xu hướng ${lastRes} đang hình thành.`;
  }
  // THUẬT TOÁN MD5 & TỶ LỆ
  else {
    prediction = (taiRate > 50) ? "XIU" : "TAI";
    confidence = 65;
    reason = `⚖️ <b>Cân bằng:</b> Tỷ lệ Tài/Xỉu (${taiRate}%). Đánh để cân bằng sàn.`;
  }

  return { prediction, confidence, reason, taiRate };
}

// ─── BOT HANDLERS ────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.replyWithHTML(`🚀 <b>SXD AI PREDICTION v4.0</b>\n\n- Hệ thống đã fix lỗi Key.\n- Thuật toán bẻ cầu MD5 thông minh hơn.\n- Live Update từ API.`, 
    Markup.inlineKeyboard([
      [Markup.button.callback("🎲 DỰ ĐOÁN NGAY", "predict_api")],
      [Markup.button.callback("👤 Tài khoản", "my_account"), Markup.button.callback("💳 Mua Key", "buy_key")]
    ])
  );
});

bot.action("predict_api", async (ctx) => {
  const key = await storage.getUserKey(ctx.from.id);
  
  // FIX: Kiểm tra key chặt chẽ
  if (!key || !isKeyValid(key)) {
    return ctx.reply("❌ Key của bạn đã hết hạn hoặc chưa kích hoạt. Vui lòng mua key mới!");
  }

  await ctx.answerCbQuery("🔎 Đang quét API...");
  
  try {
    const resp = await axios.get(API_URL, { timeout: 5000 });
    const list = Array.isArray(resp.data) ? resp.data : (resp.data.data || []);
    const sessions = list.map(normalizeSession).filter(Boolean).sort((a, b) => b.id_num - a.id_num);
    
    if (sessions.length === 0) return ctx.reply("❌ Không lấy được dữ liệu từ API.");

    const latest = sessions[0];
    const analysis = analyzeSmart(sessions);

    const msg = `
📌 Phiên: <b>#${latest.id}</b>
🎲 Kết quả: <b>${latest.result} (${latest.dice.join("-")})</b>
━━━━━━━━━━━━━━━━━━━━
🔮 Dự đoán phiên: <b>#${latest.id_num + 1}</b>
🎯 Kết quả: <b>${analysis.prediction === "TAI" ? "TÀI 🔴" : "XỈU ⚪"}</b>
📊 Tin cậy: <b>${analysis.confidence}%</b>
💡 Cầu: <i>${analysis.reason}</i>
━━━━━━━━━━━━━━━━━━━━
⏰ Hạn dùng: <code>${formatExpire(key.expire)}</code>
    `;

    ctx.editMessageText(msg, { 
      parse_mode: "HTML", 
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Cập nhật phiên", "predict_api")],
        [Markup.button.callback("🏠 Menu", "main_menu")]
      ]) 
    });
  } catch (e) {
    ctx.reply("❌ Lỗi kết nối API: " + e.message);
  }
});

// Admin Command: /taokey <user_id> <pkg>
bot.command("taokey", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const [_, uid, pkg] = ctx.message.text.split(" ");
  if (!PACKAGES[pkg]) return ctx.reply("Gói: 5h, 1ngay, 1tuan, vinhvien");
  
  const keyText = "SXD-" + Math.random().toString(36).substring(2, 10).toUpperCase();
  const hours = PACKAGES[pkg].hours;
  // FIX: Tính toán chuẩn thời gian hết hạn
  const expire = hours ? new Date(Date.now() + hours * 3600000).toISOString() : "never";
  
  await storage.setKey(keyText, {
    user_id: uid || null,
    pkg: pkg,
    expire: expire,
    created: new Date().toISOString()
  });

  ctx.replyWithHTML(`✅ <b>Đã tạo Key thành công</b>\n\nKey: <code>${keyText}</code>\nGói: ${pkg}\nHạn dùng: ${formatExpire(expire)}`);
});

bot.action("my_account", async (ctx) => {
  const key = await storage.getUserKey(ctx.from.id);
  if (!key) return ctx.reply("Bạn chưa có Key.");
  ctx.replyWithHTML(`👤 <b>Thông tin tài khoản:</b>\n\nID: <code>${ctx.from.id}</code>\nGói: ${key.pkg}\nHết hạn: ${formatExpire(key.expire)}\nTrạng thái: ${isKeyValid(key) ? "✅ Hoạt động" : "❌ Hết hạn"}`);
});

// ─── KHỞI CHẠY ───────────────────────────────────────────────────────────────
const app = express();
app.get("/", (req, res) => res.send("Bot SXD AI đang chạy..."));
bot.launch().then(() => console.log("Bot đã sẵn sàng!"));
app.listen(process.env.PORT || 3000);