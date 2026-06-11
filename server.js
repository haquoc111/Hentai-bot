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
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
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
  }

  async loadAll() {
    if (this.useDb) {
      const res = await pool.query("SELECT * FROM keys");
      return Object.fromEntries(res.rows.map(r => [r.key_text, r]));
    }
    try {
      return fs.existsSync(this.keyFile) ? JSON.parse(fs.readFileSync(this.keyFile, "utf-8")) : {};
    } catch { return {}; }
  }

  async saveAll(keys) {
    if (this.useDb) {
      // For DB mode, we handle individual updates, but this method is kept for compatibility
      // Not used for bulk save, only for delete
      return;
    }
    fs.writeFileSync(this.keyFile, JSON.stringify(keys, null, 2));
  }

  async setKey(keyText, data) {
    if (this.useDb) {
      await pool.query(
        `INSERT INTO keys (key_text, user_id, pkg, expire, created, activated)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (key_text)
         DO UPDATE SET user_id=$2, pkg=$3, expire=$4, activated=$6`,
        [keyText, data.user_id || null, data.pkg, data.expire, data.created || new Date().toISOString(), data.activated || null]
      );
    } else {
      const keys = await this.loadAll();
      keys[keyText] = data;
      await this.saveAll(keys);
    }
  }

  async getUserKey(userId) {
    const keys = await this.loadAll();
    const entry = Object.entries(keys).find(([_, v]) => String(v.user_id) === String(userId));
    return entry ? { key_text: entry[0], ...entry[1] } : null;
  }

  async getKey(keyText) {
    const keys = await this.loadAll();
    return keys[keyText] ? { key_text: keyText, ...keys[keyText] } : null;
  }

  async activateKey(keyText, userId) {
    const keys = await this.loadAll();
    let k = keys[keyText];
    if (!k) return { ok: false, msg: "❌ Key không tồn tại!" };
    if (k.user_id && String(k.user_id) !== String(userId)) return { ok: false, msg: "❌ Key này đã được dùng bởi người khác!" };

    // Nếu key chưa được gắn user (key mới) → gắn user và bắt đầu đếm thời gian từ lúc này
    if (!k.user_id) {
      const pkg = k.pkg;
      const hours = PACKAGES[pkg] ? PACKAGES[pkg].hours : null;
      const expire = hours ? new Date(Date.now() + hours * 3600000).toISOString() : "never";
      k.user_id = String(userId);
      k.expire = expire;
      k.activated = new Date().toISOString();
      if (this.useDb) {
        await pool.query(
          `UPDATE keys SET user_id=$1, expire=$2, activated=$3 WHERE key_text=$4`,
          [String(userId), expire, k.activated, keyText]
        );
      } else {
        keys[keyText] = k;
        await this.saveAll(keys);
      }
    }
    return { ok: true, key: { key_text: keyText, ...k } };
  }

  async deleteKey(keyText) {
    if (this.useDb) {
      await pool.query(`DELETE FROM keys WHERE key_text=$1`, [keyText]);
    } else {
      const keys = await this.loadAll();
      delete keys[keyText];
      await this.saveAll(keys);
    }
  }
}
const storage = new KeyStorage();

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = 7680266707;
const API_URL = "https://treo-lc79-h6zy.onrender.com/";

const PACKAGES = {
  "5h":       { label: "5 Giờ ⚡",      hours: 5 },
  "1ngay":    { label: "1 Ngày 📅",     hours: 24 },
  "1tuan":    { label: "1 Tuần 🗓️",    hours: 168 },
  "1thang":   { label: "1 Tháng 💎",   hours: 720 },
  "vinhvien": { label: "Vĩnh Viễn ♾️", hours: null },
};

// ─── KEY VALIDATION ──────────────────────────────────────────────────────────
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
  if (!exp) return "Chưa kích hoạt";
  if (exp === "never") return "♾️ Vĩnh viễn";
  return new Date(exp).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

// ─── API DATA PARSER (tối ưu cho LC79) ───────────────────────────────────────
function extractListFromResponse(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.result)) return data.result;
  if (data && Array.isArray(data.list)) return data.list;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && data.data && Array.isArray(data.data.list)) return data.data.list;
  if (data && data.data && Array.isArray(data.data.items)) return data.data.items;
  return [];
}

