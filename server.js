"use strict";

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ========== DATABASE / STORAGE ==========
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
    this.memCache = {};
    try { if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true }); } catch {}
    try {
      if (!this.useDb && fs.existsSync(this.keyFile)) {
        this.memCache = JSON.parse(fs.readFileSync(this.keyFile, "utf-8"));
      }
    } catch {}
  }

  async initDb() {
    if (!this.useDb) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS keys (
        key_text TEXT PRIMARY KEY,
        user_id TEXT,
        pkg TEXT,
        expire TEXT,
        created TEXT,
        activated TEXT
      )
    `).catch(() => {});
    try {
      const res = await pool.query("SELECT * FROM keys");
      this.memCache = Object.fromEntries(res.rows.map(r => [r.key_text, r]));
    } catch {}
  }

  async loadAll() {
    if (this.useDb) {
      try {
        const res = await pool.query("SELECT * FROM keys");
        const dbData = Object.fromEntries(res.rows.map(r => [r.key_text, r]));
        this.memCache = { ...this.memCache, ...dbData };
      } catch {}
    } else {
      try {
        if (fs.existsSync(this.keyFile)) {
          const fileData = JSON.parse(fs.readFileSync(this.keyFile, "utf-8"));
          this.memCache = { ...fileData, ...this.memCache };
        }
      } catch {}
    }
    return { ...this.memCache };
  }

  async saveAll(keys) {
    this.memCache = { ...keys };
    if (this.useDb) return;
    try { fs.writeFileSync(this.keyFile, JSON.stringify(keys, null, 2)); } catch {}
  }

  async setKey(keyText, data) {
    // Ép user_id về string để so sánh nhất quán
    if (data.user_id !== undefined && data.user_id !== null) data.user_id = String(data.user_id);
    this.memCache[keyText] = data;
    if (this.useDb) {
      try {
        await pool.query(
          `INSERT INTO keys (key_text, user_id, pkg, expire, created, activated)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (key_text)
           DO UPDATE SET user_id=$2, pkg=$3, expire=$4, activated=$6`,
          [keyText, data.user_id || null, data.pkg, data.expire,
           data.created || new Date().toISOString(), data.activated || null]
        );
      } catch (e) { console.error("setKey DB error:", e.message); }
    } else {
      const keys = await this.loadAll();
      keys[keyText] = data;
      await this.saveAll(keys);
    }
  }

  async getUserKey(userId) {
    const userIdStr = String(userId);
    const keys = await this.loadAll();
    const entry = Object.entries(keys).find(([_, v]) => String(v.user_id) === userIdStr);
    return entry ? { key_text: entry[0], ...entry[1] } : null;
  }

  async getKey(keyText) {
    const keys = await this.loadAll();
    return keys[keyText] ? { key_text: keyText, ...keys[keyText] } : null;
  }

  // Kiểm tra user đã có key còn hạn chưa
  async hasValidKey(userId) {
    const key = await this.getUserKey(userId);
    if (!key) return false;
    if (key.expire === "never") return true;
    if (key.expire === "pending_activation") return false;
    const expireMs = new Date(key.expire).getTime();
    return !isNaN(expireMs) && expireMs > Date.now();
  }

  // Chỉ dùng để kích hoạt key loại "none" (user_id == null)
  async activateKey(keyText, userId) {
    const keys = await this.loadAll();
    let k = keys[keyText];
    if (!k) return { ok: false, msg: "❌ Key không tồn tại!" };

    // Nếu key đã có user_id (được tạo bằng /taokey user_id ...) thì không cho kích hoạt lại
    if (k.user_id) {
      if (String(k.user_id) === String(userId)) {
        return { ok: false, msg: "✅ Bạn đã có key này rồi! Key đang hoạt động." };
      } else {
        return { ok: false, msg: "❌ Key này đã thuộc về người khác!" };
      }
    }

    // Kiểm tra user đã có key còn hạn chưa
    const alreadyValid = await this.hasValidKey(userId);
    if (alreadyValid) {
      return { ok: false, msg: "❌ Bạn đã có key còn hiệu lực! Chỉ được nhập key mới khi key cũ hết hạn." };
    }

    // Key chưa gắn user → tiến hành kích hoạt
    const pkg = k.pkg;
    const hours = PACKAGES[pkg] ? PACKAGES[pkg].hours : null;
    const nowIso = new Date().toISOString();
    const expire = hours ? new Date(Date.now() + hours * 3600 * 1000).toISOString() : "never";
    k.user_id = String(userId);
    k.expire = expire;
    k.activated = nowIso;
    if (this.useDb) {
      try {
        await pool.query(
          `UPDATE keys SET user_id=$1, expire=$2, activated=$3 WHERE key_text=$4`,
          [String(userId), expire, nowIso, keyText]
        );
      } catch (e) { console.error("activateKey DB error:", e.message); }
    } else {
      keys[keyText] = k;
      await this.saveAll(keys);
    }
    this.memCache[keyText] = k;
    return { ok: true, key: { key_text: keyText, ...k } };
  }

  async deleteKey(keyText) {
    delete this.memCache[keyText];
    if (this.useDb) {
      try { await pool.query(`DELETE FROM keys WHERE key_text=$1`, [keyText]); } catch {}
    } else {
      const keys = await this.loadAll();
      delete keys[keyText];
      await this.saveAll(keys);
    }
  }
}

const storage = new KeyStorage();

// ========== CONFIG ==========
const BOT_TOKEN = process.env.BOT_TOKEN || "8935408887:AAHujtlfwIw2PZS65ZUFB1LfTwW07AURx2w";
const ADMIN_ID = 7680266707;
const API_URL = "https://treo-lc79-h6zy.onrender.com/";
const API_MD5_URL = "https://treo-lc79-h6zy.onrender.com/";

const PACKAGES = {
  "5h":       { label: "5 Giờ ⚡",      hours: 5 },
  "1ngay":    { label: "1 Ngày 📅",     hours: 24 },
  "1tuan":    { label: "1 Tuần 🗓️",    hours: 168 },
  "1thang":   { label: "1 Tháng 💎",   hours: 720 },
  "vinhvien": { label: "Vĩnh Viễn ♾️", hours: null },
};

// ========== WIN/LOSS STORE ==========
const userStats = {};
function getStats(userId) {
  if (!userStats[userId]) userStats[userId] = { win: 0, loss: 0, lastPrediction: null, lastSessionId: null };
  return userStats[userId];
}

// ========== AUTO-PREDICT STORE ==========
const autoSessions = {};

// ========== KEY VALIDATION ==========
function isKeyValid(key) {
  if (!key) return false;
  if (!key.user_id) return false;
  if (key.expire === "never") return true;
  const expireMs = new Date(key.expire).getTime();
  return !isNaN(expireMs) && expireMs > Date.now();
}

function timeRemaining(key) {
  if (!key || !key.expire) return "Không xác định";
  if (key.expire === "never") return "♾️ Vĩnh viễn";
  const diff = new Date(key.expire).getTime() - Date.now();
  if (diff <= 0) return "⛔ Hết hạn";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h >= 24) return `${Math.floor(h / 24)} ngày ${h % 24} giờ`;
  if (h > 0) return `${h} giờ ${m} phút`;
  return `${m} phút`;
}

function formatExpire(exp) {
  if (!exp || exp === "pending_activation") return "Chưa kích hoạt";
  if (exp === "never") return "♾️ Vĩnh viễn";
  return new Date(exp).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

// ========== API PARSER (giữ nguyên) ==========
function extractListFromResponse(data) { /* ... giống code cũ ... */ }
function extractDiceFromSession(s) { /* ... giống ... */ }
function extractSessionId(s) { /* ... giống ... */ }
function extractMd5(s) { /* ... giống ... */ }
function resultFromDice(dice) { /* ... giống ... */ }
function resultFromField(s) { /* ... giống ... */ }
function normalizeSession(s) { /* ... giống ... */ }
function analyzeMd5Hash(md5String) { /* ... giống ... */ }
function buildMd5SequenceMap(sessions) { /* ... giống ... */ }
function predictFromMd5(currentMd5, sequenceMap) { /* ... giống ... */ }
function detectPatterns(results) { /* ... giống ... */ }
function analyzeSmart(sessions) { /* ... giống ... */ }
function buildTrendBar(sessions) { /* ... giống ... */ }
function buildDiceDisplay(dice, sum) { /* ... giống ... */ }

// ========== XÂY MESSAGE DỰ ĐOÁN (có hiển thị kết quả trước) ==========
function buildPredictMessage(sessions, key, stats, lastPredictionResult = null) {
  if (!sessions || sessions.length === 0) return null;
  const latest = sessions[0];
  const analysis = analyzeSmart(sessions);
  const nextId = latest.id_num + 1;
  const predLabel = analysis.prediction === "TAI" ? "TÀI 🔴" : "XỈU ⚪";
  const trendBar = buildTrendBar(sessions.slice(0, 12));
  const diceDisp = buildDiceDisplay(latest.dice, latest.diceSum);
  let sumNote = "";
  if (latest.diceSum === 3) sumNote = " 🎯 (bộ ba 1)";
  else if (latest.diceSum === 18) sumNote = " 🎯 (bộ ba 6)";
  else if (latest.dice.every(d => d === latest.dice[0])) sumNote = " 🎲 (ba số giống)";
  const { win = 0, loss = 0 } = stats;
  const total = win + loss;
  const winRate = total > 0 ? ((win / total) * 100).toFixed(0) : "—";
  const trendNote = analysis.streak >= 3
    ? `⚡ Bệt ${analysis.streak} phiên ${analysis.lastRes === "TAI" ? "TÀI" : "XỈU"}`
    : analysis.pattern && analysis.pattern.pingpongLen >= 3
    ? `🔄 Cầu đảo ${analysis.pattern.pingpongLen} phiên`
    : `Tài/Xỉu: ${analysis.taiRate.toFixed(0)}%/${(100 - analysis.taiRate).toFixed(0)}%`;
  let resultLine = "";
  if (lastPredictionResult) {
    const emoji = lastPredictionResult === "win" ? "✅ THẮNG" : "❌ THUA";
    resultLine = `📌 <b>Kết quả dự đoán trước:</b> ${emoji}\n`;
  }
  return (
    `📌 <b>Phiên vừa mở: #${latest.id}</b>\n` +
    `🎲 Xúc xắc: ${diceDisp}${sumNote}\n` +
    `🏆 Kết quả: <b>${latest.result === "TAI" ? "TÀI 🔴" : "XỈU ⚪"}</b>\n` +
    `${resultLine}` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔮 <b>DỰ ĐOÁN PHIÊN #${nextId}:</b>\n` +
    `🎯 <b>${predLabel}</b>  |  Độ tin cậy: <b>${analysis.confidence}%</b>\n` +
    `💡 ${analysis.reason}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 Xu hướng: ${trendNote}\n` +
    `📉 12 phiên gần nhất:\n<code>${trendBar}</code>\n` +
    (analysis.md5Used ? `🔬 MD5 phân tích: <b>${analysis.md5Samples}</b> mẫu lịch sử\n` : "") +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📈 Thắng: <b>${win}</b>  Thua: <b>${loss}</b>  Tỉ lệ: <b>${winRate}%</b>\n` +
    `⏰ Key còn: <b>${timeRemaining(key)}</b>`
  );
}

// Cập nhật thắng/thua và trả về outcome
function updateWinLoss(userId, newSessionId, newResult) {
  const st = getStats(userId);
  if (!st.lastPrediction || !st.lastSessionId) return null;
  if (st.lastSessionId === newSessionId) return null;
  let outcome = null;
  if (st.lastPrediction === newResult) {
    st.win++;
    outcome = "win";
  } else {
    st.loss++;
    outcome = "loss";
  }
  st.lastSessionId = null;
  st.lastPrediction = null;
  return outcome;
}

// ========== AUTO PREDICT ==========
async function fetchAndPredict(userId, chatId, messageId, ctx) {
  try {
    const key = await storage.getUserKey(userId);
    if (!key || !isKeyValid(key)) {
      stopAutoPredict(userId, chatId);
      try {
        await ctx.telegram.editMessageText(chatId, messageId, undefined,
          "⛔ <b>Key hết hạn hoặc không hợp lệ.</b>\nDùng <code>/key SXD-XXXX</code> để kích hoạt key mới (nếu có).",
          { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("💳 Mua Key", "buy_key")]]) }
        );
      } catch {}
      return;
    }

    let resp;
    try {
      resp = await axios.get(API_URL, { timeout: 15000, headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
    } catch (apiErr) {
      console.error("API fetch error:", apiErr.message);
      try {
        await ctx.telegram.editMessageText(chatId, messageId, undefined,
          `⏳ <b>Đang tải dữ liệu API...</b>\n🔄 Tự động cập nhật mỗi 20 giây.\n\n⚠️ API đang chậm, đang thử lại...`,
          { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("⏹ Dừng tự động", `stop_auto_${userId}`)]]) }
        );
      } catch {}
      return;
    }

    const list = extractListFromResponse(resp.data);
    if (list.length === 0) return;
    const sessions = list.map(normalizeSession).filter(Boolean).sort((a, b) => b.id_num - a.id_num);
    if (sessions.length === 0) return;

    const latest = sessions[0];
    const st = getStats(userId);
    const outcome = updateWinLoss(userId, latest.id, latest.result);
    const analysis = analyzeSmart(sessions);
    st.lastPrediction = analysis.prediction;
    st.lastSessionId = String(latest.id_num + 1);

    const msg = buildPredictMessage(sessions, key, st, outcome);
    if (!msg) return;

    await ctx.telegram.editMessageText(chatId, messageId, undefined, msg, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⏹ Dừng tự động", `stop_auto_${userId}`)],
        [Markup.button.callback("🏠 Menu chính", "main_menu")],
      ]),
    });
  } catch (e) {
    console.error("AutoPredict error:", e.message);
  }
}

function startAutoPredict(userId, chatId, messageId, ctx) {
  stopAutoPredict(userId, chatId);
  const intervalId = setInterval(() => fetchAndPredict(userId, chatId, messageId, ctx), 20000);
  autoSessions[`${userId}_${chatId}`] = { intervalId, messageId };
  fetchAndPredict(userId, chatId, messageId, ctx);
}

function stopAutoPredict(userId, chatId) {
  const key = `${userId}_${chatId}`;
  if (autoSessions[key]) {
    clearInterval(autoSessions[key].intervalId);
    delete autoSessions[key];
  }
}

// ========== BOT HANDLERS ==========
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.replyWithHTML(
    `👑 <b>CHÀO MỪNG ĐẾN VỚI S2KING_BOT</b> 👑\n\n` +
    `🎯 Dự đoán Tài Xỉu siêu chuẩn, phân tích MD5 + cầu.\n` +
    `Dùng lệnh <code>/key SXD-XXXX</code> để kích hoạt key (nếu có).\n` +
    `Liên hệ admin để mua key: @cskh09099`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🎲 DỰ ĐOÁN TỰ ĐỘNG", "predict_auto")],
      [Markup.button.callback("🔍 Dự đoán MD5", "predict_md5")],
      [Markup.button.callback("👤 Tài khoản", "my_account"), Markup.button.callback("💳 Mua Key", "buy_key")],
    ])
  );
});

bot.command("key", async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const keyText = parts[1];
  if (!keyText) return ctx.reply("❌ Dùng: /key SXD-XXXXXX");
  const result = await storage.activateKey(keyText, ctx.from.id);
  if (!result.ok) return ctx.reply(result.msg);
  const key = result.key;
  ctx.replyWithHTML(
    `✅ <b>Kích hoạt thành công!</b>\n\n` +
    `🔑 Key: <code>${key.key_text}</code>\n` +
    `📦 Gói: <b>${PACKAGES[key.pkg]?.label || key.pkg}</b>\n` +
    `⏳ Hết hạn: <b>${formatExpire(key.expire)}</b>\n` +
    `⏰ Còn lại: <b>${timeRemaining(key)}</b>`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🎲 DỰ ĐOÁN TỰ ĐỘNG", "predict_auto")],
      [Markup.button.callback("🔍 Dự đoán MD5", "predict_md5")],
    ])
  );
});

bot.action("predict_auto", async (ctx) => {
  const userId = ctx.from.id;
  const key = await storage.getUserKey(userId);
  if (!key || !isKeyValid(key)) {
    const expired = key && !isKeyValid(key);
    await ctx.answerCbQuery("⛔ " + (expired ? "Key đã hết hạn!" : "Chưa có key!"), { show_alert: true });
    return ctx.replyWithHTML(
      expired
        ? `⛔ <b>Key của bạn đã hết hạn!</b>\nVui lòng mua key mới.`
        : `❌ Bạn chưa có key.\nDùng <code>/key SXD-XXXX</code> nếu có key chưa kích hoạt, hoặc liên hệ admin mua key.`,
      Markup.inlineKeyboard([[Markup.button.callback("💳 Mua Key", "buy_key")]])
    );
  }
  await ctx.answerCbQuery("🔎 Đang khởi động dự đoán tự động...");
  const sentMsg = await ctx.reply("⏳ <b>Đang tải dữ liệu API...</b>\n🔄 Tự động cập nhật mỗi 20 giây.", { parse_mode: "HTML" });
  startAutoPredict(userId, sentMsg.chat.id, sentMsg.message_id, ctx);
});

bot.action(/^stop_auto_(\d+)$/, async (ctx) => {
  const userId = parseInt(ctx.match[1]);
  if (ctx.from.id !== userId) return ctx.answerCbQuery("❌ Không phải của bạn!", { show_alert: true });
  stopAutoPredict(userId, ctx.chat.id);
  await ctx.answerCbQuery("✅ Đã dừng dự đoán tự động.");
  ctx.editMessageText(
    "⏹ <b>Đã dừng dự đoán tự động.</b>\n\nChọn bên dưới để tiếp tục:",
    { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🎲 Bắt đầu lại", "predict_auto")], [Markup.button.callback("🏠 Menu chính", "main_menu")]]) }
  );
});

bot.action("predict_md5", async (ctx) => {
  const userId = ctx.from.id;
  const key = await storage.getUserKey(userId);
  if (!key || !isKeyValid(key)) {
    const expired = key && !isKeyValid(key);
    await ctx.answerCbQuery("⛔ " + (expired ? "Key hết hạn" : "Chưa có key"), { show_alert: true });
    return ctx.replyWithHTML(expired ? "⛔ Key hết hạn" : "❌ Bạn chưa có key.\nDùng /key ...", Markup.inlineKeyboard([[Markup.button.callback("💳 Mua Key", "buy_key")]]));
  }
  await ctx.answerCbQuery("🔬 Đang phân tích MD5...");
  try {
    const resp = await axios.get(API_MD5_URL, { timeout: 12000, headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
    const list = extractListFromResponse(resp.data);
    if (list.length === 0) return ctx.reply("❌ Không lấy được dữ liệu API.");
    const sessions = list.map(normalizeSession).filter(Boolean).sort((a, b) => b.id_num - a.id_num);
    if (sessions.length === 0) return ctx.reply("❌ Không parse được phiên.");
    const latest = sessions[0];
    const md5Map = buildMd5SequenceMap(sessions);
    const md5Pred = predictFromMd5(latest.md5, md5Map);
    const diceStats = sessions.filter(s => s.dice.length >= 3);
    const sumDist = Array(19).fill(0);
    diceStats.forEach(s => { if (s.diceSum >= 3 && s.diceSum <= 18) sumDist[s.diceSum]++; });
    const topSums = sumDist.map((cnt, sum) => ({ sum, cnt })).filter(x => x.sum >= 3).sort((a,b)=>b.cnt - a.cnt).slice(0,3).map(x=>`${x.sum}(${x.cnt} lần)`).join(", ");
    const taiHistCount = diceStats.filter(s => s.result === "TAI").length;
    const xiuHistCount = diceStats.length - taiHistCount;
    let predText = "⚠️ Không đủ mẫu để dự đoán";
    if (md5Pred) predText = `${md5Pred.pred === "TAI" ? "TÀI 🔴" : "XỈU ⚪"} — Độ tin: <b>${md5Pred.conf}%</b> (${md5Pred.samples} mẫu gần giống)`;
    const md5HashDisplay = latest.md5 ? `<code>${latest.md5.slice(0,16)}...${latest.md5.slice(-8)}</code>` : "Không có";
    await ctx.replyWithHTML(
      `🔬 <b>PHÂN TÍCH MD5 – TOÀN BỘ LỊCH SỬ</b>\n\n` +
      `📌 Phiên gần nhất: <b>#${latest.id}</b>\n` +
      `🎲 Xúc xắc: ${buildDiceDisplay(latest.dice, latest.diceSum)}\n` +
      `🏆 Kết quả: <b>${latest.result === "TAI" ? "TÀI 🔴" : "XỈU ⚪"}</b>\n` +
      `🔑 MD5: ${md5HashDisplay}\n━━━━━━━━━━━━━━━━━━━━\n` +
      `🔮 <b>Dự đoán phiên #${latest.id_num + 1}:</b>\n${predText}\n━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 Lịch sử (${diceStats.length} phiên):\n  🔴 TÀI: ${taiHistCount} lần (${diceStats.length ? ((taiHistCount/diceStats.length)*100).toFixed(0):0}%)\n  ⚪ XỈU: ${xiuHistCount} lần (${diceStats.length ? ((xiuHistCount/diceStats.length)*100).toFixed(0):0}%)\n` +
      `🎲 Tổng hay xuất hiện: ${topSums || "—"}\n🔬 Tổng mẫu MD5: <b>${md5Map.length}</b>\n━━━━━━━━━━━━━━━━━━━━\n⏰ Key còn: <b>${timeRemaining(key)}</b>`,
      Markup.inlineKeyboard([[Markup.button.callback("🔄 Cập nhật MD5", "predict_md5")], [Markup.button.callback("🎲 DỰ ĐOÁN TỰ ĐỘNG", "predict_auto")], [Markup.button.callback("🏠 Menu chính", "main_menu")]])
    );
  } catch (e) { console.error("MD5 Predict Error:", e.message); ctx.reply("❌ Lỗi kết nối API: " + e.message); }
});

