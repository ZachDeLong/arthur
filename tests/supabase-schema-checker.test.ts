import { describe, it, expect } from "vitest";
import { findNearestFrom } from "../src/analysis/supabase-schema-checker.js";

describe("findNearestFrom", () => {
  it("finds a single .from() call before position", () => {
    const text = `.from('users').select('id, name')`;
    // position is at .select(
    const pos = text.indexOf(".select(");
    expect(findNearestFrom(text, pos)).toBe("users");
  });

  it("returns undefined when no .from() exists", () => {
    const text = `.select('id, name')`;
    expect(findNearestFrom(text, text.length)).toBeUndefined();
  });

  it("stops at blank lines (query boundary)", () => {
    const text = `.from('orders').select('id')

.select('name')`;
    // position is at the second .select — separated by blank line
    const pos = text.lastIndexOf(".select(");
    expect(findNearestFrom(text, pos)).toBeUndefined();
  });

  it("finds the LAST .from() when two appear on the same line", () => {
    // This is the bug case: the old regex with (?!.*\.from\() fails here
    const text = `.from('orders').select('id'); .from('users').select('name')`;
    // position is at the second .select('name')
    const pos = text.lastIndexOf(".select(");
    expect(findNearestFrom(text, pos)).toBe("users");
  });

  it("finds the last .from() when multiple appear in nearby lines", () => {
    const text = `supabase.from('orders').select('id')
supabase.from('users').eq('name', 'foo')`;
    const pos = text.indexOf(".eq(");
    expect(findNearestFrom(text, pos)).toBe("users");
  });
});
