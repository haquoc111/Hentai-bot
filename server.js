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
const API_URL   = "https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=fa2eaf73a676b982e7471927c1e0293b";
const QR_IMAGE  = path.join(__dirname, "qr_payment.png");

// ─── GÓI KEY ──────────────────────────────────────────────────────────────────
const PACKAGES = {
  "5h":       { label: "5 Giờ ⚡",     price: "10.000đ",  hours: 5       },
  "1ngay":    { label: "1 Ngày",        price: "20.000đ",  hours: 24      },
  "1tuan":    { label: "1 Tuần",        price: "50.000đ",  hours: 168     },
  "1nam":     { label: "1 Năm 🔥SALE", price: "99.000đ",  hours: 8760    },
  "vinhvien": { label: "Vĩnh Viễn ♾️",  price: "150.000đ", hours: 999999  },
};

// ─── STORAGE (JSON files) ─────────────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, "data");
const KEY_FILE  = path.join(DATA_DIR, "keys.json");
const USER_FILE = path.join(DATA_DIR, "users.json");
const PEND_FILE = path.join(DATA_DIR, "pending.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (_) {}
  return {};
}

function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ─── KEY HELPERS ──────────────────────────────────────────────────────────────
function genKey(length = 20) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result  = "SXD-";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function createKey(userId, pkg) {
  let keys    = loadJSON(KEY_FILE);
  // Xóa key cũ của user nếu có
  keys        = Object.fromEntries(
    Object.entries(keys).filter(([, v]) => v.user_id !== userId)
  );
  const info  = PACKAGES[pkg];
  const newKey = genKey();
  const expire = info.hours < 999999
    ? new Date(Date.now() + info.hours * 3600 * 1000).toISOString()
    : "never";
  keys[newKey] = {
    user_id: userId,
    pkg,
    expire,
    created: new Date().toISOString(),
  };
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

// ─── PENDING ORDERS ───────────────────────────────────────────────────────────
function savePending(userId, pkg) {
  const pending          = loadJSON(PEND_FILE);
  pending[String(userId)] = { pkg, time: new Date().toISOString() };
  saveJSON(PEND_FILE, pending);
}

function getPending(userId) {
  return loadJSON(PEND_FILE)[String(userId)] || null;
}

function removePending(userId) {
  const pending = loadJSON(PEND_FILE);
  delete pending[String(userId)];
  saveJSON(PEND_FILE, pending);
}

// ─── MD5 PREDICTION ───────────────────────────────────────────────────────────
function md5Predict(md5Hash) {
  const h = md5Hash.trim().toLowerCase();
  if (h.length !== 32 || !/^[0-9a-f]+$/.test(h)) {
    return { error: "Mã MD5 không hợp lệ (cần 32 ký tự hex)" };
  }

  // Chia thành 4 nhóm 8 ký tự
  const segments = [h.slice(0, 8), h.slice(8, 16), h.slice(16, 24), h.slice(24, 32)];
  const segVals  = segments.map(s => parseInt(s, 16));
  const weights  = [0.40, 0.30, 0.20, 0.10];
  const weighted = segVals.reduce((acc, v, i) => acc + v * weights[i], 0);
  const maxVal   = 0xFFFFFFFF;

  // Parity bit
  const totalBits = BigInt("0x" + h).toString(2).split("").filter(c => c === "1").length;
  const parity    = totalBits % 2; // 0=chẵn, 1=lẻ

  const entropy = weighted / maxVal;
  const score   = entropy * 0.7 + parity * 0.3;

  let result, confidence;
  if (score >= 0.5) {
    result     = "TÀI 🎲";
    confidence = Math.floor(50 + (score - 0.5) * 100);
  } else {
    result     = "XỈU 🎯";
    confidence = Math.floor(50 + (0.5 - score) * 100);
  }
  confidence = Math.min(confidence, 95);

  const trend = confidence >= 75 ? "Mạnh" : confidence >= 60 ? "Trung bình" : "Yếu";

  return {
    result,
    confidence,
    trend,
    entropy:  Math.round(entropy * 10000) / 100,
    parity:   parity ? "Lẻ" : "Chẵn",
  };
}

// ─── API PREDICTION ───────────────────────────────────────────────────────────
async function fetchApiData() {
  try {
    const resp = await axios.get(API_URL, { timeout: 10000 });
    return resp.data;
  } catch (e) {
    return { error: e.message };
  }
}

function analyzeHistory(sessions) {
  if (!sessions || sessions.length < 3) {
    return { result: "TÀI", confidence: 55, reason: "Không đủ dữ liệu" };
  }

  const results = [];
  for (const s of sessions.slice(0, 20)) {
    const diceSum = s.diceTotal || s.total || 0;
    if (typeof diceSum === "number") {
      results.push(diceSum >= 11 ? "TÀI" : "XỈU");
    }
  }

  if (!results.length) {
    return { result: "TÀI", confidence: 55, reason: "Dữ liệu không hợp lệ" };
  }

  let current = results[0];
  let streak  = 1;
  for (let i = 1; i < results.length; i++) {
    if (results[i] === current) streak++;
    else break;
  }

  const taiCount = results.filter(r => r === "TÀI").length;
  const xiuCount = results.filter(r => r === "XỈU").length;
  const total    = results.length;

  let prediction, confidence, reason;

  if (streak >= 5) {
    prediction = current === "TÀI" ? "XỈU" : "TÀI";
    confidence = Math.min(75 + streak * 2, 88);
    reason     = `Bẻ cầu – ${current} đã xuất hiện ${streak} lần liên tiếp`;
  } else if (streak >= 3) {
    prediction = current;
    confidence = 65 + streak;
    reason     = `Theo cầu – ${current} liên tiếp ${streak} lần`;
  } else {
    if (taiCount > xiuCount * 1.5) {
      prediction = "XỈU"; confidence = 62;
      reason     = "Tài xuất hiện quá nhiều, cân bằng về xỉu";
    } else if (xiuCount > taiCount * 1.5) {
      prediction = "TÀI"; confidence = 62;
      reason     = "Xỉu xuất hiện quá nhiều, cân bằng về tài";
    } else {
      prediction = results[0]; confidence = 58;
      reason     = "Thị trường cân bằng, theo kết quả gần nhất";
    }
  }

  return {
    result:      prediction,
    confidence,
    reason,
    streak,
    current_run: current,
    tai_rate:    Math.round((taiCount / total) * 1000) / 10,
    xiu_rate:    Math.round((xiuCount / total) * 1000) / 10,
  };
}

async function getApiPrediction() {
  const data = await fetchApiData();
  if (data.error) return { error: data.error };

  // Tìm sessions array
  let sessions = null;
  for (const key of ["data", "sessions", "result", "list", "items"]) {
    if (Array.isArray(data[key])) { sessions = data[key]; break; }
  }
  if (!sessions && Array.isArray(data)) sessions = data;
  if (!sessions) return { error: "Cấu trúc API không nhận diện được" };

  const latest  = sessions[0] || {};
  const phienId = latest.sessionId || latest.id || latest.sid || "N/A";
  const total   = latest.diceTotal || latest.total || 0;
  const diceArr = latest.dice || latest.dices || [];

  let diceStr;
  if (Array.isArray(diceArr) && diceArr.length >= 3) {
    diceStr = `${diceArr[0]}-${diceArr[1]}-${diceArr[2]}`;
  } else if (typeof total === "number" && total > 0) {
    diceStr = `Tổng: ${Math.floor(total)}`;
  } else {
    diceStr = "N/A";
  }

  const ketQua   = (typeof total === "number" && total >= 11) ? "TÀI" : "XỈU";
  const phienMoi = String(phienId).match(/^\d+$/)
    ? Number(phienId) + 1
    : `${phienId}+1`;

  const analysis   = analyzeHistory(sessions);
  const md5Latest  = latest.md5 || latest.hash || "";

  let finalConf = analysis.confidence;
  let finalRes  = analysis.result;

  if (md5Latest.length === 32) {
    const md5Pred = md5Predict(md5Latest);
    const md5Conf = md5Pred.confidence || 55;
    const md5Res  = (md5Pred.result || "").startsWith("TÀI") ? "TÀI" : "XỈU";
    if (md5Res === analysis.result) {
      finalConf = Math.min(Math.floor((analysis.confidence + md5Conf) / 2) + 5, 92);
      finalRes  = analysis.result;
    } else {
      finalConf = analysis.confidence - 5;
      finalRes  = analysis.result;
    }
  }

  return {
    phien:      phienId,
    ket_qua:    ketQua,
    xuc_xac:    diceStr,
    phien_moi:  phienMoi,
    du_doan:    finalRes,
    confidence: finalConf,
    reason:     analysis.reason,
    tai_rate:   analysis.tai_rate || 0,
    xiu_rate:   analysis.xiu_rate || 0,
  };
}

// ─── KEYBOARDS ────────────────────────────────────────────────────────────────
const mainMenuKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback("🎲 Dự đoán bằng API",    "predict_api")],
    [Markup.button.callback("🔐 Dự đoán bằng MD5",    "predict_md5")],
    [Markup.button.callback("🔑 Nhập Key sử dụng",    "enter_key")],
    [Markup.button.callback("💳 Bảng giá / Mua Key",  "buy_key")],
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

