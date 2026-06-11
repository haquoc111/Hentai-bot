"use strict";

// ─── DEPENDENCIES ──────────────────────────────────────────────────────────────
const { Telegraf, Markup } = require("telegraf");
const { message } = require("telegraf/filters");
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// PostgreSQL (optional)
let Pool = null;
let pool = null;
const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL) {
  try {
    Pool = require("pg").Pool;
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  } catch (e) {
    console.warn("⚠️ Fallback sang lưu file.");
    pool = null;
  }
}

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Thiếu BOT_TOKEN trong biến môi trường!");
const ADMIN_ID = 7680266707;
const ADMIN_TG = "@cskh09099";
const API_URL = "https://treo-lc79-h6zy.onrender.com/";

const PACKAGES = {
  "5h":      { label: "5 Giờ ⚡",       price: "10.000đ",  hours: 5 },
  "1ngay":   { label: "1 Ngày",          price: "20.000đ",  hours: 24 },
  "1tuan":   { label: "1 Tuần",          price: "50.000đ",  hours: 168 },
  "1nam":    { label: "1 Năm 🔥SALE",    price: "99.000đ",  hours: 8760 },
  "vinhvien":{ label: "Vĩnh Viễn ♾️",   price: "150.000đ", hours: null },
};

// ─── KEY STORAGE ─────────────────────────────────────────────────────────────
class KeyStorage {
  constructor() {
    this.useDb = !!(pool && DATABASE_URL);
    if (this.useDb) this.initDb().catch(console.error);
    else {
      this.dataDir = path.join(__dirname, "data");
      this.keyFile = path.join(this.dataDir, "keys.json");
      if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }
  async initDb() {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS keys (key_text TEXT PRIMARY KEY, user_id BIGINT, pkg TEXT NOT NULL, expire TEXT NOT NULL, created TIMESTAMP DEFAULT NOW())`);
    } catch (err) { this.useDb = false; }
  }
  async loadAll() {
    if (this.useDb) {
      const res = await pool.query("SELECT * FROM keys");
      return Object.fromEntries(res.rows.map(r => [r.key_text, { user_id: r.user_id ? Number(r.user_id) : null, pkg: r.pkg, expire: r.expire, created: r.created }]));
    }
    try { return fs.existsSync(this.keyFile) ? JSON.parse(fs.readFileSync(this.keyFile, "utf-8")) : {}; } catch { return {}; }
  }
  async saveAll(keys) {
    if (this.useDb) return;
    fs.writeFileSync(this.keyFile, JSON.stringify(keys, null, 2));
  }
  async setKey(keyText, data) {
    if (this.useDb) {
      await pool.query(`INSERT INTO keys (key_text, user_id, pkg, expire, created) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key_text) DO UPDATE SET user_id=$2, pkg=$3, expire=$4`, [keyText, data.user_id, data.pkg, data.expire, data.created]);
    } else {
      const keys = await this.loadAll(); keys[keyText] = data; await this.saveAll(keys);
    }
  }
  async getUserKey(userId) {
    if (this.useDb) {
      const res = await pool.query("SELECT * FROM keys WHERE user_id = $1 ORDER BY created DESC LIMIT 1", [userId]);
      return res.rows[0] ? { key_text: res.rows[0].key_text, ...res.rows[0] } : null;
    }
    const keys = await this.loadAll();
    return Object.entries(keys).find(([_, v]) => Number(v.user_id) === Number(userId))?.[0] ? { key_text: Object.entries(keys).find(([_, v]) => Number(v.user_id) === Number(userId))[0], ...Object.entries(keys).find(([_, v]) => Number(v.user_id) === Number(userId))[1] } : null;
  }
  async deleteUserKeys(userId) {
    if (this.useDb) await pool.query("DELETE FROM keys WHERE user_id = $1", [userId]);
    else {
      const keys = await this.loadAll();
      const next = Object.fromEntries(Object.entries(keys).filter(([_, v]) => Number(v.user_id) !== Number(userId)));
      await this.saveAll(next);
    }
  }
  async getKey(keyText) {
    const keys = await this.loadAll();
    return keys[keyText] ? { key_text: keyText, ...keys[keyText] } : null;
  }
}
const storage = new KeyStorage();

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function genKey() { return "SXD-" + Math.random().toString(36).substring(2, 12).toUpperCase() + Math.random().toString(36).substring(2, 12).toUpperCase(); }
function isKeyValid(key) { if (!key) return false; if (key.expire === "never") return true; return new Date(key.expire).getTime() > Date.now(); }
function formatExpire(exp) { if (exp === "never") return "♾️ Vĩnh viễn"; return new Date(exp).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }); }

// ─── API & PHÂN TÍCH SIÊU CẤP ────────────────────────────────────────────────
let apiCache = { data: null, ts: 0 };

async function fetchApiData() {
  const now = Date.now();
  if (apiCache.data && (now - apiCache.ts) < 3000) return apiCache.data; // Cache 3s để bắt phiên nhanh
  try {
    const resp = await axios.get(API_URL, { timeout: 10000, headers: { "Cache-Control": "no-cache" } });
    const parsed = parseApiResponse(resp.data);
    apiCache = { data: parsed, ts: now };
    return parsed;
  } catch (e) { return { error: e.message }; }
}

function parseApiResponse(raw) {
  let list = Array.isArray(raw) ? raw : (raw.data || raw.history || raw.list || []);
  // Sắp xếp ID giảm dần (Phiên mới nhất lên đầu)
  const sessions = list.map(normalizeSession).filter(Boolean).sort((a, b) => b.id_num - a.id_num);
  return { sessions, latest: sessions[0] || null };
}

function normalizeSession(s) {
  if (!s) return null;
  const idStr = String(s.phien || s.id || s.session || s.round || "0");
  const id_num = parseInt(idStr.replace(/\D/g, "")) || 0;
  
  let dice = [];
  if (Array.isArray(s.dices)) dice = s.dices.map(Number);
  else if (Array.isArray(s.dice)) dice = s.dice.map(Number);
  else if (typeof s.openCode === 'string') dice = s.openCode.split(',').map(Number);

  let diceSum = (dice.length >= 3) ? (dice[0] + dice[1] + dice[2]) : Number(s.point || s.total || 0);

  // LOGIC CHUẨN TUYỆT ĐỐI: 3-10 XỈU, 11-18 TÀI
  let result = null;
  if (diceSum >= 3 && diceSum <= 18) {
    result = diceSum >= 11 ? "TAI" : "XIU";
  } else {
    const r = String(s.result || "").toUpperCase();
    if (r.includes("TAI") || r === "1") result = "TAI";
    else if (r.includes("XIU") || r === "0") result = "XIU";
  }
  return result ? { id: idStr, id_num, diceSum, dice: dice.slice(0,3), result } : null;
}

function analyzeSmart(sessions) {
  if (!sessions || sessions.length < 5) return { prediction: "TÀI", confidence: 50, reason: "Đang chờ dữ liệu..." };

  const results = sessions.map(s => s.result);
  const sums = sessions.map(s => s.diceSum);

  // 1. Tính Streak (Cầu bệt)
  let streak = 1;
  const last = results[0];
  for (let i = 1; i < results.length; i++) {
    if (results[i] === last) streak++; else break;
  }

  // 2. Logic bẻ/theo cầu
  let prediction = "";
  let confidence = 50;
  let reason = "";

  // TRƯỜNG HỢP: SIÊU BẺ CẦU (Khi bệt >= 6 tay)
  if (streak >= 6) {
    prediction = (last === "TAI") ? "XIU" : "TAI";
    confidence = Math.min(85 + streak, 95);
    reason = `🔀 <b>Siêu bẻ cầu:</b> ${last === "TAI" ? "Tài" : "Xỉu"} đã bệt ${streak} phiên. Điểm bẻ cực đẹp!`;
  } 
  // TRƯỜNG HỢP: BÁM CẦU BỆT (Bệt từ 3-5 tay)
  else if (streak >= 3) {
    prediction = last;
    confidence = 70 + (streak * 3);
    reason = `🔥 <b>Bám cầu:</b> Dòng ${last === "TAI" ? "Tài" : "Xỉu"} đang bệt tay thứ ${streak}. Nên theo cầu.`;
  }
  // TRƯỜNG HỢP: CẦU 1-1 (T-X-T-X)
  else if (results[0] !== results[1] && results[1] === results[2] && results[2] !== results[3]) {
    prediction = (results[0] === "TAI") ? "XIU" : "TAI";
    confidence = 80;
    reason = `🔄 <b>Cầu 1-1:</b> Phát hiện nhịp đảo, dự đoán nhịp tiếp theo của chuỗi.`;
  }
  // TRƯỜNG HỢP: ĐIỂM BIÊN (DICE SUM BIAS)
  else {
    const avg3 = sums.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    if (avg3 >= 14) {
      prediction = "XIU"; confidence = 75; reason = `🎲 <b>Biên độ:</b> 3 phiên gần điểm quá cao (${avg3.toFixed(1)}), dự đoán sập Xỉu.`;
    } else if (avg3 <= 7) {
      prediction = "TAI"; confidence = 75; reason = `🎲 <b>Biên độ:</b> 3 phiên gần điểm quá thấp (${avg3.toFixed(1)}), dự đoán hồi Tài.`;
    } else {
      // Mặc định bẻ theo tỷ lệ 20 phiên
      const taiRate = (results.slice(0, 20).filter(r => r === "TAI").length / 20) * 100;
      prediction = (taiRate > 50) ? "XIU" : "TAI";
      confidence = 62;
      reason = `⚖️ <b>Cân bằng:</b> Tài đang chiếm ${taiRate}%, đánh ngược để cân bằng xác suất.`;
    }
  }

  return { prediction, confidence, reason, taiRate: (results.filter(r=>r==="TAI").length/results.length*100).toFixed(0) };
}

// ─── BOT HANDLERS ────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
const userStates = new Map();

bot.start((ctx) => {
  ctx.replyWithHTML(`🚀 <b>SXD PREDICTION V3.0 - AI SIÊU BẺ CẦU</b>\n\nBot đã cập nhật thuật toán bám/bẻ cầu thời gian thực.\n\n👇 Chọn chức năng:`, 
    Markup.inlineKeyboard([
      [Markup.button.callback("🎲 Dự đoán API (Realtime)", "predict_api")],
      [Markup.button.callback("🔑 Nhập Key", "enter_key"), Markup.button.callback("💳 Mua Key", "buy_key")],
      [Markup.button.callback("👤 Tài khoản", "my_account")]
    ])
  );
});

bot.action("predict_api", async (ctx) => {
  const key = await storage.getUserKey(ctx.from.id);
  if (!isKeyValid(key)) return ctx.reply("❌ Bạn cần Key còn hạn để dùng tính năng này.");

  await ctx.answerCbQuery("⏳ Đang tính toán cầu...");
  const data = await fetchApiData();
  if (data.error) return ctx.reply("❌ Lỗi API: " + data.error);

  const analysis = analyzeSmart(data.sessions);
  const latest = data.latest;
  const nextId = latest ? (latest.id_num + 1) : "N/A";

  const msg = `
━━━━━━━━━━━━━━━━━━━━
📌 Phiên: <b>${latest.id}</b>
🎲 Kết quả: <b>${latest.result === "TAI" ? "TÀI 🔴" : "XỈU ⚪"}</b>
🎯 Xúc xắc: <b>${latest.dice.join("-")} (Tổng: ${latest.diceSum})</b>
━━━━━━━━━━━━━━━━━━━━
🆕 Phiên mới: <b>${nextId}</b>
🔮 Dự đoán: <b>${analysis.prediction === "TAI" ? "TÀI 🎲" : "XỈU 🎯"}</b>
📊 Độ tin cậy: <b>${analysis.confidence}%</b>
💡 Lý do: <i>${analysis.reason}</i>
━━━━━━━━━━━━━━━━━━━━
📈 Tỷ lệ 50 phiên: Tài ${analysis.taiRate}% | Xỉu ${100 - analysis.taiRate}%
`;
  ctx.editMessageText(msg, { parse_mode: "HTML", ...Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Cập nhật phiên mới", "predict_api")],
    [Markup.button.callback("🏠 Menu", "main_menu")]
  ])});
});

bot.action("enter_key", (ctx) => {
  userStates.set(ctx.from.id, "wait_key");
  ctx.reply("🔑 Vui lòng gửi mã Key (SXD-XXXX...):");
});

bot.on(message("text"), async (ctx) => {
  const state = userStates.get(ctx.from.id);
  if (state === "wait_key") {
    const keyText = ctx.message.text.trim();
    const keyInfo = await storage.getKey(keyText);
    if (!keyInfo) return ctx.reply("❌ Key không tồn tại.");
    if (keyInfo.user_id && keyInfo.user_id !== ctx.from.id) return ctx.reply("❌ Key này đã được dùng cho tài khoản khác.");
    
    await storage.setKey(keyText, { ...keyInfo, user_id: ctx.from.id });
    userStates.delete(ctx.from.id);
    ctx.replyWithHTML(`✅ <b>Kích hoạt thành công!</b>\n\n📦 Gói: ${keyInfo.pkg}\n⏰ Hết hạn: ${formatExpire(keyInfo.expire)}`);
  }
});

// Admin command: /taokey <user_id> <pkg>
bot.command("taokey", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const [_, uid, pkg] = ctx.message.text.split(" ");
  if (!PACKAGES[pkg]) return ctx.reply("Gói sai: 5h, 1ngay, 1tuan, 1nam, vinhvien");
  const key = genKey();
  const hours = PACKAGES[pkg].hours;
  const expire = hours ? new Date(Date.now() + hours*3600000).toISOString() : "never";
  await storage.setKey(key, { user_id: uid ? Number(uid) : null, pkg, expire, created: new Date().toISOString() });
  ctx.replyWithHTML(`✅ Đã tạo Key:\n<code>${key}</code>\nGói: ${pkg}\nCho UID: ${uid || "Trống"}`);
});

bot.action("main_menu", (ctx) => {
    ctx.editMessageText("🏠 Menu chính", {
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback("🎲 Dự đoán API", "predict_api")],
            [Markup.button.callback("💳 Mua Key", "buy_key")]
        ]).reply_markup
    });
});

// ─── SERVER ───────────────────────────────────────────────────────────────────
const app = express();
app.get("/", (req, res) => res.send("Bot is running!"));
bot.launch().then(() => console.log("Bot v3.0 Started"));
app.listen(process.env.PORT || 3000);