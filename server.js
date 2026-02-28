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
  { id: 'm1',  category: 'Starters',    name: 'Veg Spring Roll',          price: 180, emoji: '🌯', popular: false },
  { id: 'm2',  category: 'Starters',    name: 'Chilli Paneer (Dry)',       price: 260, emoji: '🧀', popular: true  },
  { id: 'm3',  category: 'Starters',    name: 'Veg Manchurian (Dry)',      price: 220, emoji: '🥦', popular: false },
  { id: 'm4',  category: 'Starters',    name: 'Chilli Chicken (Dry)',      price: 280, emoji: '🌶️', popular: true  },
  { id: 'm5',  category: 'Starters',    name: 'Chicken Manchurian (Dry)',  price: 300, emoji: '🍗', popular: false },
  // Starters — Tandoori
  { id: 'm6',  category: 'Starters',    name: 'Paneer Tikka',              price: 280, emoji: '🔥', popular: true  },
  { id: 'm7',  category: 'Starters',    name: 'Tandoori Mushroom',         price: 250, emoji: '🍄', popular: false },
  { id: 'm8',  category: 'Starters',    name: 'Tandoori Chicken (Half)',   price: 340, emoji: '🍗', popular: true  },
  { id: 'm9',  category: 'Starters',    name: 'Chicken Tikka',             price: 320, emoji: '🍖', popular: false },
  // Main Course — North Indian
  { id: 'm10', category: 'Main Course', name: 'Paneer Butter Masala',      price: 300, emoji: '🧆', popular: true  },
  { id: 'm11', category: 'Main Course', name: 'Dal Makhani',               price: 240, emoji: '🫘', popular: true  },
  { id: 'm12', category: 'Main Course', name: 'Butter Chicken',            price: 360, emoji: '🍛', popular: true  },
  { id: 'm13', category: 'Main Course', name: 'Mutton Rogan Josh',         price: 420, emoji: '🥩', popular: false },
  // Main Course — Biryani
  { id: 'm14', category: 'Main Course', name: 'Veg Biryani',               price: 240, emoji: '🍚', popular: false },
  { id: 'm15', category: 'Main Course', name: 'Chicken Biryani (Full)',    price: 340, emoji: '🍲', popular: true  },
  { id: 'm16', category: 'Main Course', name: 'Mutton Biryani',            price: 420, emoji: '🥘', popular: false },
  // Breads
  { id: 'm17', category: 'Breads',      name: 'Tandoori Roti',             price: 25,  emoji: '🫓', popular: false },
  { id: 'm18', category: 'Breads',      name: 'Butter Naan',               price: 55,  emoji: '🫓', popular: true  },
  { id: 'm19', category: 'Breads',      name: 'Garlic Naan',               price: 70,  emoji: '🧄', popular: false },
  // Beverages
  { id: 'm20', category: 'Beverages',   name: 'Coke (300ml)',               price: 40,  emoji: '🥤', popular: false },
  { id: 'm21', category: 'Beverages',   name: 'Sprite (300ml)',             price: 40,  emoji: '🥤', popular: false },
  { id: 'm22', category: 'Beverages',   name: 'Mineral Water (1L)',         price: 20,  emoji: '💧', popular: false },
  // Desserts
  { id: 'm23', category: 'Desserts',    name: 'Gulab Jamun (2 pcs)',        price: 90,  emoji: '🍮', popular: true  },
  { id: 'm24', category: 'Desserts',    name: 'Rasgulla (2 pcs)',           price: 90,  emoji: '🍡', popular: false },
  { id: 'm25', category: 'Desserts',    name: 'Brownie with Ice Cream',     price: 160, emoji: '🍫', popular: true  },
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

    const validStatuses = ['pending', 'preparing', 'ready', 'completed'];
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
    activeCarts[sessionId].lastActivity = { itemId, itemName, action, timestamp: getTimestamp() };
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