function extractDiceFromSession(s) {
  if (Array.isArray(s.dices) && s.dices.length >= 3) return s.dices.map(Number);
  if (Array.isArray(s.dice) && s.dice.length >= 3) return s.dice.map(Number);
  if (typeof s.openCode === "string" && s.openCode.includes(",")) {
    const d = s.openCode.split(",").map(Number);
    if (d.length >= 3 && d.every(n => !isNaN(n))) return d;
  }
  if (typeof s.open_code === "string" && s.open_code.includes(",")) {
    const d = s.open_code.split(",").map(Number);
    if (d.length >= 3 && d.every(n => !isNaN(n))) return d;
  }
  if (typeof s.openNum === "string") {
    const d = s.openNum.split(/[,\-\s]/).map(Number).filter(n => !isNaN(n));
    if (d.length >= 3) return d;
  }
  return [];
}

function extractSessionId(s) {
  const raw = s.phien || s.issue || s.id || s.session || s.period || s.expect || s.no || "";
  return String(raw).trim();
}

function extractMd5(s) {
  return s.md5 || s.hash || s.openMd5 || s.md5Hash || s.verification || "";
}

function resultFromDice(dice) {
  if (dice.length < 3) return null;
  const sum = dice[0] + dice[1] + dice[2];
  return sum >= 11 ? "TAI" : "XIU";
}

function resultFromField(s) {
  const r = (s.result || s.txType || s.type_result || s.resultType || s.taixiu || "").toString().toUpperCase();
  if (r === "1" || r.includes("TAI") || r.includes("TÀI") || r === "BIG") return "TAI";
  if (r === "0" || r.includes("XIU") || r.includes("XỈU") || r === "SMALL") return "XIU";
  return null;
}

function normalizeSession(s) {
  if (!s) return null;
  const idStr = extractSessionId(s);
  if (!idStr) return null;
  const numStr = idStr.replace(/\D/g, "");
  const id_num = numStr ? parseInt(numStr) : 0;

  const dice = extractDiceFromSession(s);
  const md5 = extractMd5(s);
  let result = dice.length >= 3 ? resultFromDice(dice) : resultFromField(s);
  if (!result) return null;
  const diceSum = dice.length >= 3 ? dice[0] + dice[1] + dice[2] : 0;

  return { id: idStr, id_num, diceSum, dice, result, md5 };
}

// ─── MD5 SEQUENCE PREDICTION (hash phiên N → kết quả phiên N+1) ───────────────
function analyzeMd5(md5String) {
  if (!md5String || md5String.length < 32) return null;
  try {
    const lastBytes = md5String.slice(-16);
    const num = parseInt(lastBytes.slice(-8), 16);
    if (isNaN(num)) return null;
    const mod = num % 100;
    const evenOdd = num % 2;
    const byteSum = lastBytes.split("").reduce((acc, c) => acc + parseInt(c, 16), 0);
    return { num, mod, evenOdd, byteSum };
  } catch { return null; }
}

// Xây dựng map: (md5 của phiên N) -> (kết quả phiên N+1)
function buildMd5SequenceMap(sessions) {
  // sessions đã được sắp xếp giảm dần (mới nhất đầu)
  // Cần map theo thứ tự thời gian: phiên cũ hơn (chỉ số lớn hơn? thực tế id_num càng lớn càng mới)
  // Để dễ xử lý, tạo map từ phiên cũ đến phiên mới hơn.
  // Sắp xếp tăng dần theo id_num (cũ → mới)
  const sortedAsc = [...sessions].sort((a, b) => a.id_num - b.id_num);
  const sequence = [];
  for (let i = 0; i < sortedAsc.length - 1; i++) {
    const cur = sortedAsc[i];
    const next = sortedAsc[i+1];
    if (cur.md5 && next.result) {
      sequence.push({ md5: cur.md5, nextResult: next.result });
    }
  }
  return sequence;
}

