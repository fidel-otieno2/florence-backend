-- Posts table
create table if not exists posts (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,
  username    text not null,
  caption     text,
  media_url   text,
  media_type  text,
  public_id   text,
  created_at  timestamptz default now()
);

-- Reactions table
create table if not exists reactions (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid references posts(id) on delete cascade,
  user_id    text not null,
  username   text not null,
  created_at timestamptz default now(),
  unique(post_id, user_id)
);

-- Comments table
create table if not exists comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid references posts(id) on delete cascade,
  user_id    text not null,
  username   text not null,
  text       text not null,
  created_at timestamptz default now()
);

-- Enable realtime on posts
alter publication supabase_realtime add table posts;
alter publication supabase_realtime add table reactions;
alter publication supabase_realtime add table comments;
