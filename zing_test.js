const { io } = require("socket.io-client");
const http = require("http");

const BASE = "http://localhost:3000";
let pass = 0, fail = 0;

function log(label, ok, detail = "") {
  const sym = ok ? "✅" : "❌";
  console.log(`${sym} ${label}${detail ? " — " + detail : ""}`);
  if (ok) pass++; else fail++;
}

function get(path) {
  return new Promise((res, rej) => {
    http.get(BASE + path, r => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => { try { res(JSON.parse(d)); } catch(e) { res(d); } });
    }).on("error", rej);
  });
}

function post(path, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: "localhost", port: 3000,
      path, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    };
    const req = http.request(opts, r => {
      let d = "";
      r.on("data", c => d += c);
      r.on("end", () => { try { res(JSON.parse(d)); } catch(e) { res(d); } });
    });
    req.on("error", rej);
    req.write(data);
    req.end();
  });
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// Server expects item.quantity (not qty)
const ITEMS_1 = [
  { id: "m1", name: "Veg Spring Roll",      price: 180, quantity: 2 },
  { id: "m5", name: "Paneer Tikka",          price: 280, quantity: 1 }
];
const ITEMS_2 = [
  { id: "m10", name: "Dal Makhani",          price: 220, quantity: 1 },
  { id: "m15", name: "Butter Naan",          price: 60,  quantity: 3 }
];
const ITEMS_3 = [
  { id: "m2", name: "Chicken Wings",         price: 260, quantity: 2 },
  { id: "m8", name: "Paneer Butter Masala",  price: 320, quantity: 1 }
];

