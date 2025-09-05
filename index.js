const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const https = require('https');
const session = require('express-session');
const mongoose = require('mongoose');
const multer = require('multer');
// optional GridFS storage for durable uploads (enable with USE_GRIDFS=1)
const { GridFsStorage } = require('multer-gridfs-storage');
const fs = require('fs');
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || '';

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// expose configurable logo height to views (px)
app.locals.logoHeight = process.env.LOGO_HEIGHT || '80';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change_this_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 } // 1h
  })
);

// make current session user available to all templates
app.use((req, res, next) => {
  res.locals.user = req.session && req.session.user ? req.session.user : null;
  next();
});

// ensure header/top-bar locals exist for all renders (prevents ReferenceErrors)
app.use((req, res, next) => {
  try {
    if (typeof res.locals.topBarDate === 'undefined' || !res.locals.topBarDate) {
      const d = new Date();
      res.locals.topBarDate = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    }
    if (typeof res.locals.topBarList === 'undefined' || !Array.isArray(res.locals.topBarList)) {
      res.locals.topBarList = [];
    }
  } catch (e) {
    // non-fatal
    res.locals.topBarDate = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    res.locals.topBarList = [];
  }
  next();
});

// ensure upload directory exists (public/upload)
const uploadDir = path.join(__dirname, 'public', 'upload');
try { fs.mkdirSync(uploadDir, { recursive: true }); } catch (e) { /* ignore */ }

// MongoDB connection and Disk storage setup
let Article;
let Comment;
let upload;
let gridfsBucket = null; // GridFSBucket instance when using DB-backed storage
let gfs; // kept for backwards compatibility variable (not used for GridFS now)

async function initDbAndStorage() {
  // connect mongoose (drop deprecated options)
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true });
  console.log('Connected to MongoDB');

  // Define schemas and models if not already defined
  try {
    const ArticleSchema = new mongoose.Schema(
      {
        title: { type: String, required: true },
        slug: { type: String, index: true, unique: false },
        categories: { type: [String], default: [] }, 
        tags: { type: [String], default: [] },
        content: { type: String },
        featuredImageId: { type: String },
        mediaIds: { type: [String], default: [] },
        excerpt: { type: String },
        metaTitle: { type: String },
        metaDescription: { type: String },
        seoKeywords: { type: [String], default: [] },
        author: { type: String },
        status: { type: String, enum: ['draft', 'pending', 'published'], default: 'draft', index: true },
        scheduleAt: { type: Date },
        featured: { type: Boolean, default: false },
        location: { type: String },
        source: { type: String },
        commentsEnabled: { type: Boolean, default: true },
        // persist comments as embedded subdocuments so frontend adds survive refresh
        comments: {
          type: [
            {
              _id: { type: mongoose.Schema.Types.ObjectId, required: true },
              parentId: { type: String, default: null },
              author: { type: String, default: 'Anonymous' },
              text: { type: String },
              createdAt: { type: Date, default: Date.now }
            }
          ],
          default: []
        }
      },
      { timestamps: true }
    );

    // Not forcing unique slug to avoid conflicts during edits; ensure an index for faster lookups
    ArticleSchema.index({ slug: 1 }, { unique: false, sparse: true });
    ArticleSchema.index({ createdAt: -1 });
    ArticleSchema.index({ status: 1, createdAt: -1 });

    const CommentSchema = new mongoose.Schema(
      {
        articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Article', index: true },
        name: { type: String },
        body: { type: String },
        approved: { type: Boolean, default: true }
      },
      { timestamps: true }
    );

    Article = mongoose.models.Article || mongoose.model('Article', ArticleSchema);
    Comment = mongoose.models.Comment || mongoose.model('Comment', CommentSchema);

    // Setup user routes
    setupUserRoutes(app, Article);
  } catch (e) {
    console.error('Model initialization error:', e);
  }

  // Choose storage: GridFS (durable in Mongo) when enabled, otherwise disk under public/upload
  if (process.env.USE_GRIDFS === '1' && MONGODB_URI) {
    const storage = new GridFsStorage({
      url: MONGODB_URI,
      options: { useNewUrlParser: true, useUnifiedTopology: true },
      file: (req, file) => {
        const ext = path.extname(file.originalname || '');
        const filename = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
        return {
          filename,
          bucketName: 'uploads'
        };
      }
    });
    upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });
    // setup GridFSBucket for streaming later
    try {
      gridfsBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });
    } catch (e) {
      console.warn('GridFS bucket init failed:', e && e.message ? e.message : e);
      gridfsBucket = null;
    }
  } else {
    // Use multer disk storage to save files under public/upload
    upload = multer({
      storage: multer.diskStorage({
        destination: function (req, file, cb) {
          cb(null, uploadDir);
        },
        filename: function (req, file, cb) {
          const ext = path.extname(file.originalname || '');
          const base = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          cb(null, base + ext);
        }
      }),
      limits: { fileSize: 20 * 1024 * 1024 } // 20MB max
    });
  }
}

initDbAndStorage().catch((e) => console.error('Initialization error:', e));

// Replace /admin/upload handler to use disk storage
app.post('/admin/upload',
  (req, res, next) => {
    if (!upload) return res.status(503).send('File storage not initialized');
    upload.single('image')(req, res, function (err) {
      if (err) {
        console.error('Upload middleware error:', err);
        return res.status(500).send('Upload error');
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).send('No file uploaded');
      // Respond with public path and filename
      const publicPath = `/upload/${req.file.filename}`;
      return res.json({ success: true, filename: req.file.filename, url: publicPath });
    } catch (err) {
      console.error('Upload error:', err);
      res.status(500).send('Upload failed');
    }
  }
);

// Helpers
function ensureAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/login-admin');
}

// helpers for auth
function ensureAuthenticated(req, res, next) {
  if (req.session && req.session.user) return next();
  // save intended url and redirect to login
  req.session.redirectAfterLogin = req.originalUrl || '/';
  return res.redirect('/login');
}

