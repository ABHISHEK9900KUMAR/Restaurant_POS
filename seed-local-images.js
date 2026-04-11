/**
 * seed-local-images.js — Copies Menu_images/ PNGs to public/uploads/menu/
 * and saves the local paths to the SQLite database.
 *
 * Run with server STOPPED:  node seed-local-images.js
 * Then restart:             npm start
 */

const path     = require('path');
const fs       = require('fs');
const sharp    = require('sharp');
const Database = require('better-sqlite3');

const IMAGES_DIR  = path.join(__dirname, 'Menu_images');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads', 'menu');
const DB_PATH     = path.join(__dirname, 'data', 'restaurantos.db');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// file → item IDs (items sharing an image get the same file copied per-ID)
const MAPPINGS = [
  { file: 'Gemini_Generated_Image_35p2sg35p2sg35p2.png', ids: ['m1', 'm2'] },           // Paneer Chilly
  { file: 'Gemini_Generated_Image_fziu8kfziu8kfziu.png', ids: ['m3', 'm4'] },           // Paneer Manchurian
  { file: 'Gemini_Generated_Image_48eg0348eg0348eg.png', ids: ['m9','m10','m11','m12','m31'] }, // Mushroom items
  { file: 'Gemini_Generated_Image_izmo5oizmo5oizmo.png', ids: ['m13','m14','m17','m18'] },     // Chilly Chicken / Chicken 65
  { file: 'Gemini_Generated_Image_fnlfgpfnlfgpfnlf.png', ids: ['m15', 'm16'] },         // Chicken Manchurian
  { file: 'Gemini_Generated_Image_9z7ixd9z7ixd9z7i.png', ids: ['m29'] },               // Kadhai Paneer
  { file: 'Gemini_Generated_Image_ldm7clldm7clldm7.png', ids: ['m30', 'm37'] },         // Matar Paneer + Paneer Butter Masala
  { file: 'Gemini_Generated_Image_syyhfwsyyhfwsyyh.png', ids: ['m38'] },               // Paneer Makhani
  { file: 'Gemini_Generated_Image_6kjyur6kjyur6kjy.png', ids: ['m40', 'm41', 'm42'] }, // Chicken Curry
  { file: 'Gemini_Generated_Image_jqpk06jqpk06jqpk.png', ids: ['m80'] },               // Veg Biryani
  { file: 'Gemini_Generated_Image_j227nxj227nxj227.png', ids: ['m81'] },               // Chicken Biryani
  { file: 'Gemini_Generated_Image_p5vubpp5vubpp5vu.png', ids: ['m95','m96','m97'] },   // Roti variants
  { file: 'Gemini_Generated_Image_gwp5jwgwp5jwgwp5.png', ids: ['m98','m99','m100','m101','m102','m103'] }, // Paratha
  { file: 'Gemini_Generated_Image_4xjoek4xjoek4xjo.png', ids: ['m104','m105','m106','m107'] }, // Dal
  { file: 'Gemini_Generated_Image_994oxr994oxr994o.png', ids: ['m110'] },              // Soft Drinks
];

async function run() {
  const db = new Database(DB_PATH);
  try { db.exec('ALTER TABLE menu_state ADD COLUMN image TEXT'); } catch (_) {}

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO menu_state (id, inStock, offer, image, stockCount)
    VALUES (
      ?,
      COALESCE((SELECT inStock    FROM menu_state WHERE id=?), 1),
      COALESCE((SELECT offer      FROM menu_state WHERE id=?), 0),
      ?,
      COALESCE((SELECT stockCount FROM menu_state WHERE id=?), NULL)
    )
  `);

  let ok = 0, fail = 0;
  const total = MAPPINGS.reduce((s, m) => s + m.ids.length, 0);
  console.log(`\n🖼️  Seeding ${total} menu images locally...\n`);

  for (const { file, ids } of MAPPINGS) {
    const src = path.join(IMAGES_DIR, file);
    if (!fs.existsSync(src)) {
      console.log(`  ⚠️  Not found: ${file}`);
      fail += ids.length;
      continue;
    }

    for (const id of ids) {
      const dest     = path.join(UPLOADS_DIR, `${id}.jpg`);
      const urlPath  = `/uploads/menu/${id}.jpg`;
      try {
        await sharp(src)
          .resize(600, 400, { fit: 'cover' })
          .jpeg({ quality: 82 })
          .toFile(dest);
        upsert.run(id, id, id, urlPath, id);
        console.log(`  ✅  ${id.padEnd(5)}  →  ${urlPath}`);
        ok++;
      } catch (err) {
        console.log(`  ❌  ${id}  —  ${err.message}`);
        fail++;
      }
    }
  }

  db.close();
  console.log(`\n📊  Done!  ✅ ${ok} seeded,  ❌ ${fail} failed.\n`);
  console.log('  → Restart the server (npm start) to see the images.\n');
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
