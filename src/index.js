require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const multer       = require('multer');
const cloudinary   = require('cloudinary').v2;
const { createClient } = require('@supabase/supabase-js');
const rateLimit    = require('express-rate-limit');
const webpush      = require('web-push');
const migrate      = require('./migrate');

const app  = express();
const PORT = process.env.PORT || 4000;

/* ═══ CLOUDINARY ═══ */
cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME });

/* ═══ SUPABASE ═══ */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/* ═══ WEB PUSH ═══ */
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:fidelmartins05@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);
}

const avatarCache = {};

async function getAvatarUrl(userId) {
  if (avatarCache[userId]) return avatarCache[userId];
  const { data } = await supabase.from('profiles').select('avatar_url').eq('user_id', userId).single();
  if (data?.avatar_url) avatarCache[userId] = data.avatar_url;
  return data?.avatar_url || null;
}

function notifyOther(senderUserId, payload) {
  setImmediate(() => {
    pushToOther(senderUserId, payload).catch(err => console.error('push error:', err.message));
  });
}

async function pushToOther(senderUserId, payload) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  const otherId = senderUserId === 'fidel' ? 'florence' : 'fidel';
  const [rowsResult, icon] = await Promise.all([
    supabase.from('push_subscriptions').select('id, subscription').eq('user_id', otherId),
    getAvatarUrl(senderUserId),
  ]);
  const rows = rowsResult.data;
  if (!rows?.length) return;
  const body = JSON.stringify({
    ...payload,
    icon: icon || payload.icon,
    tag: `${payload.url || 'florish'}-${Date.now()}`,
  });
  await Promise.all(rows.map(async (row) => {
    try {
      await webpush.sendNotification(row.subscription, body, { urgency: 'high', TTL: 86400 });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await supabase.from('push_subscriptions').delete().eq('id', row.id);
      } else {
        console.error('push error:', err.statusCode, err.message);
      }
    }
  }));
}

/* ═══ USERS (no DB — hardcoded, only 2 accounts ever) ═══ */
const USERS = {
  fidel:    { id: 'fidel',    displayName: 'Fidel',    hash: process.env.FIDEL_PASSWORD_HASH },
  florence: { id: 'florence', displayName: 'Florence', hash: process.env.FLORENCE_PASSWORD_HASH },
};

/* ═══ MIDDLEWARE ═══ */
app.set('trust proxy', 1);
app.use(cors({ origin: '*' }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 800 });
app.use((req, res, next) => {
  if (req.path.startsWith('/push')) return next();
  return limiter(req, res, next);
});

/* ═══ AUTH MIDDLEWARE ═══ */
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No token' });
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

/* ═══ MULTER (memory storage → cloudinary) ═══ */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

function cloudinaryType(mimetype) {
  if (mimetype.startsWith('video') || mimetype.startsWith('audio')) return 'video';
  return 'image';
}

function mediaKind(mimetype) {
  if (mimetype.startsWith('audio')) return 'audio';
  if (mimetype.startsWith('video')) return 'video';
  return 'image';
}

function uploadToCloudinary(buffer, mimetype) {
  const b64 = `data:${mimetype};base64,${buffer.toString('base64')}`;
  return cloudinary.uploader.unsigned_upload(b64, process.env.CLOUDINARY_UPLOAD_PRESET, {
    resource_type: cloudinaryType(mimetype),
  }).catch(err => { throw new Error(`Cloudinary: ${JSON.stringify(err.error || err)}`); });
}

/* ═══════════════════════════════════════════
   ROUTES
═══════════════════════════════════════════ */

/* ── VAPID PUBLIC KEY ── */
app.get('/push/vapid-key', (_, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

/* ── SAVE PUSH SUBSCRIPTION ── */
app.post('/push/subscribe', authMiddleware, async (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'No subscription' });
  const { data: existing } = await supabase
    .from('push_subscriptions')
    .select('id')
    .eq('subscription->>endpoint', subscription.endpoint)
    .maybeSingle();
  if (existing) {
    await supabase.from('push_subscriptions').update({ user_id: req.user.id, subscription }).eq('id', existing.id);
  } else {
    await supabase.from('push_subscriptions').insert({ user_id: req.user.id, subscription });
  }
  res.json({ ok: true });
});

