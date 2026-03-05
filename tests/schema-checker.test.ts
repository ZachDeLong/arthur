import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { parseSchema } from "../src/analysis/schema-checker.js";

describe("parseSchema", () => {
  it("handles large Prisma schemas without timeout", () => {
    let schema = "";
    for (let i = 0; i < 100; i++) {
      schema += `model Model${i} {\n`;
      for (let j = 0; j < 20; j++) {
        schema += `  field${j} String\n`;
      }
      schema += `}\n\n`;
    }

    // Write to a temp file since parseSchema reads from disk
    const tmpFile = path.join(os.tmpdir(), `prisma-bench-${Date.now()}.prisma`);
    fs.writeFileSync(tmpFile, schema);

    try {
      const start = Date.now();
      const result = parseSchema(tmpFile);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
      expect(result.models.size).toBe(100);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("correctly parses fields with various attributes", () => {
    const schema = `
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  posts     Post[]   @relation("UserPosts")
  profile   Profile?
  @@index([email])
}

model Post {
  id        Int      @id @default(autoincrement())
  title     String
  content   String?
  authorId  Int
  author    User     @relation("UserPosts", fields: [authorId], references: [id])
}

model Profile {
  id     Int    @id @default(autoincrement())
  bio    String
  userId Int    @unique
  user   User   @relation(fields: [userId], references: [id])
}

enum Role {
  ADMIN
  USER
}
`;

    const tmpFile = path.join(os.tmpdir(), `prisma-parse-${Date.now()}.prisma`);
    fs.writeFileSync(tmpFile, schema);

    try {
      const result = parseSchema(tmpFile);
      expect(result.models.size).toBe(3);
      expect(result.enums.has("Role")).toBe(true);

      const user = result.models.get("User")!;
      expect(user.accessor).toBe("user");
      expect(user.fields.has("id")).toBe(true);
      expect(user.fields.has("email")).toBe(true);
      expect(user.fields.has("posts")).toBe(true);

      const post = result.models.get("Post")!;
      expect(post.fields.get("author")!.isRelation).toBe(true);
      expect(post.fields.get("author")!.relationModel).toBe("User");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("handles models with inline braces in attributes", () => {
    // Ensure regex handles } characters within lines (not at start of line)
    const schema = `
model Config {
  id      Int    @id @default(autoincrement())
  data    Json   @default("{}")
  meta    String @default("test")
}
`;

    const tmpFile = path.join(os.tmpdir(), `prisma-brace-${Date.now()}.prisma`);
    fs.writeFileSync(tmpFile, schema);

    try {
      const result = parseSchema(tmpFile);
      expect(result.models.size).toBe(1);
      expect(result.models.get("Config")!.fields.has("data")).toBe(true);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
