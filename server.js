"use strict";

// ─── DEPENDENCIES ──────────────────────────────────────────────────────────────
const { Telegraf, Markup } = require("telegraf");
const { message } = require("telegraf/filters");
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// PostgreSQL (optional) – chỉ load nếu có DATABASE_URL
let Pool = null;
let pool = null;
const DATABASE_URL = process.env.DATABASE_URL;
if (DATABASE_URL) {
  try {
    Pool = require("pg").Pool;
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  } catch (e) {
    console.warn("⚠️ Không thể load pg, fallback sang lưu file.");
    pool = null;
  }
}

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Thiếu BOT_TOKEN trong biến môi trường!");
const ADMIN_ID = 7680266707;
const ADMIN_TG = "@cskh09099";
const API_URL = "https://treo-lc79-h6zy.onrender.com/";

// ─── GÓI KEY ──────────────────────────────────────────────────────────────────
const PACKAGES = {
  "5h":      { label: "5 Giờ ⚡",       price: "10.000đ",  hours: 5 },
  "1ngay":   { label: "1 Ngày",          price: "20.000đ",  hours: 24 },
  "1tuan":   { label: "1 Tuần",          price: "50.000đ",  hours: 168 },
  "1nam":    { label: "1 Năm 🔥SALE",    price: "99.000đ",  hours: 8760 },
  "vinhvien":{ label: "Vĩnh Viễn ♾️",   price: "150.000đ", hours: null }, // null = vĩnh viễn
};

// ─── LỚP LƯU TRỮ KEY ─────────────────────────────────────────────────────────
class KeyStorage {
  constructor() {
    this.useDb = !!(pool && DATABASE_URL);
    if (this.useDb) {
      this.initDb().catch(console.error);
    } else {
      this.dataDir = path.join(__dirname, "data");
      this.keyFile = path.join(this.dataDir, "keys.json");
      if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
      console.log("⚠️ Dùng file lưu key. Hãy thêm DATABASE_URL để lưu vĩnh viễn.");
    }
  }

  async initDb() {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS keys (
          key_text TEXT PRIMARY KEY,
          user_id BIGINT,
          pkg TEXT NOT NULL,
          expire TEXT NOT NULL,
          created TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log("✅ Đã kết nối PostgreSQL.");
    } catch (err) {
      console.error("Lỗi tạo bảng keys:", err.message);
      this.useDb = false;
    }
  }

  async loadAll() {
    if (this.useDb) {
      const res = await pool.query("SELECT key_text, user_id, pkg, expire, created FROM keys");
      const obj = {};
      for (const row of res.rows) {
        obj[row.key_text] = {
          user_id: row.user_id ? Number(row.user_id) : null,
          pkg: row.pkg,
          expire: row.expire,
          created: row.created ? row.created.toISOString() : new Date().toISOString(),
        };
      }
      return obj;
    } else {
      try {
        if (fs.existsSync(this.keyFile)) return JSON.parse(fs.readFileSync(this.keyFile, "utf-8"));
      } catch (_) {}
      return {};
    }
  }

  async saveAll(keys) {
    if (this.useDb) {
      // Dùng upsert thay vì DELETE+INSERT để an toàn hơn
      for (const [keyText, val] of Object.entries(keys)) {
        await pool.query(
          `INSERT INTO keys (key_text, user_id, pkg, expire, created)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (key_text) DO UPDATE
           SET user_id=$2, pkg=$3, expire=$4`,
          [keyText, val.user_id || null, val.pkg, val.expire, val.created]
        );
      }
    } else {
      fs.writeFileSync(this.keyFile, JSON.stringify(keys, null, 2), "utf-8");
    }
  }

  async getKey(keyText) {
    if (this.useDb) {
      const res = await pool.query("SELECT * FROM keys WHERE key_text = $1", [keyText]);
      if (!res.rows[0]) return null;
      const row = res.rows[0];
      return {
        key_text: row.key_text,
        user_id: row.user_id ? Number(row.user_id) : null,
        pkg: row.pkg,
        expire: row.expire,
        created: row.created ? row.created.toISOString() : new Date().toISOString(),
      };
    } else {
      const keys = await this.loadAll();
      if (!keys[keyText]) return null;
      return { key_text: keyText, ...keys[keyText] };
    }
  }

  async setKey(keyText, data) {
    if (this.useDb) {
      await pool.query(
        `INSERT INTO keys (key_text, user_id, pkg, expire, created)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key_text) DO UPDATE
         SET user_id=$2, pkg=$3, expire=$4`,
        [keyText, data.user_id || null, data.pkg, data.expire, data.created]
      );
    } else {
      const keys = await this.loadAll();
      keys[keyText] = data;
      await this.saveAll(keys);
    }
  }

  async deleteKey(keyText) {
    if (this.useDb) {
      await pool.query("DELETE FROM keys WHERE key_text = $1", [keyText]);
    } else {
      const keys = await this.loadAll();
      delete keys[keyText];
      await this.saveAll(keys);
    }
  }

  async getUserKey(userId) {
    const uid = Number(userId);
    if (this.useDb) {
      const res = await pool.query("SELECT * FROM keys WHERE user_id = $1 ORDER BY created DESC LIMIT 1", [uid]);
      if (!res.rows[0]) return null;
      const row = res.rows[0];
      return {
        key_text: row.key_text,
        user_id: Number(row.user_id),
        pkg: row.pkg,
        expire: row.expire,
        created: row.created ? row.created.toISOString() : new Date().toISOString(),
      };
    } else {
      const keys = await this.loadAll();
      for (const [k, v] of Object.entries(keys)) {
        if (Number(v.user_id) === uid) return { key_text: k, ...v };
      }
      return null;
    }
  }

  async deleteUserKeys(userId) {
    const uid = Number(userId);
    if (this.useDb) {
      await pool.query("DELETE FROM keys WHERE user_id = $1", [uid]);
    } else {
      const keys = await this.loadAll();
      const newKeys = Object.fromEntries(
        Object.entries(keys).filter(([, v]) => Number(v.user_id) !== uid)
      );
      await this.saveAll(newKeys);
    }
  }
}

const storage = new KeyStorage();

