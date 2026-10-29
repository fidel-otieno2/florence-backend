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

  CREATE TABLE IF NOT EXISTS profiles (
    user_id    text PRIMARY KEY,
    avatar_url text,
    updated_at timestamptz DEFAULT now()
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

  CREATE TABLE IF NOT EXISTS message_reactions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    text NOT NULL,
    username   text NOT NULL,
    emoji      text NOT NULL,
    created_at timestamptz DEFAULT now(),
    UNIQUE(message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    text NOT NULL,
    subscription jsonb NOT NULL,
    created_at timestamptz DEFAULT now()
  );

  ALTER TABLE push_subscriptions DROP CONSTRAINT IF EXISTS push_subscriptions_user_id_key;
  CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_idx
    ON push_subscriptions ((subscription->>'endpoint'));

  ALTER TABLE posts     DISABLE ROW LEVEL SECURITY;
  ALTER TABLE reactions DISABLE ROW LEVEL SECURITY;
  ALTER TABLE comments  DISABLE ROW LEVEL SECURITY;
  ALTER TABLE messages  DISABLE ROW LEVEL SECURITY;
  ALTER TABLE message_reactions DISABLE ROW LEVEL SECURITY;
  ALTER TABLE push_subscriptions DISABLE ROW LEVEL SECURITY;
  ALTER TABLE profiles DISABLE ROW LEVEL SECURITY;

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
  DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE profiles;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE message_reactions;
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
