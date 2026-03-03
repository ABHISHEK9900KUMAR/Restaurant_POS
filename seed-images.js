/**
 * seed-images.js  —  Downloads real food photos from TheMealDB + Unsplash CDN
 * Run while server is stopped:  node seed-images.js
 */

const https    = require('https');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const sharp    = require('sharp');
const Database = require('better-sqlite3');

const UPLOADS_DIR = path.join(__dirname, 'public/uploads/menu');
const DB_PATH     = path.join(__dirname, 'data/restaurantos.db');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── TheMealDB search terms per item ──────────────────────────────────────────
// Each item lists search terms in priority order; first hit wins.
// Fallback: a direct CDN URL used when TheMealDB has no match.
const ITEMS = [
  { id: 'm1',  searches: ['spring rolls', 'spring roll'], fallback: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=600&h=400&fit=crop&q=82' },
  { id: 'm2',  searches: ['chilli paneer', 'paneer'] },
  { id: 'm3',  searches: ['vegetable manchurian', 'manchurian', 'fried rice'] },
  { id: 'm4',  searches: ['chilli chicken', 'chicken wings'] },
  { id: 'm5',  searches: ['chicken manchurian', 'chicken curry'] },
  { id: 'm6',  searches: ['paneer tikka', 'paneer'] },
  { id: 'm7',  searches: ['mushroom', 'stuffed mushrooms'] },
  { id: 'm8',  searches: ['tandoori chicken', 'chicken tikka'] },
  { id: 'm9',  searches: ['chicken tikka', 'chicken tikka masala'], fallback: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=600&h=400&fit=crop&q=82' },
  { id: 'm10', searches: ['paneer butter masala', 'butter paneer', 'paneer'] },
  { id: 'm11', searches: ['dal fry', 'dal', 'lentil soup'] },
  { id: 'm12', searches: ['butter chicken', 'chicken curry'] },
  { id: 'm13', searches: ['lamb rogan josh', 'rogan josh', 'lamb curry'] },
  { id: 'm14', searches: ['vegetable biryani', 'biryani'] },
  { id: 'm15', searches: ['chicken biryani', 'biryani'] },
  { id: 'm16', searches: ['lamb biryani', 'biryani', 'mutton'] },
  { id: 'm17', searches: ['roti', 'chapati', 'naan'] },
  { id: 'm18', searches: ['butter naan', 'naan', 'flatbread'] },
  { id: 'm19', searches: ['garlic naan', 'naan'], fallback: 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=600&h=400&fit=crop&q=82' },
  // Drinks: TheMealDB has no drinks — use Unsplash direct photo IDs
  { id: 'm20', fallback: 'https://images.unsplash.com/photo-1554866585-cd94860890b7?w=600&h=400&fit=crop&q=82' },
  { id: 'm21', fallback: 'https://images.unsplash.com/photo-1625772299848-391b6a87d7b3?w=600&h=400&fit=crop&q=82' },
  { id: 'm22', fallback: 'https://images.unsplash.com/photo-1548839140-29a749e1cf4d?w=600&h=400&fit=crop&q=82' },
  { id: 'm23', searches: ['gulab jamun', 'indian dessert', 'sweet'] },
  { id: 'm24', searches: ['rasgulla', 'indian dessert', 'kheer'], fallback: 'https://images.unsplash.com/photo-1666492820453-fc25f20e831c?w=600&h=400&fit=crop&q=82' },
  { id: 'm25', searches: ['chocolate brownie', 'brownie ice cream', 'brownie'] },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function fetchBuffer(url, redirects = 8) {
  return new Promise((resolve, reject) => {
    const go = (u, left) => {
      if (left === 0) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (seed-images)' } }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          const loc = res.headers.location;
          return go(loc.startsWith('http') ? loc : new URL(loc, u).href, left - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} — ${u}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end',  () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    };
    go(url, redirects);
  });
}

function fetchJSON(url) {
  return fetchBuffer(url).then(b => JSON.parse(b.toString()));
}

// Search TheMealDB; return strMealThumb URL or null
async function mealDBImage(searches) {
  for (const term of (searches || [])) {
    try {
      const data = await fetchJSON(
        `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(term)}`
      );
      if (data.meals && data.meals.length > 0) {
        return data.meals[0].strMealThumb;
      }
    } catch (_) {}
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  const db = new Database(DB_PATH);
  let ok = 0, fail = 0;

  for (const item of ITEMS) {
    process.stdout.write(`[${item.id}] `);

    try {
      // Resolve image URL — TheMealDB first, fallback URL second
      let imgUrl = await mealDBImage(item.searches);
      if (!imgUrl && item.fallback) imgUrl = item.fallback;
      if (!imgUrl) throw new Error('No image found for: ' + item.id);

      process.stdout.write(`Downloading… `);
      const buf     = await fetchBuffer(imgUrl);
      const outPath = path.join(UPLOADS_DIR, `${item.id}.jpg`);

      await sharp(buf)
        .resize(600, 400, { fit: 'cover' })
        .jpeg({ quality: 82 })
        .toFile(outPath);

      // Preserve existing inStock / offer; only update image
      const row = db.prepare('SELECT inStock, offer FROM menu_state WHERE id=?').get(item.id);
      db.prepare(
        'INSERT OR REPLACE INTO menu_state (id, inStock, offer, image) VALUES (?, ?, ?, ?)'
      ).run(item.id, row ? row.inStock : 1, row ? row.offer : 0, `/uploads/menu/${item.id}.jpg`);

      console.log('✓');
      ok++;
    } catch (err) {
      console.log(`✗  ${err.message}`);
      fail++;
    }
  }

  db.close();
  console.log(`\nDone — ${ok} saved, ${fail} failed.`);
  if (fail === 0) console.log('Restart the server (npm start) to see images.\n');
}

run();
