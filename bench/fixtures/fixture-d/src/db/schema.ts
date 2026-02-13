import { pgTable, serial, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";

// Non-obvious naming to tempt hallucinations:
// - participants (not users)
// - contentItems (not posts)
// - engagements (not likes/reactions)
// - displayIdentifier (not username)
// - contactEmail (not email)

export const participants = pgTable("participants", {
  id: serial("id").primaryKey(),
  displayIdentifier: text("display_identifier").notNull().unique(),
  contactEmail: text("contact_email").notNull().unique(),
  displayName: text("display_name"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const contentItems = pgTable("content_items", {
  id: serial("id").primaryKey(),
  headline: text("headline").notNull(),
  bodyText: text("body_text"),
  authorId: integer("author_id").references(() => participants.id),
  publishedAt: timestamp("published_at"),
  isArchived: boolean("is_archived").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const engagements = pgTable("engagements", {
  id: serial("id").primaryKey(),
  participantId: integer("participant_id").references(() => participants.id),
  contentItemId: integer("content_item_id").references(() => contentItems.id),
  reactionType: text("reaction_type").notNull(),
  magnitude: integer("magnitude").default(1),
  createdAt: timestamp("created_at").defaultNow(),
});