/* ── HEALTH CHECK ── */
app.get('/', (_, res) => res.json({ status: 'Florence & Fidel API running 🤍' }));

/* ── LOGIN ── */
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

  const user = USERS[username.toLowerCase().trim()];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { id: user.id, displayName: user.displayName },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );

  res.json({ token, user: { id: user.id, displayName: user.displayName } });
});

/* ── VERIFY TOKEN ── */
app.get('/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

/* ── UPLOAD MEDIA ── */
app.post('/posts', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const { caption } = req.body;
    let mediaUrl = null, mediaType = null, publicId = null;

    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, req.file.mimetype);
      mediaUrl  = result.secure_url;
      publicId  = result.public_id;
      mediaType = mediaKind(req.file.mimetype);
    }

    const { data, error } = await supabase
      .from('posts')
      .insert({
        user_id:    req.user.id,
        username:   req.user.displayName,
        caption:    caption || null,
        media_url:  mediaUrl,
        media_type: mediaType,
        public_id:  publicId,
      })
      .select()
      .single();

    if (error) throw error;
    notifyOther(req.user.id, {
      title: `FloRish 🤍`,
      body: `${req.user.displayName} posted a new memory`,
      url: '/gallery',
    });
    res.json({ post: data });
  } catch (err) {
    console.error('POST /posts error:', JSON.stringify(err));
    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

/* ── GET ALL POSTS ── */
app.get('/posts', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('posts')
    .select('*, reactions(*), comments(*)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ posts: data });
});

/* ── DELETE POST ── */
app.delete('/posts/:id', authMiddleware, async (req, res) => {
  const { data: post } = await supabase
    .from('posts')
    .select('user_id, public_id, media_type')
    .eq('id', req.params.id)
    .single();

  if (!post) return res.status(404).json({ error: 'Not found' });
  if (post.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  if (post.public_id) {
    await cloudinary.uploader.destroy(post.public_id, {
      resource_type: post.media_type === 'video' ? 'video' : 'image'
    });
  }

  await supabase.from('posts').delete().eq('id', req.params.id);
  res.json({ success: true });
});

/* ── REACT TO POST ── */
app.post('/posts/:id/react', authMiddleware, async (req, res) => {
  const { data: existing } = await supabase
    .from('reactions')
    .select('id')
    .eq('post_id', req.params.id)
    .eq('user_id', req.user.id)
    .single();

  if (existing) {
    await supabase.from('reactions').delete().eq('id', existing.id);
    return res.json({ action: 'removed' });
  }

  await supabase.from('reactions').insert({
    post_id: req.params.id,
    user_id: req.user.id,
    username: req.user.displayName,
  });
  notifyOther(req.user.id, {
    title: `FloRish 🤍`,
    body: `${req.user.displayName} liked a memory`,
    url: '/gallery',
  });
  res.json({ action: 'added' });
});

/* ── COMMENT ON POST ── */
app.post('/posts/:id/comments', authMiddleware, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Empty comment' });

  const { data, error } = await supabase
    .from('comments')
    .insert({
      post_id:  req.params.id,
      user_id:  req.user.id,
      username: req.user.displayName,
      text:     text.trim(),
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  notifyOther(req.user.id, {
    title: `FloRish 🤍`,
    body: `${req.user.displayName}: ${data.text}`,
    url: '/gallery',
  });
  res.json({ comment: data });
});

/* ── GET ALL PROFILES ── */
app.get('/profiles', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('profiles').select('*');
  res.json({ profiles: data || [] });
});

/* ── GET PROFILE ── */
app.get('/profile', authMiddleware, async (req, res) => {
  const { data } = await supabase.from('profiles').select('*').eq('user_id', req.user.id).single();
  res.json({ profile: data || { user_id: req.user.id, avatar_url: null } });
});

/* ── UPLOAD AVATAR ── */
app.post('/profile/avatar', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    if (!req.file.mimetype.startsWith('image')) return res.status(400).json({ error: 'Image only' });
    const result = await uploadToCloudinary(req.file.buffer, req.file.mimetype);
    avatarCache[req.user.id] = result.secure_url;
    await supabase.from('profiles').upsert({ user_id: req.user.id, avatar_url: result.secure_url, updated_at: new Date() }, { onConflict: 'user_id' });
    res.json({ avatar_url: result.secure_url });
  } catch (err) {
    console.error('avatar upload error:', JSON.stringify(err));
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

/* ── GET MESSAGES ── */
app.get('/messages', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*, message_reactions(*)')
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ messages: data });
});

