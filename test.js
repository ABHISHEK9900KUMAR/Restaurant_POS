/**
 * RestaurantOS - API Test Suite
 */
const http = require('http');

const BASE = 'http://localhost:3000';
let passed = 0;
let failed = 0;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function run() {
  console.log('\n=== RestaurantOS API Tests ===\n');

  // 1. Config
  console.log('[ GET /api/config ]');
  const cfg = await request('GET', '/api/config');
  assert('returns 200', cfg.status === 200);
  assert('success=true', cfg.body.success === true);
  assert('gstRate=0.05', cfg.body.data.gstRate === 0.05);
  assert('serviceChargeRate=0.1', cfg.body.data.serviceChargeRate === 0.1);
  assert('maxDiscountPercent=30', cfg.body.data.maxDiscountPercent === 30);

  // 2. Menu
  console.log('\n[ GET /api/menu ]');
  const menu = await request('GET', '/api/menu');
  assert('returns 200', menu.status === 200);
  assert('success=true', menu.body.success === true);
  assert('has 25 items', menu.body.data.length === 25, `got ${menu.body.data.length}`);
  assert('item has required fields', ['id','name','price','category','emoji'].every(f => f in menu.body.data[0]));
  const categories = [...new Set(menu.body.data.map(i => i.category))];
  assert(`has 5 categories (${categories.join(', ')})`, categories.length === 5);

  // 3. Orders (initially empty)
  console.log('\n[ GET /api/orders ]');
  const orders = await request('GET', '/api/orders');
  assert('returns 200', orders.status === 200);
  assert('success=true', orders.body.success === true);
  assert('initially empty array', Array.isArray(orders.body.data));

  // 4. Calculate billing
  console.log('\n[ POST /api/calculate ]');
  const items = [
    { id: 'm1', name: 'Veg Spring Roll', price: 180, quantity: 2 },
    { id: 'm10', name: 'Paneer Butter Masala', price: 300, quantity: 1 },
  ];
  // subtotal = 180*2 + 300 = 660

  const calc1 = await request('POST', '/api/calculate', { items });
  assert('returns 200', calc1.status === 200);
  assert('subtotal=660', calc1.body.data.subtotal === 660, `got ${calc1.body.data.subtotal}`);
  assert('no service charge by default', calc1.body.data.serviceCharge === 0);
  assert('gst = 660*0.05 = 33', calc1.body.data.gst === 33, `got ${calc1.body.data.gst}`);
  assert('total = 693', calc1.body.data.total === 693, `got ${calc1.body.data.total}`);

  // With service charge (10%) and discount (10%)
  // subtotal=660, discount=66, discountedSubtotal=594
  // serviceCharge=59.4, taxable=653.4, gst=32.67, total=686.07
  const calc2 = await request('POST', '/api/calculate', { items, applyServiceCharge: true, discountPercent: 10 });
  assert('with SC+discount: subtotal=660', calc2.body.data.subtotal === 660);
  assert('discountAmount=66', calc2.body.data.discountAmount === 66);
  assert('serviceCharge=59.4', calc2.body.data.serviceCharge === 59.4, `got ${calc2.body.data.serviceCharge}`);
  assert('gst=32.67', calc2.body.data.gst === 32.67, `got ${calc2.body.data.gst}`);
  assert('total=686.07', calc2.body.data.total === 686.07, `got ${calc2.body.data.total}`);

  // 5. Edge cases for /api/calculate
  console.log('\n[ POST /api/calculate — edge cases ]');
  const calcBad = await request('POST', '/api/calculate', { items: 'bad' });
  assert('invalid items → 400', calcBad.status === 400);

  const calcEmpty = await request('POST', '/api/calculate', { items: [] });
  assert('empty cart: total=0', calcEmpty.body.data.total === 0);

  // Discount capped at 30%
  const calcMaxDiscount = await request('POST', '/api/calculate', { items, discountPercent: 50 });
  assert('discount capped at 30%', calcMaxDiscount.body.data.discountPercent === 30);

  // 6. QR code
  console.log('\n[ GET /api/qr ]');
  const qrBad = await request('GET', '/api/qr');
  assert('missing url → 400', qrBad.status === 400);

  // 7. Page routes
  console.log('\n[ Page Routes ]');
  const customerPage = await request('GET', '/customer/');
  assert('/customer/ returns 200', customerPage.status === 200);

  const adminPage = await request('GET', '/admin/');
  assert('/admin/ returns 200', adminPage.status === 200);

  const notFound = await request('GET', '/kitchen');
  assert('/kitchen returns 404 (not implemented)', notFound.status === 404);

  // 8. Summary
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('ALL TESTS PASSED ✓');
  else console.log(`${failed} TEST(S) FAILED ✗`);
}

run().catch(console.error);
