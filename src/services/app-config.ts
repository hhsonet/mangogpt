import "server-only";
import { prisma } from "@/lib/db/prisma";

export type SignupMode = "closed" | "approval" | "open";
export const SIGNUP_MODES: SignupMode[] = ["closed", "approval", "open"];

export async function getSignupMode(): Promise<SignupMode> {
  const row = await prisma.appConfig.upsert({ where: { id: "app" }, update: {}, create: { id: "app" } });
  return SIGNUP_MODES.includes(row.signupMode as SignupMode) ? (row.signupMode as SignupMode) : "approval";
}

export async function setSignupMode(mode: SignupMode): Promise<SignupMode> {
  await prisma.appConfig.upsert({ where: { id: "app" }, update: { signupMode: mode }, create: { id: "app", signupMode: mode } });
  return mode;
}

export async function getImagesEnabled(): Promise<boolean> {
  return (await prisma.appConfig.upsert({ where: { id: "app" }, update: {}, create: { id: "app" } })).imagesEnabled;
}

export async function setImagesEnabled(enabled: boolean): Promise<boolean> {
  await prisma.appConfig.upsert({ where: { id: "app" }, update: { imagesEnabled: enabled }, create: { id: "app", imagesEnabled: enabled } });
  return enabled;
}
