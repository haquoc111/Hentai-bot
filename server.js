"use strict";

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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
    this.memCache = {}; // Nguồn dữ liệu chính xác nhất
    
    try { if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true }); } catch {}
  }

  async initDb() {
    if (this.useDb) {
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
    }
    await this.loadAll(); // Nạp dữ liệu vào cache khi khởi động
  }

  async loadAll() {
    let fileData = {};
    try {
      if (fs.existsSync(this.keyFile)) {
        fileData = JSON.parse(fs.readFileSync(this.keyFile, "utf-8"));
      }
    } catch {}

    // Ưu tiên nạp từ file hệ thống vào cache
    this.memCache = { ...this.memCache, ...fileData };

    if (this.useDb) {
      try {
        const res = await pool.query("SELECT * FROM keys");
        const dbData = Object.fromEntries(res.rows.map(r => [r.key_text, r]));
        // SỬA LỖI: memCache đè lên dbData để bảo toàn key mới tạo chưa kịp lưu DB
        this.memCache = { ...dbData, ...this.memCache };
      } catch (e) { console.error("DB Load Error:", e.message); }
    }
    return this.memCache;
  }

  async saveAll(keys) {
    this.memCache = { ...keys };
    // Bắt buộc backup ra file để chống mất dữ liệu khi DB sập
    try { fs.writeFileSync(this.keyFile, JSON.stringify(this.memCache, null, 2)); } catch {}
  }

  async setKey(keyText, data) {
    this.memCache[keyText] = data;
    await this.saveAll(this.memCache); // Lưu file ngay lập tức
    
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
    }
  }

  async getUserKey(userId) {
    await this.loadAll(); // Đảm bảo cache luôn mới nhất
    const entry = Object.entries(this.memCache).find(([_, v]) => String(v.user_id) === String(userId));
    return entry ? { key_text: entry[0], ...entry[1] } : null;
  }

  async getKey(keyText) {
    await this.loadAll();
    return this.memCache[keyText] ? { key_text: keyText, ...this.memCache[keyText] } : null;
  }

  async activateKey(keyText, userId) {
    await this.loadAll();
    let k = this.memCache[keyText];
    if (!k) return { ok: false, msg: "❌ Key không tồn tại!" };
    if (k.user_id && String(k.user_id) !== String(userId))
      return { ok: false, msg: "❌ Key này đã được dùng bởi người khác!" };

    if (!k.user_id) {
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
      }
    }

    this.memCache[keyText] = k;
    await this.saveAll(this.memCache);
    return { ok: true, key: { key_text: keyText, ...k } };
  }

  async deleteKey(keyText) {
    delete this.memCache[keyText];
    await this.saveAll(this.memCache);
    if (this.useDb) {
      try { await pool.query(`DELETE FROM keys WHERE key_text=$1`, [keyText]); } catch {}
    }
  }
}

const storage = new KeyStorage();

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || "8640872279:AAHmCc9ezSBMjJNA7HEMLmeuWvXb7aRrues";
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

// ─── WIN/LOSS STORE ──────────────────────────────────────────────────────────
const userStats = {};
function getStats(userId) {
  if (!userStats[userId]) userStats[userId] = { win: 0, loss: 0, lastPrediction: null, lastSessionId: null };
  return userStats[userId];
}

// ─── AUTO-PREDICT STORE ───────────────────────────────────────────────────────
const autoSessions = {};

// ─── KEY VALIDATION ──────────────────────────────────────────────────────────
function isKeyValid(key) {
  if (!key || !key.user_id) return false;
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

// ─── HELPER: Lấy Key nhanh ────────────────────────────────────────────────────
async function getKeyForUser(userId) {
  if (storage.memCache) {
    const entry = Object.entries(storage.memCache).find(([_, v]) => String(v.user_id) === String(userId));
    if (entry) return { key_text: entry[0], ...entry[1] };
  }
  return await storage.getUserKey(userId);
}

// ─── API DATA PARSER ─────────────────────────────────────────────────────────
function extractListFromResponse(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.result)) return data.result;
  if (data && Array.isArray(data.list)) return data.list;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && data.data && Array.isArray(data.data.list)) return data.data.list;
  return [];
}

