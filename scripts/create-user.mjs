// Create or update a user. Credentials come from the environment so they stay out of shell history/ps:
//   APP_USER=admin APP_PASS='…' APP_ROLE=admin node scripts/create-user.mjs
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password.ts";

const username = process.env.APP_USER?.trim().toLowerCase();
const password = process.env.APP_PASS;
const role = process.env.APP_ROLE === "admin" ? "admin" : "user";

if (!username || !/^[a-z0-9._-]{2,32}$/.test(username)) throw new Error("APP_USER must be 2-32 chars of a-z 0-9 . _ -");
if (!password || password.length < 8) throw new Error("APP_PASS must be at least 8 characters");

const prisma = new PrismaClient();
const passwordHash = await hashPassword(password);
const user = await prisma.user.upsert({ where: { username }, update: { passwordHash, role, status: "active" }, create: { username, passwordHash, role, status: "active" } });
console.log(`${role} user "${user.username}" saved.`);
await prisma.$disconnect();
