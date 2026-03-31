/**
 * Menu Image Seeder for The Flavor Server
 * Downloads food images and assigns them to menu items via the local API.
 *
 * Usage: node seed-menu-images.js
 * Requires the server to be running on localhost:3000
 */

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}`;

// ─── Image URL mappings ─────────────────────────────────────────────────────
// Using Unsplash source for high-quality, free food images
// Format: https://source.unsplash.com/600x400/?{query}
// Also using Pexels/Pixabay direct links and Loremflickr as fallbacks

function unsplash(query) {
  return `https://source.unsplash.com/600x400/?${encodeURIComponent(query)}`;
}

function loremflickr(query) {
  return `https://loremflickr.com/600/400/${encodeURIComponent(query)}`;
}

// Map each menu item ID to a descriptive search query for finding the right image
const IMAGE_QUERIES = {
  // ─── Veg Starters ───
  'm1':  'paneer chilli indian food',
  'm2':  'paneer chilli dry indian',
  'm3':  'paneer manchurian indian',
  'm4':  'paneer manchurian gravy',
  'm5':  'paneer pepper fry',
  'm6':  'paneer pepper dry indian',
  'm7':  'paneer 65 indian starter',
  'm8':  'paneer 65 fried',
  'm9':  'mushroom chilli indian',
  'm10': 'chilli mushroom dry',
  'm11': 'mushroom manchurian indian',
  'm12': 'mushroom manchurian dry',

  // ─── Non-Veg Starters ───
  'm13': 'chilli chicken indian',
  'm14': 'chilli chicken dry',
  'm15': 'chicken manchurian indian',
  'm16': 'chicken manchurian gravy',
  'm17': 'chicken 65 indian',
  'm18': 'chicken 65 crispy fried',
  'm19': 'pepper chicken indian',
  'm20': 'pepper chicken dry',
  'm21': 'lemon chicken indian',
  'm22': 'lemon chicken fried',
  'm23': 'dry chicken fry indian',
  'm24': 'chicken fry indian plate',
  'm25': 'fried chicken pieces',
  'm26': 'fish fry indian',
  'm27': 'fried fish pieces plate',
  'm28': 'fish fry crispy',

  // ─── Main Course Veg ───
  'm29': 'kadhai paneer indian curry',
  'm30': 'matar paneer curry',
  'm31': 'mushroom masala curry',
  'm32': 'chole masala chickpea curry',
  'm33': 'paneer bhurji scrambled',
  'm34': 'aloo bhujia potato',
  'm35': 'aloo chokha mashed potato',
  'm36': 'baingan bharta eggplant',
  'm37': 'paneer butter masala',
  'm38': 'paneer makhani curry',
  'm39': 'mixed veg curry indian',

  // ─── Main Course Non-Veg ───
  'm40': 'chicken curry indian',
  'm41': 'chicken curry gravy',
  'm42': 'chicken curry plate rice',
  'm43': 'fish curry indian',
  'm44': 'fish curry mustard',
  'm45': 'fish curry bengali',
  'm46': 'egg bhurji scrambled',
  'm47': 'anda bhurji indian',
  'm48': 'egg bhurji plate',
  'm49': 'indian omelette masala',
  'm50': 'masala omelette',
  'm51': 'egg omelette plate',
  'm52': 'egg curry indian',
  'm53': 'anda curry gravy',
  'm54': 'egg curry boiled',

  // ─── Veg Meals ───
  'm55': 'paneer rice meal indian thali',
  'm56': 'jeera rice paneer meal',
  'm57': 'pulao paneer meal',
  'm58': 'paneer roti meal plate',
  'm59': 'veg thali indian meal',
  'm60': 'special veg thali',
  'm61': 'dal chawal rice meal',
  'm62': 'dal rice chokha plate',
  'm63': 'roti sabzi meal',
  'm64': 'paratha sabzi meal',
  'm65': 'puri sabzi meal',
  'm66': 'dal khichdi indian',

  // ─── Non-Veg Meals ───
  'm67': 'chicken rice meal indian',
  'm68': 'chicken jeera rice plate',
  'm69': 'chicken pulav meal',
  'm70': 'chicken roti meal plate',
  'm71': 'fish thali indian meal',

  // ─── Rice & Biryani ───
  'm72': 'plain steamed rice bowl',
  'm73': 'steamed rice plate',
  'm74': 'jeera rice cumin',
  'm75': 'jeera rice plate',
  'm76': 'ghee rice indian',
  'm77': 'ghee rice plate',
  'm78': 'veg pulao rice',
  'm79': 'vegetable pulav',
  'm80': 'veg biryani indian',
  'm81': 'chicken biryani indian',
  'm82': 'egg fried rice',
  'm83': 'veg fried rice',
  'm84': 'schezwan fried rice',
  'm85': 'paneer fried rice',
  'm86': 'schezwan paneer rice',
  'm87': 'chicken fried rice',
  'm88': 'chicken schezwan rice',

  // ─── Noodles ───
  'm89': 'veg noodles hakka',
  'm90': 'schezwan noodles',
  'm91': 'paneer noodles',
  'm92': 'schezwan paneer noodles',
  'm93': 'chicken noodles hakka',
  'm94': 'chicken schezwan noodles',

  // ─── Roti & Paratha ───
  'm95':  'plain roti chapati',
  'm96':  'ghee roti indian bread',
  'm97':  'butter roti',
  'm98':  'plain paratha',
  'm99':  'aloo paratha indian',
  'm100': 'sattu paratha',
  'm101': 'aloo pyaz paratha',
  'm102': 'pyaz paratha onion',
  'm103': 'paneer paratha',

  // ─── Dal ───
  'm104': 'dal fry indian',
  'm105': 'dal fry lentil',
  'm106': 'dal tadka indian',
  'm107': 'dal tadka tempered',

  // ─── Beverages ───
  'm108': 'lassi indian drink',
  'm109': 'sattu drink indian',
  'm110': 'soft drink cola bottle',
  'm111': 'mineral water bottle',
};

// ─── Fetch and seed images ─────────────────────────────────────────────────
async function seedImage(itemId, query) {
  const imageUrl = unsplash(query);

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ url: imageUrl });
    const req = http.request(`${BASE}/api/admin/menu/${itemId}/image-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          reject(new Error(`Parse error: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const entries = Object.entries(IMAGE_QUERIES);
  console.log(`\n🖼️  Seeding ${entries.length} menu images...\n`);

  let success = 0, failed = 0;

  // Process in batches of 5 to avoid overwhelming the server
  for (let i = 0; i < entries.length; i += 5) {
    const batch = entries.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(([id, query]) => seedImage(id, query))
    );

    results.forEach((result, idx) => {
      const [id, query] = batch[idx];
      if (result.status === 'fulfilled' && result.value.success) {
        success++;
        console.log(`  ✅ ${id} — ${query}`);
      } else {
        failed++;
        const err = result.status === 'rejected' ? result.reason.message : result.value?.error || 'Unknown';
        console.log(`  ❌ ${id} — ${query} — ${err}`);
      }
    });

    // Small delay between batches
    if (i + 5 < entries.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`\n📊 Done! ✅ ${success} succeeded, ❌ ${failed} failed out of ${entries.length} total.\n`);

  // Trigger menu refresh
  try {
    await new Promise((resolve, reject) => {
      http.get(`${BASE}/api/menu`, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(d));
      }).on('error', reject);
    });
    console.log('✅ Menu refreshed.\n');
  } catch (_) {}
}

main().catch(console.error);