// ─── STATE MAP (per-user) ──────────────────────────────────────────────────────
// "waiting_key" | "waiting_md5" | "waiting_bill" | null
const userStates = new Map();

// ─── BOT ──────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// /start
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

// /cancel
bot.command("cancel", async (ctx) => {
  userStates.delete(ctx.from.id);
  await ctx.replyWithHTML("❌ Đã huỷ.", mainMenuKeyboard());
});

// ─── ADMIN COMMANDS ───────────────────────────────────────────────────────────
bot.hears(/^\/confirm_(\d+)_(\w+)$/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const userId = parseInt(ctx.match[1]);
  const pkg    = ctx.match[2];

  if (!PACKAGES[pkg]) {
    return ctx.reply(`❌ Gói '${pkg}' không hợp lệ.`);
  }

  const newKey   = createKey(userId, pkg);
  const info     = PACKAGES[pkg];
  const expireMs = info.hours < 999999
    ? new Date(Date.now() + info.hours * 3600 * 1000)
    : null;
  const expireStr = expireMs
    ? expireMs.toLocaleString("vi-VN", { hour12: false })
    : "Vĩnh viễn";

  removePending(userId);

  try {
    await ctx.telegram.sendMessage(
      userId,
      `🎉 <b>Thanh toán đã được xác nhận!</b>\n\n` +
      `📦 Gói: ${info.label}\n` +
      `🔑 Key của bạn:\n<code>${newKey}</code>\n` +
      `⏰ Hết hạn: ${expireStr}\n\n` +
      `⚠️ Key chỉ dùng được cho tài khoản này.\n` +
      `Vào /start và chọn <b>Nhập Key</b> để kích hoạt.`,
      { parse_mode: "HTML" }
    );
  } catch (_) {}

  await ctx.replyWithHTML(
    `✅ Đã tạo Key cho user <code>${userId}</code>\n` +
    `Key: <code>${newKey}</code>\n` +
    `Gói: ${info.label}`
  );
});