bot.action("main_menu", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  ctx.editMessageText("🏠 <b>Menu Chính – S2KING_BOT</b>", { parse_mode: "HTML", ...Markup.inlineKeyboard([
    [Markup.button.callback("🎲 DỰ ĐOÁN TỰ ĐỘNG", "predict_auto")],
    [Markup.button.callback("🔍 Dự đoán MD5", "predict_md5")],
    [Markup.button.callback("👤 Tài khoản", "my_account"), Markup.button.callback("💳 Mua Key", "buy_key")],
  ]) });
});

bot.action("my_account", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  const key = await storage.getUserKey(ctx.from.id);
  const st = getStats(ctx.from.id);
  const total = st.win + st.loss;
  const winRate = total > 0 ? ((st.win / total) * 100).toFixed(0) : "—";
  if (!key) {
    return ctx.replyWithHTML(`👤 <b>Tài khoản của bạn</b>\n\nID: <code>${ctx.from.id}</code>\n❌ Chưa có key.\n\nDùng <code>/key SXD-XXXX</code> nếu có key chưa kích hoạt.`);
  }
  const valid = isKeyValid(key);
  ctx.replyWithHTML(
    `👤 <b>Thông tin tài khoản</b>\n\n` +
    `🆔 ID: <code>${ctx.from.id}</code>\n` +
    `🔑 Key: <code>${key.key_text}</code>\n` +
    `📦 Gói: <b>${PACKAGES[key.pkg]?.label || key.pkg}</b>\n` +
    `⏰ Hết hạn: <b>${formatExpire(key.expire)}</b>\n` +
    `⏳ Còn lại: <b>${timeRemaining(key)}</b>\n` +
    `🔘 Trạng thái: ${valid ? "✅ Đang hoạt động" : "❌ Hết hạn"}\n\n` +
    `📈 <b>Thống kê:</b>\n  🏆 Thắng: <b>${st.win}</b>  |  ❌ Thua: <b>${st.loss}</b>  |  Tỉ lệ: <b>${winRate}%</b>`
  );
});

