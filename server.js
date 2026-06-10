"use strict";

// ─── DEPENDENCIES ──────────────────────────────────────────────────────────────
const { Telegraf, Markup } = require("telegraf");
const { message } = require("telegraf/filters");
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

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
  "5h": { label: "5 Giờ ⚡", price: "10.000đ", hours: 5 },
  "1ngay": { label: "1 Ngày", price: "20.000đ", hours: 24 },
  "1tuan": { label: "1 Tuần", price: "50.000đ", hours: 168 },
  "1nam": { label: "1 Năm 🔥SALE", price: "99.000đ", hours: 8760 },
  "vinhvien": { label: "Vĩnh Viễn ♾️", price: "150.000đ", hours: 999999 },
};

// ─── LỚP LƯU TRỮ KEY (POSTGRES HOẶC FILE) ──────────────────────────────────────
class KeyStorage {
  constructor() {
    this.useDb = !!(pool && DATABASE_URL);
    if (this.useDb) {
      this.initDb().catch(console.error);
    } else {
      this.dataDir = path.join(__dirname, "data");
      this.keyFile = path.join(this.dataDir, "keys.json");
      if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
      console.log("⚠️ Dùng file lưu key (dễ mất khi restart Render). Hãy thêm DATABASE_URL để lưu vĩnh viễn.");
    }
  }

