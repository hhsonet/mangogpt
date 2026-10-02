// Finds your Telegram chat id. 1) Create a bot with @BotFather and put TELEGRAM_BOT_TOKEN in .env.
// 2) Open the bot in Telegram and send it any message. 3) Run: node scripts/telegram-chat-id.mjs
import fs from "node:fs";

const env = fs.existsSync(new URL("../.env", import.meta.url)) ? fs.readFileSync(new URL("../.env", import.meta.url), "utf8") : "";
const token = process.env.TELEGRAM_BOT_TOKEN || /^TELEGRAM_BOT_TOKEN=(.+)$/m.exec(env)?.[1]?.trim();
if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN in .env first.");

const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const data = await res.json();
if (!data.ok) throw new Error(`Telegram said: ${data.description ?? res.status}`);
const chats = new Map();
for (const u of data.result) {
  const c = (u.message ?? u.channel_post ?? u.my_chat_member)?.chat;
  if (c) chats.set(c.id, `${c.type}: ${c.title ?? [c.first_name, c.last_name].filter(Boolean).join(" ") ?? c.username}`);
}
if (!chats.size) console.log("No messages found. Send your bot a message in Telegram, then run this again.");
for (const [id, label] of chats) console.log(`TELEGRAM_CHAT_ID=${id}    (${label})`);
