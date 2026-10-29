require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const multer       = require('multer');
const cloudinary   = require('cloudinary').v2;
const { createClient } = require('@supabase/supabase-js');
const rateLimit    = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 4000;

/* ═══ CLOUDINARY ═══ */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* ═══ SUPABASE ═══ */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/* ═══ USERS (no DB — hardcoded, only 2 accounts ever) ═══ */
const USERS = {
  fidel:    { id: 'fidel',    displayName: 'Fidel',    hash: process.env.FIDEL_PASSWORD_HASH },
  florence: { id: 'florence', displayName: 'Florence', hash: process.env.FLORENCE_PASSWORD_HASH },
};

/* ═══ MIDDLEWARE ═══ */
app.set('trust proxy', 1);
app.use(cors({ origin: '*' }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use(limiter);

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

function uploadToCloudinary(buffer, mimetype) {
  return new Promise((resolve, reject) => {
    const resourceType = mimetype.startsWith('video') ? 'video' : 'image';
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'florence_fidel', resource_type: resourceType },
      (err, result) => err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });
}

/* ═══════════════════════════════════════════
   ROUTES
═══════════════════════════════════════════ */

/* Health check */
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
      mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';
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
  res.json({ comment: data });
});

/* ── GET MESSAGES ── */
app.get('/messages', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
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
      mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';
    }
    if (!text?.trim() && !mediaUrl) return res.status(400).json({ error: 'Empty message' });
    const { data, error } = await supabase
      .from('messages')
      .insert({ user_id: req.user.id, username: req.user.displayName, text: text?.trim() || null, media_url: mediaUrl, media_type: mediaType })
      .select().single();
    if (error) throw error;
    res.json({ message: data });
  } catch (err) {
    console.error('POST /messages error:', JSON.stringify(err));
    res.status(500).json({ error: err.message || 'Failed' });
  }
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

app.listen(PORT, () => {
  console.log(`API running on port ${PORT} 🤍`);
  console.log('Cloudinary cloud:', process.env.CLOUDINARY_CLOUD_NAME || 'MISSING');
  console.log('Supabase URL:', process.env.SUPABASE_URL ? 'set' : 'MISSING');
  console.log('JWT secret:', process.env.JWT_SECRET ? 'set' : 'MISSING');
  console.log('Fidel hash:', process.env.FIDEL_PASSWORD_HASH ? 'set' : 'MISSING');
});
