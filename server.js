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
    const keys = await this.loadAll();
    const entry = Object.entries(keys).find(([_, v]) => String(v.user_id) === String(userId));
    return entry ? { key_text: entry[0], ...entry[1] } : null;
  }

  async getKey(keyText) {
    const keys = await this.loadAll();
    return keys[keyText] ? { key_text: keyText, ...keys[keyText] } : null;
  }

  // Check if user already has a valid (non‑expired) key
  async hasValidKey(userId) {
    const key = await this.getUserKey(userId);
    if (!key) return false;
    if (key.expire === "never") return true;
    if (key.expire === "pending_activation") return false; // not yet activated
    const expireMs = new Date(key.expire).getTime();
    return !isNaN(expireMs) && expireMs > Date.now();
  }

  async activateKey(keyText, userId) {
    const keys = await this.loadAll();
    let k = keys[keyText];
    if (!k) return { ok: false, msg: "❌ Key không tồn tại!" };

    // Kiểm tra xem user đã có key còn hạn chưa
    const alreadyValid = await this.hasValidKey(userId);
    if (alreadyValid) {
      return { ok: false, msg: "❌ Bạn đã có key còn hiệu lực! Chỉ được nhập key mới khi key cũ hết hạn." };
    }

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
      } else {
        keys[keyText] = k;
        await this.saveAll(keys);
      }
    } else {
      k = { ...k, user_id: String(k.user_id) };
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

// ─── WIN/LOSS STORE ────────────────────────────────────────────────────
const userStats = {};
function getStats(userId) {
  if (!userStats[userId]) userStats[userId] = { win: 0, loss: 0, lastPrediction: null, lastSessionId: null };
  return userStats[userId];
}

// ─── AUTO-PREDICT STORE ───────────────────────────────────────────────────────
const autoSessions = {};

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
  if (!exp || exp === "pending_activation") return "Chưa kích hoạt";
  if (exp === "never") return "♾️ Vĩnh viễn";
  return new Date(exp).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

// ─── API DATA PARSER ─────────────────────────────────────────────────────────
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
    if (d.length >= 3 && d.every(n => !isNaN(n) && n >= 1 && n <= 6)) return d;
  }
  if (typeof s.open_code === "string" && s.open_code.includes(",")) {
    const d = s.open_code.split(",").map(Number);
    if (d.length >= 3 && d.every(n => !isNaN(n) && n >= 1 && n <= 6)) return d;
  }
  if (typeof s.openNum === "string") {
    const d = s.openNum.split(/[,\-\s]/).map(Number).filter(n => !isNaN(n) && n >= 1 && n <= 6);
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
  if (!dice || dice.length < 3) return null;
  const sum = dice[0] + dice[1] + dice[2];
  if (sum < 3 || sum > 18) return null;
  return sum >= 11 ? "TAI" : "XIU";
}

function resultFromField(s) {
  const r = (s.result || s.txType || s.type_result || s.resultType || s.taixiu || "")
    .toString().toUpperCase().trim();
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
  const md5 = extractMd5(s);

  let result = dice.length >= 3 ? resultFromDice(dice) : null;
  if (!result) result = resultFromField(s);
  if (!result) return null;

  const diceSum = dice.length >= 3 ? dice[0] + dice[1] + dice[2] : 0;
  return { id: idStr, id_num, diceSum, dice, result, md5 };
}

// ─── MD5 SEQUENCE ANALYSIS ───────────────────────────────────────────────────
function analyzeMd5Hash(md5String) {
  if (!md5String || md5String.length < 32) return null;
  try {
    const h = md5String.toLowerCase();
    const byteSum = h.split("").reduce((acc, c) => acc + parseInt(c, 16), 0);
    const firstHalf = h.slice(0, 16);
    const secondHalf = h.slice(16, 32);
    const num1 = parseInt(firstHalf.slice(-8), 16) || 0;
    const num2 = parseInt(secondHalf.slice(-8), 16) || 0;
    const mod11 = num1 % 11;
    const mod7  = num2 % 7;
    const evenOdd = (num1 + num2) % 2;
    const bucket = Math.floor(byteSum / 10) % 10;
    return { byteSum, mod11, mod7, evenOdd, bucket };
  } catch { return null; }
}

