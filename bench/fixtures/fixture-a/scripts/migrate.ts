#!/usr/bin/env tsx

const direction = process.argv[2] as "up" | "down" | undefined;
if (!direction || !["up", "down"].includes(direction)) {
  console.error("Usage: migrate.ts <up|down>");
  process.exit(1);
}

console.log(`Running migration: ${direction}`);

// Migration logic placeholder
const migrations = [
  { id: "001", name: "create_plugins_table" },
  { id: "002", name: "add_status_column" },
];

for (const m of migrations) {
  console.log(`  ${direction === "up" ? "Applying" : "Reverting"}: ${m.id}_${m.name}`);
}

console.log("Migration complete.");