bot.action("buy_key", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  ctx.replyWithHTML(`💳 <b>Bảng Giá Key S2KING_BOT</b>\n\n⚡ 5 Giờ — 📅 1 Ngày — 🗓️ 1 Tuần — 💎 1 Tháng — ♾️ Vĩnh Viễn\n\n📩 Liên hệ <a href="https://t.me/cskh09099">@cskh09099</a> để mua key.`, { parse_mode: "HTML", disable_web_page_preview: true });
});

// ========== ADMIN COMMANDS ==========
bot.command("taokey", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  const uid = parts[1];
  const pkg = parts[2];
  if (!uid || !pkg || !PACKAGES[pkg]) {
    return ctx.reply("Cách dùng: /taokey <user_id|none> <pkg>\nGói: 5h, 1ngay, 1tuan, 1thang, vinhvien\nVí dụ: /taokey none 1ngay\n       /taokey 123456789 1tuan");
  }
  const keyText = "SXD-" + crypto.randomBytes(8).toString("hex").toUpperCase();
  const isNone = uid === "none";
  let expire, user_id, activatedNote;
  if (isNone) {
    user_id = null;
    expire = "pending_activation";
    activatedNote = "Bắt đầu đếm khi user kích hoạt bằng /key";
  } else {
    user_id = String(uid);
    const hours = PACKAGES[pkg].hours;
    expire = hours ? new Date(Date.now() + hours * 3600 * 1000).toISOString() : "never";
    activatedNote = `Bắt đầu ngay: ${formatExpire(expire)}`;
  }
  await storage.setKey(keyText, { user_id, pkg, expire, created: new Date().toISOString(), activated: isNone ? null : new Date().toISOString() });
  ctx.replyWithHTML(`✅ <b>Tạo Key thành công</b>\n\n🔑 Key: <code>${keyText}</code>\n📦 Gói: <b>${PACKAGES[pkg].label}</b>\n👤 User: <b>${isNone ? "Chưa gắn (user tự kích hoạt)" : uid}</b>\n⏰ Hết hạn: <b>${activatedNote}</b>`);
});