// ─── KEY HELPERS ──────────────────────────────────────────────────────────────
function genKey(length = 20) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "SXD-";
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

async function createKey(userId, pkg) {
  await storage.deleteUserKeys(userId);
  const info = PACKAGES[pkg];
  const newKey = genKey();
  // FIX: vinhvien => expire = "never", các gói có giờ => tính đúng thời hạn
  const expire = info.hours === null
    ? "never"
    : new Date(Date.now() + info.hours * 3600 * 1000).toISOString();
  await storage.setKey(newKey, {
    user_id: Number(userId),
    pkg,
    expire,
    created: new Date().toISOString(),
  });
  return { key: newKey, expire };
}

// FIX KEY EXPIRY: so sánh chính xác với Date.now()
function isKeyValid(keyInfo) {
  if (!keyInfo) return false;
  if (keyInfo.expire === "never") return true;
  // Dùng Date.now() để tránh lỗi timezone
  return new Date(keyInfo.expire).getTime() > Date.now();
}

async function validateKey(userId) {
  const keyInfo = await storage.getUserKey(Number(userId));
  return isKeyValid(keyInfo);
}

async function getUserKeyInfo(userId) {
  const keyInfo = await storage.getUserKey(Number(userId));
  if (!keyInfo) return null;
  return {
    key: keyInfo.key_text,
    user_id: keyInfo.user_id,
    pkg: keyInfo.pkg,
    expire: keyInfo.expire,
    valid: isKeyValid(keyInfo),
  };
}

function formatExpire(expire) {
  if (expire === "never") return "♾️ Vĩnh viễn";
  const d = new Date(expire);
  return d.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

function timeLeftStr(expire) {
  if (expire === "never") return "♾️ Vĩnh viễn";
  const ms = new Date(expire).getTime() - Date.now();
  if (ms <= 0) return "⏰ Đã hết hạn";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 24) {
    const days = Math.floor(h / 24);
    const remH = h % 24;
    return `${days} ngày ${remH} giờ`;
  }
  return `${h} giờ ${m} phút`;
}

// ─── CACHE API (tránh gọi liên tục) ──────────────────────────────────────────
let apiCache = { data: null, ts: 0 };
const CACHE_TTL = 8000; // 8 giây

async function fetchApiData() {
  const now = Date.now();
  if (apiCache.data && (now - apiCache.ts) < CACHE_TTL) {
    return apiCache.data;
  }
  try {
    const resp = await axios.get(API_URL, {
      timeout: 12000,
      headers: { "Accept": "application/json", "User-Agent": "SXDBot/2.0" },
    });
    const raw = resp.data;
    // Parse và chuẩn hoá cấu trúc API
    const parsed = parseApiResponse(raw);
    apiCache = { data: parsed, ts: now };
    return parsed;
  } catch (e) {
    console.error("API Error:", e.message);
    return { error: e.message };
  }
}

// ─── PARSE API RESPONSE – TỰ ĐỘNG NHẬN DẠNG CẤU TRÚC ─────────────────────────
function parseApiResponse(raw) {
  if (!raw || typeof raw !== "object") return { error: "API trả về dữ liệu không hợp lệ" };

  // Thử các cấu trúc phổ biến của API sxd/tài xỉu
  let sessions = [];
  let latestSession = null;

  // Cấu trúc 1: { data: [...] }
  if (Array.isArray(raw.data)) {
    sessions = raw.data;
  }
  // Cấu trúc 2: { history: [...], latest: {...} }
  else if (Array.isArray(raw.history)) {
    sessions = raw.history;
    latestSession = raw.latest || raw.history[0];
  }
  // Cấu trúc 3: Array trực tiếp
  else if (Array.isArray(raw)) {
    sessions = raw;
  }
  // Cấu trúc 4: { list: [...] }
  else if (Array.isArray(raw.list)) {
    sessions = raw.list;
  }
  // Cấu trúc 5: { result: [...] }
  else if (Array.isArray(raw.result) && raw.result.length > 0 && typeof raw.result[0] === "object") {
    sessions = raw.result;
  }
  // Cấu trúc 6: { sessions: [...] }
  else if (Array.isArray(raw.sessions)) {
    sessions = raw.sessions;
  }
  else {
    // Không tìm thấy mảng phiên – thử dùng raw trực tiếp như 1 phiên
    sessions = [];
    latestSession = raw;
  }

  // Nếu chưa có latestSession, lấy phần tử đầu (mới nhất)
  if (!latestSession && sessions.length > 0) {
    latestSession = sessions[0];
  }

  // Chuẩn hoá từng phiên
  const normalizedSessions = sessions.slice(0, 50).map(s => normalizeSession(s)).filter(Boolean);

  return {
    raw,
    latest: latestSession ? normalizeSession(latestSession) : null,
    sessions: normalizedSessions,
    prediction: raw.prediction || raw.predict || null,
    confidence: raw.confidence || raw.acc || null,
    tai: raw.tai || raw.over || null,
    xiu: raw.xiu || raw.under || null,
  };
}

