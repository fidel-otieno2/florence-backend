const { Client } = require('pg');

const SQL = `
  CREATE TABLE IF NOT EXISTS posts (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    text NOT NULL,
    username   text NOT NULL,
    caption    text,
    media_url  text,
    media_type text,
    public_id  text,
    created_at timestamptz DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS reactions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    text NOT NULL,
    username   text NOT NULL,
    created_at timestamptz DEFAULT now(),
    UNIQUE(post_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id    uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    text NOT NULL,
    username   text NOT NULL,
    text       text NOT NULL,
    created_at timestamptz DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    text NOT NULL,
    username   text NOT NULL,
    text       text,
    media_url  text,
    media_type text,
    created_at timestamptz DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    text NOT NULL UNIQUE,
    subscription jsonb NOT NULL,
    created_at timestamptz DEFAULT now()
  );

  ALTER TABLE posts     DISABLE ROW LEVEL SECURITY;
  ALTER TABLE reactions DISABLE ROW LEVEL SECURITY;
  ALTER TABLE comments  DISABLE ROW LEVEL SECURITY;
  ALTER TABLE messages  DISABLE ROW LEVEL SECURITY;
  ALTER TABLE push_subscriptions DISABLE ROW LEVEL SECURITY;

  DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE posts;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE reactions;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE comments;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE messages;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;

async function migrate() {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  try {
    await client.connect();
    await client.query(SQL);
    console.log('✓ DB migration complete');
  } catch (err) {
    console.error('Migration error:', err.message);
  } finally {
    await client.end();
  }
}

module.exports = migrate;