// Dashboard - simple user area
app.get('/dashboard', ensureAuthenticated, async (req, res) => {
  try {
    const user = req.session.user || null;
    // basic stats for dashboard (safe if models not initialized yet)
    const stats = {
      articles: 0,
      comments: 0,
      users: 0
    };
    try {
      if (typeof Article !== 'undefined' && Article) stats.articles = await Article.countDocuments({});
      if (typeof Comment !== 'undefined' && Comment) stats.comments = await Comment.countDocuments({});
      if (typeof User !== 'undefined' && User) stats.users = await User.countDocuments({});
    } catch (e) {
      console.error('Dashboard stats error:', e);
    }

    return res.render('dashboard', {
      title: 'Dashboard - ViralSurge',
      user,
      stats
    });
  } catch (e) {
    console.error('Dashboard error:', e);
    return res.status(500).send('Server error');
  }
});

// Routes
app.get('/', async (req, res) => {
  try {
    let hero = null;
    let articles = [];
    if (Article) {
      hero = await Article.findOne({ status: 'published' }).sort({ createdAt: -1 }).lean();
      const excludeId = hero ? hero._id : null;
      const q = excludeId
        ? { status: 'published', _id: { $ne: excludeId } }
        : { status: 'published' };
      articles = await Article.find(q, {
        _id: 1,
        title: 1,
        slug: 1,
        excerpt: 1,
        categories: 1,
        author: 1,
        createdAt: 1,
        featuredImageId: 1
      }).sort({ createdAt: -1 }).limit(8).lean();

      // normalize ids to strings so templates can safely render them
      articles = (articles || []).map(a => ({ ...a, _id: String(a._id) }));
      if (hero && hero._id) hero._id = String(hero._id);
    }
    const heroImageUrl = hero && hero.featuredImageId
      ? `/upload/${hero.featuredImageId}`
      : 'https://images.unsplash.com/photo-1495020689067-958852a7765e?ixlib=rb-4.0.3&auto=format&fit=crop&w=1600&q=80';

    // compute top bar source: the latest published article that has a picture (featuredImageId)
    let topBarSource = null;
    let topBarList = [];
    // ensure categoriesLatest is always defined (prevents ReferenceError later)
    let categoriesLatest = [];
    try {
      if (Article) {
        topBarSource = await Article.findOne({
          status: 'published',
          featuredImageId: { $exists: true, $ne: null, $ne: '' }
        })
          .sort({ createdAt: -1 })
          .select('createdAt featuredImageId title slug')
          .lean();

        // Also fetch the latest published articles for the BREAKING ticker
        const latest = await Article.find({ status: 'published' })
          .sort({ createdAt: -1 })
          .limit(10)
          .select('_id title slug createdAt')
          .lean();
        topBarList = (latest || []).map(it => ({
          title: it.title,
          href: it.slug ? `/a/${it.slug}` : (it._id ? `/a/${String(it._id)}` : '#'),
          createdAt: it.createdAt
        }));

        // --- new: fetch latest article per category (for "More News") ---
        try {
          if (Article) {
            const cats = (await Article.distinct('categories')) || [];
            // limit to 6 categories, parallel fetch latest article for each
            const limited = cats.filter(Boolean).slice(0, 6);
            const rows = await Promise.all(
              limited.map(async (cat) => {
                const art = await Article.findOne({ status: 'published', categories: cat })
                  .sort({ createdAt: -1 })
                  .select('_id title slug excerpt createdAt featuredImageId')
                  .lean();
                return art ? { category: cat, article: art } : null;
              })
            );
            categoriesLatest = (rows || []).filter(Boolean);
          }
        } catch (e) {
          console.error('Categories latest lookup error:', e);
        }
        // --- end new ---
      }
    } catch (e) {
      console.error('Top bar lookup error:', e);
    }

    // Fallback to the latest article overall or today
    if (!topBarSource && Article) {
      try {
        const latest = await Article.findOne({}).sort({ createdAt: -1 }).select('createdAt title slug featuredImageId').lean();
        if (latest) topBarSource = latest;
      } catch (e) {
        console.error('Top bar fallback lookup error:', e);
      }
    }

    let topBarDate = new Date();
    let topBarImage = null;
    let topBarTitle = null;
    let topBarLink = null;
    if (topBarSource && topBarSource.createdAt) topBarDate = new Date(topBarSource.createdAt);
    if (topBarSource && topBarSource.featuredImageId) topBarImage = `/upload/${topBarSource.featuredImageId}`;
    if (topBarSource && topBarSource.title) topBarTitle = topBarSource.title;
    // Build a link to the article — prefer slug, fallback to id
    if (topBarSource) {
      if (topBarSource.slug) topBarLink = `/a/${topBarSource.slug}`;
      else if (topBarSource._id) topBarLink = `/a/${topBarSource._id}`;
    }

    const formatLongDate = (d) =>
      d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const topBarDateFormatted = formatLongDate(topBarDate);

    // compute Most Read for today (articles published today, sorted by views)
    let mostReadList = [];
    try {
      if (Article) {
        const startOfDay = new Date();
        startOfDay.setHours(0,0,0,0);
        mostReadList = await Article.find({ status: 'published', createdAt: { $gte: startOfDay } })
          .sort({ views: -1, createdAt: -1 })
          .limit(5)
          .select('_id title slug createdAt views')
          .lean();
      }
    } catch (err) {
      console.error('Most read (index) lookup error:', err);
      mostReadList = [];
    }

    // pass logoHeight and topBar data to the template
    res.render('index', {
      title: 'ViralSurge',
      hero,
      heroImageUrl,
      articles,
      mostReadList,
      logoHeight: app.locals.logoHeight,
      topBarDate: topBarDateFormatted,
      topBarImage,
      topBarTitle,
      topBarLink,
      topBarList,
      // pass categoriesLatest for "More News" section
      categoriesLatest,
    });
  } catch (e) {
    console.error('Index route error:', e);
    const fallbackDate = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    res.render('index', {
      title: 'ViralSurge',
      hero: null,
      heroImageUrl: 'https://images.unsplash.com/photo-1495020689067-958852a7765e?ixlib=rb-4.0.3&auto=format&fit=crop&w=1600&q=80',
      articles: [],
      logoHeight: app.locals.logoHeight,
      topBarDate: fallbackDate,
      topBarImage: null,
      topBarTitle: null,
      topBarLink: null
    });
  }
});