// Chuẩn hoá 1 phiên thành { id, diceSum, dice, result, md5 }
// NGƯỠNG ĐÚNG: 3-10 = XỈU, 11-18 = TÀI
function normalizeSession(s) {
  if (!s || typeof s !== "object") return null;

  // ID phiên
  const id = s.phien || s.id || s.session || s.session_id || s.round || s.issue || s.no || s._id || "N/A";

  // ── BƯỚC 1: Tính tổng xúc xắc từ giá trị thực ──────────────────────────────
  let dice = null;
  let diceSum = 0;
  let hasDice = false;

  if (Array.isArray(s.dices) && s.dices.length >= 3) {
    const d = s.dices.slice(0, 3).map(Number);
    if (d.every(n => n >= 1 && n <= 6)) {
      dice = d; diceSum = d[0] + d[1] + d[2]; hasDice = true;
    }
  } else if (Array.isArray(s.dice) && s.dice.length >= 3) {
    const d = s.dice.slice(0, 3).map(Number);
    if (d.every(n => n >= 1 && n <= 6)) {
      dice = d; diceSum = d[0] + d[1] + d[2]; hasDice = true;
    }
  } else if (Array.isArray(s.openCode)) {
    const nums = s.openCode.map(Number).filter(n => n >= 1 && n <= 6);
    if (nums.length >= 3) { dice = nums.slice(0, 3); diceSum = dice[0]+dice[1]+dice[2]; hasDice = true; }
  } else if (typeof s.open_code === "string") {
    const nums = s.open_code.split(",").map(Number).filter(n => n >= 1 && n <= 6);
    if (nums.length >= 3) { dice = nums.slice(0, 3); diceSum = dice[0]+dice[1]+dice[2]; hasDice = true; }
  }

  // Fallback: dùng tổng điểm từ field khác (chỉ khi không có dice)
  if (!hasDice) {
    const fallbackSum = Number(s.point || s.diceTotal || s.total || s.sum || s.score || 0);
    if (fallbackSum >= 3 && fallbackSum <= 18) {
      diceSum = fallbackSum;
    }
  }

  // ── BƯỚC 2: Xác định kết quả – ƯU TIÊN TÍNH TỪ DICE THỰC TẾ ──────────────
  // Nếu có dice hoặc tổng hợp lệ (3-18), tính từ tổng → CHÍNH XÁC TUYỆT ĐỐI
  // KHÔNG dùng result string của API khi có dice (API hay trả sai)
  let result = null;

  if (diceSum >= 3 && diceSum <= 18) {
    // Luật tài xỉu chuẩn: 11-18 = TÀI, 3-10 = XỈU
    result = diceSum >= 11 ? "TAI" : "XIU";
  } else {
    // Chỉ fallback vào result string khi hoàn toàn không có thông tin điểm
    if (typeof s.result === "string") {
      const r = s.result.toUpperCase();
      if (r === "TAI" || r === "TÀI" || r === "OVER" || r === "BIG" || r === "T" || r === "1") result = "TAI";
      else if (r === "XIU" || r === "XỈU" || r === "UNDER" || r === "SMALL" || r === "X" || r === "0") result = "XIU";
    }
    if (!result && typeof s.res === "string") {
      const r = s.res.toUpperCase();
      if (r === "TAI" || r === "1") result = "TAI";
      else result = "XIU";
    }
  }

  // MD5
  const md5 = s.md5 || s.hash || s.verify_hash || s.hashValue || s.verifyHash || null;

  if (!result) return null;

  return { id: String(id), diceSum, dice, result, md5: md5 ? String(md5).toLowerCase() : null };
}

// ─── PHÂN TÍCH LỊCH SỬ: BẺ CẦU / THEO CẦU THÔNG MINH ────────────────────────
function analyzeHistory(sessions) {
  if (!sessions || sessions.length === 0) {
    return {
      result: Math.random() < 0.5 ? "TÀI" : "XỈU",
      confidence: 52,
      reason: "Chưa có đủ dữ liệu",
      tai_rate: 50, xiu_rate: 50,
      streak: 0, streakType: null,
    };
  }

  const results = sessions.map(s => s.result).filter(Boolean); // ['TAI','XIU',...]
  if (results.length === 0) {
    return { result: "TÀI", confidence: 52, reason: "Không đọc được kết quả", tai_rate: 50, xiu_rate: 50, streak: 0, streakType: null };
  }

  const taiCount = results.filter(r => r === "TAI").length;
  const xiuCount = results.filter(r => r === "XIU").length;
  const total = results.length;
  const taiRate = (taiCount / total) * 100;
  const xiuRate = (xiuCount / total) * 100;

  // Tính streak hiện tại (từ kết quả mới nhất)
  let streak = 1;
  const streakType = results[0]; // kết quả mới nhất
  for (let i = 1; i < results.length; i++) {
    if (results[i] === streakType) streak++;
    else break;
  }

  // Phân tích cầu ngắn (5 phiên gần nhất)
  const recent5 = results.slice(0, 5);
  const recentTai = recent5.filter(r => r === "TAI").length;

  // Phân tích điểm xúc xắc
  const diceSums = sessions.map(s => s.diceSum).filter(s => s > 0);
  const avgSum = diceSums.length > 0 ? diceSums.reduce((a, b) => a + b, 0) / diceSums.length : 10.5;

  let prediction, confidence, reason;

  // ── LOGIC DỰ ĐOÁN ────────────────────────────────────────────────────────
  if (streak >= 6) {
    // Cầu cực dài → bẻ mạnh
    prediction = streakType === "TAI" ? "XỈU" : "TÀI";
    confidence = Math.min(85 + streak - 6, 92);
    reason = `🔀 Bẻ cầu mạnh – ${streakType === "TAI" ? "Tài" : "Xỉu"} đã xuất hiện <b>${streak} lần liên tiếp</b>`;
  } else if (streak >= 4) {
    // Cầu dài → khả năng bẻ cao
    prediction = streakType === "TAI" ? "XỈU" : "TÀI";
    confidence = 75 + streak;
    reason = `🔀 Bẻ cầu – ${streakType === "TAI" ? "Tài" : "Xỉu"} đã chạy <b>${streak} phiên</b>, xác suất đổi chiều cao`;
  } else if (streak >= 3) {
    // Cầu trung bình – xem thêm tỷ lệ tổng
    if (Math.abs(taiRate - xiuRate) > 25) {
      // Tỷ lệ mất cân bằng nhiều → bẻ về bên kém hơn
      prediction = taiRate > xiuRate ? "XỈU" : "TÀI";
      confidence = 70 + Math.min(Math.abs(taiRate - xiuRate) / 4, 12);
      reason = `⚖️ Bẻ cầu + cân bằng – ${streakType === "TAI" ? "Tài" : "Xỉu"} đang chiếm ưu thế quá cao (${taiRate.toFixed(0)}%/${xiuRate.toFixed(0)}%)`;
    } else {
      // Theo xác suất điểm xúc xắc
      if (avgSum > 11.2) {
        prediction = "XỈU";
        confidence = 68;
        reason = `🎲 Bẻ cầu – cầu ${streakType === "TAI" ? "Tài" : "Xỉu"} ${streak} phiên, điểm trung bình ${avgSum.toFixed(1)} đang chệch về Tài`;
      } else if (avgSum < 9.8) {
        prediction = "TÀI";
        confidence = 68;
        reason = `🎲 Bẻ cầu – điểm trung bình ${avgSum.toFixed(1)} đang chệch về Xỉu, dự đoán đảo chiều`;
      } else {
        prediction = streakType === "TAI" ? "XỈU" : "TÀI";
        confidence = 65;
        reason = `🔀 Bẻ cầu nhẹ – ${streakType === "TAI" ? "Tài" : "Xỉu"} đã chạy ${streak} phiên liên tiếp`;
      }
    }
  } else if (streak === 2) {
    // Cầu ngắn – phân tích kỹ hơn
    if (recentTai === 4 || recentTai === 5) {
      // 5 phiên gần đây thiên Tài nhiều
      prediction = "XỈU";
      confidence = 63;
      reason = `📊 Phân tích 5 phiên: Tài chiếm ${recentTai}/5, dự đoán về Xỉu`;
    } else if (recentTai === 0 || recentTai === 1) {
      prediction = "TÀI";
      confidence = 63;
      reason = `📊 Phân tích 5 phiên: Xỉu chiếm ${5 - recentTai}/5, dự đoán về Tài`;
    } else if (Math.abs(taiRate - xiuRate) > 20) {
      prediction = taiRate > xiuRate ? "XỈU" : "TÀI";
      confidence = 62 + Math.min(Math.abs(taiRate - xiuRate) / 5, 10);
      reason = `⚖️ Cân bằng lịch sử – Tài:${taiRate.toFixed(0)}% Xỉu:${xiuRate.toFixed(0)}%, chọn bên thấp hơn`;
    } else {
      // Theo cầu hiện tại khi cầu ngắn và tỷ lệ cân bằng
      prediction = streakType;
      confidence = 58;
      reason = `➡️ Theo cầu ngắn – ${streakType === "TAI" ? "Tài" : "Xỉu"} đang cầu ${streak}, tỷ lệ cân bằng`;
    }
  } else {
    // Streak = 1, phân tích toàn bộ
    if (Math.abs(taiRate - xiuRate) > 30) {
      prediction = taiRate > xiuRate ? "XỈU" : "TÀI";
      confidence = 65 + Math.min(Math.abs(taiRate - xiuRate) / 4, 15);
      reason = `⚖️ Mất cân bằng rõ rệt – Tài:${taiRate.toFixed(0)}% Xỉu:${xiuRate.toFixed(0)}%`;
    } else if (recentTai >= 4) {
      prediction = "XỈU";
      confidence = 60;
      reason = `📊 5 phiên gần: Tài ${recentTai}/5 – chọn Xỉu`;
    } else if (recentTai <= 1) {
      prediction = "TÀI";
      confidence = 60;
      reason = `📊 5 phiên gần: Xỉu ${5-recentTai}/5 – chọn Tài`;
    } else {
      // Theo xu hướng điểm
      prediction = avgSum > 10.5 ? "XỈU" : "TÀI";
      confidence = 56;
      reason = `🎲 Điểm trung bình ${avgSum.toFixed(1)} – dự đoán ${avgSum > 10.5 ? "Xỉu" : "Tài"}`;
    }
  }

  confidence = Math.min(Math.round(confidence), 92);
  return {
    result: prediction,
    confidence,
    reason,
    tai_rate: Math.round(taiRate * 10) / 10,
    xiu_rate: Math.round(xiuRate * 10) / 10,
    streak,
    streakType,
  };
}