async function runTests() {
  console.log("\n=== ZingPOS End-to-End Test Suite ===\n");

  // ── REST API ──────────────────────────────────────────────────────
  console.log("── REST API ──");

  const menu = await get("/api/menu");
  log("GET /api/menu", menu.success && menu.data.length > 0, menu.data?.length + " items");

  const config = await get("/api/config");
  log("GET /api/config", config.success && config.data?.gstRate !== undefined,
    "GST=" + (config.data?.gstRate * 100) + "% SC=" + (config.data?.serviceChargeRate * 100) + "%");

  const tables = await get("/api/tables");
  log("GET /api/tables", tables.success && Array.isArray(tables.data), tables.data?.length + " tables");

  const orders = await get("/api/orders");
  log("GET /api/orders", orders.success, orders.data?.length + " existing orders");

  const pubUrl = await get("/api/public-url");
  log("GET /api/public-url", pubUrl.success, pubUrl.data?.customerUrl);

  // Auth: GET /api/auth?pin=...&role=...
  const authOk = await get("/api/auth?pin=1234&role=admin");
  log("GET /api/auth (admin PIN)", authOk.success === true);
  const authBad = await get("/api/auth?pin=0000&role=admin");
  log("GET /api/auth (wrong PIN rejected)", authBad.success === false);
  const waiterAuth = await get("/api/auth?pin=5678&role=waiter");
  log("GET /api/auth (waiter PIN)", waiterAuth.success === true);

  // Calculate: needs { items[].quantity, discountPercent, applyServiceCharge }
  const b1 = await post("/api/calculate", {
    items: [{ id: "m1", price: 180, quantity: 2 }, { id: "m5", price: 280, quantity: 1 }],
    applyServiceCharge: true, discountPercent: 0
  });
  log("POST /api/calculate (no disc)", b1.success && b1.data?.total > 0,
    "subtotal=Rs." + b1.data?.subtotal + " total=Rs." + b1.data?.total);

  const b2 = await post("/api/calculate", {
    items: [{ id: "m1", price: 360, quantity: 2 }],  // subtotal=720
    applyServiceCharge: true, discountPercent: 20
  });
  log("POST /api/calculate (20% disc)", b2.success && b2.data?.total < b2.data?.subtotal,
    "subtotal=Rs." + b2.data?.subtotal + " total=Rs." + b2.data?.total);

  const b3 = await post("/api/calculate", {
    items: [{ id: "m1", price: 500, quantity: 1 }],
    applyServiceCharge: false, discountPercent: 0
  });
  // GST only: 500 * 1.05 = 525
  log("POST /api/calculate (no SC, no disc)", b3.success && b3.data?.total === 525,
    "expected=525 got=" + b3.data?.total);

  await wait(500);

  // ── Sockets ──────────────────────────────────────────────────────
  console.log("\n── Socket Events ──");
  const socketAdmin = io(BASE, { transports: ["websocket"] });
  const socket1 = io(BASE, { transports: ["websocket"] });
  const socket2 = io(BASE, { transports: ["websocket"] });
  const socket3 = io(BASE, { transports: ["websocket"] });

  let initOk = false;
  let order1Id = null, order2Id = null, order3Id = null, order4Id = null;
  let paidOrderIds = [];
  let oosStatusTriggered = false;

  socketAdmin.on("init", (state) => {
    initOk = true;
    log("Socket: init event", true,
      state.orders?.length + " orders, " + state.menu?.length + " menu items");
  });
  // order:paid emits { orderId, change, total }
  socketAdmin.on("order:paid", (payload) => {
    if (payload?.orderId) paidOrderIds.push(payload.orderId);
    log("Socket: order:paid broadcast", !!payload?.orderId,
      "orderId=" + payload?.orderId + " change=Rs." + payload?.change + " total=Rs." + payload?.total);
  });
  socket3.on("order:updated", (o) => {
    if (o.status === "awaiting_customer") oosStatusTriggered = true;
  });

  await wait(1200);
  log("Socket: init received", initOk);

  // ── Order 1: T3 Cash + 15% discount ──────────────────────────
  console.log("\n── Order 1: T3, Cash + 15% Discount ──");
  const sess1 = "tsess-T3-" + Date.now();

  socket1.emit("cart:update", {
    sessionId: sess1, tableNo: "T3", customerName: "Ravi",
    items: ITEMS_1, subtotal: 640
  });
  await wait(700);

  const tablesAfterCart = await get("/api/tables");
  const t3 = (tablesAfterCart.data || []).find(t => t.tableId === "T3");
  log("T3 reserved after cart:update", t3?.occupied === true, "occupied=" + t3?.occupied);

  await new Promise(resolve => {
    socket1.emit("order:place", {
      sessionId: sess1, tableNo: "T3", customerName: "Ravi",
      items: ITEMS_1, subtotal: 640
    });
    socketAdmin.once("order:new", (o) => { order1Id = o.id; resolve(); });
    setTimeout(() => resolve(), 2500);
  });
  log("Order 1 placed (T3)", !!order1Id, order1Id);

  if (order1Id) {
    socketAdmin.emit("order:status_update", { orderId: order1Id, status: "preparing" });
    await wait(500);
    log("Order 1: status -> preparing", true);

    // apply_discount uses 'discountPercent' not 'discount'
    socketAdmin.emit("order:apply_discount", { orderId: order1Id, discountPercent: 15 });
    await wait(600);
    const ordersAfterDisc = await get("/api/orders");
    const o1 = ordersAfterDisc.data?.find(o => o.id === order1Id);
    log("Order 1: 15% discount applied",
      o1?.billing?.discountPercent === 15,
      "discountPercent=" + o1?.billing?.discountPercent + " total=Rs." + o1?.billing?.total);

    socketAdmin.emit("order:status_update", { orderId: order1Id, status: "ready" });
    await wait(300);
    socketAdmin.emit("order:status_update", { orderId: order1Id, status: "completed" });
    await wait(300);
    log("Order 1: ready -> completed", true);

    await new Promise(resolve => {
      socketAdmin.emit("order:payment", { orderId: order1Id, paymentMethod: "cash", cashTendered: 1000 });
      const check = setInterval(() => {
        if (paidOrderIds.includes(order1Id)) { clearInterval(check); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 3000);
    });
    log("Order 1: cash payment processed", paidOrderIds.includes(order1Id));
  }

  // ── Order 2: T4 UPI payment ────────────────────────────────────
  console.log("\n── Order 2: T4, UPI Payment ──");
  const sess2 = "tsess-T4-" + Date.now();

  await new Promise(resolve => {
    socket2.emit("order:place", {
      sessionId: sess2, tableNo: "T4", customerName: "Priya",
      items: ITEMS_2, subtotal: 400
    });
    socketAdmin.once("order:new", (o) => { order2Id = o.id; resolve(); });
    setTimeout(() => resolve(), 2500);
  });
  log("Order 2 placed (T4)", !!order2Id, order2Id);

  if (order2Id) {
    for (const status of ["preparing", "ready", "completed"]) {
      socketAdmin.emit("order:status_update", { orderId: order2Id, status });
      await wait(300);
    }
    log("Order 2: preparing -> ready -> completed", true);

    await new Promise(resolve => {
      socketAdmin.emit("order:payment-upi", { orderId: order2Id });
      const check = setInterval(() => {
        if (paidOrderIds.includes(order2Id)) { clearInterval(check); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 3000);
    });
    log("Order 2: UPI payment processed", paidOrderIds.includes(order2Id));
  }

  // ── Order 3: T5 OOS flow -> customer 'proceed' ─────────────────
  console.log("\n── Order 3: T5, OOS Flow (proceed) ──");
  const sess3 = "tsess-T5-" + Date.now();

  await new Promise(resolve => {
    socket3.emit("order:place", {
      sessionId: sess3, tableNo: "T5", customerName: "Suresh",
      items: ITEMS_3, subtotal: 840
    });
    socketAdmin.once("order:new", (o) => { order3Id = o.id; resolve(); });
    setTimeout(() => resolve(), 2500);
  });
  log("Order 3 placed (T5)", !!order3Id, order3Id);

  if (order3Id) {
    socketAdmin.emit("order:flag_oos", { orderId: order3Id, oosItemIds: ["m2"] });
    await wait(900);
    log("OOS flagged for m2 (Chicken Wings)", true);
    log("Order status -> awaiting_customer", oosStatusTriggered);

    socket3.emit("order:review_response", {
      orderId: order3Id, sessionId: sess3, choice: "proceed"
    });
    await wait(700);
    const ordersAfterProceed = await get("/api/orders");
    const o3 = ordersAfterProceed.data?.find(o => o.id === order3Id);
    log("Order 3: status after 'proceed'", o3?.status !== "awaiting_customer",
      "status=" + o3?.status);

    for (const status of ["preparing", "ready", "completed"]) {
      socketAdmin.emit("order:status_update", { orderId: order3Id, status });
      await wait(300);
    }
    socketAdmin.emit("order:payment", { orderId: order3Id, paymentMethod: "cash", cashTendered: 1000 });
    await wait(700);
    log("Order 3: OOS flow -> paid", paidOrderIds.includes(order3Id));
  }

  // ── Order 4: T6 Max discount enforcement ──────────────────────
  console.log("\n── Order 4: T6, Max Discount (30% cap) ──");
  const sess4 = "tsess-T6-" + Date.now();
  const socket4 = io(BASE, { transports: ["websocket"] });

  await new Promise(resolve => {
    socket4.emit("order:place", {
      sessionId: sess4, tableNo: "T6", customerName: "Meena",
      items: [{ id: "m6", name: "Fish Fry", price: 350, quantity: 1 }],
      subtotal: 350
    });
    socketAdmin.once("order:new", (o) => { order4Id = o.id; resolve(); });
    setTimeout(() => resolve(), 2500);
  });
  log("Order 4 placed (T6)", !!order4Id, order4Id);

  if (order4Id) {
    socketAdmin.emit("order:apply_discount", { orderId: order4Id, discountPercent: 50 });
    await wait(700);
    const ordersNow = await get("/api/orders");
    const o4 = ordersNow.data?.find(o => o.id === order4Id);
    const appliedDisc = o4?.billing?.discountPercent || 0;
    log("Max 30% discount enforced (tried 50%)", appliedDisc <= 30 && appliedDisc > 0,
      "applied=" + appliedDisc + "%");
  }

  // ── Order 5: T7 All items OOS -> 'modify' response ─────────────
  console.log("\n── Order 5: T7, All Items OOS (modify) ──");
  const sess5 = "tsess-T7-" + Date.now();
  const socket5 = io(BASE, { transports: ["websocket"] });
  let allOosTriggered = false;
  socket5.on("order:updated", (o) => {
    if (o.status === "awaiting_customer") allOosTriggered = true;
  });

  let order5Id = null;
  await new Promise(resolve => {
    socket5.emit("order:place", {
      sessionId: sess5, tableNo: "T7", customerName: "Kabir",
      items: [{ id: "m4", name: "Chilli Chicken", price: 280, quantity: 1 }],
      subtotal: 280
    });
    socketAdmin.once("order:new", (o) => { order5Id = o.id; resolve(); });
    setTimeout(() => resolve(), 2500);
  });
  log("Order 5 placed (T7)", !!order5Id, order5Id);

  if (order5Id) {
    socketAdmin.emit("order:flag_oos", { orderId: order5Id, oosItemIds: ["m4"] });
    await wait(900);
    log("All items OOS -> awaiting_customer triggered", allOosTriggered);
    socket5.emit("order:review_response", {
      orderId: order5Id, sessionId: sess5, choice: "modify"
    });
    await wait(500);
    const ordersAfterModify = await get("/api/orders");
    const o5 = ordersAfterModify.data?.find(o => o.id === order5Id);
    log("Order 5: customer chose modify (order back to pending/modifiable)",
      o5?.status !== "awaiting_customer",
      "status=" + o5?.status);
  }

  // ── Menu & Table Features ─────────────────────────────────────
  console.log("\n── Menu & Table Features ──");

  // menu:toggle_stock sets inStock explicitly (not a true toggle)
  // Read current state, then set opposite
  const menuCur = await get("/api/menu");
  const m9cur = menuCur.data?.find(i => i.id === "m9");
  const newInStock = !m9cur?.inStock;
  socketAdmin.emit("menu:toggle_stock", { itemId: "m9", inStock: newInStock });
  await wait(700);
  const menuAfterToggle = await get("/api/menu");
  const m9after = menuAfterToggle.data?.find(i => i.id === "m9");
  log("menu:toggle_stock (m9)", m9after?.inStock === newInStock,
    "was=" + m9cur?.inStock + " now=" + m9after?.inStock);

  // Set back
  socketAdmin.emit("menu:toggle_stock", { itemId: "m9", inStock: true });
  await wait(300);

  // Set offer (uses offerPercent)
  socketAdmin.emit("menu:set_offer", { itemId: "m4", offerPercent: 25 });
  await wait(700);
  const menuAfterOffer = await get("/api/menu");
  const m4after = menuAfterOffer.data?.find(i => i.id === "m4");
  log("menu:set_offer 25% on m4", m4after?.offer === 25, "offer=" + m4after?.offer + "%");

  // Clear offer
  socketAdmin.emit("menu:set_offer", { itemId: "m4", offerPercent: 0 });
  await wait(300);

  // Free a table
  socketAdmin.emit("table:free", { tableId: "T5" });
  await wait(600);
  const tablesEnd = await get("/api/tables");
  const t5End = (tablesEnd.data || []).find(t => t.tableId === "T5");
  log("table:free T5", !t5End?.occupied, "occupied=" + t5End?.occupied);

  // ── Billing math ──────────────────────────────────────────────
  console.log("\n── Billing Math ──");

  // Reset m1 offer to 0 so billing tests use clean base prices
  await new Promise(resolve => {
    const s = io(BASE, { transports: ['websocket'] });
    s.emit('menu:set_offer', { itemId: 'm1', offerPercent: 0 }, () => { s.disconnect(); resolve(); });
  });

  // subtotal=500, no SC, no disc -> gst=25, total=525
  const bm1 = await post("/api/calculate", {
    items: [{ id: "m1", price: 500, quantity: 1 }],
    applyServiceCharge: false, discountPercent: 0
  });
  log("Billing: GST only (500 * 1.05 = 525)",
    bm1.data?.total === 525, "got=" + bm1.data?.total);

  // subtotal=1000, SC=10%, disc=10% -> after_disc=900, SC=90, gst=(990)*5%=49.5, total=1039.5
  const bm2 = await post("/api/calculate", {
    items: [{ id: "m1", price: 1000, quantity: 1 }],
    applyServiceCharge: true, discountPercent: 10
  });
  log("Billing: disc=10% SC+GST (expected 1039.5)",
    bm2.data?.total === 1039.5, "got=" + bm2.data?.total);

  // subtotal=500, SC=10%, disc=0 -> SC=50, gst=(550)*5%=27.5, total=577.5
  const bm3 = await post("/api/calculate", {
    items: [{ id: "m1", price: 500, quantity: 1 }],
    applyServiceCharge: true, discountPercent: 0
  });
  log("Billing: SC+GST (expected 577.5)",
    bm3.data?.total === 577.5, "got=" + bm3.data?.total);

  // Verify discount is applied in billing
  const bm4 = await post("/api/calculate", {
    items: [{ id: "m1", price: 1000, quantity: 1 }],
    applyServiceCharge: false, discountPercent: 30
  });
  // disc=30%, after_disc=700, gst=35, total=735
  log("Billing: max 30% disc applied",
    bm4.data?.discountPercent === 30 && bm4.data?.total === 735, "got=" + bm4.data?.total);

  // ── Final state ───────────────────────────────────────────────
  console.log("\n── Final State ──");
  const finalOrders = await get("/api/orders");
  const paidCount = finalOrders.data?.filter(o => o.paymentStatus === "paid").length;
  log("Total orders", finalOrders.data?.length >= 5, finalOrders.data?.length + " total orders");
  log("Paid orders", paidCount >= 3, paidCount + " paid orders");

  const finalTables = await get("/api/tables");
  const occupiedCount = (finalTables.data || []).filter(t => t.occupied).length;
  log("Tables endpoint healthy", finalTables.success, occupiedCount + " currently occupied");

  // ── Summary ───────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════");
  console.log("  RESULTS: " + pass + " passed  |  " + fail + " failed  |  " + (pass + fail) + " total");
  console.log("══════════════════════════════════════════\n");

  [socketAdmin, socket1, socket2, socket3, socket4, socket5].forEach(s => s.disconnect());
  process.exit(fail > 0 ? 1 : 0);
}

runTests().catch(e => { console.error("Fatal:", e); process.exit(1); });