bot.command("listkeys", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const keys = await storage.loadAll();
  const entries = Object.entries(keys);
  if (entries.length === 0) return ctx.reply("Chưa có key nào.");
  const lines = entries.slice(-20).map(([k, v]) => {
    const valid = isKeyValid({ ...v, key_text: k });
    const remain = timeRemaining({ ...v, key_text: k });
    return `${valid ? "✅" : "❌"} <code>${k}</code> | ${v.pkg} | ${v.user_id || "chưa kích hoạt"} | ${remain}`;
  });
  ctx.replyWithHTML(`📋 <b>Danh sách Key (${entries.length} keys):</b>\n\n` + lines.join("\n"));
});

bot.command("deletekey", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const keyText = ctx.message.text.trim().split(/\s+/)[1];
  if (!keyText) return ctx.reply("Cách dùng: /deletekey SXD-XXXX");
  const key = await storage.getKey(keyText);
  if (!key) return ctx.reply("❌ Không tìm thấy key.");
  await storage.deleteKey(keyText);
  ctx.reply(`✅ Đã xoá key: ${keyText}`);
});

bot.command("resetstats", (ctx) => {
  userStats[ctx.from.id] = { win: 0, loss: 0, lastPrediction: null, lastSessionId: null };
  ctx.reply("✅ Đã reset thống kê thắng/thua của bạn.");
});

bot.command("debug", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    const resp = await axios.get(API_URL, { timeout: 8000 });
    const list = extractListFromResponse(resp.data);
    const sessions = list.map(normalizeSession).filter(Boolean).sort((a,b)=>b.id_num - a.id_num);
    const sample3 = sessions.slice(0,3).map(s => `#${s.id} → ${s.result} | dice:${s.dice.join(",")} | sum:${s.diceSum} | md5:${s.md5?.slice(0,12)}…`).join("\n");
    ctx.reply(`📦 API OK – ${list.length} items, ${sessions.length} phiên parse được\n\n3 phiên gần nhất:\n${sample3}`);
  } catch (e) { ctx.reply("❌ Lỗi: " + e.message); }
});

// ========== KHỞI CHẠY ==========
const app = express();
app.get("/", (req, res) => res.send("✅ SXD AI Bot v7.0 đang chạy..."));
app.listen(process.env.PORT || 3000, () => console.log("Express server started"));

storage.initDb().then(() => {
  bot.launch().then(() => console.log("✅ Bot SXD AI v7.0 đã sẵn sàng!"));
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));