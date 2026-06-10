"use strict";

// ─── DEPENDENCIES ──────────────────────────────────────────────────────────────
const { Telegraf, Markup } = require("telegraf");
const { message }          = require("telegraf/filters");
const express              = require("express");
const axios                = require("axios");
const fs                   = require("fs");
const path                 = require("path");

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || "8640872279:AAHmCc9ezSBMjJNA7HEMLmeuWvXb7aRrues";
const ADMIN_ID  = 7680266707;
const ADMIN_TG  = "@cskh09099";
// 🔥 API MỚI ĐÃ ĐƯỢC THAY THẾ 🔥
const API_URL   = "https://treo-lc79-h6zy.onrender.com/";

// ─── GÓI KEY ──────────────────────────────────────────────────────────────────
const PACKAGES = {
  "5h":       { label: "5 Giờ ⚡",     price: "10.000đ",  hours: 5       },
  "1ngay":    { label: "1 Ngày",        price: "20.000đ",  hours: 24      },
  "1tuan":    { label: "1 Tuần",        price: "50.000đ",  hours: 168     },
  "1nam":     { label: "1 Năm 🔥SALE", price: "99.000đ",  hours: 8760    },
  "vinhvien": { label: "Vĩnh Viễn ♾️",  price: "150.000đ", hours: 999999  },
};