function predictFromMd5Sequence(currentMd5, sequenceMap) {
  if (!currentMd5 || sequenceMap.length < 10) return null;
  const target = analyzeMd5(currentMd5);
  if (!target) return null;

  // Tìm các bản ghi trong lịch sử có md5 gần giống (cùng đặc điểm)
  const similar = sequenceMap.filter(item => {
    const hist = analyzeMd5(item.md5);
    if (!hist) return false;
    return (Math.abs(hist.byteSum - target.byteSum) <= 8) || (hist.evenOdd === target.evenOdd);
  });
  if (similar.length < 5) return null;

  const taiCount = similar.filter(item => item.nextResult === "TAI").length;
  const xiuCount = similar.length - taiCount;
  const taiRate = (taiCount / similar.length) * 100;

  if (taiRate >= 65) return { pred: "TAI", conf: Math.round(taiRate), from: "MD5" };
  if (taiRate <= 35) return { pred: "XIU", conf: Math.round(100 - taiRate), from: "MD5" };
  return null;
}

// ─── THUẬT TOÁN DỰ ĐOÁN THÔNG MINH (chính xác theo chuỗi thực tế) ────────────
function analyzeSmart(sessions) {
  if (!sessions || sessions.length < 5) {
    return { prediction: "TAI", confidence: 50, reason: "⚠️ Đang thu thập dữ liệu..." };
  }

  const results = sessions.map(s => s.result);
  const n = results.length;

  // 1. STREAK (bệt) - tính từ phiên mới nhất (sessions[0])
  let streak = 1;
  const lastRes = results[0];
  for (let i = 1; i < n; i++) {
    if (results[i] === lastRes) streak++;
    else break;
  }

  // 2. Tỷ lệ Tài/Xỉu trong 20 phiên gần nhất
  const windowSize = Math.min(20, n);
  const taiCount20 = results.slice(0, windowSize).filter(r => r === "TAI").length;
  const taiRate20 = (taiCount20 / windowSize) * 100;

  // 3. Phát hiện cầu 1-1 (đảo liên tục)
  let pingpong = 0;
  for (let i = 0; i < Math.min(8, n-1); i++) {
    if (results[i] !== results[i+1]) pingpong++;
    else { pingpong = -10; break; }
  }
  const isPingPong = pingpong >= 4;

  // 4. Phát hiện cầu đôi (TT-XX-TT)
  let doublePair = 0;
  for (let i = 0; i < Math.min(8, n-1); i+=2) {
    if (i+1 < n && results[i] === results[i+1]) doublePair++;
    else { doublePair = 0; break; }
  }
  const isDoublePair = doublePair >= 2;

  // 5. Dự đoán MD5 dựa trên chuỗi (hash phiên hiện tại -> kết quả phiên tiếp theo)
  const md5Sequence = buildMd5SequenceMap(sessions);
  const currentMd5 = sessions[0].md5; // MD5 của phiên đã mở gần nhất
  const md5Pred = predictFromMd5Sequence(currentMd5, md5Sequence);

  // ── QUYẾT ĐỊNH DỰ ĐOÁN ────────────────────────────────────────────────────
  let prediction = "";
  let confidence = 60;
  let reason = "";

  // Bẻ cầu bệt dài (ưu tiên cao nhất)
  if (streak >= 7) {
    prediction = lastRes === "TAI" ? "XIU" : "TAI";
    confidence = Math.min(95, 82 + streak * 2);
    reason = `🔥 <b>Bẻ Cầu Mạnh:</b> ${lastRes === "TAI" ? "TÀI" : "XỈU"} bệt <b>${streak}</b> phiên liên tiếp. Xác suất gãy cực cao!`;
  }
  else if (streak >= 5) {
    prediction = lastRes === "TAI" ? "XIU" : "TAI";
    confidence = Math.min(88, 76 + streak * 2);
    reason = `🔥 <b>Bẻ Cầu:</b> ${lastRes === "TAI" ? "TÀI" : "XỈU"} bệt ${streak} phiên. Thời điểm vào bẻ cầu.`;
  }
  // Cầu đảo 1-1
  else if (isPingPong) {
    prediction = lastRes === "TAI" ? "XIU" : "TAI";
    confidence = 82;
    reason = `🔄 <b>Cầu Đảo 1-1:</b> Nhịp đảo ổn định. Đánh theo nhịp đảo (${lastRes === "TAI" ? "TÀI→XỈU" : "XỈU→TÀI"}).`;
  }
  // Cầu đôi
  else if (isDoublePair) {
    prediction = lastRes;
    confidence = 80;
    reason = `🧩 <b>Cầu Đôi:</b> Đang đi đôi (${lastRes === "TAI" ? "TÀI-TÀI" : "XỈU-XỈU"}). Đánh theo tiếp theo.`;
  }
  // Theo cầu ngắn (2-3 phiên)
  else if (streak >= 2) {
    if (md5Pred && md5Pred.pred === lastRes) {
      prediction = lastRes;
      confidence = Math.round((75 + md5Pred.conf) / 2);
      reason = `📈 <b>Theo Cầu + MD5:</b> Xu hướng ${lastRes === "TAI" ? "TÀI" : "XỈU"} được xác nhận bởi phân tích MD5 (${md5Pred.conf}%).`;
    } else {
      prediction = lastRes;
      confidence = 72;
      reason = `📈 <b>Theo Cầu:</b> Xu hướng ${lastRes === "TAI" ? "TÀI" : "XỈU"} đang hình thành (${streak} phiên).`;
    }
  }
  // Dựa vào MD5 Pattern (chuỗi)
  else if (md5Pred) {
    prediction = md5Pred.pred;
    confidence = md5Pred.conf;
    reason = `🔬 <b>Phân tích MD5 chuỗi:</b> ${md5Pred.pred === "TAI" ? "TÀI" : "XỈU"} theo pattern hash (${md5Pred.conf}% từ ${md5Sequence.length} mẫu).`;
  }
  // Cân bằng tỷ lệ
  else {
    if (taiRate20 >= 65) {
      prediction = "XIU";
      confidence = Math.round(50 + (taiRate20 - 50) * 0.7);
      reason = `⚖️ <b>Cân Bằng:</b> TÀI xuất hiện ${taiRate20.toFixed(0)}% trong 20 phiên → Xỉu để cân bằng.`;
    } else if (taiRate20 <= 35) {
      prediction = "TAI";
      confidence = Math.round(50 + (50 - taiRate20) * 0.7);
      reason = `⚖️ <b>Cân Bằng:</b> XỈU xuất hiện ${(100 - taiRate20).toFixed(0)}% trong 20 phiên → Tài để cân bằng.`;
    } else {
      prediction = taiRate20 >= 50 ? "XIU" : "TAI";
      confidence = 58;
      reason = `📊 <b>Thống kê:</b> Tỷ lệ Tài ${taiRate20.toFixed(0)}% / Xỉu ${(100 - taiRate20).toFixed(0)}% (20 phiên gần nhất).`;
    }
  }

  return {
    prediction,
    confidence,
    reason,
    taiRate: taiRate20,
    streak,
    lastRes,
    md5Used: !!md5Pred,
  };
}