bot.hears(/^\/reject_(\d+)$/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const userId = parseInt(ctx.match[1]);
  removePending(userId);
  try {
    await ctx.telegram.sendMessage(
      userId,
      `❌ <b>Thanh toán bị từ chối</b>\n\n` +
      `Bill chuyển khoản của bạn không được xác nhận.\n` +
      `Vui lòng liên hệ ${ADMIN_TG} để được hỗ trợ.`,
      { parse_mode: "HTML" }
    );
  } catch (_) {}
  await ctx.reply(`✅ Đã từ chối và thông báo user ${userId}.`);
});

bot.command("listkeys", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const keys = loadJSON(KEY_FILE);
  const entries = Object.entries(keys);
  if (!entries.length) return ctx.reply("Chưa có key nào.");

  const lines = ["<b>📋 Danh sách Key</b>\n"];
  for (const [k, v] of entries.slice(0, 30)) {
    const active = v.expire === "never" || new Date(v.expire) > new Date();
    lines.push(`${active ? "✅" : "❌"} <code>${k}</code> | UID:${v.user_id || "?"} | ${v.pkg || "?"}`);
  }
  await ctx.replyWithHTML(lines.join("\n"));
});

bot.command("delkey", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply("Dùng: /delkey <KEY>");
  const keys = loadJSON(KEY_FILE);
  const key  = parts[1];
  if (keys[key]) {
    delete keys[key];
    saveJSON(KEY_FILE, keys);
    await ctx.reply(`✅ Đã xoá key: ${key}`);
  } else {
    await ctx.reply("❌ Không tìm thấy key.");
  }
});