function buildMd5SequenceMap(sessions) {
  const sortedAsc = [...sessions].sort((a, b) => a.id_num - b.id_num);
  const sequence = [];
  for (let i = 0; i < sortedAsc.length - 1; i++) {
    const cur = sortedAsc[i];
    const next = sortedAsc[i + 1];
    if (cur.md5 && next.result) {
      sequence.push({
        md5: cur.md5,
        analysis: analyzeMd5Hash(cur.md5),
        nextResult: next.result,
        curDiceSum: cur.diceSum,
      });
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
    else if (Math.abs(item.analysis.byteSum - target.byteSum) <= 12) score += 2;
    return { ...item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const topN = Math.max(10, Math.floor(scored.length * 0.3));
  const similar = scored.slice(0, topN).filter(x => x.score >= 3);
  if (similar.length < 5) return null;

  const taiCount = similar.filter(x => x.nextResult === "TAI").length;
  const xiuCount = similar.length - taiCount;
  const taiRate = (taiCount / similar.length) * 100;

  if (taiRate >= 62) return { pred: "TAI", conf: Math.round(taiRate), samples: similar.length };
  if (taiRate <= 38) return { pred: "XIU", conf: Math.round(100 - taiRate), samples: similar.length };
  return null;
}

// ─── PHÂN TÍCH CẦU NÂNG CAO ──────────────────────────────────────────────────
function detectPatterns(results) {
  const n = results.length;
  if (n < 4) return {};

  let streak = 1;
  const last = results[0];
  for (let i = 1; i < n; i++) {
    if (results[i] === last) streak++;
    else break;
  }

  let pingpongLen = 0;
  for (let i = 0; i < n - 1; i++) {
    if (results[i] !== results[i + 1]) pingpongLen++;
    else break;
  }

  let doublePairLen = 0;
  let i = 0;
  while (i + 1 < n && results[i] === results[i + 1]) {
    doublePairLen++;
    i += 2;
  }

  let triplePairLen = 0;
  let j = 0;
  while (j + 2 < n && results[j] === results[j + 1] && results[j + 1] === results[j + 2]) {
    triplePairLen++;
    j += 3;
  }

  let zigzagScore = 0;
  for (let k = 0; k < Math.min(6, n - 2); k++) {
    if (results[k] !== results[k + 1] && results[k] === results[k + 2]) zigzagScore++;
  }

  const window20 = results.slice(0, Math.min(20, n));
  let longestRun = 1, curRun = 1;
  for (let k = 1; k < window20.length; k++) {
    if (window20[k] === window20[k - 1]) { curRun++; longestRun = Math.max(longestRun, curRun); }
    else curRun = 1;
  }

  return {
    streak, last,
    pingpongLen,
    doublePairLen,
    triplePairLen,
    zigzagScore,
    longestRun,
  };
}

function analyzeSmart(sessions) {
  if (!sessions || sessions.length < 3) {
    return { prediction: "XIU", confidence: 50, reason: "⚠️ Đang thu thập dữ liệu..." };
  }

  const results = sessions.map(s => s.result);
  const n = results.length;
  const windowSize = Math.min(20, n);

  const taiCount20 = results.slice(0, windowSize).filter(r => r === "TAI").length;
  const taiRate20 = (taiCount20 / windowSize) * 100;

  const windowSize50 = Math.min(50, n);
  const taiCount50 = results.slice(0, windowSize50).filter(r => r === "TAI").length;
  const taiRate50 = (taiCount50 / windowSize50) * 100;

  const pat = detectPatterns(results);
  const { streak, last, pingpongLen, doublePairLen, triplePairLen, zigzagScore } = pat;

  const md5Map = buildMd5SequenceMap(sessions);
  const md5Pred = predictFromMd5(sessions[0].md5, md5Map);

  const recentDice = sessions.slice(0, Math.min(10, n)).filter(s => s.dice.length >= 3);
  const avgSum = recentDice.length > 0
    ? recentDice.reduce((acc, s) => acc + s.diceSum, 0) / recentDice.length : 10.5;

  let prediction = "";
  let confidence = 60;
  let reason = "";
  let methodTag = "";

  if (streak >= 6) {
    prediction = last === "TAI" ? "XIU" : "TAI";
    confidence = Math.min(95, 80 + streak * 2);
    reason = `🔥 <b>BẺ CẦU CỰC MẠNH:</b> ${last === "TAI" ? "TÀI" : "XỈU"} bệt <b>${streak}</b> phiên! Xác suất gãy cực cao. Vào bẻ cầu ngay!`;
    methodTag = "BẺ_CẦU_DÀI";
  }
  else if (streak >= 4) {
    prediction = last === "TAI" ? "XIU" : "TAI";
    confidence = Math.min(88, 72 + streak * 3);
    const support = md5Pred && md5Pred.pred !== last ? ` (MD5 xác nhận ${md5Pred.conf}%)` : "";
    reason = `🔥 <b>BẺ CẦU:</b> ${last === "TAI" ? "TÀI" : "XỈU"} bệt ${streak} phiên, đến điểm gãy.${support}`;
    methodTag = "BẺ_CẦU";
  }
  else if (pingpongLen >= 5) {
    prediction = last === "TAI" ? "XIU" : "TAI";
    confidence = 85;
    reason = `🔄 <b>CẦU ĐẢO 1-1 MẠNH:</b> Đảo liên tục ${pingpongLen} phiên. Đánh theo nhịp đảo (${last === "TAI" ? "TÀI→XỈU" : "XỈU→TÀI"}).`;
    methodTag = "CẦU_ĐẢO_MẠNH";
  }
  else if (triplePairLen >= 2) {
    if (streak === 3) {
      prediction = last === "TAI" ? "XIU" : "TAI";
      confidence = 82;
      reason = `🧊 <b>CẦU BA (3-3):</b> Vừa đủ 3 phiên ${last === "TAI" ? "TÀI" : "XỈU"}, bắt đầu cặp 3 mới (đảo sang ${last === "TAI" ? "XỈU" : "TÀI"}).`;
      methodTag = "CẦU_BA_ĐẢO";
    } else if (streak < 3) {
      prediction = last;
      confidence = 80;
      reason = `🧊 <b>CẦU BA (3-3):</b> Đang đi cặp 3 ${last === "TAI" ? "TÀI" : "XỈU"} (phiên ${streak}/3). Theo cầu.`;
      methodTag = "CẦU_BA_THEO";
    }
  }
  else if (doublePairLen >= 2) {
    if (streak === 2) {
      prediction = last === "TAI" ? "XIU" : "TAI";
      confidence = 80;
      reason = `🧩 <b>CẦU ĐÔI (2-2):</b> Vừa hoàn thành 2 phiên ${last === "TAI" ? "TÀI" : "XỈU"}, đảo sang cặp ${last === "TAI" ? "XỈU" : "TÀI"}.`;
      methodTag = "CẦU_ĐÔI_ĐẢO";
    } else if (streak === 1) {
      prediction = last;
      confidence = 78;
      reason = `🧩 <b>CẦU ĐÔI (2-2):</b> Phiên 1/2 cặp ${last === "TAI" ? "TÀI" : "XỈU"}, theo tiếp để đủ đôi.`;
      methodTag = "CẦU_ĐÔI_THEO";
    }
  }
  else if (pingpongLen >= 3) {
    prediction = last === "TAI" ? "XIU" : "TAI";
    confidence = 76;
    reason = `🔄 <b>CẦU ĐẢO 1-1:</b> Nhịp đảo ${pingpongLen} phiên. Theo nhịp (${last === "TAI" ? "TÀI→XỈU" : "XỈU→TÀI"}).`;
    methodTag = "CẦU_ĐẢO";
  }
  else if (streak >= 2 && streak <= 3) {
    const md5Confirm = md5Pred && md5Pred.pred === last;
    if (md5Confirm) {
      prediction = last;
      confidence = Math.round(Math.min(82, (72 + md5Pred.conf) / 2));
      reason = `📈 <b>THEO CẦU + MD5 XÁC NHẬN:</b> Xu hướng ${last === "TAI" ? "TÀI" : "XỈU"} được MD5 xác nhận (${md5Pred.conf}%, ${md5Pred.samples} mẫu).`;
      methodTag = "THEO_CẦU_MD5";
    } else {
      prediction = last;
      confidence = 70;
      reason = `📈 <b>THEO CẦU:</b> Xu hướng ${last === "TAI" ? "TÀI" : "XỈU"} đang hình thành (${streak} phiên liên tiếp).`;
      methodTag = "THEO_CẦU";
    }
  }
  else if (md5Pred) {
    prediction = md5Pred.pred;
    confidence = md5Pred.conf;
    reason = `🔬 <b>PHÂN TÍCH MD5:</b> ${md5Pred.pred === "TAI" ? "TÀI" : "XỈU"} theo pattern hash lịch sử (${md5Pred.conf}%, phân tích ${md5Pred.samples}/${md5Map.length} mẫu).`;
    methodTag = "MD5";
  }
  else {
    const diceSignal = avgSum > 10.5 ? "XIU" : "TAI";
    if (taiRate20 >= 65) {
      prediction = "XIU";
      confidence = Math.round(50 + (taiRate20 - 50) * 0.8);
      reason = `⚖️ <b>CÂN BẰNG:</b> TÀI chiếm ${taiRate20.toFixed(0)}% trong 20 phiên (xu hướng dài: ${taiRate50.toFixed(0)}%). Về XIU để cân bằng.`;
      methodTag = "CÂN_BẰNG";
    } else if (taiRate20 <= 35) {
      prediction = "TAI";
      confidence = Math.round(50 + (50 - taiRate20) * 0.8);
      reason = `⚖️ <b>CÂN BẰNG:</b> XỈU chiếm ${(100 - taiRate20).toFixed(0)}% trong 20 phiên (xu hướng dài: ${(100 - taiRate50).toFixed(0)}%). Về TÀI để cân bằng.`;
      methodTag = "CÂN_BẰNG";
    } else {
      prediction = diceSignal;
      confidence = 60;
      reason = `📊 <b>THỐNG KÊ:</b> TÀI: ${taiRate20.toFixed(0)}% / XỈU: ${(100 - taiRate20).toFixed(0)}% (20 phiên). Tổng trung bình gần đây: ${avgSum.toFixed(1)}.`;
      methodTag = "THỐNG_KÊ";
    }
  }

  return {
    prediction,
    confidence,
    reason,
    taiRate: taiRate20,
    taiRate50,
    streak,
    lastRes: last,
    md5Used: !!md5Pred,
    md5Samples: md5Map.length,
    avgSum,
    pattern: pat,
    methodTag,
  };
}

function buildTrendBar(sessions) {
  return sessions
    .slice()
    .reverse()
    .map(s => {
      const icon = s.result === "TAI" ? "🔴" : "⚪";
      return s.diceSum ? `${icon}${s.diceSum}` : icon;
    })
    .join(" ");
}

function buildDiceDisplay(dice, sum) {
  if (!dice || dice.length < 3) return "? ? ? | ?";
  const faces = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
  const emojis = dice.map(d => (d >= 1 && d <= 6) ? faces[d] : "?").join(" ");
  return `${emojis} | ${dice.join("+")} = <b>${sum}</b>`;
}

// ─── XÂY MESSAGE DỰ ĐOÁN (có hiển thị kết quả dự đoán trước) ────────────────
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

  const trendNote =
    analysis.streak >= 3
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

// Cập nhật thắng/thua và trả về kết quả so sánh (win/loss)
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

// ─── AUTO PREDICT ─────────────────────────────────────────────────────────────
async function fetchAndPredict(userId, chatId, messageId, ctx) {
  try {
    const key = await storage.getUserKey(userId);
    if (!key || !isKeyValid(key)) {
      stopAutoPredict(userId, chatId);
      try {
        await ctx.telegram.editMessageText(chatId, messageId, undefined,
          "⛔ <b>Key hết hạn hoặc không hợp lệ.</b>\nDùng <code>/key SXD-XXXX</code> để kích hoạt key mới.",
          { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("💳 Mua Key", "buy_key")]]) }
        );
      } catch {}
      return;
    }

    let resp;
    try {
      resp = await axios.get(API_URL, {
        timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      });
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

    const sessions = list
      .map(normalizeSession)
      .filter(Boolean)
      .sort((a, b) => b.id_num - a.id_num);
    if (sessions.length === 0) return;

    const latest = sessions[0];
    const st = getStats(userId);

    // Cập nhật thắng/thua và lấy outcome để hiển thị
    const outcome = updateWinLoss(userId, latest.id, latest.result);

    // Tính dự đoán mới
    const analysis = analyzeSmart(sessions);
    // Lưu dự đoán cho phiên tiếp theo
    st.lastPrediction = analysis.prediction;
    st.lastSessionId = String(latest.id_num + 1);

    const msg = buildPredictMessage(sessions, key, st, outcome);
    if (!msg) return;

    try {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, msg, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⏹ Dừng tự động", `stop_auto_${userId}`)],
          [Markup.button.callback("🏠 Menu chính", "main_menu")],
        ]),
      });
    } catch (e) {}
  } catch (e) {
    console.error("AutoPredict error:", e.message);
  }
}