// ─── DỰ ĐOÁN MD5 THÔNG MINH (dùng toàn bộ lịch sử MD5+kết quả) ─────────────
function md5PredictSmart(inputMd5, sessions) {
  const h = inputMd5.trim().toLowerCase();
  if (h.length !== 32 || !/^[0-9a-f]+$/.test(h)) {
    return { error: "Mã MD5 không hợp lệ (cần 32 ký tự hex)" };
  }

  // 1. Tính các đặc trưng của MD5 đầu vào
  const bytes = [];
  for (let i = 0; i < 32; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
  const byteSum = bytes.reduce((a, b) => a + b, 0);
  const last4 = parseInt(h.slice(28, 32), 16);
  const first4 = parseInt(h.slice(0, 4), 16);
  const mid4 = parseInt(h.slice(14, 18), 16);
  const parity = byteSum % 2 === 0 ? "Chẵn" : "Lẻ";

  // Tần suất ký tự hex
  const freq = {};
  for (const c of h) freq[c] = (freq[c] || 0) + 1;
  const entropy = -Object.values(freq).map(f => { const p = f/32; return p * Math.log2(p); }).reduce((a,b)=>a+b,0);

  // 2. Tìm các MD5 trong lịch sử có đặc điểm tương tự
  let matchScore = { TAI: 0, XIU: 0, total: 0 };

  if (sessions && sessions.length > 0) {
    for (const s of sessions) {
      if (!s.md5 || !s.result || s.md5.length !== 32) continue;
      const sh = s.md5.toLowerCase();

      // Tính độ tương đồng MD5
      const sBytes = [];
      for (let i = 0; i < 32; i += 2) sBytes.push(parseInt(sh.slice(i, i + 2), 16));
      const sByteSum = sBytes.reduce((a, b) => a + b, 0);
      const sLast4 = parseInt(sh.slice(28, 32), 16);

      // Trọng số tương đồng dựa trên nhiều đặc trưng
      let sim = 0;
      // Parity giống nhau
      if (sByteSum % 2 === byteSum % 2) sim += 2;
      // Khoảng tổng byte gần nhau (±20)
      if (Math.abs(sByteSum - byteSum) <= 20) sim += 3;
      if (Math.abs(sByteSum - byteSum) <= 10) sim += 2;
      // last4 gần nhau
      if (Math.abs(sLast4 - last4) <= 500) sim += 2;
      // Ký tự đầu giống
      if (sh[0] === h[0]) sim += 1;
      if (sh.slice(0, 3) === h.slice(0, 3)) sim += 2;
      // Cùng nhóm tổng (< 128 hay >= 128)
      if ((sByteSum >= 128) === (byteSum >= 128)) sim += 1;

      if (sim >= 4) {
        const weight = sim;
        matchScore.total += weight;
        if (s.result === "TAI") matchScore.TAI += weight;
        else matchScore.XIU += weight;
      }
    }
  }

  // 3. Tính xác suất từ dữ liệu lịch sử tương đồng
  let taiProb = 0.5;
  let dataConfidence = 0;
  let method = "formula";

  if (matchScore.total >= 20) {
    // Đủ dữ liệu tương đồng → tin vào pattern lịch sử
    taiProb = matchScore.TAI / matchScore.total;
    dataConfidence = Math.min(matchScore.total / 2, 25); // max +25 từ data
    method = "history";
  } else if (matchScore.total >= 8) {
    // Dữ liệu ít → pha trộn 50/50 với pattern
    const histProb = matchScore.TAI / matchScore.total;
    taiProb = histProb * 0.6 + 0.5 * 0.4;
    dataConfidence = matchScore.total;
    method = "hybrid";
  }

  // 4. Điều chỉnh bởi công thức MD5
  // byteSum range: 0–3570, mid ~1785
  const formulaAdj = ((byteSum - 1785) / 1785) * 0.15;
  // last4 range: 0–65535
  const last4Adj = ((last4 - 32768) / 65536) * 0.08;
  // entropy: cao = gần 50/50, thấp = thiên về 1 phía
  const entropyAdj = (entropy - 3.5) * 0.02;

  let finalProb;
  if (method === "history") {
    finalProb = taiProb * 0.75 + (0.5 + formulaAdj + last4Adj) * 0.25;
  } else if (method === "hybrid") {
    finalProb = taiProb * 0.5 + (0.5 + formulaAdj + last4Adj + entropyAdj) * 0.5;
  } else {
    finalProb = 0.5 + formulaAdj + last4Adj + entropyAdj;
  }

  finalProb = Math.min(0.88, Math.max(0.12, finalProb));

  const isTai = finalProb >= 0.5;
  const result = isTai ? "TÀI 🎲" : "XỈU 🎯";
  const distFromCenter = Math.abs(finalProb - 0.5);
  let confidence = Math.round(50 + distFromCenter * 80 + dataConfidence);
  confidence = Math.min(confidence, 92);
  const trend = confidence >= 75 ? "💪 Mạnh" : confidence >= 62 ? "🔶 Trung bình" : "🔷 Yếu";

  let methodLabel;
  if (method === "history") methodLabel = `Khớp ${Math.round(matchScore.total)} điểm từ lịch sử`;
  else if (method === "hybrid") methodLabel = `Kết hợp lịch sử + thuật toán`;
  else methodLabel = "Phân tích thuật toán MD5";

  return {
    result, confidence, trend,
    entropy: Math.round(entropy * 100) / 100,
    parity,
    taiProb: Math.round(finalProb * 100),
    method: methodLabel,
    histMatches: matchScore.total > 0 ? Math.round(matchScore.total) : 0,
  };
}

// ─── LẤY DỰ ĐOÁN API ─────────────────────────────────────────────────────────
async function getApiPrediction() {
  const data = await fetchApiData();
  if (data.error) return { error: data.error };

  const latest = data.latest;
  if (!latest) return { error: "API chưa có dữ liệu phiên" };

  const phienId = latest.id || "N/A";
  const ketQuaRaw = latest.result; // "TAI" hoặc "XIU"
  const ketQuaDisplay = ketQuaRaw === "TAI" ? "TÀI 🎲" : ketQuaRaw === "XIU" ? "XỈU 🎯" : "N/A";

  let diceStr = "N/A";
  if (latest.dice && latest.dice.length >= 3) {
    diceStr = `${latest.dice[0]}-${latest.dice[1]}-${latest.dice[2]} (Tổng: ${latest.diceSum})`;
  } else if (latest.diceSum) {
    diceStr = `Tổng: ${latest.diceSum}`;
  }

  // Phiên tiếp theo
  const phienNum = parseInt(String(phienId).replace(/\D/g, ""), 10);
  const phienMoi = isNaN(phienNum) ? `${phienId}+1` : String(phienNum + 1);

  // Phân tích dự đoán
  let duDoan, confidence, reason, taiRate = 50, xiuRate = 50, streak = 0, streakType = null;

  // Ưu tiên prediction từ API (nếu có và hợp lệ)
  const apiPredRaw = data.prediction;
  const apiConf = data.confidence;
  const hasApiPred = apiPredRaw &&
    typeof apiPredRaw === "string" &&
    !["ĐANG HỌC", "UNKNOWN", "N/A", ""].includes(apiPredRaw.toUpperCase()) &&
    typeof apiConf === "number" && apiConf > 0;

  if (hasApiPred) {
    const ap = apiPredRaw.toUpperCase();
    duDoan = (ap === "TAI" || ap === "TÀI") ? "TÀI 🎲" : "XỈU 🎯";
    confidence = Math.min(apiConf, 92);
    reason = `🤖 Hệ thống AI (độ chính xác ${apiConf}%)`;
    if (typeof data.tai === "number") taiRate = data.tai;
    if (typeof data.xiu === "number") xiuRate = data.xiu;
  } else {
    // Dùng phân tích lịch sử
    const analysis = analyzeHistory(data.sessions);
    duDoan = analysis.result === "TÀI" ? "TÀI 🎲" : "XỈU 🎯";
    confidence = analysis.confidence;
    reason = analysis.reason;
    taiRate = analysis.tai_rate;
    xiuRate = analysis.xiu_rate;
    streak = analysis.streak;
    streakType = analysis.streakType;
  }

  // Xây dựng thông tin streak để hiển thị
  let streakInfo = "";
  if (streak >= 2 && streakType) {
    const sLabel = streakType === "TAI" ? "Tài" : "Xỉu";
    const arrow = streakType === "TAI" ? "🔴" : "⚪";
    streakInfo = `\n${arrow} Cầu hiện tại: ${sLabel} x${streak}`;
  }

  return {
    phien: phienId,
    ket_qua: ketQuaDisplay,
    xuc_xac: diceStr,
    phien_moi: phienMoi,
    du_doan: duDoan,
    confidence: Math.floor(confidence),
    reason,
    tai_rate: taiRate,
    xiu_rate: xiuRate,
    streak_info: streakInfo,
    sessions_count: data.sessions ? data.sessions.length : 0,
  };
}

// ─── BÀN PHÍM ─────────────────────────────────────────────────────────────────
const mainMenuKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback("🎲 Dự đoán bằng API", "predict_api")],
    [Markup.button.callback("🔐 Dự đoán bằng MD5", "predict_md5")],
    [Markup.button.callback("🔑 Nhập Key sử dụng", "enter_key")],
    [Markup.button.callback("💳 Bảng giá / Mua Key", "buy_key")],
    [Markup.button.callback("👤 Thông tin tài khoản", "my_account")],
  ]);