// Article detail by slug
app.get('/a/:slug', async (req, res) => {
  try {
    if (!Article) return res.status(503).send('Database not initialized');
    const { slug } = req.params;
    let article = await Article.findOne({ slug }).lean();
    if (!article) {
      // fallback: try by ObjectId
      try {
        const maybeId = new mongoose.Types.ObjectId(slug);
        article = await Article.findById(maybeId).lean();
      } catch (_) {}
    }
    if (!article) return res.status(404).send('Article not found');

    const imageUrl = article.featuredImageId ? `/media/${article.featuredImageId}` : null;
    // Build header data for the partial
    let topBarList = [];
    try {
      if (Article) {
        const latest = await Article.find({ status: 'published' })
          .sort({ createdAt: -1 })
          .limit(10)
          .select('_id title slug createdAt')
          .lean();
        topBarList = (latest || []).map(it => ({
          title: it.title,
          href: it.slug ? `/a/${it.slug}` : (it._id ? `/a/${String(it._id)}` : '#'),
          createdAt: it.createdAt
        }));
      }
    } catch (e) {
      console.error('Article route top bar list error:', e);
    }

    const formatLongDate = (d) =>
      d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const topBarDate = article && article.createdAt ? new Date(article.createdAt) : new Date();
    const topBarDateFormatted = formatLongDate(topBarDate);

    res.render('article', {
      title: article.metaTitle || article.title,
      article,
      imageUrl,
      topBarDate: topBarDateFormatted,
      topBarList
    });
  } catch (e) {
    console.error('Article detail error:', e);
    return res.status(500).send('Server error');
  }
});

// simple South Africa section route (/sa)
app.get('/sa', async (req, res) => {
  try {
    const categoryName = 'SA';
    let hero = null;
    let articles = [];
    let mostReadList = [];
    let moreInCategory = [];
    let heroImageUrl = '';

    if (Article) {
      hero = await Article.findOne({ status: 'published', categories: categoryName }).sort({ createdAt: -1 }).lean();
      const excludeId = hero ? hero._id : null;
      const q = excludeId ? { status: 'published', categories: categoryName, _id: { $ne: excludeId } } : { status: 'published', categories: categoryName };
      articles = await Article.find(q).sort({ createdAt: -1 }).limit(20).lean();
      articles = (articles || []).map(a => ({ ...a, _id: String(a._id) }));
      if (hero && hero._id) hero._id = String(hero._id);
      heroImageUrl = hero && hero.featuredImageId ? `/upload/${hero.featuredImageId}` : '';

      mostReadList = await Article.find({ status: 'published', categories: categoryName }).sort({ views: -1 }).limit(5).select('_id title slug createdAt views').lean();
      moreInCategory = await Article.find({ status: 'published', categories: categoryName }).sort({ createdAt: -1 }).limit(6).select('_id title slug createdAt').lean();
    }

    // top bar data
    const topBarList = res.locals.topBarList || [];
    const topBarDate = res.locals.topBarDate || formatLongDate();

    res.render('sa', {
      title: 'SA - ViralSurge',
      categoryName,
      subtitle: '',
      hero,
      heroImageUrl,
      articles,
      mostReadList,
      moreInCategory,
      topBarDate,
      topBarList
    });
  } catch (e) {
    console.error('SA route error:', e);
    res.status(500).send('Server error');
  }
});

// 404 handler was moved to the end of this file to avoid catching routes defined after it

// Stream a file from upload folder (keep for compatibility with any /media usage)
app.get('/media/:filename', async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(uploadDir, filename);
    if (fs.existsSync(filePath)) return res.sendFile(filePath);

    // Fallback: if using GridFS, try to stream the file from DB
    if (gridfsBucket) {
      try {
        const filter = { filename };
        const cursor = mongoose.connection.db.collection('uploads.files').find(filter).limit(1);
        const fileDoc = await cursor.next();
        if (!fileDoc) return res.status(404).send('File not found');
        res.setHeader('Content-Type', fileDoc.contentType || 'application/octet-stream');
        const readStream = gridfsBucket.openDownloadStreamByName(filename);
        return readStream.pipe(res);
      } catch (e) {
        console.error('GridFS media stream error:', e);
        return res.status(500).send('Error streaming file');
      }
    }
    return res.status(404).send('File not found');
  } catch (e) {
    console.error('Media route error:', e);
    return res.status(400).send('Invalid request');
  }
});

app.get('/login-admin', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  const { error } = req.query;
  res.render('login-admin', { title: 'Admin Login', error });
});

app.post('/login-admin', (req, res) => {
  const { username, password } = req.body;
  const expectedUser = process.env.ADMIN_USER || 'admin';
  const expectedPass = process.env.ADMIN_PASSWORD || 'admin';

  if (username === expectedUser && password === expectedPass) {
    req.session.isAdmin = true;
    req.session.user = { name: username };
    return res.redirect('/admin');
  }
  return res.redirect('/login-admin?error=Invalid%20credentials');
});