/* ── SEND MESSAGE ── */
app.post('/messages', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const { text } = req.body;
    let mediaUrl = null, mediaType = null;
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, req.file.mimetype);
      mediaUrl  = result.secure_url;
      mediaType = mediaKind(req.file.mimetype);
    }
    if (!text?.trim() && !mediaUrl) return res.status(400).json({ error: 'Empty message' });
    const { data, error } = await supabase
      .from('messages')
      .insert({ user_id: req.user.id, username: req.user.displayName, text: text?.trim() || null, media_url: mediaUrl, media_type: mediaType })
      .select('*, message_reactions(*)').single();
    if (error) throw error;
    const preview = data.text
      || (data.media_type === 'audio' ? '🎤 Sent a voice note' : data.media_type === 'video' ? '🎥 Sent a video' : '📸 Sent a photo');
    notifyOther(req.user.id, {
      title: `${req.user.displayName} 🤍`,
      body: preview,
      url: '/chat',
    });
    res.json({ message: data });
  } catch (err) {
    console.error('POST /messages error:', JSON.stringify(err));
    res.status(500).json({ error: err.message || 'Failed' });
  }
});

/* ── REACT TO MESSAGE ── */
app.post('/messages/:id/react', authMiddleware, async (req, res) => {
  const emoji = (req.body.emoji || '').trim();
  if (!emoji) return res.status(400).json({ error: 'No emoji' });

  const { data: existing } = await supabase
    .from('message_reactions')
    .select('id, emoji')
    .eq('message_id', req.params.id)
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (existing && existing.emoji === emoji) {
    await supabase.from('message_reactions').delete().eq('id', existing.id);
    return res.json({ action: 'removed' });
  }

  if (existing) {
    await supabase.from('message_reactions').update({ emoji, username: req.user.displayName }).eq('id', existing.id);
  } else {
    const { error } = await supabase.from('message_reactions').insert({
      message_id: req.params.id,
      user_id: req.user.id,
      username: req.user.displayName,
      emoji,
    });
    if (error) return res.status(500).json({ error: error.message });
  }

  const { data: msg } = await supabase.from('messages').select('user_id').eq('id', req.params.id).single();
  if (msg && msg.user_id !== req.user.id) {
    notifyOther(req.user.id, {
      title: `${req.user.displayName} 🤍`,
      body: `Reacted ${emoji} to your message`,
      url: '/chat',
    });
  }
  res.json({ action: 'added', emoji });
});

/* ── DELETE COMMENT ── */
app.delete('/comments/:id', authMiddleware, async (req, res) => {
  const { data: comment } = await supabase
    .from('comments')
    .select('user_id')
    .eq('id', req.params.id)
    .single();

  if (!comment) return res.status(404).json({ error: 'Not found' });
  if (comment.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  await supabase.from('comments').delete().eq('id', req.params.id);
  res.json({ success: true });
});

app.listen(PORT, async () => {
  await migrate();
  console.log(`API running on port ${PORT} 🤍`);
  console.log('Cloudinary cloud:', process.env.CLOUDINARY_CLOUD_NAME || 'MISSING');
  console.log('Supabase URL:', process.env.SUPABASE_URL ? 'set' : 'MISSING');
  console.log('JWT secret:', process.env.JWT_SECRET ? 'set' : 'MISSING');
  console.log('Fidel hash:', process.env.FIDEL_PASSWORD_HASH ? 'set' : 'MISSING');
});