function extractDiceFromSession(s) {
  if (Array.isArray(s.dices) && s.dices.length >= 3) return s.dices.map(Number);
  if (Array.isArray(s.dice) && s.dice.length >= 3) return s.dice.map(Number);
  if (typeof s.openCode === "string" && s.openCode.includes(",")) return s.openCode.split(",").map(Number);
  if (typeof s.open_code === "string" && s.open_code.includes(",")) return s.open_code.split(",").map(Number);
  return [];
}

function extractSessionId(s) {
  const raw = s.phien || s.issue || s.id || s.session || s.period || "";
  return String(raw).trim();
}

function extractMd5(s) {
  return s.md5 || s.hash || s.openMd5 || s.md5Hash || "";
}

function resultFromDice(dice) {
  if (!dice || dice.length < 3) return null;
  const sum = dice[0] + dice[1] + dice[2];
  if (sum < 3 || sum > 18) return null;
  return sum >= 11 ? "TAI" : "XIU"; // Chuẩn hóa: 11-18 = Tài, 3-10 = Xỉu
}

function resultFromField(s) {
  const r = (s.result || s.txType || s.type_result || s.resultType || s.taixiu || "").toString().toUpperCase().trim();
  if (r === "1" || r === "TAI" || r.includes("TÀI") || r === "BIG" || r === "T") return "TAI";
  if (r === "0" || r === "XIU" || r.includes("XỈU") || r === "SMALL" || r === "X") return "XIU";
  return null;
}

function normalizeSession(s) {
  if (!s) return null;
  const idStr = extractSessionId(s);
  if (!idStr) return null;
  const numStr = idStr.replace(/\D/g, "");
  const id_num = numStr ? parseInt(numStr) : 0;
  const dice = extractDiceFromSession(s);
  let result = dice.length >= 3 ? resultFromDice(dice) : resultFromField(s);
  if (!result) return null;
  const diceSum = dice.length >= 3 ? dice[0] + dice[1] + dice[2] : 0;
  return { id: idStr, id_num, diceSum, dice, result, md5: extractMd5(s) };
}

// ─── MD5 SEQUENCE ANALYSIS ───────────────────────────────────────────────────
function analyzeMd5Hash(md5String) {
  if (!md5String || md5String.length < 32) return null;
  try {
    const h = md5String.toLowerCase();
    const byteSum = h.split("").reduce((acc, c) => acc + parseInt(c, 16), 0);
    const num1 = parseInt(h.slice(0, 16).slice(-8), 16) || 0;
    const num2 = parseInt(h.slice(16, 32).slice(-8), 16) || 0;
    return { byteSum, mod11: num1 % 11, mod7: num2 % 7, evenOdd: (num1 + num2) % 2, bucket: Math.floor(byteSum / 10) % 10 };
  } catch { return null; }
}

function buildMd5SequenceMap(sessions) {
  const sortedAsc = [...sessions].sort((a, b) => a.id_num - b.id_num);
  const sequence = [];
  for (let i = 0; i < sortedAsc.length - 1; i++) {
    const cur = sortedAsc[i];
    const next = sortedAsc[i + 1];
    if (cur.md5 && next.result) {
      sequence.push({ md5: cur.md5, analysis: analyzeMd5Hash(cur.md5), nextResult: next.result });
    }
  }
  return sequence;
}