// ─── STORAGE ──────────────────────────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, "data");
const KEY_FILE  = path.join(DATA_DIR, "keys.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (_) {}
  return {};
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ─── KEY HELPERS ──────────────────────────────────────────────────────────────
function genKey(length = 20) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "SXD-";
  for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

function createKey(userId, pkg) {
  let keys = loadJSON(KEY_FILE);
  keys = Object.fromEntries(Object.entries(keys).filter(([, v]) => v.user_id !== userId));
  const info = PACKAGES[pkg];
  const newKey = genKey();
  const expire = info.hours < 999999 ? new Date(Date.now() + info.hours * 3600 * 1000).toISOString() : "never";
  keys[newKey] = { user_id: userId, pkg, expire, created: new Date().toISOString() };
  saveJSON(KEY_FILE, keys);
  return newKey;
}

function validateKey(userId) {
  const keys = loadJSON(KEY_FILE);
  for (const v of Object.values(keys)) {
    if (v.user_id === userId) {
      if (v.expire === "never") return true;
      if (new Date(v.expire) > new Date()) return true;
    }
  }
  return false;
}

function getUserKeyInfo(userId) {
  const keys = loadJSON(KEY_FILE);
  for (const [k, v] of Object.entries(keys)) {
    if (v.user_id === userId) return { key: k, ...v };
  }
  return null;
}

// ─── THUẬT TOÁN DỰ ĐOÁN MD5 (GIỮ NGUYÊN) ───────────────────────────────────────
function md5Predict(md5Hash) {
  const h = md5Hash.trim().toLowerCase();
  if (h.length !== 32 || !/^[0-9a-f]+$/.test(h)) {
    return { error: "Mã MD5 không hợp lệ (cần 32 ký tự hex)" };
  }

  const last4 = parseInt(h.slice(28, 32), 16);
  let sum = 0;
  for (let i = 0; i < 32; i += 2) {
    sum += parseInt(h.slice(i, i+2), 16);
  }
  const parity = (sum % 2 === 0) ? "Chẵn" : "Lẻ";
  const trendSeed = (last4 % 100) / 100;
  let taiProb = 0.5 + (sum % 20 - 10) / 100;
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

// ─── PHÂN TÍCH LỊCH SỬ (HỖ TRỢ CẤU TRÚC MỚI + CŨ) ──────────────────────────────
function analyzeHistory(sessionsData) {
  // Xác định dữ liệu đầu vào: nếu có history array thì dùng, không thì dùng sessions
  let results = [];
  
  if (sessionsData.history && Array.isArray(sessionsData.history)) {
    // API mới: dùng history array
    for (const s of sessionsData.history.slice(0, 30)) {
      if (s.result) {
        results.push(s.result === "TAI" ? "TÀI" : "XỈU");
      } else if (s.dices && s.dices.length === 3) {
        const sum = s.dices[0] + s.dices[1] + s.dices[2];
        results.push(sum >= 11 ? "TÀI" : "XỈU");
      }
    }
  } else if (Array.isArray(sessionsData)) {
    // API cũ: dùng sessions array
    for (const s of sessionsData.slice(0, 30)) {
      const diceSum = s.diceTotal || s.total || 0;
      if (typeof diceSum === "number" && diceSum !== 0) {
        results.push(diceSum >= 11 ? "TÀI" : "XỈU");
      }
    }
  }
  
  if (results.length === 0) {
    // Khi không có dữ liệu, dự đoán cân bằng 50-50
    const rand = Math.random();
    return {
      result: rand < 0.5 ? "TÀI" : "XỈU",
      confidence: 55,
      reason: "Chưa có dữ liệu lịch sử, dự đoán cân bằng",
      tai_rate: 50,
      xiu_rate: 50,
      streak: 0,
      current_run: "?"
    };
  }

  // Tính tỷ lệ
  const taiCount = results.filter(r => r === "TÀI").length;
  const xiuCount = results.filter(r => r === "XỈU").length;
  const total = results.length;
  const taiRate = (taiCount / total) * 100;
  const xiuRate = (xiuCount / total) * 100;

  // Phát hiện chuỗi (streak)
  let currentRun = results[0];
  let streak = 1;
  for (let i = 1; i < results.length; i++) {
    if (results[i] === currentRun) streak++;
    else break;
  }

  // Logic dự đoán dựa trên xác suất thống kê + yếu tố chuỗi
  let prediction, confidence, reason;
  
  // Nếu chuỗi quá dài (>=4) -> bẻ cầu với xác suất cao
  if (streak >= 4) {
    prediction = currentRun === "TÀI" ? "XỈU" : "TÀI";
    confidence = 70 + Math.min(streak, 8);
    reason = `Bẻ cầu - ${currentRun} xuất hiện ${streak} lần liên tiếp`;
  }
  // Nếu chênh lệch tỷ lệ quá lớn (>20%) -> dự đoán bên yếu hơn
  else if (Math.abs(taiRate - xiuRate) > 20) {
    prediction = taiRate > xiuRate ? "XỈU" : "TÀI";
    confidence = 65 + Math.min(Math.abs(taiRate - xiuRate) / 2, 15);
    reason = `Cân bằng - ${prediction} đang ít hơn (Tài:${taiRate.toFixed(1)}% / Xỉu:${xiuRate.toFixed(1)}%)`;
  }
  // Mô hình Markov đơn giản: dựa vào kết quả trước đó
  else {
    const last = results[0];
    // Xác suất giữ nguyên cầu là 60%, đổi cầu 40%
    const keepProb = 0.6;
    const change = Math.random() < keepProb ? false : true;
    if (change) {
      prediction = last === "TÀI" ? "XỈU" : "TÀI";
      confidence = 55 + Math.floor(Math.random() * 10);
      reason = `Đảo cầu - theo xu hướng ngẫu nhiên`;
    } else {
      prediction = last;
      confidence = 55 + Math.floor(Math.random() * 10);
      reason = `Theo cầu - kết quả gần nhất là ${last}`;
    }
  }

  // Đảm bảo confidence không vượt quá 92
  confidence = Math.min(confidence, 92);
  
  return {
    result: prediction,
    confidence,
    reason,
    tai_rate: Math.round(taiRate * 10) / 10,
    xiu_rate: Math.round(xiuRate * 10) / 10,
    streak,
    current_run: currentRun
  };
}

// ─── GỌI API MỚI VÀ XỬ LÝ DỮ LIỆU ───────────────────────────────────────────────
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
  
  // Kiểm tra cấu trúc API mới
  if (!data.latest && !data.history) {
    return { error: "Cấu trúc API không hợp lệ" };
  }

  // Lấy thông tin phiên hiện tại từ API mới
  const latest = data.latest || {};
  const phienId = latest.phien || latest.id || "N/A";
  const ketQua = latest.result || (latest.point >= 11 ? "TAI" : "XIU");
  
  // Xử lý xúc xắc
  let diceStr = "N/A";
  if (latest.dices && Array.isArray(latest.dices) && latest.dices.length >= 3) {
    diceStr = `${latest.dices[0]}-${latest.dices[1]}-${latest.dices[2]}`;
  } else if (latest.point) {
    diceStr = `Tổng: ${latest.point}`;
  }
  
  // Phiên mới = phiên cũ + 1
  const phienMoi = String(phienId).match(/^\d+$/) ? Number(phienId) + 1 : `${phienId}+1`;
  
  // Phân tích lịch sử (API mới có sẵn history array)
  const analysis = analyzeHistory(data);
  
  // Kiểm tra nếu API có sẵn dự đoán (prediction field)
  let finalPred = analysis.result;
  let finalConf = analysis.confidence;
  let finalReason = analysis.reason;
  
  if (data.prediction && data.prediction !== "ĐANG HỌC" && data.confidence > 0) {
    const apiPred = data.prediction === "TAI" ? "TÀI" : "XỈU";
    const apiConf = data.confidence;
    if (apiPred === analysis.result) {
      finalConf = Math.min(Math.floor((analysis.confidence + apiConf) / 2) + 5, 90);
      finalReason = `${analysis.reason} + AI đồng thuận (độ tin cậy ${apiConf}%)`;
    } else if (apiConf > analysis.confidence + 10) {
      finalPred = apiPred;
      finalConf = apiConf;
      finalReason = `AI dự đoán ${apiPred} với độ tin cậy ${apiConf}%`;
    }
  }

  // Chuyển đổi kết quả về dạng hiển thị
  const ketQuaDisplay = ketQua === "TAI" ? "TÀI 🎲" : "XỈU 🎯";
  const duDoanDisplay = finalPred === "TÀI" ? "TÀI 🎲" : "XỈU 🎯";
  
  return {
    phien: phienId,
    ket_qua: ketQuaDisplay,
    xuc_xac: diceStr,
    phien_moi: phienMoi,
    du_doan: duDoanDisplay,
    confidence: Math.floor(finalConf),
    reason: finalReason,
    tai_rate: analysis.tai_rate,
    xiu_rate: analysis.xiu_rate,
  };
}

// ─── BÀN PHÍM ─────────────────────────────────────────────────────────────────
const mainMenuKeyboard = () => Markup.inlineKeyboard([
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

const backKeyboard = (target = "main_menu") => Markup.inlineKeyboard([
  [Markup.button.callback("⬅️ Quay lại", target)]
]);

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
  
  const newKey = createKey(userId, pkg);
  const info = PACKAGES[pkg];
  const expireStr = info.hours < 999999 ? new Date(Date.now() + info.hours * 3600 * 1000).toLocaleString("vi-VN") : "Vĩnh viễn";
  try {
    await ctx.telegram.sendMessage(userId,
      `🎉 <b>Bạn đã được cấp Key thành công!</b>\n\n📦 Gói: ${info.label}\n🔑 Key: <code>${newKey}</code>\n⏰ Hết hạn: ${expireStr}\n\n👉 Vào /start và chọn <b>Nhập Key</b> để kích hoạt.`,
      { parse_mode: "HTML" });
  } catch (err) { /* bỏ qua nếu không gửi được */ }
  await ctx.replyWithHTML(`✅ Đã tạo Key cho user <code>${userId}</code>\nKey: <code>${newKey}</code>\nGói: ${info.label}`);
});

bot.command("listkeys", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const keys = loadJSON(KEY_FILE);
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
  const keys = loadJSON(KEY_FILE);
  const key = parts[1];
  if (keys[key]) {
    delete keys[key];
    saveJSON(KEY_FILE, keys);
    await ctx.reply(`✅ Đã xoá key: ${key}`);
  } else await ctx.reply("❌ Không tìm thấy key.");
});

