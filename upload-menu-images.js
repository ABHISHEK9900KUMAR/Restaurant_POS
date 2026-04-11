/**
 * upload-menu-images.js — Uploads local Menu_images/ PNGs to Cloudinary
 * and saves the URLs to the local SQLite database.
 *
 * Run once before deploying:
 *   1. Add CLOUDINARY_URL=cloudinary://api_key:api_secret@cloud_name to .env
 *   2. node upload-menu-images.js
 *
 * After this, every Render deploy will auto-restore images from Cloudinary on startup.
 */

require('dotenv').config();
const cloudinary  = require('cloudinary').v2;
const Database    = require('better-sqlite3');
const fs          = require('fs');
const path        = require('path');

// ── Cloudinary config (supports both CLOUDINARY_URL and individual vars) ─────
if (process.env.CLOUDINARY_URL) {
  cloudinary.config({ cloudinary_url: process.env.CLOUDINARY_URL });
} else {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

const IMAGES_DIR = path.join(__dirname, 'Menu_images');
const DB_PATH    = path.join(__dirname, 'data', 'restaurantos.db');

// ── Image mappings: which local file → which menu item IDs ───────────────────
// Items that share the same image get uploaded once; the same Cloudinary URL
// is written for each item ID.
const MAPPINGS = [
  {
    file: 'Gemini_Generated_Image_35p2sg35p2sg35p2.png',
    ids:  ['m1', 'm2'],           // Paneer Chilly (Half / Full)
  },
  {
    file: 'Gemini_Generated_Image_fziu8kfziu8kfziu.png',
    ids:  ['m3', 'm4'],           // Paneer Manchurian (Half / Full)
  },
  {
    file: 'Gemini_Generated_Image_48eg0348eg0348eg.png',
    ids:  ['m9', 'm10', 'm11', 'm12', 'm31'],  // Mushroom Chilly / Manchurian / Masala
  },
  {
    file: 'Gemini_Generated_Image_izmo5oizmo5oizmo.png',
    ids:  ['m13', 'm14', 'm17', 'm18'],  // Chilly Chicken + Chicken 65 (closest match)
  },
  {
    file: 'Gemini_Generated_Image_fnlfgpfnlfgpfnlf.png',
    ids:  ['m15', 'm16'],         // Chicken Manchurian (Half / Full)
  },
  {
    file: 'Gemini_Generated_Image_9z7ixd9z7ixd9z7i.png',
    ids:  ['m29'],                // Kadhai Paneer
  },
  {
    file: 'Gemini_Generated_Image_ldm7clldm7clldm7.png',
    ids:  ['m30', 'm37'],         // Matar Paneer + Paneer Butter Masala
  },
  {
    file: 'Gemini_Generated_Image_syyhfwsyyhfwsyyh.png',
    ids:  ['m38'],                // Paneer Makhani
  },
  {
    file: 'Gemini_Generated_Image_6kjyur6kjyur6kjy.png',
    ids:  ['m40', 'm41', 'm42'], // Chicken Curry (2pc / 4pc / 8pc)
  },
  {
    file: 'Gemini_Generated_Image_jqpk06jqpk06jqpk.png',
    ids:  ['m80'],                // Veg Biryani
  },
  {
    file: 'Gemini_Generated_Image_j227nxj227nxj227.png',
    ids:  ['m81'],                // Chicken Biryani
  },
  {
    file: 'Gemini_Generated_Image_p5vubpp5vubpp5vu.png',
    ids:  ['m95', 'm96', 'm97'], // Plain / Ghee / Butter Roti
  },
  {
    file: 'Gemini_Generated_Image_gwp5jwgwp5jwgwp5.png',
    ids:  ['m98', 'm99', 'm100', 'm101', 'm102', 'm103'], // Paratha variants
  },
  {
    file: 'Gemini_Generated_Image_4xjoek4xjoek4xjo.png',
    ids:  ['m104', 'm105', 'm106', 'm107'],  // Dal Fry / Dal Tadka
  },
  {
    file: 'Gemini_Generated_Image_994oxr994oxr994o.png',
    ids:  ['m110'],               // Soft Drinks
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function uploadToCloudinary(filePath, publicId) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      filePath,
      { public_id: publicId, overwrite: true, resource_type: 'image' },
      (err, result) => err ? reject(err) : resolve(result.secure_url),
    );
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  // Verify Cloudinary is configured
  const cfg = cloudinary.config();
  if (!cfg.cloud_name) {
    console.error('\n❌  No Cloudinary credentials found.');
    console.error('    Add CLOUDINARY_URL=cloudinary://api_key:api_secret@cloud_name to .env\n');
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  // Ensure image column exists
  try { db.exec('ALTER TABLE menu_state ADD COLUMN image TEXT'); } catch (_) {}

  const upsert = db.prepare(
    'INSERT OR REPLACE INTO menu_state (id, inStock, offer, image, stockCount) ' +
    'VALUES (?, COALESCE((SELECT inStock FROM menu_state WHERE id=?), 1), ' +
    'COALESCE((SELECT offer FROM menu_state WHERE id=?), 0), ?, ' +
    'COALESCE((SELECT stockCount FROM menu_state WHERE id=?), NULL))'
  );

  let ok = 0, fail = 0;
  const totalItems = MAPPINGS.reduce((s, m) => s + m.ids.length, 0);
  console.log(`\n🖼️  Uploading ${MAPPINGS.length} images → ${totalItems} menu item assignments...\n`);

  for (const { file, ids } of MAPPINGS) {
    const filePath = path.join(IMAGES_DIR, file);

    if (!fs.existsSync(filePath)) {
      console.log(`  ⚠️  File not found, skipping: ${file}`);
      fail += ids.length;
      continue;
    }

    // Upload once using the first item's ID as the Cloudinary public_id
    const primaryId  = ids[0];
    const publicId   = `dinefy-menu/${primaryId}`;
    process.stdout.write(`  ⬆️  Uploading ${file.slice(0, 40)}… `);

    let secureUrl;
    try {
      secureUrl = await uploadToCloudinary(filePath, publicId);
      process.stdout.write(`✅\n`);
    } catch (err) {
      console.log(`❌  ${err.message}`);
      fail += ids.length;
      continue;
    }

    // Upload separately for each additional ID so each has its own Cloudinary asset
    // (allows per-item deletion later). Collect the per-item URLs.
    const itemUrls = { [primaryId]: secureUrl };
    for (let i = 1; i < ids.length; i++) {
      const extraId = ids[i];
      try {
        itemUrls[extraId] = await uploadToCloudinary(filePath, `dinefy-menu/${extraId}`);
      } catch (err) {
        console.log(`     ❌  Extra upload failed for ${extraId}: ${err.message}`);
        itemUrls[extraId] = secureUrl; // fallback to the primary URL
      }
    }

    // Save to DB
    for (const id of ids) {
      const url = itemUrls[id] || secureUrl;
      upsert.run(id, id, id, url, id);
      console.log(`     💾  ${id} → ${url}`);
      ok++;
    }
  }

  db.close();
  console.log(`\n📊  Done!  ✅ ${ok} items updated,  ❌ ${fail} failed.\n`);
  console.log('Next steps:');
  console.log('  • Restart your local server (npm start) to see images');
  console.log('  • Push to git + deploy on Render — images auto-restore from Cloudinary on startup\n');
}

run().catch(err => {
  console.error('\n❌  Fatal:', err.message);
  process.exit(1);
});