function predictFromMd5(currentMd5, sequenceMap) {
  if (!currentMd5 || sequenceMap.length < 5) return null;
  const target = analyzeMd5Hash(currentMd5);
  if (!target) return null;

  const scored = sequenceMap.map(item => {
    if (!item.analysis) return { ...item, score: 0 };
    let score = 0;
    if (item.analysis.evenOdd === target.evenOdd) score += 3;
    if (item.analysis.bucket === target.bucket) score += 4;
    if (item.analysis.mod11 === target.mod11) score += 3;
    if (item.analysis.mod7 === target.mod7) score += 2;
    if (Math.abs(item.analysis.byteSum - target.byteSum) <= 5) score += 4;
    return { ...item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const similar = scored.slice(0, Math.max(10, Math.floor(scored.length * 0.3))).filter(x => x.score >= 3);
  if (similar.length < 5) return null;

  const taiCount = similar.filter(x => x.nextResult === "TAI").length;
  const taiRate = (taiCount / similar.length) * 100;

  if (taiRate >= 60) return { pred: "TAI", conf: Math.round(taiRate), samples: similar.length };
  if (taiRate <= 40) return { pred: "XIU", conf: Math.round(100 - taiRate), samples: similar.length };
  return null;
}

// ─── THUẬT TOÁN DỰ ĐOÁN TOÀN DIỆN ───────────────────────────────────────────
function analyzeSmart(sessions) {
  if (!sessions || sessions.length < 3) return { prediction: "XIU", confidence: 50, reason: "⚠️ Đang thu thập dữ liệu..." };

  const results = sessions.map(s => s.result);
  const n = results.length;
  
  let streak = 1;
  const last = results[0];
  for (let i = 1; i < n; i++) { if (results[i] === last) streak++; else break; }

  let pingpongLen = 0;
  for (let i = 0; i < n - 1; i++) { if (results[i] !== results[i + 1]) pingpongLen++; else break; }

  const md5Map = buildMd5SequenceMap(sessions);
  const md5Pred = predictFromMd5(sessions[0].md5, md5Map);

  const recentDice = sessions.slice(0, Math.min(10, n)).filter(s => s.dice.length >= 3);
  const avgSum = recentDice.length > 0 ? recentDice.reduce((acc, s) => acc + s.diceSum, 0) / recentDice.length : 10.5;
  const diceTrendStr = avgSum <= 10 ? "XỈU (3-10 điểm)" : "TÀI (11-18 điểm)";

  let prediction = "";
  let confidence = 60;
  let reason = "";

  if (streak >= 6) {
    prediction = last === "TAI" ? "XIU" : "TAI";
    confidence = Math.min(95, 80 + streak * 2);
    reason = `🔥 <b>BẺ CẦU CỰC MẠNH:</b> ${last === "TAI" ? "TÀI" : "XỈU"} đã bệt ${streak} tay. Tổng 3 xúc xắc đang nghiêng về ${diceTrendStr}, vào bẻ cầu ngay!`;
  } else if (streak >= 4) {
    prediction = last === "TAI" ? "XIU" : "TAI";
    confidence = Math.min(88, 72 + streak * 3);
    reason = `🔥 <b>BẺ CẦU:</b> Bệt ${streak} phiên. Áp dụng quy tắc xúc xắc hiện đang theo ${diceTrendStr}, đến điểm gãy.`;
  } else if (pingpongLen >= 5) {
    prediction = last === "TAI" ? "XIU" : "TAI";
    confidence = 85;
    reason = `🔄 <b>THEO CẦU 1-1 MẠNH:</b> Đảo liên tục ${pingpongLen} tay. Đánh theo nhịp đảo kết hợp ${diceTrendStr}.`;
  } else if (streak >= 2 && streak <= 3) {
    prediction = last;
    confidence = 75;
    reason = `📈 <b>MẠNH MẼ THEO CẦU:</b> Xu hướng ${last === "TAI" ? "TÀI" : "XỈU"} đang hình thành đẹp, điểm 3 xúc xắc hướng về ${diceTrendStr}.`;
  } else if (md5Pred) {
    prediction = md5Pred.pred;
    confidence = md5Pred.conf;
    reason = `🔬 <b>THEO MD5:</b> Dự đoán ${md5Pred.pred === "TAI" ? "TÀI" : "XỈU"} theo lịch sử mã hash (${md5Pred.conf}%), xúc xắc: ${diceTrendStr}.`;
  } else {
    prediction = avgSum <= 10 ? "XIU" : "TAI";
    confidence = 65;
    reason = `📊 <b>THEO XÚC XẮC:</b> Điểm 3 xúc xắc trung bình: ${avgSum.toFixed(1)} -> Nghiêng về ${diceTrendStr}.`;
  }

  return { prediction, confidence, reason };
}

function buildDiceDisplay(dice, sum) {
  if (!dice || dice.length < 3) return "? ? ? | ?";
  const faces = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
  const emojis = dice.map(d => (d >= 1 && d <= 6) ? faces[d] : "?").join(" ");
  return `${emojis} | Tổng: <b>${sum}</b>`;
}

function buildPredictMessage(sessions, key, stats) {
  if (!sessions || sessions.length === 0) return null;
  const latest = sessions[0];
  const analysis = analyzeSmart(sessions);
  const nextId = latest.id_num + 1;
  const predLabel = analysis.prediction === "TAI" ? "TÀI 🔴" : "XỈU ⚪";
  
  const { win = 0, loss = 0 } = stats;
  const total = win + loss;
  const winRate = total > 0 ? ((win / total) * 100).toFixed(0) : "—";

  return (
    `📌 <b>Phiên vừa mở: #${latest.id}</b>\n` +
    `🎲 Xúc xắc: ${buildDiceDisplay(latest.dice, latest.diceSum)}\n` +
    `🏆 Kết quả: <b>${latest.result === "TAI" ? "TÀI 🔴" : "XỈU ⚪"}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔮 <b>DỰ ĐOÁN PHIÊN MỚI #${nextId}:</b>\n` +
    `🎯 <b>${predLabel}</b>  |  Độ tin cậy: <b>${analysis.confidence}%</b>\n` +
    `💡 ${analysis.reason}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📈 Thắng: <b>${win}</b>  Thua: <b>${loss}</b>  Tỉ lệ: <b>${winRate}%</b>\n` +
    `⏰ Key còn: <b>${timeRemaining(key)}</b>`
  );
}

// ─── AUTO PREDICT ─────────────────────────────────────────────────────────────
async function fetchAndPredict(userId, chatId, messageId, ctx) {
  try {
    const keyObj = await getKeyForUser(userId);
    if (!keyObj || !isKeyValid(keyObj)) {
      stopAutoPredict(userId, chatId);
      try {
        await ctx.telegram.editMessageText(chatId, messageId, undefined,
          "⛔ <b>Key hết hạn hoặc không hợp lệ.</b>\nDùng <code>/key SXD-XXXX</code> để kích hoạt.",
          { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("💳 Mua Key", "buy_key")]]) }
        );
      } catch {}
      return;
    }

    const resp = await axios.get(API_URL, { timeout: 15000 });
    const list = extractListFromResponse(resp.data);
    const sessions = list.map(normalizeSession).filter(Boolean).sort((a, b) => b.id_num - a.id_num);
    if (sessions.length === 0) return;

    const latest = sessions[0];
    const st = getStats(userId);

    if (st.lastSessionId && st.lastSessionId !== String(latest.id_num)) {
      if (st.lastPrediction === latest.result) st.win++;
      else st.loss++;
    }

    const msg = buildPredictMessage(sessions, keyObj, st);
    if (!msg) return;

    st.lastPrediction = analyzeSmart(sessions).prediction;
    st.lastSessionId = String(latest.id_num);

    try {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, msg, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⏹ Dừng tự động", `stop_auto_${userId}`)],
          [Markup.button.callback("🏠 Menu chính", "main_menu")],
        ]),
      });
    } catch (e) { /* Tin nhắn không đổi */ }
  } catch (e) { console.error("AutoPredict error:", e.message); }
}