  async initDb() {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS keys (
          key_text TEXT PRIMARY KEY,
          user_id BIGINT NOT NULL,
          pkg TEXT NOT NULL,
          expire TEXT NOT NULL,
          created TIMESTAMP DEFAULT NOW()
        )
      `);
      console.log("✅ Đã kết nối PostgreSQL, key sẽ được lưu vĩnh viễn.");
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
          user_id: row.user_id,
          pkg: row.pkg,
          expire: row.expire,
          created: row.created.toISOString(),
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
      await pool.query("DELETE FROM keys");
      for (const [keyText, val] of Object.entries(keys)) {
        await pool.query(
          "INSERT INTO keys (key_text, user_id, pkg, expire, created) VALUES ($1, $2, $3, $4, $5)",
          [keyText, val.user_id, val.pkg, val.expire, val.created]
        );
      }
    } else {
      fs.writeFileSync(this.keyFile, JSON.stringify(keys, null, 2), "utf-8");
    }
  }

  async getKey(keyText) {
    if (this.useDb) {
      const res = await pool.query("SELECT * FROM keys WHERE key_text = $1", [keyText]);
      return res.rows[0] || null;
    } else {
      const keys = await this.loadAll();
      return keys[keyText] || null;
    }
  }

  async setKey(keyText, data) {
    const keys = await this.loadAll();
    keys[keyText] = data;
    await this.saveAll(keys);
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
    if (this.useDb) {
      const res = await pool.query("SELECT * FROM keys WHERE user_id = $1", [userId]);
      return res.rows[0] || null;
    } else {
      const keys = await this.loadAll();
      for (const [k, v] of Object.entries(keys)) {
        if (v.user_id === userId) return { key_text: k, ...v };
      }
      return null;
    }
  }

  async deleteUserKeys(userId) {
    if (this.useDb) {
      await pool.query("DELETE FROM keys WHERE user_id = $1", [userId]);
    } else {
      const keys = await this.loadAll();
      const newKeys = Object.fromEntries(Object.entries(keys).filter(([, v]) => v.user_id !== userId));
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
  await storage.deleteUserKeys(userId); // xóa key cũ của user
  const info = PACKAGES[pkg];
  const newKey = genKey();
  const expire = info.hours < 999999 ? new Date(Date.now() + info.hours * 3600 * 1000).toISOString() : "never";
  await storage.setKey(newKey, {
    user_id: userId,
    pkg: pkg,
    expire: expire,
    created: new Date().toISOString(),
  });
  return newKey;
}

async function validateKey(userId) {
  const keyInfo = await storage.getUserKey(userId);
  if (!keyInfo) return false;
  if (keyInfo.expire === "never") return true;
  return new Date(keyInfo.expire) > new Date();
}

async function getUserKeyInfo(userId) {
  const keyInfo = await storage.getUserKey(userId);
  if (!keyInfo) return null;
  return { key: keyInfo.key_text, user_id: keyInfo.user_id, pkg: keyInfo.pkg, expire: keyInfo.expire };
}

// ─── DỰ ĐOÁN MD5 ──────────────────────────────────────────────────────────────
function md5Predict(md5Hash) {
  const h = md5Hash.trim().toLowerCase();
  if (h.length !== 32 || !/^[0-9a-f]+$/.test(h)) {
    return { error: "Mã MD5 không hợp lệ (cần 32 ký tự hex)" };
  }
  const last4 = parseInt(h.slice(28, 32), 16);
  let sum = 0;
  for (let i = 0; i < 32; i += 2) sum += parseInt(h.slice(i, i + 2), 16);
  const parity = sum % 2 === 0 ? "Chẵn" : "Lẻ";
  const trendSeed = (last4 % 100) / 100;
  let taiProb = 0.5 + ((sum % 20) - 10) / 100;
  taiProb = Math.min(0.85, Math.max(0.15, taiProb));
  taiProb = taiProb * 0.7 + trendSeed * 0.3;
  const isTai = Math.random() < taiProb;
  let result = isTai ? "TÀI 🎲" : "XỈU 🎯";
  let confidence = Math.floor(50 + Math.abs(taiProb - 0.5) * 80);
  confidence = Math.min(confidence, 92);
  const trend = confidence >= 70 ? "Mạnh" : confidence >= 55 ? "Trung bình" : "Yếu";
  const entropy = Math.floor(taiProb * 100);
  return { result, confidence, trend, entropy, parity };
}

// ─── PHÂN TÍCH LỊCH SỬ (FALLBACK KHI API KHÔNG CÓ DỰ ĐOÁN) ─────────────────────
function analyzeHistory(data) {
  let results = [];
  if (data.history && Array.isArray(data.history)) {
    for (const s of data.history.slice(0, 30)) {
      if (s.result) results.push(s.result === "TAI" ? "TÀI" : "XỈU");
      else if (s.dices && s.dices.length === 3) {
        const sum = s.dices[0] + s.dices[1] + s.dices[2];
        results.push(sum >= 11 ? "TÀI" : "XỈU");
      }
    }
  } else if (Array.isArray(data)) {
    for (const s of data.slice(0, 30)) {
      const diceSum = s.diceTotal || s.total || 0;
      if (typeof diceSum === "number" && diceSum !== 0) results.push(diceSum >= 11 ? "TÀI" : "XỈU");
    }
  }
  if (results.length === 0) {
    return { result: Math.random() < 0.5 ? "TÀI" : "XỈU", confidence: 55, reason: "Chưa có dữ liệu", tai_rate: 50, xiu_rate: 50 };
  }
  const taiCount = results.filter(r => r === "TÀI").length;
  const xiuCount = results.filter(r => r === "XỈU").length;
  const total = results.length;
  const taiRate = (taiCount / total) * 100;
  const xiuRate = (xiuCount / total) * 100;
  let currentRun = results[0];
  let streak = 1;
  for (let i = 1; i < results.length; i++) {
    if (results[i] === currentRun) streak++;
    else break;
  }
  let prediction, confidence, reason;
  if (streak >= 4) {
    prediction = currentRun === "TÀI" ? "XỈU" : "TÀI";
    confidence = 70 + Math.min(streak, 8);
    reason = `Bẻ cầu – ${currentRun} đã xuất hiện ${streak} lần liên tiếp`;
  } else if (Math.abs(taiRate - xiuRate) > 20) {
    prediction = taiRate > xiuRate ? "XỈU" : "TÀI";
    confidence = 65 + Math.min(Math.abs(taiRate - xiuRate) / 2, 15);
    reason = `Cân bằng – ${prediction} đang ít hơn (Tài:${taiRate.toFixed(1)}% / Xỉu:${xiuRate.toFixed(1)}%)`;
  } else {
    const last = results[0];
    const change = Math.random() < 0.4;
    if (change) {
      prediction = last === "TÀI" ? "XỈU" : "TÀI";
      confidence = 55 + Math.floor(Math.random() * 10);
      reason = "Đảo cầu – xu hướng ngẫu nhiên";
    } else {
      prediction = last;
      confidence = 55 + Math.floor(Math.random() * 10);
      reason = `Theo cầu – kết quả gần nhất là ${last}`;
    }
  }
  confidence = Math.min(confidence, 92);
  return { result: prediction, confidence, reason, tai_rate: Math.round(taiRate * 10) / 10, xiu_rate: Math.round(xiuRate * 10) / 10 };
}

// ─── DỰ ĐOÁN API (ƯU TIÊN PREDICTION TỪ API MỚI) ──────────────────────────────
async function fetchApiData() {
  try {
    const resp = await axios.get(API_URL, { timeout: 10000 });
    return resp.data;
  } catch (e) {
    console.error("API Error:", e.message);
    return { error: e.message };
  }
}

async function getApiPrediction() {
  const data = await fetchApiData();
  if (data.error) return { error: data.error };
  if (!data.latest && !data.history) return { error: "API trả về cấu trúc không hợp lệ" };

  const latest = data.latest || {};
  const phienId = latest.phien || latest.id || "N/A";
  const ketQuaRaw = latest.result || (latest.point >= 11 ? "TAI" : "XIU");
  const ketQuaDisplay = ketQuaRaw === "TAI" ? "TÀI 🎲" : "XỈU 🎯";

  let diceStr = "N/A";
  if (latest.dices && Array.isArray(latest.dices) && latest.dices.length >= 3) {
    diceStr = `${latest.dices[0]}-${latest.dices[1]}-${latest.dices[2]}`;
  } else if (latest.point) {
    diceStr = `Tổng: ${latest.point}`;
  }
  const phienMoi = String(phienId).match(/^\d+$/) ? Number(phienId) + 1 : `${phienId}+1`;

  // Ưu tiên dùng prediction từ API nếu có
  let duDoan, confidence, reason, taiRate = 50, xiuRate = 50;
  const hasValidPrediction =
    data.prediction &&
    typeof data.prediction === "string" &&
    data.prediction.toUpperCase() !== "ĐANG HỌC" &&
    data.prediction.toUpperCase() !== "UNKNOWN" &&
    data.confidence &&
    typeof data.confidence === "number" &&
    data.confidence > 0;

  if (hasValidPrediction) {
    const apiPred = data.prediction.toUpperCase() === "TAI" ? "TÀI 🎲" : "XỈU 🎯";
    duDoan = apiPred;
    confidence = Math.min(data.confidence, 92);
    reason = `Dự đoán từ hệ thống (độ tin cậy ${data.confidence}%)`;
    if (typeof data.tai === "number") taiRate = data.tai;
    if (typeof data.xiu === "number") xiuRate = data.xiu;
  } else {
    const analysis = analyzeHistory(data);
    duDoan = analysis.result === "TÀI" ? "TÀI 🎲" : "XỈU 🎯";
    confidence = analysis.confidence;
    reason = analysis.reason;
    taiRate = analysis.tai_rate;
    xiuRate = analysis.xiu_rate;
  }

  return {
    phien: phienId,
    ket_qua: ketQuaDisplay,
    xuc_xac: diceStr,
    phien_moi: phienMoi,
    du_doan: duDoan,
    confidence: Math.floor(confidence),
    reason: reason,
    tai_rate: taiRate,
    xiu_rate: xiuRate,
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
  const rows = Object.entries(PACKAGES).map(([id, info]) => [Markup.button.callback(`${info.label} – ${info.price}`, `buy_${id}`)]);
  rows.push([Markup.button.callback("⬅️ Quay lại", "main_menu")]);
  return Markup.inlineKeyboard(rows);
};

const backKeyboard = (target = "main_menu") => Markup.inlineKeyboard([[Markup.button.callback("⬅️ Quay lại", target)]]);

const userStates = new Map();

// ─── BOT ──────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  const first = ctx.from.firstName || ctx.from.first_name || "bạn";
  await ctx.replyWithHTML(
    `👋 Chào mừng <b>${first}</b> đến với <b>SXD Prediction Bot</b>!\n\n` +
      `🎯 Bot dự đoán Tài/Xỉu thông minh sử dụng:\n` +
      `  • Phân tích cầu theo API thời gian thực\n` +
      `  • Thuật toán phân tích mã MD5\n\n` +
      `⚠️ Cần có <b>Key</b> để sử dụng tính năng dự đoán.\n` +
      `Chọn một tùy chọn bên dưới:`,
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
  if (parts.length < 3) return ctx.reply("⚠️ Cú pháp: /taokey <user_id> <gói>\nGói: 5h, 1ngay, 1tuan, 1nam, vinhvien");
  const userId = parseInt(parts[1]);
  if (isNaN(userId)) return ctx.reply("❌ user_id phải là số.");
  const pkg = parts[2];
  if (!PACKAGES[pkg]) return ctx.reply(`❌ Gói không hợp lệ. Các gói: ${Object.keys(PACKAGES).join(", ")}`);

  const newKey = await createKey(userId, pkg);
  const info = PACKAGES[pkg];
  const expireStr = info.hours < 999999 ? new Date(Date.now() + info.hours * 3600 * 1000).toLocaleString("vi-VN") : "Vĩnh viễn";
  try {
    await ctx.telegram.sendMessage(
      userId,
      `🎉 <b>Bạn đã được cấp Key thành công!</b>\n\n📦 Gói: ${info.label}\n🔑 Key: <code>${newKey}</code>\n⏰ Hết hạn: ${expireStr}\n\n👉 Vào /start và chọn <b>Nhập Key</b> để kích hoạt.`,
      { parse_mode: "HTML" }
    );
  } catch (err) {}
  await ctx.replyWithHTML(`✅ Đã tạo Key cho user <code>${userId}</code>\nKey: <code>${newKey}</code>\nGói: ${info.label}`);
});

bot.command("listkeys", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const keys = await storage.loadAll();
  const entries = Object.entries(keys);
  if (!entries.length) return ctx.reply("Chưa có key nào.");
  const lines = ["<b>📋 Danh sách Key</b>"];
  for (const [k, v] of entries.slice(0, 30)) {
    const active = v.expire === "never" || new Date(v.expire) > new Date();
    lines.push(`${active ? "✅" : "❌"} <code>${k}</code> | UID:${v.user_id} | ${v.pkg}`);
  }
  await ctx.replyWithHTML(lines.join("\n"));
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
  let ok = 0,
    fail = 0;
  for (const uid of uids) {
    try {
      await ctx.telegram.sendMessage(uid, `📢 ${msg}`);
      ok++;
    } catch (_) {
      fail++;
    }
  }
  await ctx.reply(`✅ Gửi OK: ${ok} | Thất bại: ${fail}`);
});

// ─── CALLBACK QUERIES ─────────────────────────────────────────────────────────
bot.on("callback_query", async (ctx) => {
  try {
    await ctx.answerCbQuery();
  } catch (_) {
    return;
  }
  const data = ctx.callbackQuery.data;
  const userId = ctx.from.id;

  if (data === "main_menu") {
    userStates.delete(userId);
    try {
      await ctx.editMessageText("🏠 <b>Menu chính</b>\nChọn tính năng:", { parse_mode: "HTML", ...mainMenuKeyboard() });
    } catch (_) {
      await ctx.replyWithHTML("🏠 Menu chính", mainMenuKeyboard());
    }
    return;
  }

  if (data === "my_account") {
    const info = await getUserKeyInfo(userId);
    let text = info
      ? `👤 <b>Tài khoản</b>\n🔑 Key: <code>${info.key}</code>\n📦 Gói: ${PACKAGES[info.pkg]?.label || info.pkg}\n⏰ Hết hạn: ${info.expire === "never" ? "Vĩnh viễn" : new Date(info.expire).toLocaleString("vi-VN")}\n✅ Trạng thái: ${(await validateKey(userId)) ? "Còn hạn" : "Hết hạn"}`
      : "❌ Bạn chưa có Key.";
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...backKeyboard() });
    } catch (_) {
      await ctx.replyWithHTML(text, backKeyboard());
    }
    return;
  }

  if (data === "buy_key") {
    const text =
      "💳 <b>Bảng giá Key</b>\n\n⚡ 5 Giờ – 10.000đ\n📅 1 Ngày – 20.000đ\n📆 1 Tuần – 50.000đ\n🔥 1 Năm – 99.000đ\n♾️ Vĩnh Viễn – 150.000đ\n\n👇 Chọn gói:";
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
    const text = `💰 <b>Gói: ${info.label}</b>\n💵 Giá: ${info.price}\n\n📌 Liên hệ Admin ${ADMIN_TG} để mua Key.\nSau khi thanh toán, admin sẽ cấp Key.`;
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
    const text = "🔑 <b>Nhập Key</b>\n\nVui lòng gửi Key (dạng SXD-XXXX...):";
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...backKeyboard() });
    } catch (_) {
      await ctx.replyWithHTML(text, backKeyboard());
    }
    return;
  }

  if (data === "predict_api") {
    if (!(await validateKey(userId))) {
      const text = "🔒 Bạn cần Key để dự đoán.";
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback("💳 Mua Key", "buy_key")],
        [Markup.button.callback("🔑 Nhập Key", "enter_key")],
        [Markup.button.callback("⬅️ Quay lại", "main_menu")],
      ]);
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", ...kb });
      } catch (_) {
        await ctx.replyWithHTML(text, kb);
      }
      return;
    }
    try {
      await ctx.editMessageText("⏳ Đang lấy dữ liệu từ API...");
    } catch (_) {}
    const pred = await getApiPrediction();
    if (pred.error) {
      const text = `❌ Lỗi API: ${pred.error}`;
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", ...backKeyboard() });
      } catch (_) {
        await ctx.replyWithHTML(text, backKeyboard());
      }
      return;
    }
    const emoji = pred.du_doan.startsWith("TÀI") ? "🔴" : "⚪";
    const msg = `━━━━━━━━━━━━━━━━━━━━\n📌 Phiên: ${pred.phien}\n🎲 Kết quả: ${pred.ket_qua}\n🎯 Xúc xắc: ${pred.xuc_xac}\n━━━━━━━━━━━━━━━━━━━━\n🆕 Phiên mới: ${pred.phien_moi}\n${emoji} Dự đoán: ${pred.du_doan}\n📊 Độ tin cậy: ${pred.confidence}%\n💡 Lý do: ${pred.reason}\n━━━━━━━━━━━━━━━━━━━━\n📈 Tài: ${pred.tai_rate}% | Xỉu: ${pred.xiu_rate}%`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("🔄 Cập nhật", "predict_api")],
      [Markup.button.callback("🏠 Menu", "main_menu")],
    ]);
    try {
      await ctx.editMessageText(msg, { parse_mode: "HTML", ...kb });
    } catch (_) {
      await ctx.replyWithHTML(msg, kb);
    }
    return;
  }

  if (data === "predict_md5") {
    if (!(await validateKey(userId))) {
      const text = "🔒 Cần Key để dự đoán MD5.";
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback("💳 Mua Key", "buy_key")],
        [Markup.button.callback("🔑 Nhập Key", "enter_key")],
        [Markup.button.callback("⬅️ Quay lại", "main_menu")],
      ]);
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", ...kb });
      } catch (_) {
        await ctx.replyWithHTML(text, kb);
      }
      return;
    }
    userStates.set(userId, "waiting_md5");
    const text = "🔐 <b>Dự đoán MD5</b>\n\nGửi mã MD5 32 ký tự:";
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...backKeyboard() });
    } catch (_) {
      await ctx.replyWithHTML(text, backKeyboard());
    }
  }
});

// ─── TEXT MESSAGES ───────────────────────────────────────────────────────────
bot.on(message("text"), async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  const text = ctx.message.text.trim();

  if (state === "waiting_key") {
    const keyInfo = await storage.getKey(text);
    if (!keyInfo) return ctx.replyWithHTML("❌ Key không hợp lệ.", backKeyboard());
    if (keyInfo.expire !== "never" && new Date(keyInfo.expire) <= new Date())
      return ctx.replyWithHTML("⏰ Key đã hết hạn.", backKeyboard());
    if (keyInfo.user_id && keyInfo.user_id !== userId)
      return ctx.replyWithHTML("🚫 Key đã được dùng bởi tài khoản khác.", backKeyboard());
    // Cập nhật user_id cho key (nếu key chưa có user_id)
    if (keyInfo.user_id !== userId) {
      keyInfo.user_id = userId;
      await storage.setKey(text, keyInfo);
    }
    userStates.delete(userId);
    const expireStr = keyInfo.expire === "never" ? "Vĩnh viễn" : new Date(keyInfo.expire).toLocaleString("vi-VN");
    await ctx.replyWithHTML(
      `✅ Kích hoạt thành công!\n📦 Gói: ${PACKAGES[keyInfo.pkg]?.label || keyInfo.pkg}\n⏰ Hết hạn: ${expireStr}`,
      mainMenuKeyboard()
    );
    return;
  }

  if (state === "waiting_md5") {
    if (!(await validateKey(userId))) {
      userStates.delete(userId);
      return ctx.replyWithHTML("🔒 Key hết hạn.", mainMenuKeyboard());
    }
    const pred = md5Predict(text);
    if (pred.error) return ctx.replyWithHTML(`❌ ${pred.error}`, backKeyboard("predict_md5"));
    const emoji = pred.result.startsWith("TÀI") ? "🔴" : "⚪";
    const msg = `━━━━━━━━━━━━━━━━━━━━\n🔐 MD5: <code>${text}</code>\n━━━━━━━━━━━━━━━━━━━━\n${emoji} Dự đoán: ${pred.result}\n📊 Độ tin cậy: ${pred.confidence}%\n📉 Entropy: ${pred.entropy}%\n🔢 Parity: ${pred.parity}\n💪 Xu hướng: ${pred.trend}`;
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
app.get("/", (_, res) => res.json({ status: "online", bot: "SXD Prediction Bot" }));
app.get("/health", (_, res) => res.json({ status: "healthy" }));

bot.catch((err, ctx) => {
  const desc = err?.response?.description || err?.message || "";
  if (!desc.includes("query is too old") && !desc.includes("message is not modified")) console.error("Bot error:", desc);
});

bot.launch({ dropPendingUpdates: true }).then(() => console.log("🤖 Bot đang chạy..."));
app.listen(PORT, "0.0.0.0", () => console.log(`🌐 Web server port ${PORT}`));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));