app.get('/admin', ensureAdmin, async (req, res) => {
  try {
    // Default metrics if DB is not ready
    let metrics = {
      totalPublished: 0,
      pendingCount: 0,
      categoriesCount: 0,
      commentsCount: 0
    };

    if (Article) {
      const [totalPublished, pendingCount, distinctCategories] = await Promise.all([
        Article.countDocuments({ status: 'published' }),
        Article.countDocuments({ status: 'pending' }),
        Article.distinct('categories')
      ]);
      metrics.totalPublished = totalPublished || 0;
      metrics.pendingCount = pendingCount || 0;
      metrics.categoriesCount = (distinctCategories || []).filter(Boolean).length;
    }

    if (Comment) {
      metrics.commentsCount = await Comment.countDocuments({});
    }

    // Build weekly published articles time-series for the last 12 weeks
    let chart = { labels: [], counts: [] };
    try {
      const weeksBack = 12;
      const now = new Date();
      const since = new Date(now);
      since.setDate(now.getDate() - weeksBack * 7);

      // Aggregate by ISO week and year
      const agg = Article
        ? await Article.aggregate([
            { $match: { status: 'published', createdAt: { $gte: since } } },
            {
              $group: {
                _id: {
                  year: { $isoWeekYear: '$createdAt' },
                  week: { $isoWeek: '$createdAt' }
                },
                count: { $sum: 1 }
              }
            },
            { $sort: { '_id.year': 1, '_id.week': 1 } }
          ])
        : [];

      const map = new Map();
      for (const r of agg) {
        const key = `${r._id.year}-W${String(r._id.week).padStart(2, '0')}`;
        map.set(key, r.count);
      }

      // Helper to get ISO week and year
      function getISOWeekYear(d) {
        const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        // Thursday in current week decides the year.
        date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
        return date.getUTCFullYear();
      }
      function getISOWeek(d) {
        const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        // Thursday in current week decides the year.
        date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
        const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
        return weekNo;
      }

      const labels = [];
      const counts = [];
      for (let i = weeksBack - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setUTCDate(d.getUTCDate() - i * 7);
        const year = getISOWeekYear(d);
        const week = getISOWeek(d);
        const key = `${year}-W${String(week).padStart(2, '0')}`;
        labels.push(key);
        counts.push(map.get(key) || 0);
      }
      chart = { labels, counts };
    } catch (e) {
      console.error('Weekly chart build error:', e);
    }

    // Fetch recent articles for the management table
    let articles = [];
    try {
      if (Article) {
        articles = await Article.find({}, {
          title: 1,
          author: 1,
          categories: 1,
          status: 1,
          createdAt: 1
        }).sort({ createdAt: -1 }).limit(20).lean();
      }
    } catch (e) {
      console.error('Fetch articles error:', e);
    }

    // Build categories list with article counts
    let categories = [];
    try {
      if (Article) {
        const agg = await Article.aggregate([
          { $unwind: { path: '$categories', preserveNullAndEmptyArrays: false } },
          { $match: { categories: { $type: 'string', $ne: '' } } },
          { $group: { _id: { $toLower: '$categories' }, count: { $sum: 1 } } },
          { $sort: { count: -1, _id: 1 } },
          { $limit: 50 }
        ]);
        categories = agg.map(r => ({ name: r._id, count: r.count }));
      }
    } catch (e) {
      console.error('Categories aggregate error:', e);
    }

    res.render('admin', {
      title: 'Admin Panel',
      header: 'News Admin Panel',
      user: { name: (req.session && req.session.user && req.session.user.name) || 'Admin' },
      year: new Date().getFullYear(),
      appName: 'ViralSurge',
      metrics,
      chart,
      articles,
      categories
    });
  } catch (err) {
    console.error('Admin metrics error:', err);
    return res.status(500).send('Server error');
  }
});

