// One-off: copy every row from the old SQLite database into the PostgreSQL database in DATABASE_URL.
//   node scripts/migrate-sqlite-to-postgres.mjs <path-to-database.db>
// Stop the app first so nothing writes during the copy. The target must be empty (run `npm run db:migrate` first).
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";

const file = process.argv[2];
if (!file) throw new Error("Usage: node scripts/migrate-sqlite-to-postgres.mjs <path-to-sqlite.db>");
const sqlite = new DatabaseSync(file, { readOnly: true });
const prisma = new PrismaClient();

// Parents before children so foreign keys are satisfied.
const TABLES = [
  { name: "User", model: "user", dates: ["createdAt", "lastLoginAt"], bools: [] },
  { name: "AppConfig", model: "appConfig", dates: [], bools: ["imagesEnabled"] },
  { name: "Settings", model: "settings", dates: [], bools: ["compact"] },
  { name: "Project", model: "project", dates: ["createdAt", "updatedAt"], bools: [] },
  { name: "Conversation", model: "conversation", dates: ["createdAt", "updatedAt"], bools: ["pinned"] },
  { name: "Message", model: "message", dates: ["createdAt"], bools: [] },
  { name: "Image", model: "image", dates: ["createdAt"], bools: [] },
  { name: "Attachment", model: "attachment", dates: ["createdAt"], bools: [] },
  { name: "UsageEvent", model: "usageEvent", dates: ["createdAt"], bools: [] },
  { name: "Document", model: "document", dates: ["createdAt"], bools: [] },
];

const toDate = (v) => (v === null || v === undefined ? null : new Date(typeof v === "number" || /^\d+$/.test(String(v)) ? Number(v) : v));

for (const t of TABLES) {
  if ((await prisma[t.model].count()) > 0) throw new Error(`Target table ${t.name} is not empty. Refusing to import into a database that already has data.`);
}

const report = [];
await prisma.$transaction(
  async (tx) => {
    for (const t of TABLES) {
      const rows = sqlite.prepare(`SELECT * FROM "${t.name}"`).all().map((r) => {
        const o = { ...r };
        for (const d of t.dates) if (d in o) o[d] = toDate(o[d]);
        for (const b of t.bools) if (b in o) o[b] = Boolean(o[b]);
        return o;
      });
      // Insert in batches to stay under PostgreSQL's parameter limit.
      for (let i = 0; i < rows.length; i += 500) await tx[t.model].createMany({ data: rows.slice(i, i + 500) });
      report.push({ table: t.name, sqlite: rows.length });
    }
  },
  { timeout: 120_000 },
);

let ok = true;
for (const r of report) {
  const pg = await prisma[TABLES.find((t) => t.name === r.table).model].count();
  const same = pg === r.sqlite;
  ok &&= same;
  console.log(`${same ? "ok " : "BAD"} ${r.table.padEnd(13)} sqlite=${String(r.sqlite).padStart(5)}  postgres=${String(pg).padStart(5)}`);
}
await prisma.$disconnect();
if (!ok) process.exit(1);
console.log("Import complete and verified.");