// ─── BOT HANDLERS ─────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.replyWithHTML(
    `🚀 <b>SXD AI PREDICTION v6.0</b>\n\n` +
    `✅ Fix chuẩn API LC79 – đọc đúng phiên & kết quả\n` +
    `✅ Thuật toán MD5 theo chuỗi (hash N → kết quả N+1)\n` +
    `✅ Bẻ cầu mạnh / Theo cầu khoẻ dựa trên dữ liệu thực\n` +
    `✅ Key đếm giờ chuẩn từ lúc kích hoạt\n\n` +
    `Dùng lệnh <code>/key XXXX</code> để kích hoạt key của bạn.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🎲 DỰ ĐOÁN NGAY", "predict_api")],
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
      [Markup.button.callback("🎲 DỰ ĐOÁN NGAY", "predict_api")],
    ])
  );
});

bot.action("predict_api", async (ctx) => {
  const key = await storage.getUserKey(ctx.from.id);
  if (!key || !isKeyValid(key)) {
    const expired = key && !isKeyValid(key);
    return ctx.answerCbQuery("⛔ " + (expired ? "Key đã hết hạn!" : "Chưa có key!"), { show_alert: true })
      .then(() =>
        ctx.reply(
          expired
            ? `⛔ <b>Key của bạn đã hết hạn!</b>\nVui lòng mua key mới và dùng <code>/key SXD-XXXX</code> để kích hoạt.`
            : `❌ Bạn chưa có key.\nDùng <code>/key SXD-XXXX</code> để kích hoạt.`,
          { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("💳 Mua Key", "buy_key")]]) }
        )
      );
  }

  await ctx.answerCbQuery("🔎 Đang quét API...");

  try {
    const resp = await axios.get(API_URL, {
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    });

    const list = extractListFromResponse(resp.data);
    if (list.length === 0) {
      return ctx.reply("❌ Không lấy được dữ liệu từ API. Cấu trúc API có thể đã thay đổi.");
    }

    const sessions = list
      .map(normalizeSession)
      .filter(Boolean)
      .sort((a, b) => b.id_num - a.id_num); // mới nhất đầu

    if (sessions.length === 0) {
      if (ctx.from.id === ADMIN_ID) {
        const sample = JSON.stringify(list.slice(0, 2), null, 2).slice(0, 800);
        return ctx.reply("❌ Không parse được phiên.\nSample API:\n" + sample);
      }
      return ctx.reply("❌ Không phân tích được dữ liệu API. Liên hệ admin.");
    }

    const latest = sessions[0];
    const analysis = analyzeSmart(sessions);
    const diceStr = latest.dice.length > 0 ? latest.dice.join("-") : "?";
    const nextId = latest.id_num + 1;
    const predLabel = analysis.prediction === "TAI" ? "TÀI 🔴" : "XỈU ⚪";
    const trendBar = buildTrendBar(sessions.slice(0, 10));

    const msg =
      `📌 <b>Phiên gần nhất: #${latest.id}</b>\n` +
      `🎲 Kết quả: <b>${latest.result === "TAI" ? "TÀI 🔴" : "XỈU ⚪"}</b>  |  Xúc xắc: <b>${diceStr}</b>  |  Tổng: <b>${latest.diceSum || "?"}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🔮 <b>Dự đoán phiên #${nextId}:</b>\n` +
      `🎯 Kết quả: <b>${predLabel}</b>\n` +
      `📊 Độ tin cậy: <b>${analysis.confidence}%</b>\n` +
      `💡 Lý do: ${analysis.reason}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📉 10 phiên gần nhất:\n<code>${trendBar}</code>\n` +
      `📈 Tài: <b>${analysis.taiRate.toFixed(0)}%</b>  |  Xỉu: <b>${(100 - analysis.taiRate).toFixed(0)}%</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `⏰ Hạn dùng: <code>${formatExpire(key.expire)}</code>  (còn <b>${timeRemaining(key)}</b>)`;

    ctx.editMessageText(msg, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Cập nhật dự đoán", "predict_api")],
        [Markup.button.callback("🏠 Menu chính", "main_menu")],
      ]),
    });
  } catch (e) {
    console.error("API Error:", e.message);
    ctx.reply("❌ Lỗi kết nối API: " + e.message);
  }
});

function buildTrendBar(sessions) {
  return sessions
    .slice()
    .reverse()
    .map(s => (s.result === "TAI" ? "🔴" : "⚪"))
    .join(" ");
}

bot.action("main_menu", (ctx) => {
  ctx.editMessageText(
    "🏠 <b>Menu Chính</b>",
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🎲 DỰ ĐOÁN NGAY", "predict_api")],
        [Markup.button.callback("👤 Tài khoản", "my_account"), Markup.button.callback("💳 Mua Key", "buy_key")],
      ]),
    }
  );
});

bot.action("my_account", async (ctx) => {
  const key = await storage.getUserKey(ctx.from.id);
  if (!key) {
    return ctx.replyWithHTML(
      `👤 <b>Tài khoản của bạn</b>\n\nID: <code>${ctx.from.id}</code>\n❌ Chưa có key.\n\nDùng <code>/key SXD-XXXX</code> để kích hoạt.`
    );
  }
  const valid = isKeyValid(key);
  ctx.replyWithHTML(
    `👤 <b>Thông tin tài khoản</b>\n\n` +
    `🆔 ID: <code>${ctx.from.id}</code>\n` +
    `🔑 Key: <code>${key.key_text}</code>\n` +
    `📦 Gói: <b>${PACKAGES[key.pkg]?.label || key.pkg}</b>\n` +
    `⏰ Hết hạn: <b>${formatExpire(key.expire)}</b>\n` +
    `⏳ Còn lại: <b>${timeRemaining(key)}</b>\n` +
    `🔘 Trạng thái: ${valid ? "✅ Đang hoạt động" : "❌ Hết hạn"}`
  );
});

bot.action("buy_key", (ctx) => {
  ctx.replyWithHTML(
    `💳 <b>Bảng Giá Key SXD AI</b>\n\n` +
    `⚡ 5 Giờ — Liên hệ admin\n` +
    `📅 1 Ngày — Liên hệ admin\n` +
    `🗓️ 1 Tuần — Liên hệ admin\n` +
    `💎 1 Tháng — Liên hệ admin\n` +
    `♾️ Vĩnh Viễn — Liên hệ admin\n\n` +
    `📩 Liên hệ admin để mua key.`
  );
});

// ─── ADMIN COMMANDS ──────────────────────────────────────────────────────────
bot.command("taokey", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  const uid = parts[1];
  const pkg = parts[2];
  if (!uid || !pkg || !PACKAGES[pkg]) {
    return ctx.reply("Cách dùng: /taokey <user_id|none> <pkg>\nGói: 5h, 1ngay, 1tuan, 1thang, vinhvien\nVí dụ: /taokey none 1ngay");
  }

  const keyText = "SXD-" + crypto.randomBytes(8).toString("hex").toUpperCase();
  const isNone = uid === "none";
  let expire, user_id;
  if (isNone) {
    user_id = null;
    expire = "pending_activation";
  } else {
    user_id = uid;
    const hours = PACKAGES[pkg].hours;
    expire = hours ? new Date(Date.now() + hours * 3600000).toISOString() : "never";
  }

  await storage.setKey(keyText, {
    user_id,
    pkg,
    expire,
    created: new Date().toISOString(),
    activated: null,
  });

  ctx.replyWithHTML(
    `✅ <b>Tạo Key thành công</b>\n\n` +
    `🔑 Key: <code>${keyText}</code>\n` +
    `📦 Gói: <b>${PACKAGES[pkg].label}</b>\n` +
    `👤 User: <b>${isNone ? "Chưa gắn (user tự kích hoạt bằng /key)" : uid}</b>\n` +
    `⏰ Hết hạn: <b>${isNone ? "Bắt đầu khi kích hoạt" : formatExpire(expire)}</b>`
  );
});

bot.command("listkeys", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const keys = await storage.loadAll();
  const entries = Object.entries(keys);
  if (entries.length === 0) return ctx.reply("Chưa có key nào.");
  const lines = entries.slice(-20).map(([k, v]) => {
    const valid = isKeyValid({ ...v, key_text: k });
    return `${valid ? "✅" : "❌"} <code>${k}</code> | ${v.pkg} | ${v.user_id || "chưa kích hoạt"}`;
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

bot.command("debug", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    const resp = await axios.get(API_URL, { timeout: 8000 });
    const sample = JSON.stringify(resp.data).slice(0, 1500);
    ctx.reply("📦 Raw API:\n" + sample);
  } catch (e) {
    ctx.reply("❌ Lỗi: " + e.message);
  }
});

// ─── KHỞI CHẠY ───────────────────────────────────────────────────────────────
const app = express();
app.get("/", (req, res) => res.send("✅ SXD AI Bot đang chạy..."));
app.listen(process.env.PORT || 3000, () => console.log("Express server started"));

storage.initDb().then(() => {
  bot.launch().then(() => console.log("✅ Bot SXD AI v6.0 đã sẵn sàng!"));
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));