function startAutoPredict(userId, chatId, messageId, ctx) {
  stopAutoPredict(userId, chatId);
  // Cập nhật mỗi 15s để bắt phiên cực nhanh
  const intervalId = setInterval(() => fetchAndPredict(userId, chatId, messageId, ctx), 15000); 
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

// ─── BOT HANDLERS ─────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.replyWithHTML(
    `👑 <b>CHÀO MỪNG ĐẾN VỚI S2KING_BOT</b> 👑\n\n` +
    `Ở đây có gì?\n` +
    `🎯 Dự đoán api chuẩn lên đến 80% ✅\n` +
    `🔬 Dự đoán md5 bằng mã md5 ✅\n` +
    `💰 Giá cả hợp lý ✅\n\n` +
    `<i>S2king_bot rất mong được mọi người tin dùng ạ!</i>\n\n` +
    `Dùng lệnh <code>/key SXD-XXXX</code> để kích hoạt key của bạn.`,
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
  const key = await getKeyForUser(userId);
  if (!key || !isKeyValid(key)) {
    await ctx.answerCbQuery("⛔ Bạn chưa có key hợp lệ!", { show_alert: true });
    return ctx.replyWithHTML(`❌ Bạn chưa có key.\nDùng <code>/key SXD-XXXX</code> để kích hoạt.`, Markup.inlineKeyboard([[Markup.button.callback("💳 Mua Key", "buy_key")]]));
  }
  await ctx.answerCbQuery("🔎 Đang khởi động dự đoán tự động...");
  const sentMsg = await ctx.reply("⏳ <b>Đang tải dữ liệu API...</b>", { parse_mode: "HTML" });
  startAutoPredict(userId, sentMsg.chat.id, sentMsg.message_id, ctx);
});

