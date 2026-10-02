import "server-only";
import { prisma } from "@/lib/db/prisma";

export type SignupMode = "closed" | "approval" | "open";
export const SIGNUP_MODES: SignupMode[] = ["closed", "approval", "open"];

/** The single config row, created on first use. Read-first, with an insert that tolerates concurrent creators. */
async function config() {
  const existing = await prisma.appConfig.findUnique({ where: { id: "app" } });
  if (existing) return existing;
  await prisma.appConfig.createMany({ data: [{ id: "app" }], skipDuplicates: true });
  return prisma.appConfig.findUniqueOrThrow({ where: { id: "app" } });
}

export async function getSignupMode(): Promise<SignupMode> {
  const row = await config();
  return SIGNUP_MODES.includes(row.signupMode as SignupMode) ? (row.signupMode as SignupMode) : "approval";
}

export async function setSignupMode(mode: SignupMode): Promise<SignupMode> {
  await config();
  await prisma.appConfig.update({ where: { id: "app" }, data: { signupMode: mode } });
  return mode;
}

export async function getImagesEnabled(): Promise<boolean> {
  return (await config()).imagesEnabled;
}

export async function setImagesEnabled(enabled: boolean): Promise<boolean> {
  await config();
  await prisma.appConfig.update({ where: { id: "app" }, data: { imagesEnabled: enabled } });
  return enabled;
}