const packagesKeyboard = () => {
  const rows = Object.entries(PACKAGES).map(([id, info]) => [
    Markup.button.callback(`${info.label} – ${info.price}`, `buy_${id}`),
  ]);
  rows.push([Markup.button.callback("⬅️ Quay lại", "main_menu")]);
  return Markup.inlineKeyboard(rows);
};

const backKeyboard = (target = "main_menu") =>
  Markup.inlineKeyboard([[Markup.button.callback("⬅️ Quay lại", target)]]);

const userStates = new Map();

// ─── BOT ──────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  const first = ctx.from.first_name || ctx.from.firstName || "bạn";
  await ctx.replyWithHTML(
    `👋 Chào mừng <b>${first}</b> đến với <b>SXD Prediction Bot</b>!\n\n` +
    `🎯 Bot dự đoán Tài/Xỉu thông minh:\n` +
    `  • 📡 Phân tích cầu thời gian thực từ API\n` +
    `  • 🔐 Thuật toán phân tích mã MD5 thông minh\n\n` +
    `⚠️ Cần có <b>Key</b> để sử dụng tính năng dự đoán.\n` +
    `👇 Chọn tính năng bên dưới:`,
    mainMenuKeyboard()
  );
});

bot.command("cancel", async (ctx) => {
  userStates.delete(ctx.from.id);
  await ctx.replyWithHTML("❌ Đã huỷ.", mainMenuKeyboard());
});