bot.action(/^stop_auto_(\d+)$/, async (ctx) => {
  const userId = parseInt(ctx.match[1]);
  if (ctx.from.id !== userId) return;
  stopAutoPredict(userId, ctx.chat.id);
  await ctx.answerCbQuery("✅ Đã dừng.");
  ctx.editMessageText("⏹ <b>Đã dừng dự đoán tự động.</b>", { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu chính", "main_menu")]]) });
});

bot.action("predict_md5", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.replyWithHTML(
    `🔍 <b>DỰ ĐOÁN THEO MÃ MD5 CHỈ ĐỊNH</b>\n\n` +
    `Vui lòng copy mã MD5 ở phiên hiện tại và dùng lệnh sau để phân tích nhanh:\n` +
    `👉 <code>/md5 [mã_md5]</code>\n\n` +
    `<i>Ví dụ:</i>\n<code>/md5 e10adc3949ba59abbe56e057f20f883e</code>`
  );
});

bot.command("md5", async (ctx) => {
  const userId = ctx.from.id;
  const key = await getKeyForUser(userId);
  
  if (!key || !isKeyValid(key)) {
    return ctx.replyWithHTML("❌ <b>Bạn chưa có key.</b>\nDùng <code>/key SXD-XXXX</code> để kích hoạt.");
  }

  const parts = ctx.message.text.trim().split(/\s+/);
  const targetMd5 = parts[1];
  
  if (!targetMd5 || targetMd5.length < 32) {
    return ctx.reply("❌ Vui lòng nhập mã MD5 hợp lệ (32 ký tự).\nVí dụ: /md5 d33cf45200c3de98cb4635a3b8fb76bc");
  }

  const msg = await ctx.reply("🔬 Đang truy vấn toàn bộ API để phân tích MD5 này...");

  try {
    const resp = await axios.get(API_MD5_URL, { timeout: 15000 });
    const list = extractListFromResponse(resp.data);
    
    if (list.length === 0) {
        return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, "❌ Lỗi: Không lấy được dữ liệu API.");
    }

    const sessions = list.map(normalizeSession).filter(Boolean).sort((a, b) => b.id_num - a.id_num);
    const md5Map = buildMd5SequenceMap(sessions);
    const md5Pred = predictFromMd5(targetMd5, md5Map);

    const recentDice = sessions.slice(0, 10).filter(s => s.dice.length >= 3);
    const avgSum = recentDice.length > 0 ? recentDice.reduce((acc, s) => acc + s.diceSum, 0) / recentDice.length : 10.5;
    const diceBaseStr = avgSum <= 10 ? "XỈU (3-10)" : "TÀI (11-18)";

    if (!md5Pred) {
      return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined,
        `⚠️ Mã MD5 này chưa có đủ dữ liệu lịch sử để dự đoán chắc chắn. Tổng xúc xắc hiện tại nghiêng về: ${diceBaseStr}.`
      );
    }

    const predLabel = md5Pred.pred === "TAI" ? "TÀI 🔴" : "XỈU ⚪";
    ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined,
      `🔬 <b>KẾT QUẢ PHÂN TÍCH MD5:</b>\n` +
      `🔑 Mã: <code>${targetMd5.slice(0, 16)}...</code>\n\n` +
      `🎯 Dự đoán: <b>${predLabel}</b>\n` +
      `📈 Độ tin cậy: <b>${md5Pred.conf}%</b>\n` +
      `📊 Dựa trên <b>${md5Pred.samples}</b> mẫu lịch sử.\n` +
      `🎲 Cơ sở xúc xắc (10 phiên): Trung bình ${avgSum.toFixed(1)} điểm, áp dụng quy tắc <b>${diceBaseStr}</b>.\n` +
      `💪 Chiến thuật: <b>${md5Pred.conf >= 70 ? "MẠNH MẼ THEO CẦU" : "CÂN NHẮC BẺ CẦU"}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `⏰ Key còn: <b>${timeRemaining(key)}</b>`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, "❌ Lỗi kết nối API lấy dữ liệu MD5.");
  }
});

bot.action("main_menu", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  ctx.editMessageText("🏠 <b>Menu Chính – S2KING_BOT</b>", {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("🎲 DỰ ĐOÁN TỰ ĐỘNG", "predict_auto")],
      [Markup.button.callback("🔍 Dự đoán MD5", "predict_md5")],
      [Markup.button.callback("👤 Tài khoản", "my_account"), Markup.button.callback("💳 Mua Key", "buy_key")],
    ]),
  });
});

bot.action("my_account", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  const key = await getKeyForUser(ctx.from.id);
  const st = getStats(ctx.from.id);
  const total = st.win + st.loss;
  const winRate = total > 0 ? ((st.win / total) * 100).toFixed(0) : "—";

  if (!key) return ctx.replyWithHTML(`👤 <b>Tài khoản của bạn</b>\n\nID: <code>${ctx.from.id}</code>\n❌ Chưa có key.`);
  ctx.replyWithHTML(
    `👤 <b>Thông tin tài khoản</b>\n\n` +
    `🔑 Key: <code>${key.key_text}</code>\n` +
    `📦 Gói: <b>${PACKAGES[key.pkg]?.label || key.pkg}</b>\n` +
    `⏳ Còn lại: <b>${timeRemaining(key)}</b>\n\n` +
    `📈 Thống kê:\n🏆 Thắng: <b>${st.win}</b> | ❌ Thua: <b>${st.loss}</b> | Tỉ lệ: <b>${winRate}%</b>`
  );
});

bot.action("buy_key", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  ctx.replyWithHTML(`💳 <b>Liên hệ <a href="https://t.me/cskh09099">@cskh09099</a> để mua key.</b>`, { disable_web_page_preview: true });
});

bot.command("taokey", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  const uid = parts[1];
  const pkg = parts[2];
  if (!uid || !pkg || !PACKAGES[pkg]) return ctx.reply("Cách dùng: /taokey <user_id|none> <pkg>\nGói: 5h, 1ngay, 1tuan, 1thang, vinhvien");

  const keyText = "SXD-" + crypto.randomBytes(8).toString("hex").toUpperCase();
  const isNone = uid === "none";
  let expire = isNone ? "pending_activation" : (PACKAGES[pkg].hours ? new Date(Date.now() + PACKAGES[pkg].hours * 3600000).toISOString() : "never");

  await storage.setKey(keyText, {
    user_id: isNone ? null : uid,
    pkg,
    expire,
    created: new Date().toISOString(),
    activated: isNone ? null : new Date().toISOString(),
  });

  ctx.replyWithHTML(`✅ <b>Tạo Key thành công</b>\n🔑 Key: <code>${keyText}</code>\n👤 User: <b>${isNone ? "Chưa gắn" : uid}</b>`);
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

const app = express();
app.get("/", (req, res) => res.send("✅ SXD AI Bot đang chạy..."));
app.listen(process.env.PORT || 3000, () => console.log("Express server started"));

storage.initDb().then(() => { bot.launch().then(() => console.log("✅ Bot SXD AI đã sẵn sàng!")); });
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));