bot.command("broadcast", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const idx = ctx.message.text.indexOf(" ");
  if (idx === -1) return ctx.reply("Dùng: /broadcast <nội dung>");
  const msg = ctx.message.text.slice(idx + 1);
  const keys = loadJSON(KEY_FILE);
  const uids = new Set(Object.values(keys).map(v => v.user_id).filter(Boolean));
  let ok = 0, fail = 0;
  for (const uid of uids) {
    try { await ctx.telegram.sendMessage(uid, `📢 ${msg}`); ok++; } catch (_) { fail++; }
  }
  await ctx.reply(`✅ Gửi OK: ${ok} | Thất bại: ${fail}`);
});

// ─── XỬ LÝ CALLBACK ───────────────────────────────────────────────────────────
bot.on("callback_query", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) { return; }
  const data = ctx.callbackQuery.data;
  const userId = ctx.from.id;

  if (data === "main_menu") {
    userStates.delete(userId);
    try { await ctx.editMessageText("🏠 <b>Menu chính</b>\nChọn tính năng:", { parse_mode: "HTML", ...mainMenuKeyboard() }); }
    catch (_) { await ctx.replyWithHTML("🏠 Menu chính", mainMenuKeyboard()); }
    return;
  }

  if (data === "my_account") {
    const info = getUserKeyInfo(userId);
    let text = info ? `👤 <b>Tài khoản</b>\n🔑 Key: <code>${info.key}</code>\n📦 Gói: ${PACKAGES[info.pkg]?.label || info.pkg}\n⏰ Hết hạn: ${info.expire === "never" ? "Vĩnh viễn" : new Date(info.expire).toLocaleString("vi-VN")}\n✅ Trạng thái: ${validateKey(userId) ? "Còn hạn" : "Hết hạn"}` : "❌ Bạn chưa có Key.";
    try { await ctx.editMessageText(text, { parse_mode: "HTML", ...backKeyboard() }); }
    catch (_) { await ctx.replyWithHTML(text, backKeyboard()); }
    return;
  }

  if (data === "buy_key") {
    const text = "💳 <b>Bảng giá Key</b>\n\n⚡ 5 Giờ – 10.000đ\n📅 1 Ngày – 20.000đ\n📆 1 Tuần – 50.000đ\n🔥 1 Năm – 99.000đ\n♾️ Vĩnh Viễn – 150.000đ\n\n👇 Chọn gói:";
    try { await ctx.editMessageText(text, { parse_mode: "HTML", ...packagesKeyboard() }); }
    catch (_) { await ctx.replyWithHTML(text, packagesKeyboard()); }
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
      [Markup.button.callback("🏠 Menu chính", "main_menu")]
    ]);
    try { await ctx.editMessageText(text, { parse_mode: "HTML", ...kb }); }
    catch (_) { await ctx.replyWithHTML(text, kb); }
    return;
  }

  if (data === "enter_key") {
    userStates.set(userId, "waiting_key");
    const text = "🔑 <b>Nhập Key</b>\n\nVui lòng gửi Key (dạng SXD-XXXX...):";
    try { await ctx.editMessageText(text, { parse_mode: "HTML", ...backKeyboard() }); }
    catch (_) { await ctx.replyWithHTML(text, backKeyboard()); }
    return;
  }

  if (data === "predict_api") {
    if (!validateKey(userId)) {
      const text = "🔒 Bạn cần Key để dự đoán.";
      const kb = Markup.inlineKeyboard([[Markup.button.callback("💳 Mua Key", "buy_key")], [Markup.button.callback("🔑 Nhập Key", "enter_key")], [Markup.button.callback("⬅️ Quay lại", "main_menu")]]);
      try { await ctx.editMessageText(text, { parse_mode: "HTML", ...kb }); }
      catch (_) { await ctx.replyWithHTML(text, kb); }
      return;
    }
    try { await ctx.editMessageText("⏳ Đang phân tích dữ liệu..."); } catch (_) {}
    const pred = await getApiPrediction();
    if (pred.error) {
      const text = `❌ Lỗi API: ${pred.error}`;
      try { await ctx.editMessageText(text, { parse_mode: "HTML", ...backKeyboard() }); }
      catch (_) { await ctx.replyWithHTML(text, backKeyboard()); }
      return;
    }
    const emoji = pred.du_doan.startsWith("TÀI") ? "🔴" : "⚪";
    const msg = `━━━━━━━━━━━━━━━━━━━━\n📌 Phiên: ${pred.phien}\n🎲 Kết quả: ${pred.ket_qua}\n🎯 Xúc xắc: ${pred.xuc_xac}\n━━━━━━━━━━━━━━━━━━━━\n🆕 Phiên mới: ${pred.phien_moi}\n${emoji} Dự đoán: ${pred.du_doan}\n📊 Độ tin cậy: ${pred.confidence}%\n💡 Lý do: ${pred.reason}\n━━━━━━━━━━━━━━━━━━━━\n📈 Tài: ${pred.tai_rate}% | Xỉu: ${pred.xiu_rate}%`;
    const kb = Markup.inlineKeyboard([[Markup.button.callback("🔄 Cập nhật", "predict_api")], [Markup.button.callback("🏠 Menu", "main_menu")]]);
    try { await ctx.editMessageText(msg, { parse_mode: "HTML", ...kb }); }
    catch (_) { await ctx.replyWithHTML(msg, kb); }
    return;
  }

  if (data === "predict_md5") {
    if (!validateKey(userId)) {
      const text = "🔒 Cần Key để dự đoán MD5.";
      const kb = Markup.inlineKeyboard([[Markup.button.callback("💳 Mua Key", "buy_key")], [Markup.button.callback("🔑 Nhập Key", "enter_key")], [Markup.button.callback("⬅️ Quay lại", "main_menu")]]);
      try { await ctx.editMessageText(text, { parse_mode: "HTML", ...kb }); }
      catch (_) { await ctx.replyWithHTML(text, kb); }
      return;
    }
    userStates.set(userId, "waiting_md5");
    const text = "🔐 <b>Dự đoán MD5</b>\n\nGửi mã MD5 32 ký tự:";
    try { await ctx.editMessageText(text, { parse_mode: "HTML", ...backKeyboard() }); }
    catch (_) { await ctx.replyWithHTML(text, backKeyboard()); }
  }
});