// ─── ADMIN COMMANDS ───────────────────────────────────────────────────────────
bot.command("taokey", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply("⛔ Bạn không có quyền.");
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 3) return ctx.reply(
    "⚠️ Cú pháp: /taokey <user_id> <gói>\nGói: 5h, 1ngay, 1tuan, 1nam, vinhvien"
  );
  const userId = parseInt(parts[1]);
  if (isNaN(userId)) return ctx.reply("❌ user_id phải là số.");
  const pkg = parts[2];
  if (!PACKAGES[pkg]) return ctx.reply(`❌ Gói không hợp lệ. Các gói: ${Object.keys(PACKAGES).join(", ")}`);

  const { key: newKey, expire } = await createKey(userId, pkg);
  const info = PACKAGES[pkg];
  const expireStr = formatExpire(expire);

  try {
    await ctx.telegram.sendMessage(
      userId,
      `🎉 <b>Bạn đã được cấp Key!</b>\n\n📦 Gói: ${info.label}\n🔑 Key: <code>${newKey}</code>\n⏰ Hết hạn: ${expireStr}\n\n👉 Nhấn /start → <b>Nhập Key</b> để kích hoạt.`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    console.warn("Không gửi được tin nhắn cho user:", err.message);
  }
  await ctx.replyWithHTML(
    `✅ Đã tạo Key cho user <code>${userId}</code>\n🔑 Key: <code>${newKey}</code>\n📦 Gói: ${info.label}\n⏰ Hết hạn: ${expireStr}`
  );
});

bot.command("listkeys", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const keys = await storage.loadAll();
  const entries = Object.entries(keys);
  if (!entries.length) return ctx.reply("Chưa có key nào.");
  const lines = ["<b>📋 Danh sách Key</b>"];
  for (const [k, v] of entries.slice(0, 30)) {
    const kObj = { expire: v.expire };
    const active = isKeyValid(kObj);
    const left = active ? timeLeftStr(v.expire) : "HẾT HẠN";
    lines.push(`${active ? "✅" : "❌"} <code>${k}</code>\nUID:${v.user_id} | ${v.pkg} | ${left}`);
  }
  await ctx.replyWithHTML(lines.join("\n\n"));
});

bot.command("delkey", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply("Dùng: /delkey <KEY>");
  const key = parts[1];
  const existing = await storage.getKey(key);
  if (existing) {
    await storage.deleteKey(key);
    await ctx.reply(`✅ Đã xoá key: ${key}`);
  } else {
    await ctx.reply("❌ Không tìm thấy key.");
  }
});

bot.command("broadcast", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const idx = ctx.message.text.indexOf(" ");
  if (idx === -1) return ctx.reply("Dùng: /broadcast <nội dung>");
  const msg = ctx.message.text.slice(idx + 1);
  const keys = await storage.loadAll();
  const uids = new Set(Object.values(keys).map(v => v.user_id).filter(Boolean));
  let ok = 0, fail = 0;
  for (const uid of uids) {
    try { await ctx.telegram.sendMessage(uid, `📢 ${msg}`); ok++; }
    catch (_) { fail++; }
  }
  await ctx.reply(`✅ Gửi OK: ${ok} | Thất bại: ${fail}`);
});

// Lệnh test API cho admin
bot.command("testapi", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await ctx.reply("⏳ Đang kiểm tra API...");
  const data = await fetchApiData();
  if (data.error) return ctx.reply(`❌ Lỗi: ${data.error}`);
  const info = [
    `✅ API OK`,
    `📊 Số phiên đọc được: ${data.sessions ? data.sessions.length : 0}`,
    `📌 Phiên mới nhất: ${data.latest ? data.latest.id : "N/A"}`,
    `🎲 Kết quả: ${data.latest ? data.latest.result : "N/A"}`,
    `🔐 Có MD5: ${data.sessions ? data.sessions.filter(s => s.md5).length : 0} phiên`,
    `🤖 API prediction: ${data.prediction || "N/A"}`,
  ];
  await ctx.reply(info.join("\n"));
});