function startAutoPredict(userId, chatId, messageId, ctx) {
  stopAutoPredict(userId, chatId);
  const intervalId = setInterval(() => {
    fetchAndPredict(userId, chatId, messageId, ctx);
  }, 20000);
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
  const key = await storage.getUserKey(userId);
  if (!key || !isKeyValid(key)) {
    const expired = key && !isKeyValid(key);
    await ctx.answerCbQuery("⛔ " + (expired ? "Key đã hết hạn!" : "Chưa có key!"), { show_alert: true });
    return ctx.replyWithHTML(
      expired
        ? `⛔ <b>Key của bạn đã hết hạn!</b>\nVui lòng mua key mới và dùng <code>/key SXD-XXXX</code> để kích hoạt.`
        : `❌ Bạn chưa có key.\nDùng <code>/key SXD-XXXX</code> để kích hoạt.`,
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
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🎲 Bắt đầu lại", "predict_auto")],
        [Markup.button.callback("🏠 Menu chính", "main_menu")],
      ]),
    }
  );
});

bot.action("predict_md5", async (ctx) => {
  const userId = ctx.from.id;
  const key = await storage.getUserKey(userId);
  if (!key || !isKeyValid(key)) {
    const expired = key && !isKeyValid(key);
    await ctx.answerCbQuery("⛔ " + (expired ? "Key đã hết hạn!" : "Chưa có key!"), { show_alert: true });
    return ctx.replyWithHTML(
      expired
        ? `⛔ <b>Key của bạn đã hết hạn!</b>`
        : `❌ Bạn chưa có key.\nDùng <code>/key SXD-XXXX</code> để kích hoạt.`,
      Markup.inlineKeyboard([[Markup.button.callback("💳 Mua Key", "buy_key")]])
    );
  }

  await ctx.answerCbQuery("🔬 Đang phân tích MD5...");

  try {
    const resp = await axios.get(API_MD5_URL, {
      timeout: 12000,
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    });
    const list = extractListFromResponse(resp.data);
    if (list.length === 0) return ctx.reply("❌ Không lấy được dữ liệu API.");

    const sessions = list
      .map(normalizeSession)
      .filter(Boolean)
      .sort((a, b) => b.id_num - a.id_num);
    if (sessions.length === 0) return ctx.reply("❌ Không parse được phiên.");

    const latest = sessions[0];
    const md5Map = buildMd5SequenceMap(sessions);
    const md5Pred = predictFromMd5(latest.md5, md5Map);

    const diceStats = sessions.filter(s => s.dice.length >= 3);
    const sumDist = Array(19).fill(0);
    diceStats.forEach(s => { if (s.diceSum >= 3 && s.diceSum <= 18) sumDist[s.diceSum]++; });

    const topSums = sumDist
      .map((cnt, sum) => ({ sum, cnt }))
      .filter(x => x.sum >= 3)
      .sort((a, b) => b.cnt - a.cnt)
      .slice(0, 3)
      .map(x => `${x.sum}(${x.cnt}lần)`)
      .join(", ");

    const taiHistCount = diceStats.filter(s => s.result === "TAI").length;
    const xiuHistCount = diceStats.length - taiHistCount;

    let predText = "⚠️ Không đủ mẫu để dự đoán";
    if (md5Pred) {
      predText = `${md5Pred.pred === "TAI" ? "TÀI 🔴" : "XỈU ⚪"} — Độ tin: <b>${md5Pred.conf}%</b> (${md5Pred.samples} mẫu gần giống)`;
    }

    const md5HashDisplay = latest.md5
      ? `<code>${latest.md5.slice(0, 16)}...${latest.md5.slice(-8)}</code>`
      : "Không có";

    await ctx.replyWithHTML(
      `🔬 <b>PHÂN TÍCH MD5 – TOÀN BỘ LỊCH SỬ</b>\n\n` +
      `📌 Phiên gần nhất: <b>#${latest.id}</b>\n` +
      `🎲 Xúc xắc: ${buildDiceDisplay(latest.dice, latest.diceSum)}\n` +
      `🏆 Kết quả: <b>${latest.result === "TAI" ? "TÀI 🔴" : "XỈU ⚪"}</b>\n` +
      `🔑 MD5: ${md5HashDisplay}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🔮 <b>Dự đoán phiên #${latest.id_num + 1}:</b>\n` +
      `${predText}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 Lịch sử (${diceStats.length} phiên):\n` +
      `  🔴 TÀI: ${taiHistCount} lần (${diceStats.length ? ((taiHistCount / diceStats.length) * 100).toFixed(0) : 0}%)\n` +
      `  ⚪ XỈU: ${xiuHistCount} lần (${diceStats.length ? ((xiuHistCount / diceStats.length) * 100).toFixed(0) : 0}%)\n` +
      `🎲 Tổng hay xuất hiện: ${topSums || "—"}\n` +
      `🔬 Tổng mẫu MD5 đã phân tích: <b>${md5Map.length}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `⏰ Key còn: <b>${timeRemaining(key)}</b>`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Cập nhật MD5", "predict_md5")],
        [Markup.button.callback("🎲 DỰ ĐOÁN TỰ ĐỘNG", "predict_auto")],
        [Markup.button.callback("🏠 Menu chính", "main_menu")],
      ])
    );
  } catch (e) {
    console.error("MD5 Predict Error:", e.message);
    ctx.reply("❌ Lỗi kết nối API: " + e.message);
  }
});

bot.action("main_menu", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  ctx.editMessageText(
    "🏠 <b>Menu Chính – S2KING_BOT</b>",
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🎲 DỰ ĐOÁN TỰ ĐỘNG", "predict_auto")],
        [Markup.button.callback("🔍 Dự đoán MD5", "predict_md5")],
        [Markup.button.callback("👤 Tài khoản", "my_account"), Markup.button.callback("💳 Mua Key", "buy_key")],
      ]),
    }
  );
});

bot.action("my_account", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  const key = await storage.getUserKey(ctx.from.id);
  const st = getStats(ctx.from.id);
  const total = st.win + st.loss;
  const winRate = total > 0 ? ((st.win / total) * 100).toFixed(0) : "—";

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
    `🔘 Trạng thái: ${valid ? "✅ Đang hoạt động" : "❌ Hết hạn"}\n\n` +
    `📈 <b>Thống kê:</b>\n` +
    `  🏆 Thắng: <b>${st.win}</b>  |  ❌ Thua: <b>${st.loss}</b>  |  Tỉ lệ: <b>${winRate}%</b>`
  );
});

bot.action("buy_key", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  ctx.replyWithHTML(
    `💳 <b>Bảng Giá Key S2KING_BOT</b>\n\n` +
    `⚡ 5 Giờ — Liên hệ admin\n` +
    `📅 1 Ngày — Liên hệ admin\n` +
    `🗓️ 1 Tuần — Liên hệ admin\n` +
    `💎 1 Tháng — Liên hệ admin\n` +
    `♾️ Vĩnh Viễn — Liên hệ admin\n\n` +
    `📩 Liên hệ <a href="https://t.me/cskh09099">@cskh09099</a> để mua key.`,
    { parse_mode: "HTML", disable_web_page_preview: true }
  );
});

// ─── ADMIN COMMANDS ──────────────────────────────────────────────────────────
bot.command("taokey", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  const uid = parts[1];
  const pkg = parts[2];
  if (!uid || !pkg || !PACKAGES[pkg]) {
    return ctx.reply(
      "Cách dùng: /taokey <user_id|none> <pkg>\n" +
      "Gói: 5h, 1ngay, 1tuan, 1thang, vinhvien\n" +
      "Ví dụ: /taokey none 1ngay\n" +
      "       /taokey 123456789 1tuan"
    );
  }

  const keyText = "SXD-" + crypto.randomBytes(8).toString("hex").toUpperCase();
  const isNone = uid === "none";
  let expire, user_id, activatedNote;

  if (isNone) {
    user_id = null;
    expire = "pending_activation";
    activatedNote = "Bắt đầu đếm khi user kích hoạt";
  } else {
    user_id = uid;
    const hours = PACKAGES[pkg].hours;
    expire = hours ? new Date(Date.now() + hours * 3600 * 1000).toISOString() : "never";
    activatedNote = `Bắt đầu ngay: ${formatExpire(expire)}`;
  }

  await storage.setKey(keyText, {
    user_id,
    pkg,
    expire,
    created: new Date().toISOString(),
    activated: isNone ? null : new Date().toISOString(),
  });

  ctx.replyWithHTML(
    `✅ <b>Tạo Key thành công</b>\n\n` +
    `🔑 Key: <code>${keyText}</code>\n` +
    `📦 Gói: <b>${PACKAGES[pkg].label}</b>\n` +
    `👤 User: <b>${isNone ? "Chưa gắn (user tự kích hoạt bằng /key)" : uid}</b>\n` +
    `⏰ Hết hạn: <b>${activatedNote}</b>`
  );
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
  const userId = ctx.from.id;
  userStats[userId] = { win: 0, loss: 0, lastPrediction: null, lastSessionId: null };
  ctx.reply("✅ Đã reset thống kê thắng/thua của bạn.");
});

bot.command("debug", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  try {
    const resp = await axios.get(API_URL, { timeout: 8000 });
    const list = extractListFromResponse(resp.data);
    const sessions = list.map(normalizeSession).filter(Boolean).sort((a, b) => b.id_num - a.id_num);
    const sample3 = sessions.slice(0, 3).map(s =>
      `#${s.id} → ${s.result} | dice:${s.dice.join(",")} | sum:${s.diceSum} | md5:${s.md5.slice(0, 12)}…`
    ).join("\n");
    ctx.reply(
      `📦 API OK – ${list.length} items, ${sessions.length} phiên parse được\n\n` +
      `3 phiên gần nhất:\n${sample3}`
    );
  } catch (e) {
    ctx.reply("❌ Lỗi: " + e.message);
  }
});

// ─── KHỞI CHẠY ───────────────────────────────────────────────────────────────
const app = express();
app.get("/", (req, res) => res.send("✅ SXD AI Bot v7.0 đang chạy..."));
app.listen(process.env.PORT || 3000, () => console.log("Express server started"));

storage.initDb().then(() => {
  bot.launch().then(() => console.log("✅ Bot SXD AI v7.0 đã sẵn sàng!"));
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));