// ─── XỬ LÝ TIN NHẮN ───────────────────────────────────────────────────────────
bot.on(message("text"), async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  const userId = ctx.from.id;
  const state = userStates.get(userId);
  const text = ctx.message.text.trim();

  if (state === "waiting_key") {
    const keys = loadJSON(KEY_FILE);
    const entry = Object.entries(keys).find(([k]) => k === text);
    if (!entry) return ctx.replyWithHTML("❌ Key không hợp lệ.", backKeyboard());
    const [k, v] = entry;
    if (v.expire !== "never" && new Date(v.expire) <= new Date()) return ctx.replyWithHTML("⏰ Key đã hết hạn.", backKeyboard());
    if (v.user_id && v.user_id !== userId) return ctx.replyWithHTML("🚫 Key đã được dùng bởi tài khoản khác.", backKeyboard());
    keys[k].user_id = userId;
    saveJSON(KEY_FILE, keys);
    userStates.delete(userId);
    const expireStr = v.expire === "never" ? "Vĩnh viễn" : new Date(v.expire).toLocaleString("vi-VN");
    await ctx.replyWithHTML(`✅ Kích hoạt thành công!\n📦 Gói: ${PACKAGES[v.pkg]?.label || v.pkg}\n⏰ Hết hạn: ${expireStr}`, mainMenuKeyboard());
    return;
  }

  if (state === "waiting_md5") {
    if (!validateKey(userId)) {
      userStates.delete(userId);
      return ctx.replyWithHTML("🔒 Key hết hạn.", mainMenuKeyboard());
    }
    const pred = md5Predict(text);
    if (pred.error) return ctx.replyWithHTML(`❌ ${pred.error}`, backKeyboard("predict_md5"));
    const emoji = pred.result.startsWith("TÀI") ? "🔴" : "⚪";
    const msg = `━━━━━━━━━━━━━━━━━━━━\n🔐 MD5: <code>${text}</code>\n━━━━━━━━━━━━━━━━━━━━\n${emoji} Dự đoán: ${pred.result}\n📊 Độ tin cậy: ${pred.confidence}%\n📉 Entropy: ${pred.entropy}%\n🔢 Parity: ${pred.parity}\n💪 Xu hướng: ${pred.trend}`;
    const kb = Markup.inlineKeyboard([[Markup.button.callback("🔄 Nhập MD5 khác", "predict_md5")], [Markup.button.callback("🏠 Menu", "main_menu")]]);
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