// ─── CALLBACK QUERIES ─────────────────────────────────────────────────────────
bot.on("callback_query", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) { return; }
  const data = ctx.callbackQuery.data;
  const userId = ctx.from.id;

  if (data === "main_menu") {
    userStates.delete(userId);
    try {
      await ctx.editMessageText("🏠 <b>Menu chính</b>\nChọn tính năng:", {
        parse_mode: "HTML", ...mainMenuKeyboard(),
      });
    } catch (_) {
      await ctx.replyWithHTML("🏠 Menu chính", mainMenuKeyboard());
    }
    return;
  }

  if (data === "my_account") {
    const info = await getUserKeyInfo(userId);
    let text;
    if (info) {
      text =
        `👤 <b>Tài khoản của bạn</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🔑 Key: <code>${info.key}</code>\n` +
        `📦 Gói: ${PACKAGES[info.pkg]?.label || info.pkg}\n` +
        `⏰ Hết hạn: ${formatExpire(info.expire)}\n` +
        `⏳ Còn lại: ${timeLeftStr(info.expire)}\n` +
        `✅ Trạng thái: ${info.valid ? "🟢 Còn hạn" : "🔴 Hết hạn"}\n` +
        `━━━━━━━━━━━━━━━━━━━━`;
    } else {
      text = "❌ Bạn chưa có Key.\n\n💡 Nhấn <b>Mua Key</b> để đăng ký gói dùng thử.";
    }
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...backKeyboard() });
    } catch (_) {
      await ctx.replyWithHTML(text, backKeyboard());
    }
    return;
  }

  if (data === "buy_key") {
    const text =
      `💳 <b>Bảng giá Key</b>\n\n` +
      `⚡ 5 Giờ – 10.000đ\n` +
      `📅 1 Ngày – 20.000đ\n` +
      `📆 1 Tuần – 50.000đ\n` +
      `🔥 1 Năm – 99.000đ\n` +
      `♾️ Vĩnh Viễn – 150.000đ\n\n` +
      `👇 Chọn gói muốn mua:`;
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...packagesKeyboard() });
    } catch (_) {
      await ctx.replyWithHTML(text, packagesKeyboard());
    }
    return;
  }

  if (data.startsWith("buy_")) {
    const pkg = data.slice(4);
    if (!PACKAGES[pkg]) return;
    const info = PACKAGES[pkg];
    const text =
      `💰 <b>Gói: ${info.label}</b>\n` +
      `💵 Giá: ${info.price}\n\n` +
      `📌 Liên hệ Admin ${ADMIN_TG} để mua Key.\n` +
      `Sau khi thanh toán, admin sẽ cấp Key cho bạn.`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.url("📩 Liên hệ Admin", `https://t.me/${ADMIN_TG.slice(1)}`)],
      [Markup.button.callback("⬅️ Quay lại bảng giá", "buy_key")],
      [Markup.button.callback("🏠 Menu chính", "main_menu")],
    ]);
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...kb });
    } catch (_) {
      await ctx.replyWithHTML(text, kb);
    }
    return;
  }

  if (data === "enter_key") {
    userStates.set(userId, "waiting_key");
    const text = "🔑 <b>Nhập Key</b>\n\nGửi Key của bạn (dạng SXD-XXXX...):";
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...backKeyboard() });
    } catch (_) {
      await ctx.replyWithHTML(text, backKeyboard());
    }
    return;
  }

  if (data === "predict_api") {
    const valid = await validateKey(userId);
    if (!valid) {
      const info = await getUserKeyInfo(userId);
      const isExpired = info && !info.valid;
      const text = isExpired
        ? `⏰ <b>Key của bạn đã hết hạn!</b>\n\nVui lòng mua gói mới để tiếp tục sử dụng.`
        : `🔒 <b>Bạn cần Key để dự đoán.</b>\n\nMua Key để trải nghiệm đầy đủ tính năng.`;
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback("💳 Mua Key", "buy_key")],
        [Markup.button.callback("🔑 Nhập Key", "enter_key")],
        [Markup.button.callback("⬅️ Quay lại", "main_menu")],
      ]);
      try { await ctx.editMessageText(text, { parse_mode: "HTML", ...kb }); }
      catch (_) { await ctx.replyWithHTML(text, kb); }
      return;
    }
    try { await ctx.editMessageText("⏳ Đang lấy dữ liệu mới nhất từ API..."); } catch (_) {}
    const pred = await getApiPrediction();
    if (pred.error) {
      const text = `❌ <b>Lỗi kết nối API</b>\n\n${pred.error}\n\n💡 Thử lại sau vài giây.`;
      try { await ctx.editMessageText(text, { parse_mode: "HTML", ...backKeyboard() }); }
      catch (_) { await ctx.replyWithHTML(text, backKeyboard()); }
      return;
    }
    const emoji = pred.du_doan.startsWith("TÀI") ? "🔴" : "⚪";
    const confBar = "█".repeat(Math.floor(pred.confidence / 10)) + "░".repeat(10 - Math.floor(pred.confidence / 10));
    const msg =
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📌 Phiên: <b>${pred.phien}</b>\n` +
      `🎲 Kết quả: <b>${pred.ket_qua}</b>\n` +
      `🎯 Xúc xắc: ${pred.xuc_xac}` +
      `${pred.streak_info}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🆕 Phiên mới: <b>${pred.phien_moi}</b>\n` +
      `${emoji} Dự đoán: <b>${pred.du_doan}</b>\n` +
      `📊 Tin cậy: [${confBar}] ${pred.confidence}%\n` +
      `💡 ${pred.reason}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📈 Tài: ${pred.tai_rate}% | Xỉu: ${pred.xiu_rate}%\n` +
      `📂 Phân tích từ ${pred.sessions_count} phiên`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("🔄 Cập nhật", "predict_api")],
      [Markup.button.callback("🏠 Menu", "main_menu")],
    ]);
    try { await ctx.editMessageText(msg, { parse_mode: "HTML", ...kb }); }
    catch (_) { await ctx.replyWithHTML(msg, kb); }
    return;
  }

  if (data === "predict_md5") {
    const valid = await validateKey(userId);
    if (!valid) {
      const info = await getUserKeyInfo(userId);
      const isExpired = info && !info.valid;
      const text = isExpired
        ? `⏰ <b>Key đã hết hạn!</b>\nVui lòng mua gói mới.`
        : `🔒 Cần Key để dự đoán MD5.`;
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback("💳 Mua Key", "buy_key")],
        [Markup.button.callback("🔑 Nhập Key", "enter_key")],
        [Markup.button.callback("⬅️ Quay lại", "main_menu")],
      ]);
      try { await ctx.editMessageText(text, { parse_mode: "HTML", ...kb }); }
      catch (_) { await ctx.replyWithHTML(text, kb); }
      return;
    }
    userStates.set(userId, "waiting_md5");
    const text =
      `🔐 <b>Dự đoán MD5 Thông Minh</b>\n\n` +
      `Gửi mã MD5 (32 ký tự hex) của phiên cần dự đoán:\n` +
      `<i>Hệ thống sẽ phân tích dựa trên lịch sử ${(await fetchApiData()).sessions?.length || 0}+ phiên</i>`;
    try { await ctx.editMessageText(text, { parse_mode: "HTML", ...backKeyboard("predict_md5") }); }
    catch (_) { await ctx.replyWithHTML(text, backKeyboard("predict_md5")); }
    return;
  }
});

// ─── TEXT MESSAGES ────────────────────────────────────────────────────────────
bot.on(message("text"), async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  const text = ctx.message.text.trim();

  if (state === "waiting_key") {
    const keyInfo = await storage.getKey(text);
    if (!keyInfo) {
      return ctx.replyWithHTML("❌ <b>Key không hợp lệ.</b>\nVui lòng kiểm tra lại.", backKeyboard());
    }
    // Kiểm tra hết hạn
    if (!isKeyValid(keyInfo)) {
      return ctx.replyWithHTML(
        `⏰ <b>Key đã hết hạn!</b>\n\nKey này đã hết hạn từ ${formatExpire(keyInfo.expire)}.\nVui lòng mua gói mới.`,
        Markup.inlineKeyboard([
          [Markup.button.callback("💳 Mua Key mới", "buy_key")],
          [Markup.button.callback("🏠 Menu", "main_menu")],
        ])
      );
    }
    // Kiểm tra key bị dùng bởi người khác
    if (keyInfo.user_id && Number(keyInfo.user_id) !== userId) {
      return ctx.replyWithHTML("🚫 Key đã được dùng bởi tài khoản khác.", backKeyboard());
    }
    // FIX: Luôn ghi user_id vào key khi kích hoạt
    // Dù admin đã tạo key sẵn cho userId, vẫn cần setKey để DB flush đúng user_id
    // Nhờ đó validateKey (getUserKey theo userId) mới tìm được
    const activateData = {
      user_id: userId,
      pkg: keyInfo.pkg,
      expire: keyInfo.expire,
      created: keyInfo.created || new Date().toISOString(),
    };
    await storage.setKey(text, activateData);
    userStates.delete(userId);
    await ctx.replyWithHTML(
      `✅ <b>Kích hoạt thành công!</b>\n\n` +
      `📦 Gói: ${PACKAGES[keyInfo.pkg]?.label || keyInfo.pkg}\n` +
      `⏰ Hết hạn: ${formatExpire(keyInfo.expire)}\n` +
      `⏳ Còn lại: ${timeLeftStr(keyInfo.expire)}`,
      mainMenuKeyboard()
    );
    return;
  }

  if (state === "waiting_md5") {
    if (!(await validateKey(userId))) {
      userStates.delete(userId);
      return ctx.replyWithHTML(
        "⏰ Key đã hết hạn! Vui lòng mua gói mới.",
        Markup.inlineKeyboard([
          [Markup.button.callback("💳 Mua Key", "buy_key")],
          [Markup.button.callback("🏠 Menu", "main_menu")],
        ])
      );
    }
    // Lấy lịch sử MD5 từ API để phân tích thông minh
    const apiData = await fetchApiData();
    const sessions = apiData.sessions || [];
    const pred = md5PredictSmart(text, sessions);
    if (pred.error) {
      return ctx.replyWithHTML(`❌ ${pred.error}`, backKeyboard("predict_md5"));
    }
    const emoji = pred.result.startsWith("TÀI") ? "🔴" : "⚪";
    const confBar = "█".repeat(Math.floor(pred.confidence / 10)) + "░".repeat(10 - Math.floor(pred.confidence / 10));
    const msg =
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🔐 <b>Dự đoán MD5</b>\n` +
      `📝 Hash: <code>${text.slice(0,8)}...${text.slice(-8)}</code>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${emoji} Dự đoán: <b>${pred.result}</b>\n` +
      `📊 Tin cậy: [${confBar}] ${pred.confidence}%\n` +
      `🎯 Tỷ lệ Tài: ${pred.taiProb}% | Xỉu: ${100 - pred.taiProb}%\n` +
      `💪 Xu hướng: ${pred.trend}\n` +
      `🔢 Parity: ${pred.parity}\n` +
      `📐 Entropy: ${pred.entropy}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🔍 Phương pháp: ${pred.method}` +
      (pred.histMatches > 0 ? `\n📚 Khớp ${pred.histMatches} điểm lịch sử` : "");
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("🔄 Nhập MD5 khác", "predict_md5")],
      [Markup.button.callback("🏠 Menu", "main_menu")],
    ]);
    userStates.delete(userId);
    await ctx.replyWithHTML(msg, kb);
    return;
  }
});

// ─── EXPRESS SERVER ───────────────────────────────────────────────────────────
const app = express();
const PORT = parseInt(process.env.PORT || "10000", 10);
app.get("/", (_, res) => res.json({ status: "online", bot: "SXD Prediction Bot v2.0" }));
app.get("/health", (_, res) => res.json({ status: "healthy", ts: new Date().toISOString() }));

bot.catch((err, ctx) => {
  const desc = err?.response?.description || err?.message || "";
  if (!desc.includes("query is too old") && !desc.includes("message is not modified")) {
    console.error("Bot error:", desc);
  }
});

bot.launch({ dropPendingUpdates: true }).then(() => console.log("🤖 Bot v2.0 đang chạy..."));
app.listen(PORT, "0.0.0.0", () => console.log(`🌐 Web server port ${PORT}`));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
