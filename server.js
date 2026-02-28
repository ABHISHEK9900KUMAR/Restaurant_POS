/**
 * RestaurantOS — Production Backend Server
 * Node.js + Express + Socket.io
 * Version: 2.0.0
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');
const os = require('os');

// ─── Local IP Detection ───────────────────────────────────────────────────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  // Prefer Wi-Fi interface
  for (const name of Object.keys(interfaces)) {
    if (name.toLowerCase().includes('wi-fi') || name.toLowerCase().includes('wlan')) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
  }
  // Fallback: any non-internal IPv4
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIP();

// Public URL — set via env var to override (e.g. for ngrok/production)
// e.g.  PUBLIC_URL=https://abc123.ngrok.io node server.js
const PUBLIC_URL = process.env.PUBLIC_URL || null;

const app = express();
const server = http.createServer(app);

// ─── Socket.io Setup ────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config ─────────────────────────────────────────────────────────────────
const CONFIG = {
  GST_RATE: 0.05,           // 5% GST
  SERVICE_CHARGE_RATE: 0.10, // 10% Service Charge
  MAX_DISCOUNT_PERCENT: 30,  // Max 30% discount
  CART_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes
  PORT: process.env.PORT || 3000,
};

// ─── Menu Data ───────────────────────────────────────────────────────────────
const MENU = [
  // Starters — Chinese
  { id: 'm1',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Veg Spring Roll',          nameHi: 'वेज स्प्रिंग रोल',          price: 180, emoji: '🌯', popular: false, tags: ['guilt-free'],
    nutrition: { calories: 220, protein: 5,  carbs: 28, fat: 10, ingredients: ['Cabbage', 'Carrot', 'Bean Sprouts', 'Spring Onion', 'Flour Wrapper', 'Soy Sauce'] } },
  { id: 'm2',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Chilli Paneer (Dry)',       nameHi: 'चिली पनीर (ड्राई)',          price: 260, emoji: '🧀', popular: true,  tags: ['high-protein'],
    nutrition: { calories: 380, protein: 18, carbs: 22, fat: 22, ingredients: ['Paneer', 'Capsicum', 'Onion', 'Soy Sauce', 'Garlic', 'Cornstarch'] } },
  { id: 'm3',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Veg Manchurian (Dry)',      nameHi: 'वेज मंचूरियन (ड्राई)',       price: 220, emoji: '🥦', popular: false, tags: ['guilt-free'],
    nutrition: { calories: 280, protein: 7,  carbs: 32, fat: 13, ingredients: ['Mixed Vegetables', 'Garlic', 'Ginger', 'Soy Sauce', 'Chilli', 'Cornstarch'] } },
  { id: 'm4',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Chilli Chicken (Dry)',      nameHi: 'चिली चिकन (ड्राई)',          price: 280, emoji: '🌶️', popular: true,  tags: ['high-protein'],
    nutrition: { calories: 360, protein: 28, carbs: 18, fat: 18, ingredients: ['Chicken', 'Capsicum', 'Onion', 'Soy Sauce', 'Garlic', 'Green Chilli'] } },
  { id: 'm5',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Chicken Manchurian (Dry)',  nameHi: 'चिकन मंचूरियन (ड्राई)',      price: 300, emoji: '🍗', popular: false, tags: ['high-protein'],
    nutrition: { calories: 340, protein: 26, carbs: 20, fat: 16, ingredients: ['Chicken', 'Garlic', 'Ginger', 'Soy Sauce', 'Spring Onion', 'Cornstarch'] } },
  // Starters — Tandoori
  { id: 'm6',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Paneer Tikka',              nameHi: 'पनीर टिक्का',                price: 280, emoji: '🔥', popular: true,  tags: ['high-protein', 'guilt-free'],
    nutrition: { calories: 320, protein: 20, carbs: 12, fat: 20, ingredients: ['Paneer', 'Bell Peppers', 'Onion', 'Yogurt', 'Tandoori Masala', 'Lemon'] } },
  { id: 'm7',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Tandoori Mushroom',         nameHi: 'तंदूरी मशरूम',               price: 250, emoji: '🍄', popular: false, tags: ['guilt-free'],
    nutrition: { calories: 180, protein: 8,  carbs: 14, fat: 10, ingredients: ['Mushroom', 'Yogurt', 'Tandoori Masala', 'Ginger', 'Garlic', 'Lemon'] } },
  { id: 'm8',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Tandoori Chicken (Half)',   nameHi: 'तंदूरी चिकन (हाफ)',          price: 340, emoji: '🍗', popular: true,  tags: ['high-protein', 'guilt-free'],
    nutrition: { calories: 420, protein: 45, carbs: 8,  fat: 20, ingredients: ['Chicken', 'Yogurt', 'Tandoori Masala', 'Ginger', 'Garlic', 'Chaat Masala'] } },
  { id: 'm9',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Chicken Tikka',             nameHi: 'चिकन टिक्का',                price: 320, emoji: '🍖', popular: false, tags: ['high-protein', 'guilt-free'],
    nutrition: { calories: 380, protein: 38, carbs: 10, fat: 18, ingredients: ['Chicken Breast', 'Yogurt', 'Tikka Masala', 'Ginger', 'Garlic', 'Lemon'] } },
  // Main Course — North Indian
  { id: 'm10', category: 'Main Course', categoryHi: 'मुख्य व्यंजन', name: 'Paneer Butter Masala',      nameHi: 'पनीर बटर मसाला',             price: 300, emoji: '🧆', popular: true,  tags: ['high-protein'],
    nutrition: { calories: 420, protein: 18, carbs: 24, fat: 28, ingredients: ['Paneer', 'Tomato', 'Butter', 'Cream', 'Cashew', 'Cardamom'] } },
  { id: 'm11', category: 'Main Course', categoryHi: 'मुख्य व्यंजन', name: 'Dal Makhani',               nameHi: 'दाल मखनी',                   price: 240, emoji: '🫘', popular: true,  tags: ['high-protein', 'guilt-free'],
    nutrition: { calories: 340, protein: 16, carbs: 38, fat: 14, ingredients: ['Black Lentils', 'Kidney Beans', 'Butter', 'Cream', 'Tomato', 'Garlic'] } },
  { id: 'm12', category: 'Main Course', categoryHi: 'मुख्य व्यंजन', name: 'Butter Chicken',            nameHi: 'बटर चिकन',                   price: 360, emoji: '🍛', popular: true,  tags: ['high-protein'],
    nutrition: { calories: 460, protein: 32, carbs: 22, fat: 26, ingredients: ['Chicken', 'Tomato', 'Butter', 'Cream', 'Cashew', 'Fenugreek'] } },
  { id: 'm13', category: 'Main Course', categoryHi: 'मुख्य व्यंजन', name: 'Mutton Rogan Josh',         nameHi: 'मटन रोगन जोश',               price: 420, emoji: '🥩', popular: false, tags: ['high-protein'],
    nutrition: { calories: 520, protein: 40, carbs: 12, fat: 32, ingredients: ['Mutton', 'Kashmiri Chilli', 'Fennel', 'Cardamom', 'Cinnamon', 'Yogurt'] } },
  // Main Course — Biryani
  { id: 'm14', category: 'Main Course', categoryHi: 'मुख्य व्यंजन', name: 'Veg Biryani',               nameHi: 'वेज बिरयानी',                price: 240, emoji: '🍚', popular: false, tags: ['guilt-free'],
    nutrition: { calories: 380, protein: 10, carbs: 58, fat: 12, ingredients: ['Basmati Rice', 'Mixed Vegetables', 'Saffron', 'Fried Onions', 'Whole Spices', 'Ghee'] } },
  { id: 'm15', category: 'Main Course', categoryHi: 'मुख्य व्यंजन', name: 'Chicken Biryani (Full)',    nameHi: 'चिकन बिरयानी (फुल)',         price: 340, emoji: '🍲', popular: true,  tags: ['high-protein'],
    nutrition: { calories: 560, protein: 38, carbs: 62, fat: 18, ingredients: ['Basmati Rice', 'Chicken', 'Saffron', 'Fried Onions', 'Yogurt', 'Whole Spices'] } },
  { id: 'm16', category: 'Main Course', categoryHi: 'मुख्य व्यंजन', name: 'Mutton Biryani',            nameHi: 'मटन बिरयानी',                price: 420, emoji: '🥘', popular: false, tags: ['high-protein'],
    nutrition: { calories: 620, protein: 40, carbs: 64, fat: 22, ingredients: ['Basmati Rice', 'Mutton', 'Saffron', 'Fried Onions', 'Whole Spices', 'Ghee'] } },
  // Breads
  { id: 'm17', category: 'Breads',      categoryHi: 'रोटी',          name: 'Tandoori Roti',             nameHi: 'तंदूरी रोटी',                price: 25,  emoji: '🫓', popular: false, tags: ['guilt-free'],
    nutrition: { calories: 80,  protein: 3,  carbs: 16, fat: 1,  ingredients: ['Whole Wheat Flour', 'Water', 'Salt'] } },
  { id: 'm18', category: 'Breads',      categoryHi: 'रोटी',          name: 'Butter Naan',               nameHi: 'बटर नान',                    price: 55,  emoji: '🫓', popular: true,  tags: [],
    nutrition: { calories: 180, protein: 5,  carbs: 28, fat: 6,  ingredients: ['Refined Flour', 'Butter', 'Yogurt', 'Yeast', 'Salt'] } },
  { id: 'm19', category: 'Breads',      categoryHi: 'रोटी',          name: 'Garlic Naan',               nameHi: 'लहसुन नान',                  price: 70,  emoji: '🧄', popular: false, tags: [],
    nutrition: { calories: 200, protein: 5,  carbs: 30, fat: 7,  ingredients: ['Refined Flour', 'Garlic', 'Butter', 'Yogurt', 'Coriander', 'Yeast'] } },
  // Beverages
  { id: 'm20', category: 'Beverages',   categoryHi: 'पेय',           name: 'Coke (300ml)',              nameHi: 'कोक (300मिली)',               price: 40,  emoji: '🥤', popular: false, tags: [],
    nutrition: { calories: 130, protein: 0,  carbs: 35, fat: 0,  ingredients: ['Carbonated Water', 'Sugar', 'Caramel Colour', 'Phosphoric Acid', 'Natural Flavours', 'Caffeine'] } },
  { id: 'm21', category: 'Beverages',   categoryHi: 'पेय',           name: 'Sprite (300ml)',            nameHi: 'स्प्राइट (300मिली)',          price: 40,  emoji: '🥤', popular: false, tags: [],
    nutrition: { calories: 120, protein: 0,  carbs: 33, fat: 0,  ingredients: ['Carbonated Water', 'Sugar', 'Citric Acid', 'Natural Flavour', 'Sodium Citrate'] } },
  { id: 'm22', category: 'Beverages',   categoryHi: 'पेय',           name: 'Mineral Water (1L)',        nameHi: 'मिनरल वाटर (1ली)',            price: 20,  emoji: '💧', popular: false, tags: ['guilt-free'],
    nutrition: { calories: 0,   protein: 0,  carbs: 0,  fat: 0,  ingredients: ['Purified Water'] } },
  // Desserts
  { id: 'm23', category: 'Desserts',    categoryHi: 'मिठाई',         name: 'Gulab Jamun (2 pcs)',       nameHi: 'गुलाब जामुन (2 पीस)',        price: 90,  emoji: '🍮', popular: true,  tags: [],
    nutrition: { calories: 320, protein: 6,  carbs: 48, fat: 12, ingredients: ['Milk Solids', 'Refined Flour', 'Cardamom', 'Rose Water', 'Sugar Syrup', 'Ghee'] } },
  { id: 'm24', category: 'Desserts',    categoryHi: 'मिठाई',         name: 'Rasgulla (2 pcs)',          nameHi: 'रसगुल्ला (2 पीस)',           price: 90,  emoji: '🍡', popular: false, tags: [],
    nutrition: { calories: 240, protein: 8,  carbs: 38, fat: 6,  ingredients: ['Chenna', 'Sugar', 'Cardamom', 'Rose Water'] } },
  { id: 'm25', category: 'Desserts',    categoryHi: 'मिठाई',         name: 'Brownie with Ice Cream',    nameHi: 'ब्राउनी विद आइसक्रीम',      price: 160, emoji: '🍫', popular: true,  tags: [],
    nutrition: { calories: 480, protein: 6,  carbs: 62, fat: 22, ingredients: ['Dark Chocolate', 'Butter', 'Eggs', 'Flour', 'Sugar', 'Vanilla Ice Cream'] } },
];

// Add dynamic fields to every menu item
MENU.forEach(item => { item.inStock = true; item.offer = 0; });

// ─── In-Memory State ─────────────────────────────────────────────────────────
let orders = [];         // Confirmed orders
let activeCarts = {};    // Temporary cart sessions
let orderCounter = 1000; // Starting order ID

// ─── Table Occupancy Tracking ─────────────────────────────────────────────────
// occupiedTables: { 'T1': { customerName, orderId, since } }
let occupiedTables = {};

function getTablesStatus() {
  const ALL_TABLES = ['T1','T2','T3','T4','T5','T6','T7','T8','T9','T10'];
  return ALL_TABLES.map(tableId => ({
    tableId,
    occupied: !!occupiedTables[tableId],
    customerName: occupiedTables[tableId]?.customerName || null,
    orderId: occupiedTables[tableId]?.orderId || null,
    since: occupiedTables[tableId]?.since || null,
  }));
}

function broadcastTablesStatus() {
  io.emit('tables:status', { tables: getTablesStatus() });
}

// ─── Billing Engine (Centralized) ───────────────────────────────────────────
function calculateBill(items, options = {}) {
  const { applyServiceCharge = false, discountPercent = 0 } = options;
  const safeDiscount = Math.min(Math.max(0, discountPercent), CONFIG.MAX_DISCOUNT_PERCENT);

  const subtotal = items.reduce((sum, item) => {
    const qty = Math.max(0, Math.floor(item.quantity));
    const basePrice = parseFloat(item.price) || 0;
    const menuItem = MENU.find(m => m.id === item.id);
    const offer = menuItem ? (menuItem.offer || 0) : 0;
    const effectivePrice = offer > 0 ? round2(basePrice * (1 - offer / 100)) : basePrice;
    return sum + round2(effectivePrice * qty);
  }, 0);

  const discountAmount = round2(subtotal * (safeDiscount / 100));
  const discountedSubtotal = round2(subtotal - discountAmount);
  const serviceCharge = applyServiceCharge ? round2(discountedSubtotal * CONFIG.SERVICE_CHARGE_RATE) : 0;
  const taxableAmount = round2(discountedSubtotal + serviceCharge);
  const gst = round2(taxableAmount * CONFIG.GST_RATE);
  const total = round2(taxableAmount + gst);

  return {
    subtotal,
    discountPercent: safeDiscount,
    discountAmount,
    discountedSubtotal,
    serviceCharge,
    gst,
    total,
    itemCount: items.reduce((s, i) => s + Math.max(0, Math.floor(i.quantity)), 0),
  };
}

function round2(val) {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

function generateOrderId() {
  orderCounter++;
  return `ORD-${orderCounter}`;
}

function getTimestamp() {
  return new Date().toISOString();
}

// ─── Cart Session Management ─────────────────────────────────────────────────
function clearCartTimeout(sessionId) {
  if (activeCarts[sessionId]?.timeout) {
    clearTimeout(activeCarts[sessionId].timeout);
  }
}

function setCartExpiry(sessionId) {
  clearCartTimeout(sessionId);
  if (activeCarts[sessionId]) {
    activeCarts[sessionId].timeout = setTimeout(() => {
      if (activeCarts[sessionId]) {
        delete activeCarts[sessionId];
        io.emit('cart:expired', { sessionId });
        io.emit('admin:cart_update', { activeCarts: getPublicCarts() });
      }
    }, CONFIG.CART_TIMEOUT_MS);
  }
}

function getPublicCarts() {
  return Object.entries(activeCarts).map(([id, cart]) => ({
    sessionId: id,
    customerName: cart.customerName,
    tableNo: cart.tableNo,
    items: cart.items,
    billing: calculateBill(cart.items, { applyServiceCharge: cart.applyServiceCharge, discountPercent: cart.discountPercent }),
    lastUpdate: cart.lastUpdate,
    lastActivity: cart.lastActivity || null,
  }));
}

// ─── REST API ─────────────────────────────────────────────────────────────────

// ── PIN Authentication ────────────────────────────────────────────────────────
app.get('/api/auth', (req, res) => {
  const { pin, role } = req.query;
  const adminPin  = process.env.ADMIN_PIN  || '1234';
  const waiterPin = process.env.WAITER_PIN || '5678';
  if (role === 'admin'  && pin === adminPin)  return res.json({ success: true });
  if (role === 'waiter' && pin === waiterPin) return res.json({ success: true });
  return res.status(401).json({ success: false, error: 'Incorrect PIN' });
});

app.get('/api/menu', (req, res) => {
  res.json({ success: true, data: MENU });
});

app.get('/api/orders', (req, res) => {
  res.json({ success: true, data: orders });
});

app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    data: {
      gstRate: CONFIG.GST_RATE,
      serviceChargeRate: CONFIG.SERVICE_CHARGE_RATE,
      maxDiscountPercent: CONFIG.MAX_DISCOUNT_PERCENT,
    },
  });
});

// ── Returns the correct public-facing URL for QR code generation ──────────────
// Priority: PUBLIC_URL env var → local network IP → localhost
app.get('/api/public-url', (req, res) => {
  const base = PUBLIC_URL || `http://${LOCAL_IP}:${CONFIG.PORT}`;
  res.json({
    success: true,
    data: {
      publicUrl: base,
      customerUrl: `${base}/customer`,
      localIp: LOCAL_IP,
    },
  });
});

// ── App Routes ────────────────────────────────────────────
app.get('/customer', (req, res) => res.sendFile(path.join(__dirname, 'public/customer/index.html')));
app.get('/customer/', (req, res) => res.sendFile(path.join(__dirname, 'public/customer/index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));
app.get('/admin/', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));
app.get('/waiter', (req, res) => res.sendFile(path.join(__dirname, 'public/waiter/index.html')));
app.get('/waiter/', (req, res) => res.sendFile(path.join(__dirname, 'public/waiter/index.html')));
app.get('/', (req, res) => res.redirect('/customer'));

app.get('/api/tables', (req, res) => {
  res.json({ success: true, data: getTablesStatus() });
});

app.get('/api/qr', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const png = await QRCode.toBuffer(url, { width: 260, margin: 2 });
    res.set('Content-Type', 'image/png').send(png);
  } catch (e) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

app.post('/api/calculate', (req, res) => {
  const { items, applyServiceCharge, discountPercent } = req.body;
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ success: false, error: 'Invalid items' });
  }
  res.json({ success: true, data: calculateBill(items, { applyServiceCharge, discountPercent }) });
});

// ─── Socket.io Events ────────────────────────────────────────────────────────
const processedEvents = new Set();

function isDuplicate(eventId) {
  if (!eventId) return false;
  if (processedEvents.has(eventId)) return true;
  processedEvents.add(eventId);
  setTimeout(() => processedEvents.delete(eventId), 30000);
  return false;
}

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  socket.emit('init', {
    menu: MENU,
    orders,
    activeCarts: getPublicCarts(),
    tablesStatus: getTablesStatus(),
    config: {
      gstRate: CONFIG.GST_RATE,
      serviceChargeRate: CONFIG.SERVICE_CHARGE_RATE,
      maxDiscountPercent: CONFIG.MAX_DISCOUNT_PERCENT,
    },
  });

  // ── Cart Updates (Customer browsing) ──
  socket.on('cart:update', (data, ack) => {
    const { sessionId, items, customerName, tableNo, applyServiceCharge, discountPercent, eventId } = data;

    if (isDuplicate(eventId)) {
      if (typeof ack === 'function') ack({ success: true, duplicate: true });
      return;
    }

    if (!sessionId) {
      if (typeof ack === 'function') ack({ success: false, error: 'Missing sessionId' });
      return;
    }

    const billing = calculateBill(items || [], { applyServiceCharge, discountPercent });

    activeCarts[sessionId] = {
      ...activeCarts[sessionId],
      sessionId,
      items: items || [],
      customerName: customerName || '',
      tableNo: tableNo || '',
      applyServiceCharge: !!applyServiceCharge,
      discountPercent: discountPercent || 0,
      billing,
      lastUpdate: getTimestamp(),
    };

    setCartExpiry(sessionId);
    io.emit('admin:cart_update', { activeCarts: getPublicCarts() });

    if (typeof ack === 'function') ack({ success: true, billing });
  });

  // ── Place Order (Customer) ──
  socket.on('order:place', (data, ack) => {
    const { sessionId, items, customerName, tableNo, applyServiceCharge, discountPercent, eventId } = data;

    if (isDuplicate(eventId)) {
      if (typeof ack === 'function') ack({ success: true, duplicate: true, message: 'Order already placed' });
      return;
    }

    if (!items || items.length === 0) {
      if (typeof ack === 'function') ack({ success: false, error: 'Cart is empty' });
      return;
    }
    if (!customerName || customerName.trim().length < 2) {
      if (typeof ack === 'function') ack({ success: false, error: 'Please enter your name (min 2 characters)' });
      return;
    }
    if (!tableNo || tableNo.trim().length === 0) {
      if (typeof ack === 'function') ack({ success: false, error: 'Please enter a table number' });
      return;
    }

    const billing = calculateBill(items, { applyServiceCharge, discountPercent });

    const order = {
      id: generateOrderId(),
      sessionId,
      customerName: customerName.trim(),
      tableNo: tableNo.trim(),
      items,
      billing,
      status: 'pending',
      paymentStatus: 'unpaid',
      createdAt: getTimestamp(),
      updatedAt: getTimestamp(),
      statusHistory: [{ status: 'pending', timestamp: getTimestamp() }],
    };

    orders.push(order);

    // Mark table as occupied
    occupiedTables[order.tableNo] = {
      customerName: order.customerName,
      orderId: order.id,
      since: getTimestamp(),
    };
    broadcastTablesStatus();

    clearCartTimeout(sessionId);
    delete activeCarts[sessionId];

    io.emit('order:new', order);
    io.emit('admin:cart_update', { activeCarts: getPublicCarts() });

    if (typeof ack === 'function') ack({ success: true, order });

    console.log(`[Order] New order placed: ${order.id} for ${order.customerName} at Table ${order.tableNo}`);
  });

  // ── Update Order Status (Admin) ──
  socket.on('order:status_update', (data, ack) => {
    const { orderId, status, eventId } = data;

    if (isDuplicate(eventId)) {
      if (typeof ack === 'function') ack({ success: true, duplicate: true });
      return;
    }

    const validStatuses = ['pending', 'preparing', 'ready', 'completed', 'awaiting_customer', 'cancelled'];
    if (!validStatuses.includes(status)) {
      if (typeof ack === 'function') ack({ success: false, error: 'Invalid status' });
      return;
    }

    const order = orders.find(o => o.id === orderId);
    if (!order) {
      if (typeof ack === 'function') ack({ success: false, error: 'Order not found' });
      return;
    }

    order.status = status;
    order.updatedAt = getTimestamp();
    order.statusHistory.push({ status, timestamp: getTimestamp() });

    io.emit('order:updated', order);

    if (typeof ack === 'function') ack({ success: true, order });

    console.log(`[Order] Status updated: ${orderId} → ${status}`);
  });

  // ── Process Payment (Admin) ──
  socket.on('order:payment', (data, ack) => {
    const { orderId, cashTendered, eventId } = data;

    if (isDuplicate(eventId)) {
      if (typeof ack === 'function') ack({ success: true, duplicate: true });
      return;
    }

    const order = orders.find(o => o.id === orderId);
    if (!order) {
      if (typeof ack === 'function') ack({ success: false, error: 'Order not found' });
      return;
    }

    if (order.paymentStatus === 'paid') {
      if (typeof ack === 'function') ack({ success: false, error: 'Order already paid' });
      return;
    }

    if (order.status !== 'completed' && order.status !== 'ready') {
      if (typeof ack === 'function') ack({ success: false, error: 'Order must be Ready or Completed before payment' });
      return;
    }

    const cash = parseFloat(cashTendered);
    if (isNaN(cash) || cash < order.billing.total) {
      if (typeof ack === 'function') ack({ success: false, error: `Insufficient cash. Total is ₹${order.billing.total.toFixed(2)}` });
      return;
    }

    const change = round2(cash - order.billing.total);

    order.paymentStatus = 'paid';
    order.status = 'completed';
    order.paidAt = getTimestamp();
    order.cashTendered = round2(cash);
    order.change = change;
    order.updatedAt = getTimestamp();
    order.statusHistory.push({ status: 'paid', timestamp: getTimestamp() });

    // Free the table
    delete occupiedTables[order.tableNo];
    broadcastTablesStatus();

    io.emit('order:updated', order);
    io.emit('order:paid', { orderId, change, total: order.billing.total });

    if (typeof ack === 'function') ack({ success: true, order, change });

    console.log(`[Payment] Order paid: ${orderId}, Change: ₹${change}`);
  });

  // ── Apply Discount (Admin) ──
  socket.on('order:apply_discount', (data, ack) => {
    const { orderId, discountPercent, eventId } = data;

    if (isDuplicate(eventId)) {
      if (typeof ack === 'function') ack({ success: true, duplicate: true });
      return;
    }

    const order = orders.find(o => o.id === orderId);
    if (!order) {
      if (typeof ack === 'function') ack({ success: false, error: 'Order not found' });
      return;
    }

    if (order.paymentStatus === 'paid') {
      if (typeof ack === 'function') ack({ success: false, error: 'Cannot modify a paid order' });
      return;
    }

    const discount = Math.min(Math.max(0, parseFloat(discountPercent) || 0), CONFIG.MAX_DISCOUNT_PERCENT);
    order.billing = calculateBill(order.items, {
      applyServiceCharge: order.billing.serviceCharge > 0,
      discountPercent: discount,
    });
    order.updatedAt = getTimestamp();

    io.emit('order:updated', order);

    if (typeof ack === 'function') ack({ success: true, order });
  });

  // ── Accept Order (Admin) ──
  socket.on('order:accept', (data, ack) => {
    const { orderId, eventId } = data;

    if (isDuplicate(eventId)) {
      if (typeof ack === 'function') ack({ success: true, duplicate: true });
      return;
    }

    const order = orders.find(o => o.id === orderId);
    if (!order) {
      if (typeof ack === 'function') ack({ success: false, error: 'Order not found' });
      return;
    }

    order.status = 'preparing';
    order.updatedAt = getTimestamp();
    order.statusHistory.push({ status: 'preparing', timestamp: getTimestamp() });

    io.emit('order:updated', order);
    if (typeof ack === 'function') ack({ success: true, order });
    console.log(`[Order] Accepted: ${orderId} → preparing`);
  });

  // ── Flag OOS Items (Admin) ──
  socket.on('order:flag_oos', (data, ack) => {
    const { orderId, oosItemIds, eventId } = data;

    if (isDuplicate(eventId)) {
      if (typeof ack === 'function') ack({ success: true, duplicate: true });
      return;
    }

    const order = orders.find(o => o.id === orderId);
    if (!order) {
      if (typeof ack === 'function') ack({ success: false, error: 'Order not found' });
      return;
    }

    order.oosItems = (oosItemIds || []).map(id => {
      const menuItem = MENU.find(m => m.id === id);
      return { id, name: menuItem?.name || id, nameHi: menuItem?.nameHi || menuItem?.name || id };
    });
    order.status = 'awaiting_customer';
    order.updatedAt = getTimestamp();
    order.statusHistory.push({ status: 'awaiting_customer', timestamp: getTimestamp() });

    io.emit('order:updated', order);
    if (typeof ack === 'function') ack({ success: true, order });
    console.log(`[Order] OOS flagged: ${orderId}, items: ${(oosItemIds || []).join(', ')}`);
  });

  // ── Customer/Waiter Review Response ──
  socket.on('order:review_response', (data, ack) => {
    const { orderId, choice, eventId } = data;

    if (isDuplicate(eventId)) {
      if (typeof ack === 'function') ack({ success: true, duplicate: true });
      return;
    }

    const order = orders.find(o => o.id === orderId);
    if (!order) {
      if (typeof ack === 'function') ack({ success: false, error: 'Order not found' });
      return;
    }

    if (choice === 'proceed') {
      const oosIds = (order.oosItems || []).map(i => i.id);
      order.items = order.items.filter(i => !oosIds.includes(i.id));
      order.billing = calculateBill(order.items, {
        applyServiceCharge: order.billing.serviceCharge > 0,
        discountPercent: order.billing.discountPercent || 0,
      });
      order.reviewResponse = 'proceed';
      order.status = 'preparing';
      order.updatedAt = getTimestamp();
      order.statusHistory.push({ status: 'preparing', timestamp: getTimestamp() });
      io.emit('order:updated', order);
      if (typeof ack === 'function') ack({ success: true, order });
      console.log(`[Order] Review proceed: ${orderId} → preparing`);
    } else if (choice === 'cancel') {
      order.reviewResponse = 'cancel';
      order.status = 'cancelled';
      order.updatedAt = getTimestamp();
      order.statusHistory.push({ status: 'cancelled', timestamp: getTimestamp() });
      delete occupiedTables[order.tableNo];
      broadcastTablesStatus();
      io.emit('order:updated', order);
      if (typeof ack === 'function') ack({ success: true, order });
      console.log(`[Order] Review cancel: ${orderId} → cancelled`);
    } else if (choice === 'modify') {
      order.reviewResponse = 'modify';
      order.status = 'cancelled';
      order.updatedAt = getTimestamp();
      order.statusHistory.push({ status: 'cancelled', timestamp: getTimestamp() });
      // Do NOT free the table — customer is reordering at same table
      io.emit('order:updated', order);
      if (typeof ack === 'function') ack({ success: true, order });
      console.log(`[Order] Review modify: ${orderId} → cancelled (table kept)`);
    } else {
      if (typeof ack === 'function') ack({ success: false, error: 'Invalid choice' });
    }
  });

  // ── Manual Table Free (Admin) ──
  socket.on('table:free', (data, ack) => {
    const { tableId } = data;
    if (!tableId) {
      if (typeof ack === 'function') ack({ success: false, error: 'Missing tableId' });
      return;
    }
    delete occupiedTables[tableId];
    broadcastTablesStatus();
    if (typeof ack === 'function') ack({ success: true });
    console.log(`[Table] Manually freed: ${tableId}`);
  });

  // ── Menu Management (Admin) ──
  socket.on('menu:toggle_stock', (data, ack) => {
    const { itemId, inStock } = data;
    const item = MENU.find(m => m.id === itemId);
    if (!item) { if (typeof ack === 'function') ack({ success: false, error: 'Item not found' }); return; }
    item.inStock = !!inStock;
    io.emit('menu:updated', { menu: MENU });
    if (typeof ack === 'function') ack({ success: true });
    console.log(`[Menu] ${item.name} → ${inStock ? 'In Stock' : 'Out of Stock'}`);
  });

  socket.on('menu:set_offer', (data, ack) => {
    const { itemId, offerPercent } = data;
    const item = MENU.find(m => m.id === itemId);
    if (!item) { if (typeof ack === 'function') ack({ success: false, error: 'Item not found' }); return; }
    item.offer = Math.min(Math.max(0, parseFloat(offerPercent) || 0), 50);
    io.emit('menu:updated', { menu: MENU });
    if (typeof ack === 'function') ack({ success: true });
    console.log(`[Menu] ${item.name} → offer: ${item.offer}%`);
  });

  // ── Customer Browsing Activity ──
  socket.on('customer:browsing', (data) => {
    const { sessionId, itemId, itemName, action } = data;
    if (!sessionId || !activeCarts[sessionId]) return;
    const menuItem = MENU.find(m => m.id === itemId);
    const itemNameHi = menuItem?.nameHi || itemName;
    activeCarts[sessionId].lastActivity = { itemId, itemName, itemNameHi, action, timestamp: getTimestamp() };
    io.emit('admin:cart_update', { activeCarts: getPublicCarts() });
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
server.listen(CONFIG.PORT, () => {
  const networkUrl = `http://${LOCAL_IP}:${CONFIG.PORT}`;
  const publicBase = PUBLIC_URL || networkUrl;

  console.log(`\n⚡  ZingPOS Server is running!\n`);
  console.log(`   💻  PC (Admin):      http://localhost:${CONFIG.PORT}/admin`);
  console.log(`   🧑‍💼  Waiter Tab:      http://localhost:${CONFIG.PORT}/waiter`);
  console.log(`   📱  Phone (Customer): ${networkUrl}/customer`);
  console.log(`   📷  QR Code URL:     ${publicBase}/customer\n`);

  if (PUBLIC_URL) {
    console.log(`   🌐  Public URL override: ${PUBLIC_URL}\n`);
  } else {
    console.log(`   ℹ️   Both devices must be on the same Wi-Fi network.`);
    console.log(`   ℹ️   To use externally, set: PUBLIC_URL=https://your-url.com node server.js\n`);
  }
});
