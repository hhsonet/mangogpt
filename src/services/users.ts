import "server-only";
import { prisma } from "@/lib/db/prisma";
import { hashPassword } from "@/lib/auth/password";
import { removeUserImageDir } from "@/services/images";
import { removeUserFileDir } from "@/services/attachments";

export type UserStatus = "active" | "pending" | "disabled";
export type UserRole = "admin" | "user";

export interface UserRecord {
  id: string;
  username: string;
  email: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
  conversationCount: number;
}

export class UserError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "bad_request",
  ) {
    super(message);
  }
}

/** Allowed sign-up email domain; a subdomain is required (e.g. name@bscse.uiu.ac.bd). Override with SIGNUP_EMAIL_DOMAIN. */
const EMAIL_DOMAIN = (process.env.SIGNUP_EMAIL_DOMAIN ?? "uiu.ac.bd").toLowerCase();
export const emailDomainHint = `@***.${EMAIL_DOMAIN}`;

export function normalizeEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** Returns a user-facing message when the email is unacceptable, otherwise null. */
export function emailProblem(email: string): string | null {
  const domain = EMAIL_DOMAIN.replace(/\./g, "\\.");
  const re = new RegExp(`^[a-z0-9._%+-]+@([a-z0-9-]+\\.)+${domain}$`);
  if (email.length > 254 || !re.test(email)) return `Use your university email. It should look like name@department.${EMAIL_DOMAIN}.`;
  return null;
}

export const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;
const COMMON = new Set(["password", "password1", "1234567890", "qwertyuiop", "letmein123", "iloveyou12", "admin12345", "mango@999"]);

export function normalizeUsername(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** Returns a user-facing message when the password is unacceptable, otherwise null. */
export function passwordProblem(password: unknown, username: string): string | null {
  if (typeof password !== "string" || password.length < 10) return "Use at least 10 characters. A short phrase of random words works well.";
  if (password.length > 200) return "That password is too long (200 characters max).";
  const lower = password.toLowerCase();
  if (lower.includes(username) && username.length >= 3) return "Your password shouldn't contain your username.";
  if (COMMON.has(lower)) return "That password is too common. Choose something harder to guess.";
  return null;
}

const toRecord = (u: {
  id: string;
  username: string;
  email: string | null;
  role: string;
  status: string;
  createdAt: Date;
  lastLoginAt: Date | null;
  _count: { conversations: number };
}): UserRecord => ({
  id: u.id,
  username: u.username,
  email: u.email,
  role: u.role === "admin" ? "admin" : "user",
  status: (["active", "pending", "disabled"].includes(u.status) ? u.status : "disabled") as UserStatus,
  createdAt: u.createdAt.toISOString(),
  lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  conversationCount: u._count.conversations,
});

export async function listUsers(): Promise<UserRecord[]> {
  const rows = await prisma.user.findMany({
    where: { username: { not: "local" } },
    include: { _count: { select: { conversations: true } } },
    orderBy: [{ createdAt: "asc" }],
  });
  const rank = { pending: 0, active: 1, disabled: 2 } as const;
  return rows.map(toRecord).sort((a, b) => rank[a.status] - rank[b.status] || a.createdAt.localeCompare(b.createdAt));
}

export async function createUser(input: { username: string; email?: string; requireEmail?: boolean; password: string; role?: UserRole; status?: UserStatus }) {
  const username = normalizeUsername(input.username);
  if (!USERNAME_RE.test(username) || username === "local") throw new UserError("Use 2–32 letters, numbers, dots, dashes or underscores.");
  const email = normalizeEmail(input.email);
  if (email || input.requireEmail) {
    const emailErr = emailProblem(email);
    if (emailErr) throw new UserError(emailErr, 400, "bad_email");
  }
  const problem = passwordProblem(input.password, username);
  if (problem) throw new UserError(problem, 400, "weak_password");
  if (await prisma.user.findUnique({ where: { username } })) throw new UserError("That username is taken. Try another.", 409, "username_taken");
  if (email && (await prisma.user.findUnique({ where: { email } }))) throw new UserError("An account with that email already exists. Try signing in instead.", 409, "email_taken");
  // The checks above can race with a concurrent request; the unique indexes are the real guarantee,
  // so translate a violation into the same friendly error.
  const duplicate = (err: unknown) => {
    const e = err as { code?: string; meta?: { target?: unknown } };
    if (e?.code !== "P2002") return err;
    const target = JSON.stringify(e.meta?.target ?? "");
    return target.includes("email")
      ? new UserError("An account with that email already exists. Try signing in instead.", 409, "email_taken")
      : new UserError("That username is taken. Try another.", 409, "username_taken");
  };
  return prisma.user.create({
    data: { username, email: email || null, passwordHash: await hashPassword(input.password), role: input.role ?? "user", status: input.status ?? "active" },
    include: { _count: { select: { conversations: true } } },
  }).catch((err) => {
    throw duplicate(err);
  });
}

async function activeAdminCount() {
  return prisma.user.count({ where: { role: "admin", status: "active", username: { not: "local" } } });
}

export async function updateUser(
  actorId: string,
  id: string,
  patch: { role?: UserRole; status?: UserStatus; password?: string },
): Promise<UserRecord> {
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target || target.username === "local") throw new UserError("User not found.", 404);
  const isSelf = actorId === id;

  const data: { role?: string; status?: string; passwordHash?: string } = {};
  if (patch.role !== undefined) {
    if (!["admin", "user"].includes(patch.role)) throw new UserError("Invalid role.");
    if (isSelf && patch.role !== "admin") throw new UserError("You can't remove your own admin role.", 409);
    data.role = patch.role;
  }
  if (patch.status !== undefined) {
    if (!["active", "pending", "disabled"].includes(patch.status)) throw new UserError("Invalid status.");
    if (isSelf && patch.status !== "active") throw new UserError("You can't disable your own account.", 409);
    data.status = patch.status;
  }
  if (patch.password !== undefined) {
    const problem = passwordProblem(patch.password, target.username);
    if (problem) throw new UserError(problem, 400, "weak_password");
    data.passwordHash = await hashPassword(patch.password);
  }
  // Never leave the system without an active admin.
  const losesAdmin = target.role === "admin" && target.status === "active" && ((data.role && data.role !== "admin") || (data.status && data.status !== "active"));
  if (losesAdmin && (await activeAdminCount()) <= 1) throw new UserError("At least one active admin is required.", 409);

  const updated = await prisma.user.update({ where: { id }, data, include: { _count: { select: { conversations: true } } } });
  return toRecord(updated);
}

export async function deleteUser(actorId: string, id: string): Promise<void> {
  if (actorId === id) throw new UserError("You can't delete your own account.", 409);
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target || target.username === "local") throw new UserError("User not found.", 404);
  if (target.role === "admin" && target.status === "active" && (await activeAdminCount()) <= 1) {
    throw new UserError("At least one active admin is required.", 409);
  }
  await prisma.user.delete({ where: { id } }); // conversations, messages, projects, image rows cascade
  await prisma.settings.deleteMany({ where: { id } }); // keyed by user id with no foreign key, so remove it explicitly
  await removeUserImageDir(id);
  await removeUserFileDir(id);
}
