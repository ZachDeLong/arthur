import { describe, it, expect } from "vitest";
import { parseSqlSchema } from "../src/analysis/sql-schema-checker.js";

describe("parseSqlSchema", () => {
  it("extracts basic columns from CREATE TABLE", () => {
    const sql = `CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE
    );`;
    const tables = parseSqlSchema(sql, "test.sql");
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("users");
    expect(tables[0].columns.get("id")).toBe("INTEGER");
    expect(tables[0].columns.get("name")).toBe("TEXT");
    expect(tables[0].columns.get("email")).toBe("TEXT");
  });

  it("handles CHECK constraints with embedded commas", () => {
    const sql = `CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('active', 'inactive', 'pending')),
      amount NUMERIC DEFAULT 0
    );`;
    const tables = parseSqlSchema(sql, "test.sql");
    expect(tables).toHaveLength(1);
    const cols = tables[0].columns;
    expect(cols.get("id")).toBe("INTEGER");
    expect(cols.get("status")).toBe("TEXT");
    expect(cols.get("amount")).toBe("NUMERIC");
    // Should have exactly 3 columns, not more from comma splitting inside CHECK
    expect(cols.size).toBe(3);
  });

  it("handles DEFAULT values with function calls containing commas", () => {
    const sql = `CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      payload TEXT DEFAULT replace('a,b', ',', '-'),
      created_at TIMESTAMP DEFAULT now()
    );`;
    const tables = parseSqlSchema(sql, "test.sql");
    expect(tables).toHaveLength(1);
    const cols = tables[0].columns;
    expect(cols.get("id")).toBe("INTEGER");
    expect(cols.get("payload")).toBe("TEXT");
    expect(cols.get("created_at")).toBe("TIMESTAMP");
    expect(cols.size).toBe(3);
  });

  it("handles table-level CONSTRAINT with commas in expressions", () => {
    const sql = `CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      price NUMERIC NOT NULL,
      discount NUMERIC NOT NULL,
      CONSTRAINT valid_pricing CHECK (price > 0 AND discount IN (0, 5, 10, 15))
    );`;
    const tables = parseSqlSchema(sql, "test.sql");
    expect(tables).toHaveLength(1);
    const cols = tables[0].columns;
    expect(cols.get("id")).toBe("INTEGER");
    expect(cols.get("price")).toBe("NUMERIC");
    expect(cols.get("discount")).toBe("NUMERIC");
    // CONSTRAINT line should be skipped, not produce extra columns
    expect(cols.size).toBe(3);
  });
});
