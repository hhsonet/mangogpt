import "server-only";
import { prisma } from "@/lib/db/prisma";
import type { AppSettings } from "@/types";

function toSettings(row: Awaited<ReturnType<typeof prisma.settings.upsert>>): AppSettings {
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

export async function getSettings(userId: string): Promise<AppSettings> {
  return toSettings(await prisma.settings.upsert({ where: { id: userId }, update: {}, create: { id: userId } }));
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
  return toSettings(await prisma.settings.upsert({ where: { id: userId }, update: data, create: { id: userId, ...data } }));
}
