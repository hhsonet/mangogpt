import "server-only";
import { logEvent } from "@/services/usage";

/**
 * Admin notifications over Slack (incoming webhook) and/or Telegram (bot). Configured only through
 * environment variables, so no secret ever lives in the database or reaches the browser:
 *   SLACK_WEBHOOK_URL      https://hooks.slack.com/services/…
 *   TELEGRAM_BOT_TOKEN     123456:ABC…   (from @BotFather)
 *   TELEGRAM_CHAT_ID       your chat or group id
 *   APP_PUBLIC_URL         optional, e.g. https://example.com:3443, used for the "Review" link
 *   TELEGRAM_API_BASE      optional override (tests only)
 */
const slackUrl = () => process.env.SLACK_WEBHOOK_URL?.trim() || "";
const tgToken = () => process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
const tgChat = () => process.env.TELEGRAM_CHAT_ID?.trim() || "";
const tgBase = () => (process.env.TELEGRAM_API_BASE?.trim() || "https://api.telegram.org").replace(/\/$/, "");
const publicUrl = () => process.env.APP_PUBLIC_URL?.trim().replace(/\/$/, "") || "";

export type ChannelResult = "ok" | "not configured" | string;

export function channelStatus() {
  return { slack: Boolean(slackUrl()), telegram: Boolean(tgToken() && tgChat()) };
}

export interface Notice {
  title: string;
  /** Plain-text "label: value" lines. Values may contain user input and are escaped per channel. */
  lines: [string, string][];
  linkPath?: string; // e.g. "/admin"
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escSlack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function post(url: string, body: unknown): Promise<ChannelResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000) });
      if (res.ok) return "ok";
      // 4xx means bad config (wrong token, bot not in chat): retrying won't help.
      if (res.status < 500 && res.status !== 429) return `rejected (HTTP ${res.status})`;
    } catch {
      /* network error or timeout: retry once */
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return "unreachable";
}

async function sendSlack(n: Notice): Promise<ChannelResult> {
  if (!slackUrl()) return "not configured";
  const link = n.linkPath && publicUrl() ? `${publicUrl()}${n.linkPath}` : "";
  const text = `*${escSlack(n.title)}*\n${n.lines.map(([k, v]) => `• ${escSlack(k)}: ${escSlack(v)}`).join("\n")}`;
  return post(slackUrl(), {
    text: `${n.title}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      ...(link ? [{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Review in admin" }, url: link }] }] : []),
    ],
  });
}

async function sendTelegram(n: Notice): Promise<ChannelResult> {
  if (!tgToken() || !tgChat()) return "not configured";
  const link = n.linkPath && publicUrl() ? `${publicUrl()}${n.linkPath}` : "";
  const text = `<b>${escHtml(n.title)}</b>\n${n.lines.map(([k, v]) => `• ${escHtml(k)}: ${escHtml(v)}`).join("\n")}${link ? `\n\n${escHtml(link)}` : ""}`;
  return post(`${tgBase()}/bot${tgToken()}/sendMessage`, { chat_id: tgChat(), text, parse_mode: "HTML", disable_web_page_preview: true });
}

// At most 20 notifications per hour, so a flood of sign-ups can't flood the admin's phone.
const sent: number[] = [];
function allowed() {
  const now = Date.now();
  while (sent.length && now - sent[0]! > 3_600_000) sent.shift();
  if (sent.length >= 20) return false;
  sent.push(now);
  return true;
}

/** Send to every configured channel. Never throws; failures are logged without secrets. */
export async function notifyAdmins(n: Notice, opts: { force?: boolean } = {}): Promise<{ slack: ChannelResult; telegram: ChannelResult }> {
  if (!opts.force && !allowed()) return { slack: "throttled", telegram: "throttled" };
  const [slack, telegram] = await Promise.all([sendSlack(n), sendTelegram(n)]);
  for (const [name, result] of [["slack", slack], ["telegram", telegram]] as const) {
    if (result !== "ok" && result !== "not configured") {
      logEvent({ type: "error", status: "error", detail: `${name} notification failed: ${result}` });
    }
  }
  return { slack, telegram };
}

export function notifyNewSignup(user: { username: string; email: string | null; status: string }, ip: string | null) {
  const pending = user.status === "pending";
  void notifyAdmins({
    title: pending ? "New sign-up request" : "New user signed up",
    lines: [
      ["Username", user.username],
      ["Email", user.email ?? "–"],
      ["Status", pending ? "waiting for your approval" : "active (sign-ups are open)"],
      ...(ip ? ([["IP", ip]] as [string, string][]) : []),
      ["Time", new Date().toUTCString()],
    ],
    linkPath: "/admin",
  }).catch(() => undefined);
}