bot.command("broadcast", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const idx = ctx.message.text.indexOf(" ");
  if (idx === -1) return ctx.reply("Dùng: /broadcast <nội dung>");
  const msg  = ctx.message.text.slice(idx + 1);
  const keys = loadJSON(KEY_FILE);
  const uids = new Set(Object.values(keys).map(v => v.user_id).filter(Boolean));
  let ok = 0, fail = 0;
  for (const uid of uids) {
    try { await ctx.telegram.sendMessage(uid, `📢 ${msg}`); ok++; }
    catch (_) { fail++; }
  }
  await ctx.reply(`✅ Gửi OK: ${ok} | Thất bại: ${fail}`);
});

// ─── CALLBACK QUERIES ─────────────────────────────────────────────────────────
bot.on("callback_query", async (ctx) => {
  // Bỏ qua lỗi "query is too old" khi Render wake up từ sleep
  try { await ctx.answerCbQuery(); } catch (_) { return; }
  const data   = ctx.callbackQuery.data;
  const userId = ctx.from.id;

  // ── Main menu
  if (data === "main_menu") {
    userStates.delete(userId);
    try {
      await ctx.editMessageText(
        "🏠 <b>Menu chính</b>\nChọn tính năng bạn muốn sử dụng:",
        { parse_mode: "HTML", ...mainMenuKeyboard() }
      );
    } catch (_) {
      await ctx.replyWithHTML("🏠 <b>Menu chính</b>", mainMenuKeyboard());
    }
    return;
  }

  // ── My account
  if (data === "my_account") {
    const info = getUserKeyInfo(userId);
    let text;
    if (info) {
      const expireStr = info.expire === "never"
        ? "Vĩnh viễn"
        : new Date(info.expire).toLocaleString("vi-VN", { hour12: false });
      const pkgLabel  = PACKAGES[info.pkg]?.label || info.pkg;
      text =
        `👤 <b>Tài khoản của bạn</b>\n\n` +
        `🔑 Key: <code>${info.key}</code>\n` +
        `📦 Gói: ${pkgLabel}\n` +
        `⏰ Hết hạn: ${expireStr}\n` +
        `✅ Trạng thái: ${validateKey(userId) ? "Còn hạn" : "❌ Hết hạn"}`;
    } else {
      text = "❌ Bạn chưa có Key nào.\nHãy mua Key để sử dụng tính năng dự đoán.";
    }
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...backKeyboard() });
    } catch (_) {
      await ctx.replyWithHTML(text, backKeyboard());
    }
    return;
  }

  // ── Buy key – show packages
  if (data === "buy_key") {
    const text =
      `💳 <b>Bảng giá Key</b>\n\n` +
      `1️⃣  1 Ngày          –   <b>20.000đ</b>\n` +
      `7️⃣  1 Tuần          –   <b>50.000đ</b>\n` +
      `🔥  1 Năm (SALE)  –   <b>99.000đ</b>\n` +
      `♾️  Vĩnh Viễn       – <b>150.000đ</b>\n` +
      `⚡  5 Giờ            –   <b>10.000đ</b>\n\n` +
      `👇 Chọn gói bạn muốn mua:`;
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...packagesKeyboard() });
    } catch (_) {
      await ctx.replyWithHTML(text, packagesKeyboard());
    }
    return;
  }

  // ── Confirm package purchase
  if (data.startsWith("buy_")) {
    const pkg = data.slice(4);
    if (!PACKAGES[pkg]) return ctx.answerCbQuery("Gói không hợp lệ!", { show_alert: true });
    const info = PACKAGES[pkg];
    savePending(userId, pkg);
    const text =
      `💰 <b>Thanh toán gói: ${info.label}</b>\n` +
      `💵 Số tiền: <b>${info.price}</b>\n\n` +
      `📲 Quét mã QR bên dưới để chuyển khoản.\n` +
      `Nội dung CK: <code>SXD ${userId}</code>\n\n` +
      `✅ Sau khi chuyển khoản, gửi <b>bill/ảnh xác nhận</b> cho bot này.\n` +
      `Admin ${ADMIN_TG} sẽ xác nhận và tạo Key cho bạn.`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("📤 Gửi bill xác nhận", "send_bill")],
      [Markup.button.callback("⬅️ Quay lại", "buy_key")],
    ]);
    try {
      await ctx.replyWithPhoto(
        { source: fs.createReadStream(QR_IMAGE) },
        { caption: text, parse_mode: "HTML", ...kb }
      );
      await ctx.deleteMessage().catch(() => {});
    } catch (_) {
      try {
        await ctx.editMessageText(text + "\n\n⚠️ <i>(Mã QR đang được cập nhật)</i>",
          { parse_mode: "HTML", ...kb });
      } catch (__) {
        await ctx.replyWithHTML(text + "\n\n⚠️ <i>(Mã QR đang được cập nhật)</i>", kb);
      }
    }
    return;
  }

  // ── Send bill
  if (data === "send_bill") {
    userStates.set(userId, "waiting_bill");
    const caption =
      `📤 <b>Gửi bill chuyển khoản</b>\n\n` +
      `Hãy gửi ảnh chụp màn hình hoặc ảnh bill chuyển khoản vào đây.\n` +
      `Bot sẽ chuyển tiếp đến admin để xác nhận.`;
    try {
      await ctx.editMessageCaption(caption, { parse_mode: "HTML", ...backKeyboard("buy_key") });
    } catch (_) {
      await ctx.replyWithHTML(caption, backKeyboard("buy_key"));
    }
    return;
  }

  // ── Enter key
  if (data === "enter_key") {
    userStates.set(userId, "waiting_key");
    const text = "🔑 <b>Nhập Key sử dụng</b>\n\nVui lòng gửi Key của bạn (dạng: SXD-XXXX...):";
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...backKeyboard() });
    } catch (_) {
      await ctx.replyWithHTML(text, backKeyboard());
    }
    return;
  }

  // ── Predict API
  if (data === "predict_api") {
    if (!validateKey(userId)) {
      const text =
        `🔒 <b>Tính năng này yêu cầu Key</b>\n\n` +
        `Bạn chưa có Key hoặc Key đã hết hạn.\n` +
        `Vui lòng mua Key để tiếp tục sử dụng.`;
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback("💳 Mua Key ngay", "buy_key")],
        [Markup.button.callback("🔑 Nhập Key",     "enter_key")],
        [Markup.button.callback("⬅️ Quay lại",     "main_menu")],
      ]);
      try { await ctx.editMessageText(text, { parse_mode: "HTML", ...kb }); }
      catch (_) { await ctx.replyWithHTML(text, kb); }
      return;
    }

    try { await ctx.editMessageText("⏳ Đang lấy dữ liệu từ API...", { parse_mode: "HTML" }); }
    catch (_) {}

    const pred = await getApiPrediction();
    if (pred.error) {
      const text = `❌ Lỗi kết nối API:\n<code>${pred.error}</code>`;
      try { await ctx.editMessageText(text, { parse_mode: "HTML", ...backKeyboard() }); }
      catch (_) { await ctx.replyWithHTML(text, backKeyboard()); }
      return;
    }

    const emoji = pred.du_doan === "TÀI" ? "🔴" : "⚪";
    const text =
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📌 <b>Phiên:</b> ${pred.phien}\n` +
      `🎲 <b>Kết quả:</b> ${pred.ket_qua}\n` +
      `🎯 <b>Xúc xắc:</b> ${pred.xuc_xac}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🆕 <b>Phiên mới:</b> ${pred.phien_moi}\n` +
      `${emoji} <b>Dự đoán:</b> ${pred.du_doan}\n` +
      `📊 <b>Độ tin cậy:</b> ${pred.confidence}%\n` +
      `💡 <b>Lý do:</b> ${pred.reason}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📈 Tài: ${pred.tai_rate}%  |  Xỉu: ${pred.xiu_rate}%\n`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("🔄 Cập nhật dự đoán", "predict_api")],
      [Markup.button.callback("⬅️ Menu chính",        "main_menu")],
    ]);
    try { await ctx.editMessageText(text, { parse_mode: "HTML", ...kb }); }
    catch (_) { await ctx.replyWithHTML(text, kb); }
    return;
  }

  // ── Predict MD5
  if (data === "predict_md5") {
    if (!validateKey(userId)) {
      const text = `🔒 <b>Tính năng này yêu cầu Key</b>\n\nBạn chưa có Key hoặc Key đã hết hạn.`;
      const kb = Markup.inlineKeyboard([
        [Markup.button.callback("💳 Mua Key ngay", "buy_key")],
        [Markup.button.callback("🔑 Nhập Key",     "enter_key")],
        [Markup.button.callback("⬅️ Quay lại",     "main_menu")],
      ]);
      try { await ctx.editMessageText(text, { parse_mode: "HTML", ...kb }); }
      catch (_) { await ctx.replyWithHTML(text, kb); }
      return;
    }
    userStates.set(userId, "waiting_md5");
    const text =
      `🔐 <b>Dự đoán bằng MD5</b>\n\n` +
      `Vui lòng gửi mã MD5 (32 ký tự) để dự đoán:`;
    try { await ctx.editMessageText(text, { parse_mode: "HTML", ...backKeyboard() }); }
    catch (_) { await ctx.replyWithHTML(text, backKeyboard()); }
    return;
  }
});

// ─── TEXT MESSAGES ─────────────────────────────────────────────────────────────
bot.on(message("text"), async (ctx) => {
  // Skip commands
  if (ctx.message.text.startsWith("/")) return;

  const userId = ctx.from.id;
  const state  = userStates.get(userId);
  const text   = ctx.message.text.trim();

  // ── Waiting for key input
  if (state === "waiting_key") {
    const keys   = loadJSON(KEY_FILE);
    const entry  = Object.entries(keys).find(([k]) => k === text);

    if (!entry) {
      await ctx.replyWithHTML(
        "❌ Key không hợp lệ hoặc không tồn tại.\nVui lòng kiểm tra lại.",
        backKeyboard()
      );
      return; // stay in state
    }

    const [k, v] = entry;

    if (v.expire !== "never" && new Date(v.expire) <= new Date()) {
      await ctx.replyWithHTML("⏰ Key này đã hết hạn!\nVui lòng mua Key mới.", backKeyboard());
      userStates.delete(userId);
      return;
    }

    if (v.user_id && v.user_id !== 0 && v.user_id !== userId) {
      await ctx.replyWithHTML("🚫 Key này đã được sử dụng bởi tài khoản khác.", backKeyboard());
      userStates.delete(userId);
      return;
    }

    keys[k].user_id = userId;
    saveJSON(KEY_FILE, keys);

    const expireStr = v.expire === "never"
      ? "Vĩnh viễn"
      : new Date(v.expire).toLocaleString("vi-VN", { hour12: false });
    const pkgLabel  = PACKAGES[v.pkg]?.label || v.pkg;

    userStates.delete(userId);
    await ctx.replyWithHTML(
      `✅ <b>Kích hoạt Key thành công!</b>\n\n` +
      `📦 Gói: ${pkgLabel}\n` +
      `⏰ Hết hạn: ${expireStr}\n\n` +
      `Bạn có thể sử dụng tất cả tính năng dự đoán.`,
      mainMenuKeyboard()
    );
    return;
  }

  // ── Waiting for MD5 input
  if (state === "waiting_md5") {
    if (!validateKey(userId)) {
      userStates.delete(userId);
      await ctx.replyWithHTML("🔒 Key của bạn đã hết hạn.", mainMenuKeyboard());
      return;
    }

    const pred = md5Predict(text);
    if (pred.error) {
      await ctx.replyWithHTML(`❌ ${pred.error}`, backKeyboard("predict_md5"));
      return; // stay in state
    }

    const emoji = pred.result.startsWith("TÀI") ? "🔴" : "⚪";
    const msg =
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `🔐 <b>Mã MD5:</b>\n<code>${text}</code>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${emoji} <b>Dự đoán:</b> ${pred.result}\n` +
      `📊 <b>Độ tin cậy:</b> ${pred.confidence}%\n` +
      `📉 <b>Entropy:</b> ${pred.entropy}%\n` +
      `🔢 <b>Parity:</b> ${pred.parity}\n` +
      `💪 <b>Xu hướng:</b> ${pred.trend}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n`;
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("🔄 Nhập MD5 khác", "predict_md5")],
      [Markup.button.callback("⬅️ Menu chính",    "main_menu")],
    ]);

    userStates.delete(userId);
    await ctx.replyWithHTML(msg, kb);
    return;
  }
});

// ─── PHOTO MESSAGES ─────────────────────────────────────────────────────────
bot.on(message("photo"), async (ctx) => {
  const userId  = ctx.from.id;
  const state   = userStates.get(userId);
  const pending = getPending(userId);

  if (state !== "waiting_bill" && !pending) return;

  const user    = ctx.from;
  const pkgInfo = pending ? PACKAGES[pending.pkg] || {} : {};
  const caption =
    `📥 <b>Bill chuyển khoản mới</b>\n\n` +
    `👤 User: ${user.first_name || ""} (@${user.username || "N/A"})\n` +
    `🆔 ID: <code>${userId}</code>\n` +
    `📦 Gói đặt: ${pkgInfo.label || "N/A"} – ${pkgInfo.price || "N/A"}\n\n` +
    `✅ Xác nhận: /confirm_${userId}_${pending?.pkg || "unknown"}\n` +
    `❌ Từ chối:  /reject_${userId}`;

  try {
    await ctx.telegram.sendPhoto(ADMIN_ID, ctx.message.photo.at(-1).file_id, {
      caption,
      parse_mode: "HTML",
    });
  } catch (_) {}

  userStates.delete(userId);
  await ctx.replyWithHTML(
    `✅ <b>Đã gửi bill thành công!</b>\n\n` +
    `Admin ${ADMIN_TG} sẽ xác nhận và tạo Key cho bạn trong thời gian sớm nhất.\n` +
    `Vui lòng chờ thông báo.`,
    mainMenuKeyboard()
  );
});

// ─── EXPRESS KEEP-ALIVE ────────────────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT || "10000", 10);

app.get("/",       (_, res) => res.json({ status: "online", bot: "SXD Prediction Bot", ping: "pong" }));
app.get("/health", (_, res) => res.json({ status: "healthy" }));

// ─── GLOBAL ERROR HANDLER – bot không crash vì lỗi lẻ ────────────────────────
bot.catch((err, ctx) => {
  const desc = err?.response?.description || err?.message || String(err);
  const ignore = [
    "query is too old",
    "message is not modified",
    "message to delete not found",
    "MESSAGE_ID_INVALID",
  ];
  if (ignore.some(s => desc.includes(s))) return;
  console.error("Bot error:", desc);
});

// ─── LAUNCH ───────────────────────────────────────────────────────────────────
// dropPendingUpdates: bỏ qua toàn bộ tin nhắn/button cũ khi Render wake up
bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log("🤖 Bot đang chạy...");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Web server đang chạy tại port ${PORT}`);
});

// Graceful shutdown
process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