// Rename a category across all articles
app.post('/admin/categories/rename', ensureAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    let { from, to } = req.body || {};
    if (!from || !to) return res.status(400).json({ ok: false, error: 'Both from and to are required' });
    from = String(from).trim();
    to = String(to).trim();
    if (!from || !to) return res.status(400).json({ ok: false, error: 'Invalid category names' });

    // Update array elements equal to `from` -> `to`
    const result = await Article.updateMany(
      { categories: from },
      { $set: { 'categories.$[el]': to } },
      { arrayFilters: [{ el: from }] }
    );
    return res.json({ ok: true, modified: result.modifiedCount || 0 });
  } catch (e) {
    console.error('Rename category error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Delete a category from all articles
app.post('/admin/categories/delete', ensureAdmin, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    let { name } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'Category name required' });
    name = String(name).trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Invalid category name' });

    const result = await Article.updateMany(
      { categories: name },
      { $pull: { categories: name } }
    );
    return res.json({ ok: true, modified: result.modifiedCount || 0 });
  } catch (e) {
    console.error('Delete category error:', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// Redirect /admin/articles to the New Article form (placeholder until list view exists)
app.get('/admin/articles', ensureAdmin, (req, res) => {
  return res.redirect('/admin/articles/new');
});

// New Article form
app.get('/admin/articles/new', ensureAdmin, (req, res) => {
  res.render('new-article', {
    title: 'Create Article',
    categories: ['Politics', 'Business', 'Sports', 'Technology', 'Health', 'Environment'],
  });
});

// Create Article submit
// Expect fields and files: featuredImage (single), media (multiple)
app.post(
  '/admin/articles',
  ensureAdmin,
  (req, res, next) => {
    if (!upload) {
      return res.status(500).send('File storage not configured (missing MONGODB_URI).');
    }
    
    // Use multer middleware
    upload.fields([
      { name: 'featuredImage', maxCount: 1 },
      { name: 'media', maxCount: 10 }
    ])(req, res, (err) => {
      if (err) {
        console.error('Upload error:', err);
        return res.status(500).send('Error uploading files');
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const b = req.body;
      
      // Handle file uploads: filenames stored in DB, accessible at /upload/<filename>
      const featuredImageId = req.files && req.files.featuredImage && req.files.featuredImage[0] 
        ? req.files.featuredImage[0].filename 
        : null;
      
      const mediaIds = req.files && req.files.media 
        ? req.files.media.map(file => file.filename) 
        : [];

      // Build article doc (keep using featuredImageId/mediaIds fields)
      const doc = {
        title: b.title,
        slug: (b.slug || b.title || 'untitled')
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-')
          .slice(0, 120),
        categories: (b.categories || '').split(',').map(s => s.trim()).filter(Boolean),
        tags: (b.tags || '').split(',').map(s => s.trim()).filter(Boolean),
        content: b.content,
        featuredImageId,
        mediaIds,
        excerpt: b.excerpt,
        metaTitle: b.metaTitle,
        metaDescription: b.metaDescription,
        seoKeywords: (b.seoKeywords || '').split(',').map(s => s.trim()).filter(Boolean),
        author: b.author || (req.session?.user?.name || 'Admin'),
        status: b.status || 'draft',
        scheduleAt: b.scheduleAt ? new Date(b.scheduleAt) : null,
        featured: b.featured === 'on' || b.featured === 'true',
        location: b.location,
        source: b.source,
        commentsEnabled: b.commentsEnabled === 'on' || b.commentsEnabled === 'true'
      };

      if (!Article) return res.status(500).send('Database not initialized.');
      
      const created = await Article.create(doc);
      return res.redirect(`/admin`);
    } catch (err) {
      console.error('Article creation error:', err);
      return res.status(500).send('Error creating article');
    }
  }
);

// Edit Article form
app.get('/admin/articles/:id/edit', ensureAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!Article) return res.status(500).send('Database not initialized.');
    const article = await Article.findById(id).lean();
    if (!article) return res.status(404).send('Article not found');
    res.render('edit-article', { title: 'Edit Article', article });
  } catch (e) {
    console.error('Load edit article error:', e);
    return res.status(500).send('Server error');
  }
});

// Update Article submit
app.post(
  '/admin/articles/:id',
  ensureAdmin,
  (req, res, next) => {
    if (!upload) return next(); // allow text-only edits when storage not configured
    upload.fields([
      { name: 'featuredImage', maxCount: 1 },
      { name: 'media', maxCount: 10 }
    ])(req, res, (err) => {
      if (err) {
        console.error('Upload error (edit):', err);
        return res.status(500).send('Error uploading files');
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const id = req.params.id;
      if (!Article) return res.status(500).send('Database not initialized.');
      const current = await Article.findById(id);
      if (!current) return res.status(404).send('Article not found');

      const b = req.body || {};
      const update = {};

      if (b.title !== undefined) update.title = b.title;
      if (b.slug !== undefined) {
        update.slug = (b.slug || b.title || current.title || 'untitled')
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-')
          .slice(0, 120);
      }
      if (b.categories !== undefined) update.categories = (b.categories || '').split(',').map(s => s.trim()).filter(Boolean);
      if (b.tags !== undefined) update.tags = (b.tags || '').split(',').map(s => s.trim()).filter(Boolean);
      if (b.content !== undefined) update.content = b.content;
      if (b.excerpt !== undefined) update.excerpt = b.excerpt;
      if (b.metaTitle !== undefined) update.metaTitle = b.metaTitle;
      if (b.metaDescription !== undefined) update.metaDescription = b.metaDescription;
      if (b.seoKeywords !== undefined) update.seoKeywords = (b.seoKeywords || '').split(',').map(s => s.trim()).filter(Boolean);
      if (b.author !== undefined) update.author = b.author;
      if (b.status !== undefined) update.status = b.status;
      if (b.scheduleAt !== undefined) update.scheduleAt = b.scheduleAt ? new Date(b.scheduleAt) : null;
      if (b.featured !== undefined) update.featured = b.featured === 'on' || b.featured === 'true';
      if (b.location !== undefined) update.location = b.location;
      if (b.source !== undefined) update.source = b.source;

      // Files
      const newFeatured = req.files && req.files.featuredImage && req.files.featuredImage[0]
        ? req.files.featuredImage[0].filename
        : null;
      const newMedia = req.files && req.files.media ? req.files.media.map(f => f.filename) : [];

      if (newFeatured) update.featuredImageId = newFeatured;
      if (newMedia.length) update.mediaIds = Array.isArray(current.mediaIds) ? current.mediaIds.concat(newMedia) : newMedia;

      await Article.updateOne({ _id: id }, { $set: update });
      return res.redirect('/admin');
    } catch (e) {
      console.error('Update article error:', e);
      return res.status(500).send('Error updating article');
    }
  }
);

app.get('/logout', (req, res) => {
  req.session?.destroy(() => {
    res.redirect('/');
  });
});

app.get('/health', (req, res) => res.send('OK'));

// World category route
app.get('/world', async (req, res) => {
  try {
    const categoryName = 'World';
    let hero = null;
    let articles = [];
    let mostReadList = [];
    let moreInCategory = [];

    if (Article) {
      // featured hero in this category
      hero = await Article.findOne({ status: 'published', categories: { $in: [categoryName] } })
        .sort({ createdAt: -1 })
        .lean();

      const excludeId = hero ? hero._id : null;
      const q = excludeId
        ? { status: 'published', categories: { $in: [categoryName] }, _id: { $ne: excludeId } }
        : { status: 'published', categories: { $in: [categoryName] } };

      articles = await Article.find(q, {
        _id: 1, title: 1, slug: 1, excerpt: 1, categories: 1, author: 1, createdAt: 1, featuredImageId: 1, views: 1
      }).sort({ createdAt: -1 }).limit(20).lean();

      // normalize ids
      articles = (articles || []).map(a => ({ ...a, _id: String(a._id) }));
      if (hero && hero._id) hero._id = String(hero._id);

      // most read in this category (by views)
      mostReadList = await Article.find({ status: 'published', categories: { $in: [categoryName] } })
        .sort({ views: -1, createdAt: -1 }).limit(5).select('_id title slug createdAt views').lean();

      // more recent items in category
      moreInCategory = await Article.find({ status: 'published', categories: { $in: [categoryName] } })
        .sort({ createdAt: -1 }).limit(6).select('_id title slug createdAt').lean();
    }

    const heroImageUrl = hero && hero.featuredImageId
      ? `/upload/${hero.featuredImageId}`
      : 'https://via.placeholder.com/1600x900?text=No+Image';

    // build top-bar data (same as index) so partial header has required vars
    let topBarSource = null;
    let topBarList = [];
    try {
      if (Article) {
        topBarSource = await Article.findOne({
          status: 'published',
          featuredImageId: { $exists: true, $ne: null, $ne: '' }
        })
          .sort({ createdAt: -1 })
          .select('createdAt featuredImageId title slug')
          .lean();

        const latest = await Article.find({ status: 'published' })
          .sort({ createdAt: -1 })
          .limit(10)
          .select('_id title slug createdAt')
          .lean();
        topBarList = (latest || []).map(it => ({
          title: it.title,
          href: it.slug ? `/a/${it.slug}` : (it._id ? `/a/${String(it._id)}` : '#'),
          createdAt: it.createdAt
        }));
      }
    } catch (e) {
      console.error('World top bar lookup error:', e);
    }

    let topBarDate = new Date();
    let topBarImage = null;
    let topBarTitle = null;
    let topBarLink = null;
    if (topBarSource && topBarSource.createdAt) topBarDate = new Date(topBarSource.createdAt);
    if (topBarSource && topBarSource.featuredImageId) topBarImage = `/upload/${topBarSource.featuredImageId}`;
    if (topBarSource && topBarSource.title) topBarTitle = topBarSource.title;
    // Build a link to the article — prefer slug, fallback to id
    if (topBarSource) {
      if (topBarSource.slug) topBarLink = `/a/${topBarSource.slug}`;
      else if (topBarSource._id) topBarLink = `/a/${topBarSource._id}`;
    }
    const formatLongDate = (d) =>
      d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const topBarDateFormatted = formatLongDate(topBarDate);

    res.render('world', {
      title: (categoryName + ' - ViralSurge'),
      categoryName,
      subtitle: '',
      hero,
      heroImageUrl,
      articles,
      mostReadList,
      moreInCategory,
      pagination: null,
      topBarDate: topBarDateFormatted,
      topBarImage,
      topBarTitle,
      topBarLink,
      topBarList
    });
  } catch (e) {
    console.error('World route error:', e);
    res.status(500).send('Server error');
  }
});

// POST comment for an article (supports replies via parentId)
app.post('/a/:id/comments', async (req, res) => {
  try {
    if (!Article) return res.status(500).json({ error: 'DB not ready' });
    const articleId = req.params.id;
    const { parentId = null, author = 'Anonymous', text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Empty comment' });

    const comment = {
      _id: new mongoose.Types.ObjectId(),
      parentId: parentId ? String(parentId) : null,
      author: String(author).slice(0, 100),
      text: String(text),
      createdAt: new Date()
    };

    // push comment into article.comments (array of comment objects)
    await Article.updateOne({ _id: articleId }, { $push: { comments: comment } });

    return res.json({ success: true, comment });
  } catch (err) {
    console.error('Comment save error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Politics category route
app.get('/politics', async (req, res) => {
  try {
    const categoryName = 'Politics';
    let hero = null;
    let articles = [];
    let mostReadList = [];
    let moreInCategory = [];

    if (Article) {
      // featured hero in this category
      hero = await Article.findOne({ status: 'published', categories: { $in: [categoryName] } })
        .sort({ createdAt: -1 })
        .lean();

      const excludeId = hero ? hero._id : null;
      const q = excludeId
        ? { status: 'published', categories: { $in: [categoryName] }, _id: { $ne: excludeId } }
        : { status: 'published', categories: { $in: [categoryName] } };

      articles = await Article.find(q, {
        _id: 1, title: 1, slug: 1, excerpt: 1, categories: 1, author: 1, createdAt: 1, featuredImageId: 1, views: 1
      }).sort({ createdAt: -1 }).limit(20).lean();

      // normalize ids
      articles = (articles || []).map(a => ({ ...a, _id: String(a._id) }));
      if (hero && hero._id) hero._id = String(hero._id);

      // most read in this category (by views)
      mostReadList = await Article.find({ status: 'published', categories: { $in: [categoryName] } })
        .sort({ views: -1, createdAt: -1 }).limit(5).select('_id title slug createdAt views').lean();

      // more recent items in category
      moreInCategory = await Article.find({ status: 'published', categories: { $in: [categoryName] } })
        .sort({ createdAt: -1 }).limit(6).select('_id title slug createdAt').lean();
    }

    const heroImageUrl = hero && hero.featuredImageId
      ? `/upload/${hero.featuredImageId}`
      : 'https://via.placeholder.com/1600x900?text=No+Image';

    // build top-bar data (same as index/world)
    let topBarSource = null;
    let topBarList = [];
    try {
      if (Article) {
        topBarSource = await Article.findOne({
          status: 'published',
          featuredImageId: { $exists: true, $ne: null, $ne: '' }
        })
          .sort({ createdAt: -1 })
          .select('createdAt featuredImageId title slug')
          .lean();

        const latest = await Article.find({ status: 'published' })
          .sort({ createdAt: -1 })
          .limit(10)
          .select('_id title slug createdAt')
          .lean();
        topBarList = (latest || []).map(it => ({
          title: it.title,
          href: it.slug ? `/a/${it.slug}` : (it._id ? `/a/${String(it._id)}` : '#'),
          createdAt: it.createdAt
        }));
      }
    } catch (e) {
      console.error('Politics top bar lookup error:', e);
    }

    let topBarDate = new Date();
    let topBarImage = null;
    let topBarTitle = null;
    let topBarLink = null;
    if (topBarSource && topBarSource.createdAt) topBarDate = new Date(topBarSource.createdAt);
    if (topBarSource && topBarSource.featuredImageId) topBarImage = `/upload/${topBarSource.featuredImageId}`;
    if (topBarSource && topBarSource.title) topBarTitle = topBarSource.title;
    if (topBarSource) {
      if (topBarSource.slug) topBarLink = `/a/${topBarSource.slug}`;
      else if (topBarSource._id) topBarLink = `/a/${topBarSource._id}`;
    }
    const formatLongDate = (d) =>
      d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const topBarDateFormatted = formatLongDate(topBarDate);

    res.render('politics', {
      title: (categoryName + ' - ViralSurge'),
      categoryName,
      subtitle: '',
      hero,
      heroImageUrl,
      articles,
      mostReadList,
      moreInCategory,
      pagination: null,
      topBarDate: topBarDateFormatted,
      topBarImage,
      topBarTitle,
      topBarLink,
      topBarList
    });
  } catch (e) {
    console.error('Politics route error:', e);
    res.status(500).send('Server error');
  }
});

// Technology category route
app.get('/tech', async (req, res) => {
  try {
    const categoryName = 'Technology';
    let hero = null;
    let articles = [];
    let mostReadList = [];
    let moreInCategory = [];

    if (Article) {
      hero = await Article.findOne({ status: 'published', categories: { $in: [categoryName] } })
        .sort({ createdAt: -1 })
        .lean();

      const excludeId = hero ? hero._id : null;
      const q = excludeId
        ? { status: 'published', categories: { $in: [categoryName] }, _id: { $ne: excludeId } }
        : { status: 'published', categories: { $in: [categoryName] } };

      articles = await Article.find(q, {
        _id: 1, title: 1, slug: 1, excerpt: 1, categories: 1, author: 1, createdAt: 1, featuredImageId: 1, views: 1
      }).sort({ createdAt: -1 }).limit(20).lean();

      articles = (articles || []).map(a => ({ ...a, _id: String(a._id) }));
      if (hero && hero._id) hero._id = String(hero._id);

      mostReadList = await Article.find({ status: 'published', categories: { $in: [categoryName] } })
        .sort({ views: -1, createdAt: -1 }).limit(5).select('_id title slug createdAt views').lean();

      moreInCategory = await Article.find({ status: 'published', categories: { $in: [categoryName] } })
        .sort({ createdAt: -1 }).limit(6).select('_id title slug createdAt').lean();
    }

    const heroImageUrl = hero && hero.featuredImageId
      ? `/upload/${hero.featuredImageId}`
      : 'https://via.placeholder.com/1600x900?text=No+Image';

    // top-bar data (reuse logic used by other category routes)
    let topBarSource = null;
    let topBarList = [];
    try {
      if (Article) {
        topBarSource = await Article.findOne({
          status: 'published',
          featuredImageId: { $exists: true, $ne: null, $ne: '' }
        })
          .sort({ createdAt: -1 })
          .select('createdAt featuredImageId title slug')
          .lean();

        const latest = await Article.find({ status: 'published' })
          .sort({ createdAt: -1 })
          .limit(10)
          .select('_id title slug createdAt')
          .lean();
        topBarList = (latest || []).map(it => ({
          title: it.title,
          href: it.slug ? `/a/${it.slug}` : (it._id ? `/a/${String(it._id)}` : '#'),
          createdAt: it.createdAt
        }));
      }
    } catch (e) {
      console.error('Tech top bar lookup error:', e);
    }

    let topBarDate = new Date();
    let topBarImage = null;
    let topBarTitle = null;
    let topBarLink = null;
    if (topBarSource && topBarSource.createdAt) topBarDate = new Date(topBarSource.createdAt);
    if (topBarSource && topBarSource.featuredImageId) topBarImage = `/upload/${topBarSource.featuredImageId}`;
    if (topBarSource && topBarSource.title) topBarTitle = topBarSource.title;
    if (topBarSource) {
      if (topBarSource.slug) topBarLink = `/a/${topBarSource.slug}`;
      else if (topBarSource._id) topBarLink = `/a/${topBarSource._id}`;
    }
    const formatLongDate = (d) =>
      d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const topBarDateFormatted = formatLongDate(topBarDate);

    res.render('tech', {
      title: (categoryName + ' - ViralSurge'),
      categoryName,
      subtitle: '',
      hero,
      heroImageUrl,
      articles,
      mostReadList,
      moreInCategory,
      pagination: null,
      topBarDate: topBarDateFormatted,
      topBarImage,
      topBarTitle,
      topBarLink,
      topBarList
    });
  } catch (e) {
    console.error('Tech route error:', e);
    res.status(500).send('Server error');
  }
});

// Science category route
app.get('/science', async (req, res) => {
  try {
    const categoryName = 'Science';
    let hero = null;
    let articles = [];
    let mostReadList = [];
    let moreInCategory = [];

    if (Article) {
      hero = await Article.findOne({ status: 'published', categories: { $in: [categoryName] } })
        .sort({ createdAt: -1 })
        .lean();

      const excludeId = hero ? hero._id : null;
      const q = excludeId
        ? { status: 'published', categories: { $in: [categoryName] }, _id: { $ne: excludeId } }
        : { status: 'published', categories: { $in: [categoryName] } };

      articles = await Article.find(q, {
        _id: 1, title: 1, slug: 1, excerpt: 1, categories: 1, author: 1, createdAt: 1, featuredImageId: 1, views: 1
      }).sort({ createdAt: -1 }).limit(20).lean();

      articles = (articles || []).map(a => ({ ...a, _id: String(a._id) }));
      if (hero && hero._id) hero._id = String(hero._id);

      mostReadList = await Article.find({ status: 'published', categories: { $in: [categoryName] } })
        .sort({ views: -1, createdAt: -1 }).limit(5).select('_id title slug createdAt views').lean();

      moreInCategory = await Article.find({ status: 'published', categories: { $in: [categoryName] } })
        .sort({ createdAt: -1 }).limit(6).select('_id title slug createdAt').lean();
    }

    const heroImageUrl = hero && hero.featuredImageId
      ? `/upload/${hero.featuredImageId}`
      : 'https://via.placeholder.com/1600x900?text=No+Image';

    // top-bar data (reuse logic used by other category routes)
    let topBarSource = null;
    let topBarList = [];
    try {
      if (Article) {
        topBarSource = await Article.findOne({
          status: 'published',
          featuredImageId: { $exists: true, $ne: null, $ne: '' }
        })
          .sort({ createdAt: -1 })
          .select('createdAt featuredImageId title slug')
          .lean();

        const latest = await Article.find({ status: 'published' })
          .sort({ createdAt: -1 })
          .limit(10)
          .select('_id title slug createdAt')
          .lean();
        topBarList = (latest || []).map(it => ({
          title: it.title,
          href: it.slug ? `/a/${it.slug}` : (it._id ? `/a/${String(it._id)}` : '#'),
          createdAt: it.createdAt
        }));
      }
    } catch (e) {
      console.error('Science top bar lookup error:', e);
    }

    let topBarDate = new Date();
    let topBarImage = null;
    let topBarTitle = null;
    let topBarLink = null;
    if (topBarSource && topBarSource.createdAt) topBarDate = new Date(topBarSource.createdAt);
    if (topBarSource && topBarSource.featuredImageId) topBarImage = `/upload/${topBarSource.featuredImageId}`;
    if (topBarSource && topBarSource.title) topBarTitle = topBarSource.title;
    if (topBarSource) {
      if (topBarSource.slug) topBarLink = `/a/${topBarSource.slug}`;
      else if (topBarSource._id) topBarLink = `/a/${topBarSource._id}`;
    }
    const formatLongDate = (d) =>
      d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const topBarDateFormatted = formatLongDate(topBarDate);

    res.render('science', {
      title: (categoryName + ' - ViralSurge'),
      categoryName,
      subtitle: '',
      hero,
      heroImageUrl,
      articles,
      mostReadList,
      moreInCategory,
      pagination: null,
      topBarDate: topBarDateFormatted,
      topBarImage,
      topBarTitle,
      topBarLink,
      topBarList
    });
  } catch (e) {
    console.error('Science route error:', e);
    res.status(500).send('Server error');
  }
});


const server = app.listen(PORT, () => {
  console.log('Server listening on', PORT);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Kill the process using the port and restart the app.`);
    process.exit(1);
  }
  throw err;
});

// simple User schema
const UserSchema = new mongoose.Schema({
  fullName: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model('User', UserSchema);

// helpers
function formatLongDate(d = new Date()) {
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function headerLocals() {
  return {
    topBarDate: formatLongDate(),
    topBarList: [],
    topBarImage: null,
    topBarTitle: '',
    topBarLink: '#'
  };
}

// serve register page
app.get('/register', (req, res) => {
  res.render('register', {
    ...headerLocals(),
    title: 'Register - ViralSurge',
    error: null,
    success: null
  });
});

// handle registration
app.post('/register', async (req, res) => {
  try {
    const { fullName = '', email = '', password = '', confirmPassword = '' } = req.body;
    // basic validation
    if (!fullName.trim() || !email.trim() || !password) {
      return res.render('register', { ...headerLocals(), error: 'Please fill all required fields.', success: null, title: 'Register - ViralSurge' });
    }
    if (password !== confirmPassword) {
      return res.render('register', { ...headerLocals(), error: 'Passwords do not match.', success: null, title: 'Register - ViralSurge' });
    }
    const normalizedEmail = String(email).toLowerCase().trim();
    const exists = await User.findOne({ email: normalizedEmail }).lean();
    if (exists) {
      return res.render('register', { ...headerLocals(), error: 'An account with that email already exists.', success: null, title: 'Register - ViralSurge' });
    }

    const saltRounds = Number(process.env.BCRYPT_ROUNDS) || 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const user = new User({ fullName: fullName.trim(), email: normalizedEmail, passwordHash });
    await user.save();

    return res.render('register', { ...headerLocals(), error: null, success: 'Account created. You may now sign in.', title: 'Register - ViralSurge' });
  } catch (err) {
    console.error('Register error:', err);
    return res.render('register', { ...headerLocals(), error: 'Server error, please try again later.', success: null, title: 'Register - ViralSurge' });
  }
});

// serve login page
app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/');
  res.render('login', {
    ...headerLocals(),
    title: 'Sign In - ViralSurge',
    error: null,
    success: null
  });
});

// simple link shortener page (client-side TinyURL)
app.get('/link', (req, res) => {
  res.render('link', {
    ...headerLocals(),
    title: 'Shorten Link - ViralSurge'
  });
});

// Server-side shortener proxy to avoid CORS and client failures
app.post('/api/shorten', express.json(), async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: 'Missing url' });
    // Basic URL validation
    try { new URL(url); } catch (e) { return res.status(400).json({ ok: false, error: 'Invalid url' }); }

    const apiUrl = 'https://tinyurl.com/api-create?url=' + encodeURIComponent(url);
    https.get(apiUrl, (r) => {
      let data = '';
      r.on('data', (chunk) => { data += chunk; });
      r.on('end', () => {
        if (r.statusCode >= 200 && r.statusCode < 300) {
          return res.json({ ok: true, shortUrl: data.trim() });
        }
        return res.status(502).json({ ok: false, error: 'Shortener service error' });
      });
    }).on('error', (err) => {
      console.error('Shorten proxy error:', err);
      return res.status(502).json({ ok: false, error: 'Shortener service error' });
    });
  } catch (err) {
    console.error('Shorten API error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// handle login
app.post('/login', async (req, res) => {
  try {
    const { email = '', password = '' } = req.body || {};
    if (!email.trim() || !password) {
      return res.render('login', { ...headerLocals(), error: 'Email and password are required.', success: null, title: 'Sign In - ViralSurge' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail }).lean();
    if (!user) {
      return res.render('login', { ...headerLocals(), error: 'Invalid email or password.', success: null, title: 'Sign In - ViralSurge' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.render('login', { ...headerLocals(), error: 'Invalid email or password.', success: null, title: 'Sign In - ViralSurge' });
    }

    // create session
    req.session.user = { id: String(user._id), name: user.fullName || '', email: user.email };
    // optional: redirect to intended page if provided
    const redirectTo = req.session.redirectAfterLogin || '/';
    delete req.session.redirectAfterLogin;
    return res.redirect(redirectTo);
  } catch (err) {
    console.error('Login error:', err);
    return res.render('login', { ...headerLocals(), error: 'Server error, try again later.', success: null, title: 'Sign In - ViralSurge' });
  }
});

// Dashboard - simple user area
app.get('/dashboard', ensureAuthenticated, async (req, res) => {
  try {
    const user = req.session.user || null;
    // basic stats for dashboard (safe if models not initialized yet)
    const stats = {
      articles: 0,
      comments: 0,
      users: 0
    };
    try {
      if (typeof Article !== 'undefined' && Article) stats.articles = await Article.countDocuments({});
      if (typeof Comment !== 'undefined' && Comment) stats.comments = await Comment.countDocuments({});
      if (typeof User !== 'undefined' && User) stats.users = await User.countDocuments({});
    } catch (e) {
      console.error('Dashboard stats error:', e);
    }

    return res.render('dashboard', {
      title: 'Dashboard - ViralSurge',
      user,
      stats
    });
  } catch (e) {
    console.error('Dashboard error:', e);
    return res.status(500).send('Server error');
  }
});

// Education category route
app.get('/education', async (req, res) => {
  try {
    const categoryName = 'Education';
    let hero = null;
    let articles = [];
    let mostReadList = [];
    let moreInCategory = [];
    let heroImageUrl = '';

    if (Article) {
      hero = await Article.findOne({ status: 'published', categories: categoryName }).sort({ createdAt: -1 }).lean();
      const excludeId = hero ? hero._id : null;
      const q = excludeId ? { status: 'published', categories: categoryName, _id: { $ne: excludeId } } : { status: 'published', categories: categoryName };
      articles = await Article.find(q).sort({ createdAt: -1 }).limit(20).lean();
      articles = (articles || []).map(a => ({ ...a, _id: String(a._id) }));
      if (hero && hero._id) hero._id = String(hero._id);
      heroImageUrl = hero && hero.featuredImageId ? `/upload/${hero.featuredImageId}` : '';

      mostReadList = await Article.find({ status: 'published', categories: categoryName }).sort({ views: -1 }).limit(5).select('_id title slug createdAt views').lean();
      moreInCategory = await Article.find({ status: 'published', categories: categoryName }).sort({ createdAt: -1 }).limit(6).select('_id title slug createdAt').lean();
    }

    // top bar data
    const topBarList = res.locals.topBarList || [];
    const topBarDate = res.locals.topBarDate || formatLongDate();

    res.render('education', {
      title: 'Education - ViralSurge',
      categoryName,
      subtitle: '',
      hero,
      heroImageUrl,
      articles,
      mostReadList,
      moreInCategory,
      topBarDate,
      topBarList
    });
  } catch (e) {
    console.error('Education route error:', e);
    res.status(500).send('Server error');
  }
});

// Final 404 handler (must be last)
app.use((req, res) => {
  res.status(404).render('404', {
    title: 'Page not found'
  });
});
