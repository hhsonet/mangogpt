import "server-only";
import { prisma } from "@/lib/db/prisma";
import type { AppSettings } from "@/types";

type SettingsRow = NonNullable<Awaited<ReturnType<typeof prisma.settings.findUnique>>>;

function toSettings(row: SettingsRow): AppSettings {
  return {
    defaultModel: row.defaultModel,
    theme: (["dark", "light", "system"].includes(row.theme) ? row.theme : "dark") as AppSettings["theme"],
    temperature: row.temperature,
    topP: row.topP,
    numCtx: row.numCtx,
    systemPrompt: row.systemPrompt,
    fontSize: (["sm", "md", "lg"].includes(row.fontSize) ? row.fontSize : "md") as AppSettings["fontSize"],
    compact: row.compact,
  };
}

/**
 * Read the user's settings row, creating it on first use. Reads dominate, so look first; the insert is
 * `ON CONFLICT DO NOTHING`, which makes simultaneous first requests (a new user's page load fires several)
 * safe. A plain upsert can fail with a unique-key error when two requests race to create the same row.
 */
async function ensureSettings(userId: string): Promise<SettingsRow> {
  const existing = await prisma.settings.findUnique({ where: { id: userId } });
  if (existing) return existing;
  await prisma.settings.createMany({ data: [{ id: userId }], skipDuplicates: true });
  return prisma.settings.findUniqueOrThrow({ where: { id: userId } });
}

export async function getSettings(userId: string): Promise<AppSettings> {
  return toSettings(await ensureSettings(userId));
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export async function updateSettings(userId: string, patch: Partial<AppSettings>): Promise<AppSettings> {
  const data: Partial<AppSettings> = {};
  if (typeof patch.defaultModel === "string") data.defaultModel = patch.defaultModel.slice(0, 200);
  if (patch.theme && ["dark", "light", "system"].includes(patch.theme)) data.theme = patch.theme;
  if (typeof patch.temperature === "number") data.temperature = clamp(patch.temperature, 0, 2);
  if (typeof patch.topP === "number") data.topP = clamp(patch.topP, 0, 1);
  if (typeof patch.numCtx === "number") data.numCtx = Math.round(clamp(patch.numCtx, 512, 131072));
  if (typeof patch.systemPrompt === "string") data.systemPrompt = patch.systemPrompt.slice(0, 20000);
  if (patch.fontSize && ["sm", "md", "lg"].includes(patch.fontSize)) data.fontSize = patch.fontSize;
  if (typeof patch.compact === "boolean") data.compact = patch.compact;
  await ensureSettings(userId);
  return toSettings(await prisma.settings.update({ where: { id: userId }, data }));
}
