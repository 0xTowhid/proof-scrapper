const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS — only allow your website
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (health checks)
    if (!origin) return callback(null, true);
    // Allow localhost for dev
    if (origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
      return callback(null, true);
    }
    // Check against allowed list
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  }
}));

app.use(express.json());

// ── Rate limiting (simple in-memory)
const rateLimitMap = new Map();
function rateLimit(ip, windowMs = 60000, max = 10) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + windowMs };
  if (entry.resetAt < now) { entry.count = 0; entry.resetAt = now + windowMs; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap) { if (v.resetAt < now) rateLimitMap.delete(k); }
}, 300000);

// ── Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'session-proof-scraper' });
});

// ── Main scrape endpoint
// GET /scrape?username=oxtowhid
app.get('/scrape', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';

  if (rateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' });
  }

  const username = (req.query.username || '').replace(/^@/, '').toLowerCase().trim();

  if (!username || !/^[a-zA-Z0-9_]{1,15}$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username' });
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-blink-features=AutomationControlled',
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });

    // Remove webdriver flag
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const collectedIds = new Set();

    // Intercept X's internal GraphQL API responses
    context.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('UserTweetsAndReplies') || url.includes('UserWithReplies')) {
          const text = await response.text().catch(() => '{}');
          extractIdsFromJson(text, collectedIds);
        }
      } catch {}
    });

    const page = await context.newPage();

    // Navigate to with_replies page
    await page.goto(`https://x.com/${username}/with_replies`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    });

    // Check if profile exists
    await page.waitForTimeout(3000);
    const bodyText = await page.innerText('body').catch(() => '');
    if (
      bodyText.includes("doesn't exist") ||
      bodyText.includes('Account suspended') ||
      bodyText.includes("This account") && bodyText.includes("exist")
    ) {
      await browser.close();
      return res.status(404).json({ error: `User @${username} not found or account suspended.` });
    }

    // Scroll multiple times
    for (let i = 0; i < 6; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
      await page.waitForTimeout(1200 + Math.random() * 800);

      // Also extract from DOM on each scroll
      const domIds = await page.evaluate(extractFromDOM);
      domIds.forEach(id => collectedIds.add(id));
    }

    // Final DOM extraction
    const finalIds = await page.evaluate(extractFromDOM);
    finalIds.forEach(id => collectedIds.add(id));

    await browser.close();

    return res.json({
      success: true,
      ids: Array.from(collectedIds),
      count: collectedIds.size,
      username
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Scrape error:', err.message);
    return res.status(500).json({ error: 'Scrape failed: ' + err.message });
  }
});

// ── Injected DOM extractor
function extractFromDOM() {
  const ids = new Set();
  const html = document.documentElement.innerHTML;

  // JSON patterns
  [
    /"in_reply_to_status_id_str"\s*:\s*"(\d{10,20})"/g,
    /"in_reply_to_status_id"\s*:\s*(\d{10,20})/g,
    /"conversation_id_str"\s*:\s*"(\d{10,20})"/g,
  ].forEach(re => [...html.matchAll(re)].forEach(m => ids.add(m[1])));

  // DOM: all status links
  document.querySelectorAll('a[href*="/status/"]').forEach(a => {
    const m = a.href.match(/\/status\/(\d{10,20})/);
    if (m) ids.add(m[1]);
  });

  return Array.from(ids);
}

// ── JSON GraphQL response extractor
function extractIdsFromJson(jsonText, ids) {
  try {
    // Extract all in_reply_to_status_id_str from raw JSON text
    const m1 = [...jsonText.matchAll(/"in_reply_to_status_id_str"\s*:\s*"(\d{10,20})"/g)];
    m1.forEach(m => ids.add(m[1]));

    const m2 = [...jsonText.matchAll(/\/status\/(\d{10,20})/g)];
    m2.forEach(m => ids.add(m[1]));
  } catch {}
}

app.listen(PORT, () => {
  console.log(`Session Proof Scraper running on port ${PORT}`);
});
