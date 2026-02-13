CREATE TABLE IF NOT EXISTS participants (
  id SERIAL PRIMARY KEY,
  display_identifier TEXT NOT NULL UNIQUE,
  contact_email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS content_items (
  id SERIAL PRIMARY KEY,
  headline TEXT NOT NULL,
  body_text TEXT,
  author_id INTEGER REFERENCES participants(id),
  published_at TIMESTAMP,
  is_archived BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS engagements (
  id SERIAL PRIMARY KEY,
  participant_id INTEGER REFERENCES participants(id),
  content_item_id INTEGER REFERENCES content_items(id),
  reaction_type TEXT NOT NULL,
  magnitude INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW()
);
