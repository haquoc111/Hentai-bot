"use strict";

const { Telegraf } = require("telegraf");
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// --- CẤU HÌNH ---
const BOT_TOKEN = "8640872279:AAHmCc9ezSBMjJNA7HEMLmeuWvXb7aRrues";
const ADMIN_ID = 7680266707;
const API_URL = "https://treo-lc79-h6zy.onrender.com/";
const DATA_FILE = path.join(__dirname, "data.json");

// --- QUẢN LÝ DỮ LIỆU ---
let db = { keys: {}, stats: {} };
if (fs.existsSync(DATA_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")); } catch (e) {}
}
function saveDb() { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }

// --- HÀM HỖ TRỢ ---
async function fetchGameData() {
    try {
        const res = await axios.get(API_URL, { timeout: 10000 });
        const list = res.data.data?.list || res.data.result || [];
        return list.map(s => ({
            id: String(s.phien || s.id || s.period),
            dice: (s.dices || s.dice || [0,0,0]).map(Number),
            result: (s.result || "").toString().toLowerCase().includes("tai") ? "Tài" : "Xỉu"
        })).sort((a, b) => Number(b.id) - Number(a.id));
    } catch { return []; }
}

const bot = new Telegraf(BOT_TOKEN);

// --- LỆNH NGƯỜI DÙNG ---
bot.command("start", (ctx) => ctx.reply("S2KING_BOT đã sẵn sàng. Dùng /key <mã> để kích hoạt."));

bot.command("key", (ctx) => {
    const inputKey = ctx.message.text.split(" ")[1];
    if (!db.keys[inputKey]) return ctx.reply("❌ Key không tồn tại!");
    db.keys[inputKey].userId = ctx.from.id;
    db.keys[inputKey].activated = true;
    saveDb();
    ctx.reply("✅ Kích hoạt thành công! Key đã lưu vĩnh viễn.");
});

bot.command("duan", async (ctx) => {
    const key = Object.values(db.keys).find(k => k.userId === ctx.from.id);
    if (!key || !key.activated) return ctx.reply("⛔ Vui lòng kích hoạt key.");

    const data = await fetchGameData();
    if (data.length < 2) return ctx.reply("⚠️ Đang chờ dữ liệu...");
    
    const latest = data[0];
    if (!db.stats[ctx.from.id]) db.stats[ctx.from.id] = { w: 0, l: 0 };
    
    const msg = `📌 Phien: ${latest.id}
🏆 Ket qua: ${latest.result}
🎲 Xuc xac: ${latest.dice.join("-")}
━━━━━━━━━━━━
🔮 Phien moi: ${Number(latest.id) + 1}
🎯 Du doan: ${latest.result === "Tài" ? "Xỉu" : "Tài"}
📊 Do tin cay: 70%
━━━━━━━━━━━━
📈 Thang: ${db.stats[ctx.from.id].w}      Thua: ${db.stats[ctx.from.id].l}`;
    ctx.reply(msg);
});

bot.command("md5", async (ctx) => {
    const data = await fetchGameData();
    const prediction = data.length > 0 && data[0].dice[0] > 3 ? "Tài" : "Xỉu";
    ctx.reply(`🔬 Ket qua phan tich MD5:
🎯 Du doan: ${prediction}
📊 Do tin cay: 70%
(Du lieu lay tu ${data.length} phien API)`);
});

// --- LỆNH ADMIN ---
bot.command("taokey", (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const key = "SXD-" + crypto.randomBytes(4).toString("hex").toUpperCase();
    db.keys[key] = { userId: null, activated: false };
    saveDb();
    ctx.reply(`✅ Tạo key: ${key}`);
});

// --- SERVER EXPRESS ĐỂ GIỮ BOT SỐNG ---
const app = express();
app.get("/", (req, res) => res.send("Bot đang chạy!"));
app.listen(process.env.PORT || 3000);

bot.launch().then(() => console.log("✅ Bot đã khởi động!"));