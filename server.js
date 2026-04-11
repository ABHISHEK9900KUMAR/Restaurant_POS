/**
 * RestaurantOS — Production Backend Server
 * Node.js + Express + Socket.io
 * Version: 2.0.0
 */

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const { rateLimit } = require('express-rate-limit');
const path       = require('path');
const QRCode     = require('qrcode');
const os         = require('os');
const fs         = require('fs');
const PDFDocument = require('pdfkit');
const Database   = require('better-sqlite3');
const multer     = require('multer');
const sharp      = require('sharp');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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
// RENDER_EXTERNAL_URL is set automatically by Render for every web service
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || null;

// ─── Allowed Origins (strict in prod, open in local dev) ─────────────────────
const isProd = !!(process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL);
const ALLOWED_ORIGINS = isProd
  ? ['https://dinefy.in', 'https://www.dinefy.in']
  : true; // allow all in local dev

const app = express();
const server = http.createServer(app);

// ─── Socket.io Setup ────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── Security Middleware ─────────────────────────────────────────────────────
// Helmet — sets secure HTTP headers (XSS, clickjacking, MIME sniffing, etc.)
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled to avoid breaking Google Fonts / socket.io CDN

// CORS — locked to dinefy.in in production, open in local dev
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));

// Rate limiter for auth — max 10 attempts per IP per 15 minutes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// ─── Config ─────────────────────────────────────────────────────────────────
const CONFIG = {
  GST_RATE: 0.05,           // 5% GST (CGST 2.5% + SGST 2.5%)
  SERVICE_CHARGE_RATE: 0.10, // 10% Service Charge
  MAX_DISCOUNT_PERCENT: 30,  // Max 30% discount
  CART_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes
  PORT: process.env.PORT || 3000,
  UPI_VPA: process.env.UPI_VPA || '',        // e.g. "merchant@okaxis"
  UPI_NAME: process.env.UPI_NAME || 'Restaurant',
  SHOP_NAME: process.env.SHOP_NAME || 'Dinefy',
  SHOP_TAGLINE: process.env.SHOP_TAGLINE || 'Pure Veg & Non-Veg Restaurant',
  GST_NO: process.env.GST_NO || '',          // e.g. "27AABCU9603R1ZX"  (legacy key)
  GSTIN: process.env.GSTIN || process.env.GST_NO || '',   // preferred key
  SAC_CODE: '996331',                        // SAC for restaurant dine-in services
  INVOICE_PREFIX: process.env.INVOICE_PREFIX || 'FS',
};

const UPLOADS_DIR = path.join(__dirname, 'public/uploads/menu');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });


// ─── PDF Receipt Generator ────────────────────────────────────────────────────
function generateReceiptPDF(order) {
  return new Promise((resolve, reject) => {
    const W   = 595.28; // A4 width pt
    const ML  = 50;     // margin left
    const MR  = 50;     // margin right
    const CW  = W - ML - MR; // content width = 495

    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const GOLD  = '#C9A84C';
    const DARK  = '#1A1A1A';
    const GRAY  = '#666666';
    const LIGHT = '#F5F2EC';
    const LINE  = '#DDD8CC';
    const GREEN = '#2ECC71';

    const rs = n => 'Rs. ' + parseFloat(n).toFixed(2);

    // ── HEADER BAND ──────────────────────────────────────────────
    doc.rect(0, 0, W, 100).fill(DARK);
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(30).text('Dinefy', ML, 22);
    doc.fillColor('#FFFFFF').font('Helvetica').fontSize(10).text('Restaurant Receipt', ML, 58);
    // Right side: order meta
    doc.fillColor('#AAAAAA').fontSize(9)
       .text(order.id,              ML, 22, { width: CW, align: 'right' })
       .text('Table ' + order.tableNo, ML, 36, { width: CW, align: 'right' })
       .text(order.paidAt || order.createdAt, ML, 50, { width: CW, align: 'right' });

    // ── BILLED TO ────────────────────────────────────────────────
    let y = 115;
    doc.rect(ML, y, CW, 1).fill(LINE);
    y += 14;
    doc.fillColor(GRAY).font('Helvetica-Bold').fontSize(8)
       .text('BILLED TO', ML, y);
    y += 14;
    doc.fillColor(DARK).font('Helvetica-Bold').fontSize(12)
       .text(order.customerName, ML, y);
    y += 16;
    doc.font('Helvetica').fontSize(9).fillColor(GRAY);
    if (order.customerPhone) {
      doc.text('Phone: ' + order.customerPhone, ML, y);
      y += 13;
    }
    if (order.customerEmail) {
      doc.text('Email: ' + order.customerEmail, ML, y);
      y += 13;
    }

    // ── ITEMS TABLE ──────────────────────────────────────────────
    y += 10;
    doc.rect(ML, y, CW, 1).fill(LINE);
    y += 10;

    // Table header
    doc.rect(ML, y, CW, 24).fill(DARK);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9);
    doc.text('ITEM',       ML + 8,       y + 8, { width: 230 });
    doc.text('QTY',        ML + 245,     y + 8, { width: 50,  align: 'center' });
    doc.text('UNIT PRICE', ML + 305,     y + 8, { width: 90,  align: 'right' });
    doc.text('AMOUNT',     ML + 400,     y + 8, { width: 87,  align: 'right' });
    y += 24;

    // Item rows
    const { billing, items } = order;
    items.forEach((item, i) => {
      const rowH = 22;
      if (i % 2 === 1) doc.rect(ML, y, CW, rowH).fill(LIGHT);
      doc.fillColor(DARK).font('Helvetica').fontSize(9);
      // Strip emoji from item names for PDF compatibility
      const name = (item.name || '').replace(/[\u{1F300}-\u{1FFFF}]/gu, '').trim();
      doc.text(name,                              ML + 8,   y + 7, { width: 230, ellipsis: true });
      doc.text(String(item.quantity),             ML + 245, y + 7, { width: 50,  align: 'center' });
      doc.text(rs(item.price),                    ML + 305, y + 7, { width: 90,  align: 'right' });
      doc.text(rs(item.quantity * item.price),    ML + 400, y + 7, { width: 87,  align: 'right' });
      y += rowH;
    });

    // ── BILLING SUMMARY ──────────────────────────────────────────
    y += 14;
    doc.rect(ML, y, CW, 1).fill(LINE);
    y += 14;

    const summaryX     = ML + 260; // label start
    const summaryLabelW = 130;
    const summaryValX  = ML + 395; // value start
    const summaryValW  = 92;

    const sumRow = (label, value, color = GRAY, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
      doc.fillColor(GRAY).text(label, summaryX, y, { width: summaryLabelW });
      doc.fillColor(color).text(value, summaryValX, y, { width: summaryValW, align: 'right' });
      y += 18;
    };

    sumRow('Subtotal',                      rs(billing.subtotal));
    if (billing.discount > 0)
      sumRow(`Discount (${billing.discountPercent}%)`, '- ' + rs(billing.discount), GREEN);
    if (billing.serviceCharge > 0)
      sumRow('Service Charge (10%)',        rs(billing.serviceCharge));
    sumRow(`GST (${(billing.gstRate || 0.05) * 100}%)`, rs(billing.gst));

    // Total bar
    y += 4;
    doc.rect(ML + 255, y, CW - 255, 32).fill(DARK);
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(13);
    doc.text('TOTAL',          summaryX,  y + 10, { width: summaryLabelW });
    doc.text(rs(billing.total), summaryValX, y + 10, { width: summaryValW, align: 'right' });
    y += 44;

    if (order.cashTendered != null) {
      sumRow('Cash Paid',  rs(order.cashTendered));
      sumRow('Change',     rs(order.change), GREEN);
      y += 4;
    }

    // ── FOOTER ───────────────────────────────────────────────────
    y += 14;
    doc.rect(ML, y, CW, 1).fill(LINE);
    y += 18;
    doc.fillColor(GRAY).font('Helvetica').fontSize(9)
       .text('Thank you for dining with us! We hope to see you again.', ML, y, { width: CW, align: 'center' });
    y += 14;
    doc.fillColor(GOLD).fontSize(8)
       .text('Powered by Dinefy', ML, y, { width: CW, align: 'center' });

    doc.end();
  });
}

async function emailReceipt() { /* email receipts disabled */ }

// ─── IST Date Helpers ─────────────────────────────────────────────────────────
function getISTDateStr(isoStr) {
  const istMs = new Date(isoStr).getTime() + (5.5 * 60 * 60 * 1000);
  return new Date(istMs).toISOString().slice(0, 10);
}

function todayIST() {
  return getISTDateStr(new Date().toISOString());
}

// ─── Daily Report Generator ───────────────────────────────────────────────────
function generateDailyReport(dateStr) {
  const dayOrders = orders.filter(o => getISTDateStr(o.createdAt) === dateStr);
  const paidOrders = dayOrders.filter(o => o.paymentStatus === 'paid');

  const totalRevenue        = round2(paidOrders.reduce((s, o) => s + (o.billing?.total || 0), 0));
  const totalGST            = round2(paidOrders.reduce((s, o) => s + (o.billing?.gst || 0), 0));
  const totalServiceCharge  = round2(paidOrders.reduce((s, o) => s + (o.billing?.serviceCharge || 0), 0));
  const totalDiscount       = round2(paidOrders.reduce((s, o) => s + (o.billing?.discountAmount || 0), 0));
  const avgOrderValue       = paidOrders.length ? round2(totalRevenue / paidOrders.length) : 0;

  const summary = { totalRevenue, ordersCount: dayOrders.length, paidCount: paidOrders.length, avgOrderValue, totalGST, totalServiceCharge, totalDiscount };

  // Top Items — aggregate qty + revenue across ALL orders that day
  const itemMap = {};
  dayOrders.forEach(order => {
    (order.items || []).forEach(item => {
      const key = item.id || item.name;
      if (!itemMap[key]) itemMap[key] = { name: item.name, qty: 0, revenue: 0 };
      const qty = Math.max(0, Math.floor(item.quantity || 1));
      itemMap[key].qty += qty;
      itemMap[key].revenue = round2(itemMap[key].revenue + (item.price || 0) * qty);
    });
  });
  const topItems = Object.values(itemMap).sort((a, b) => b.qty - a.qty).slice(0, 5);

  // Table-wise Revenue — paid orders only
  const tableMap = {};
  paidOrders.forEach(order => {
    const t = order.tableNo || 'N/A';
    if (!tableMap[t]) tableMap[t] = { table: t, ordersCount: 0, revenue: 0 };
    tableMap[t].ordersCount++;
    tableMap[t].revenue = round2(tableMap[t].revenue + (order.billing?.total || 0));
  });
  const tableRevenue = Object.values(tableMap).sort((a, b) => b.revenue - a.revenue);

  // Hourly Orders (IST hour)
  const hourlyOrders = Array(24).fill(0);
  dayOrders.forEach(order => {
    const istMs = new Date(order.createdAt).getTime() + (5.5 * 60 * 60 * 1000);
    hourlyOrders[new Date(istMs).getUTCHours()]++;
  });

  const cashRevenue = round2(paidOrders.filter(o => o.paymentMethod === 'cash').reduce((s, o) => s + (o.billing?.total || 0), 0));
  const upiRevenue  = round2(paidOrders.filter(o => o.paymentMethod === 'upi').reduce((s, o) => s + (o.billing?.total || 0), 0));
  const totalCGST   = round2(paidOrders.reduce((s, o) => s + (o.billing?.cgst || o.billing?.gst / 2 || 0), 0));
  const totalSGST   = round2(paidOrders.reduce((s, o) => s + (o.billing?.sgst || o.billing?.gst / 2 || 0), 0));

  return { date: dateStr, summary: { ...summary, totalCGST, totalSGST }, topItems, tableRevenue, hourlyOrders, paymentBreakdown: { cash: cashRevenue, upi: upiRevenue } };
}

// ─── Report PDF Generator ─────────────────────────────────────────────────────
function generateReportPDF(report) {
  return new Promise((resolve, reject) => {
    const W  = 595.28;
    const ML = 50;
    const MR = 50;
    const CW = W - ML - MR;

    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const GOLD  = '#C9A84C';
    const DARK  = '#1A1A1A';
    const GRAY  = '#666666';
    const LIGHT = '#F5F2EC';
    const LINE  = '#DDD8CC';

    const rs = n => 'Rs. ' + parseFloat(n).toFixed(2);

    // ── HEADER ───────────────────────────────────────────────────
    doc.rect(0, 0, W, 100).fill(DARK);
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(28).text('Dinefy', ML, 20);
    doc.fillColor('#FFFFFF').font('Helvetica').fontSize(10).text('Daily Sales Report', ML, 54);
    doc.fillColor('#AAAAAA').fontSize(9)
       .text('Date: ' + report.date,                                   ML, 20, { width: CW, align: 'right' })
       .text('Generated: ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), ML, 34, { width: CW, align: 'right' });

    let y = 118;

    // ── SUMMARY ──────────────────────────────────────────────────
    doc.fillColor(GRAY).font('Helvetica-Bold').fontSize(8).text('SUMMARY', ML, y);
    y += 10;
    doc.rect(ML, y, CW, 1).fill(LINE);
    y += 12;

    const s = report.summary;
    const sumRow = (label, value, bold = false, color = DARK) => {
      doc.font('Helvetica').fontSize(10).fillColor(GRAY).text(label, ML, y, { width: CW * 0.65 });
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(color).text(value, ML + CW * 0.65, y, { width: CW * 0.35, align: 'right' });
      y += 19;
    };

    sumRow('Total Revenue (incl. GST)', rs(s.totalRevenue), true, GOLD);
    sumRow('Total Orders',              String(s.ordersCount));
    sumRow('Paid Orders',               String(s.paidCount));
    sumRow('Avg Order Value',           rs(s.avgOrderValue));
    if (s.totalDiscount > 0) sumRow('Total Discounts', rs(s.totalDiscount));
    sumRow('Service Charge',            rs(s.totalServiceCharge));
    // GST breakdown
    sumRow('CGST Collected (2.5%)',     rs(s.totalCGST || s.totalGST / 2));
    sumRow('SGST Collected (2.5%)',     rs(s.totalSGST || s.totalGST / 2));
    sumRow('Total GST (5%)',            rs(s.totalGST), false, '#999999');
    y += 6;
    // Payment split
    doc.rect(ML, y, CW, 1).fill(LINE); y += 10;
    sumRow('Cash Collected',   rs(report.paymentBreakdown?.cash || 0), true);
    sumRow('UPI Collected',    rs(report.paymentBreakdown?.upi  || 0), true);

    y += 12;

    // ── TOP ITEMS ────────────────────────────────────────────────
    doc.fillColor(GRAY).font('Helvetica-Bold').fontSize(8).text('TOP 5 ITEMS', ML, y);
    y += 10;
    doc.rect(ML, y, CW, 1).fill(LINE);
    y += 10;

    doc.rect(ML, y, CW, 22).fill(DARK);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9);
    doc.text('ITEM',    ML + 8,   y + 7, { width: 290 });
    doc.text('QTY',     ML + 305, y + 7, { width: 80, align: 'center' });
    doc.text('REVENUE', ML + 390, y + 7, { width: 97, align: 'right' });
    y += 22;

    if (report.topItems.length === 0) {
      doc.fillColor(GRAY).font('Helvetica').fontSize(9).text('No items sold on this date.', ML + 8, y + 6);
      y += 20;
    } else {
      report.topItems.forEach((item, i) => {
        if (i % 2 === 1) doc.rect(ML, y, CW, 20).fill(LIGHT);
        const name = (item.name || '').replace(/[\u{1F300}-\u{1FFFF}]/gu, '').trim();
        doc.fillColor(DARK).font('Helvetica').fontSize(9);
        doc.text(name,              ML + 8,   y + 6, { width: 290, ellipsis: true });
        doc.text(String(item.qty),  ML + 305, y + 6, { width: 80, align: 'center' });
        doc.text(rs(item.revenue),  ML + 390, y + 6, { width: 97, align: 'right' });
        y += 20;
      });
    }

    y += 16;

    // ── TABLE REVENUE ────────────────────────────────────────────
    doc.fillColor(GRAY).font('Helvetica-Bold').fontSize(8).text('TABLE-WISE REVENUE', ML, y);
    y += 10;
    doc.rect(ML, y, CW, 1).fill(LINE);
    y += 10;

    doc.rect(ML, y, CW, 22).fill(DARK);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9);
    doc.text('TABLE',   ML + 8,   y + 7, { width: 160 });
    doc.text('ORDERS',  ML + 175, y + 7, { width: 120, align: 'center' });
    doc.text('REVENUE', ML + 390, y + 7, { width: 97, align: 'right' });
    y += 22;

    if (report.tableRevenue.length === 0) {
      doc.fillColor(GRAY).font('Helvetica').fontSize(9).text('No paid orders on this date.', ML + 8, y + 6);
      y += 20;
    } else {
      report.tableRevenue.forEach((row, i) => {
        if (i % 2 === 1) doc.rect(ML, y, CW, 20).fill(LIGHT);
        doc.fillColor(DARK).font('Helvetica').fontSize(9);
        doc.text(row.table,              ML + 8,   y + 6, { width: 160 });
        doc.text(String(row.ordersCount),ML + 175, y + 6, { width: 120, align: 'center' });
        doc.text(rs(row.revenue),        ML + 390, y + 6, { width: 97, align: 'right' });
        y += 20;
      });
    }

    y += 20;

    // ── FOOTER ───────────────────────────────────────────────────
    doc.rect(ML, y, CW, 1).fill(LINE);
    y += 14;
    doc.fillColor(GRAY).font('Helvetica').fontSize(9)
       .text('Dinefy — Automated Daily Sales Report', ML, y, { width: CW, align: 'center' });
    y += 13;
    doc.fillColor(GOLD).fontSize(8)
       .text('Powered by Dinefy', ML, y, { width: CW, align: 'center' });

    doc.end();
  });
}

// ─── Menu Data ───────────────────────────────────────────────────────────────
const MENU = [
  // ─── Veg Starters ───
  { id: 'm1',  category: 'Veg Starters',     categoryHi: 'वेज स्टार्टर',      name: 'Paneer Chilly (Half)',       nameHi: 'पनीर चिली (हाफ)',           price: 100, emoji: '🧀', popular: true,  tags: ['veg'],     nutrition: { calories: 210, protein: 12, carbs: 15, fat: 12, ingredients: ['Paneer', 'Capsicum', 'Onion', 'Soy Sauce', 'Garlic', 'Green Chilli'] } },
  { id: 'm2',  category: 'Veg Starters',     categoryHi: 'वेज स्टार्टर',      name: 'Paneer Chilly (Full)',       nameHi: 'पनीर चिली (फुल)',           price: 200, emoji: '🧀', popular: true,  tags: ['veg', 'high-protein'],     nutrition: { calories: 420, protein: 24, carbs: 30, fat: 24, ingredients: ['Paneer', 'Capsicum', 'Onion', 'Soy Sauce', 'Garlic', 'Green Chilli'] } },
  { id: 'm3',  category: 'Veg Starters',     categoryHi: 'वेज स्टार्टर',      name: 'Paneer Manchurian (Half)',   nameHi: 'पनीर मंचूरियन (हाफ)',       price: 100, emoji: '🥘', popular: false, tags: ['veg'],     nutrition: { calories: 220, protein: 11, carbs: 18, fat: 13, ingredients: ['Paneer', 'Garlic', 'Ginger', 'Soy Sauce', 'Spring Onion', 'Cornstarch'] } },
  { id: 'm4',  category: 'Veg Starters',     categoryHi: 'वेज स्टार्टर',      name: 'Paneer Manchurian (Full)',   nameHi: 'पनीर मंचूरियन (फुल)',       price: 200, emoji: '🥘', popular: false, tags: ['veg', 'high-protein'],     nutrition: { calories: 440, protein: 22, carbs: 36, fat: 26, ingredients: ['Paneer', 'Garlic', 'Ginger', 'Soy Sauce', 'Spring Onion', 'Cornstarch'] } },
  { id: 'm5',  category: 'Veg Starters',     categoryHi: 'वेज स्टार्टर',      name: 'Paneer Pepper Dry (Half)',   nameHi: 'पनीर पेप्पर ड्राई (हाफ)',   price: 120, emoji: '🌶️', popular: false, tags: ['veg'],     nutrition: { calories: 230, protein: 12, carbs: 14, fat: 15, ingredients: ['Paneer', 'Black Pepper', 'Capsicum', 'Onion', 'Garlic', 'Soy Sauce'] } },
  { id: 'm6',  category: 'Veg Starters',     categoryHi: 'वेज स्टार्टर',      name: 'Paneer Pepper Dry (Full)',   nameHi: 'पनीर पेप्पर ड्राई (फुल)',   price: 240, emoji: '🌶️', popular: false, tags: ['veg', 'high-protein'],     nutrition: { calories: 460, protein: 24, carbs: 28, fat: 30, ingredients: ['Paneer', 'Black Pepper', 'Capsicum', 'Onion', 'Garlic', 'Soy Sauce'] } },
  { id: 'm7',  category: 'Veg Starters',     categoryHi: 'वेज स्टार्टर',      name: 'Paneer 65 (Half)',           nameHi: 'पनीर 65 (हाफ)',             price: 120, emoji: '🧀', popular: false, tags: ['veg'],     nutrition: { calories: 250, protein: 13, carbs: 16, fat: 16, ingredients: ['Paneer', 'Yogurt', 'Chilli', 'Curry Leaves', 'Garlic', 'Cornstarch'] } },
  { id: 'm8',  category: 'Veg Starters',     categoryHi: 'वेज स्टार्टर',      name: 'Paneer 65 (Full)',           nameHi: 'पनीर 65 (फुल)',             price: 240, emoji: '🧀', popular: false, tags: ['veg', 'high-protein'],     nutrition: { calories: 500, protein: 26, carbs: 32, fat: 32, ingredients: ['Paneer', 'Yogurt', 'Chilli', 'Curry Leaves', 'Garlic', 'Cornstarch'] } },
  { id: 'm9',  category: 'Veg Starters',     categoryHi: 'वेज स्टार्टर',      name: 'Mushroom Chilly (Half)',     nameHi: 'मशरूम चिली (हाफ)',          price: 100, emoji: '🍄', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 150, protein:  6, carbs: 18, fat:  6, ingredients: ['Mushroom', 'Capsicum', 'Onion', 'Soy Sauce', 'Garlic', 'Chilli'] } },
  { id: 'm10', category: 'Veg Starters',     categoryHi: 'वेज स्टार्टर',      name: 'Mushroom Chilly (Full)',     nameHi: 'मशरूम चिली (फुल)',          price: 200, emoji: '🍄', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 300, protein: 12, carbs: 36, fat: 12, ingredients: ['Mushroom', 'Capsicum', 'Onion', 'Soy Sauce', 'Garlic', 'Chilli'] } },
  { id: 'm11', category: 'Veg Starters',     categoryHi: 'वेज स्टार्टर',      name: 'Mushroom Manchurian (Half)', nameHi: 'मशरूम मंचूरियन (हाफ)',      price: 100, emoji: '🍄', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 160, protein:  6, carbs: 20, fat:  7, ingredients: ['Mushroom', 'Garlic', 'Ginger', 'Soy Sauce', 'Spring Onion', 'Cornstarch'] } },
  { id: 'm12', category: 'Veg Starters',     categoryHi: 'वेज स्टार्टर',      name: 'Mushroom Manchurian (Full)', nameHi: 'मशरूम मंचूरियन (फुल)',      price: 200, emoji: '🍄', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 320, protein: 12, carbs: 40, fat: 14, ingredients: ['Mushroom', 'Garlic', 'Ginger', 'Soy Sauce', 'Spring Onion', 'Cornstarch'] } },

  // ─── Non-Veg Starters ───
  { id: 'm13', category: 'Non-Veg Starters', categoryHi: 'नॉन-वेज स्टार्टर', name: 'Chilly Chicken (Half)',      nameHi: 'चिली चिकन (हाफ)',           price: 100, emoji: '🍗', popular: true,  tags: ['non-veg', 'high-protein'], nutrition: { calories: 190, protein: 18, carbs: 10, fat:  9, ingredients: ['Chicken', 'Capsicum', 'Onion', 'Soy Sauce', 'Garlic', 'Green Chilli'] } },
  { id: 'm14', category: 'Non-Veg Starters', categoryHi: 'नॉन-वेज स्टार्टर', name: 'Chilly Chicken (Full)',      nameHi: 'चिली चिकन (फुल)',           price: 200, emoji: '🍗', popular: true,  tags: ['non-veg', 'high-protein'], nutrition: { calories: 380, protein: 36, carbs: 20, fat: 18, ingredients: ['Chicken', 'Capsicum', 'Onion', 'Soy Sauce', 'Garlic', 'Green Chilli'] } },
  { id: 'm15', category: 'Non-Veg Starters', categoryHi: 'नॉन-वेज स्टार्टर', name: 'Chicken Manchurian (Half)',  nameHi: 'चिकन मंचूरियन (हाफ)',       price: 100, emoji: '🍜', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 180, protein: 17, carbs: 12, fat:  8, ingredients: ['Chicken', 'Garlic', 'Ginger', 'Soy Sauce', 'Spring Onion', 'Cornstarch'] } },
  { id: 'm16', category: 'Non-Veg Starters', categoryHi: 'नॉन-वेज स्टार्टर', name: 'Chicken Manchurian (Full)',  nameHi: 'चिकन मंचूरियन (फुल)',       price: 200, emoji: '🍜', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 360, protein: 34, carbs: 24, fat: 16, ingredients: ['Chicken', 'Garlic', 'Ginger', 'Soy Sauce', 'Spring Onion', 'Cornstarch'] } },
  { id: 'm17', category: 'Non-Veg Starters', categoryHi: 'नॉन-वेज स्टार्टर', name: 'Chicken 65 (Half)',          nameHi: 'चिकन 65 (हाफ)',             price: 120, emoji: '🍗', popular: true,  tags: ['non-veg', 'high-protein'], nutrition: { calories: 210, protein: 20, carbs: 12, fat: 10, ingredients: ['Chicken', 'Yogurt', 'Chilli', 'Curry Leaves', 'Garlic', 'Cornstarch'] } },
  { id: 'm18', category: 'Non-Veg Starters', categoryHi: 'नॉन-वेज स्टार्टर', name: 'Chicken 65 (Full)',          nameHi: 'चिकन 65 (फुल)',             price: 240, emoji: '🍗', popular: true,  tags: ['non-veg', 'high-protein'], nutrition: { calories: 420, protein: 40, carbs: 24, fat: 20, ingredients: ['Chicken', 'Yogurt', 'Chilli', 'Curry Leaves', 'Garlic', 'Cornstarch'] } },
  { id: 'm19', category: 'Non-Veg Starters', categoryHi: 'नॉन-वेज स्टार्टर', name: 'Pepper Chicken (Half)',      nameHi: 'पेप्पर चिकन (हाफ)',         price: 120, emoji: '🌶️', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 200, protein: 19, carbs:  8, fat: 11, ingredients: ['Chicken', 'Black Pepper', 'Onion', 'Garlic', 'Capsicum', 'Soy Sauce'] } },
  { id: 'm20', category: 'Non-Veg Starters', categoryHi: 'नॉन-वेज स्टार्टर', name: 'Pepper Chicken (Full)',      nameHi: 'पेप्पर चिकन (फुल)',         price: 240, emoji: '🌶️', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 400, protein: 38, carbs: 16, fat: 22, ingredients: ['Chicken', 'Black Pepper', 'Onion', 'Garlic', 'Capsicum', 'Soy Sauce'] } },
  { id: 'm21', category: 'Non-Veg Starters', categoryHi: 'नॉन-वेज स्टार्टर', name: 'Lemon Chicken (Half)',       nameHi: 'लेमन चिकन (हाफ)',           price: 120, emoji: '🍋', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 190, protein: 19, carbs:  9, fat:  9, ingredients: ['Chicken', 'Lemon Juice', 'Onion', 'Garlic', 'Ginger', 'Capsicum'] } },
  { id: 'm22', category: 'Non-Veg Starters', categoryHi: 'नॉन-वेज स्टार्टर', name: 'Lemon Chicken (Full)',       nameHi: 'लेमन चिकन (फुल)',           price: 240, emoji: '🍋', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 380, protein: 38, carbs: 18, fat: 18, ingredients: ['Chicken', 'Lemon Juice', 'Onion', 'Garlic', 'Ginger', 'Capsicum'] } },
  { id: 'm23', category: 'Non-Veg Starters', categoryHi: 'नॉन-वेज स्टार्टर', name: 'Dry Chicken (2Pc)',          nameHi: 'ड्राई चिकन (2 पीस)',        price: 109, emoji: '🍖', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 180, protein: 22, carbs:  4, fat:  9, ingredients: ['Chicken', 'Spices', 'Onion', 'Ginger', 'Garlic', 'Chilli'] } },
  { id: 'm24', category: 'Non-Veg Starters', categoryHi: 'नॉन-वेज स्टार्टर', name: 'Dry Chicken (4Pc)',          nameHi: 'ड्राई चिकन (4 पीस)',        price: 199, emoji: '🍖', popular: true,  tags: ['non-veg', 'high-protein'], nutrition: { calories: 360, protein: 44, carbs:  8, fat: 18, ingredients: ['Chicken', 'Spices', 'Onion', 'Ginger', 'Garlic', 'Chilli'] } },
  { id: 'm25', category: 'Non-Veg Starters', categoryHi: 'नॉन-वेज स्टार्टर', name: 'Dry Chicken (8Pc)',          nameHi: 'ड्राई चिकन (8 पीस)',        price: 389, emoji: '🍖', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 720, protein: 88, carbs: 16, fat: 36, ingredients: ['Chicken', 'Spices', 'Onion', 'Ginger', 'Garlic', 'Chilli'] } },
  { id: 'm26', category: 'Non-Veg Starters', categoryHi: 'नॉन-वेज स्टार्टर', name: 'Fish Fry (2Pc)',             nameHi: 'फिश फ्राई (2 पीस)',         price: 109, emoji: '🐟', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 200, protein: 20, carbs:  8, fat: 10, ingredients: ['Fish', 'Turmeric', 'Chilli', 'Lemon Juice', 'Garlic', 'Ginger'] } },
  { id: 'm27', category: 'Non-Veg Starters', categoryHi: 'नॉन-वेज स्टार्टर', name: 'Fish Fry (4Pc)',             nameHi: 'फिश फ्राई (4 पीस)',         price: 209, emoji: '🐟', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 400, protein: 40, carbs: 16, fat: 20, ingredients: ['Fish', 'Turmeric', 'Chilli', 'Lemon Juice', 'Garlic', 'Ginger'] } },
  { id: 'm28', category: 'Non-Veg Starters', categoryHi: 'नॉन-वेज स्टार्टर', name: 'Fish Fry (8Pc)',             nameHi: 'फिश फ्राई (8 पीस)',         price: 399, emoji: '🐟', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 800, protein: 80, carbs: 32, fat: 40, ingredients: ['Fish', 'Turmeric', 'Chilli', 'Lemon Juice', 'Garlic', 'Ginger'] } },

  // ─── Main Course Veg ───
  { id: 'm29', category: 'Main Course Veg',  categoryHi: 'मुख्य व्यंजन (वेज)', name: 'Kadhai Paneer',            nameHi: 'कढ़ाई पनीर',                price: 109, emoji: '🫕', popular: true,  tags: ['veg', 'high-protein'],     nutrition: { calories: 380, protein: 18, carbs: 16, fat: 28, ingredients: ['Paneer', 'Tomato', 'Onion', 'Capsicum', 'Kadhai Masala', 'Ginger'] } },
  { id: 'm30', category: 'Main Course Veg',  categoryHi: 'मुख्य व्यंजन (वेज)', name: 'Matar Paneer',             nameHi: 'मटर पनीर',                  price: 109, emoji: '🫕', popular: false, tags: ['veg', 'high-protein'],     nutrition: { calories: 360, protein: 16, carbs: 22, fat: 24, ingredients: ['Paneer', 'Green Peas', 'Tomato', 'Onion', 'Ginger', 'Cream'] } },
  { id: 'm31', category: 'Main Course Veg',  categoryHi: 'मुख्य व्यंजन (वेज)', name: 'Mushroom Masala',          nameHi: 'मशरूम मसाला',               price: 129, emoji: '🍄', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 220, protein:  8, carbs: 18, fat: 14, ingredients: ['Mushroom', 'Tomato', 'Onion', 'Ginger', 'Garlic', 'Spices'] } },
  { id: 'm32', category: 'Main Course Veg',  categoryHi: 'मुख्य व्यंजन (वेज)', name: 'Chole Masala',             nameHi: 'छोले मसाला',                price: 99,  emoji: '🫘', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 280, protein: 12, carbs: 38, fat: 10, ingredients: ['Chickpeas', 'Tomato', 'Onion', 'Ginger', 'Garlic', 'Chole Masala'] } },
  { id: 'm33', category: 'Main Course Veg',  categoryHi: 'मुख्य व्यंजन (वेज)', name: 'Paneer Bhurji',            nameHi: 'पनीर भुर्जी',               price: 99,  emoji: '🧀', popular: false, tags: ['veg', 'high-protein'],     nutrition: { calories: 350, protein: 18, carbs: 10, fat: 26, ingredients: ['Paneer', 'Onion', 'Tomato', 'Capsicum', 'Ginger', 'Spices'] } },
  { id: 'm34', category: 'Main Course Veg',  categoryHi: 'मुख्य व्यंजन (वेज)', name: 'Aloo Bhujiya',             nameHi: 'आलू भुजिया',                price: 59,  emoji: '🥔', popular: false, tags: ['veg'],     nutrition: { calories: 200, protein:  4, carbs: 28, fat:  8, ingredients: ['Potato', 'Onion', 'Mustard Seeds', 'Turmeric', 'Green Chilli', 'Coriander'] } },
  { id: 'm35', category: 'Main Course Veg',  categoryHi: 'मुख्य व्यंजन (वेज)', name: 'Aloo Chokha',              nameHi: 'आलू चोखा',                  price: 59,  emoji: '🥔', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 180, protein:  4, carbs: 30, fat:  6, ingredients: ['Potato', 'Mustard Oil', 'Green Chilli', 'Onion', 'Garlic', 'Coriander'] } },
  { id: 'm36', category: 'Main Course Veg',  categoryHi: 'मुख्य व्यंजन (वेज)', name: 'Aloo Baigan Tamatar Chokha', nameHi: 'आलू बैगन टमाटर चोखा',    price: 49,  emoji: '🍆', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 160, protein:  4, carbs: 28, fat:  4, ingredients: ['Potato', 'Brinjal', 'Tomato', 'Mustard Oil', 'Green Chilli', 'Onion'] } },
  { id: 'm37', category: 'Main Course Veg',  categoryHi: 'मुख्य व्यंजन (वेज)', name: 'Paneer Butter Masala',     nameHi: 'पनीर बटर मसाला',            price: 149, emoji: '🧈', popular: true,  tags: ['veg', 'high-protein'],     nutrition: { calories: 420, protein: 18, carbs: 24, fat: 28, ingredients: ['Paneer', 'Tomato', 'Butter', 'Cream', 'Cashew', 'Cardamom'] } },
  { id: 'm38', category: 'Main Course Veg',  categoryHi: 'मुख्य व्यंजन (वेज)', name: 'Paneer Makhani',           nameHi: 'पनीर मखनी',                 price: 149, emoji: '🫕', popular: true,  tags: ['veg', 'high-protein'],     nutrition: { calories: 440, protein: 18, carbs: 22, fat: 30, ingredients: ['Paneer', 'Tomato', 'Butter', 'Cream', 'Fenugreek', 'Cardamom'] } },
  { id: 'm39', category: 'Main Course Veg',  categoryHi: 'मुख्य व्यंजन (वेज)', name: 'Veg Regular',              nameHi: 'वेज रेगुलर',                price: 69,  emoji: '🥗', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 180, protein:  6, carbs: 22, fat:  8, ingredients: ['Mixed Vegetables', 'Onion', 'Tomato', 'Spices', 'Oil', 'Coriander'] } },

  // ─── Main Course Non-Veg ───
  { id: 'm40', category: 'Main Course Non-Veg', categoryHi: 'मुख्य व्यंजन (नॉन-वेज)', name: 'Chicken Curry (2Pc)',   nameHi: 'चिकन करी (2 पीस)',    price: 99,  emoji: '🍛', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 220, protein: 24, carbs:  8, fat: 12, ingredients: ['Chicken', 'Tomato', 'Onion', 'Ginger', 'Garlic', 'Spices'] } },
  { id: 'm41', category: 'Main Course Non-Veg', categoryHi: 'मुख्य व्यंजन (नॉन-वेज)', name: 'Chicken Curry (4Pc)',   nameHi: 'चिकन करी (4 पीस)',    price: 189, emoji: '🍛', popular: true,  tags: ['non-veg', 'high-protein'], nutrition: { calories: 440, protein: 48, carbs: 16, fat: 24, ingredients: ['Chicken', 'Tomato', 'Onion', 'Ginger', 'Garlic', 'Spices'] } },
  { id: 'm42', category: 'Main Course Non-Veg', categoryHi: 'मुख्य व्यंजन (नॉन-वेज)', name: 'Chicken Curry (8Pc)',   nameHi: 'चिकन करी (8 पीस)',    price: 369, emoji: '🍛', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 880, protein: 96, carbs: 32, fat: 48, ingredients: ['Chicken', 'Tomato', 'Onion', 'Ginger', 'Garlic', 'Spices'] } },
  { id: 'm43', category: 'Main Course Non-Veg', categoryHi: 'मुख्य व्यंजन (नॉन-वेज)', name: 'Fish Curry (2Pc)',      nameHi: 'फिश करी (2 पीस)',     price: 139, emoji: '🐟', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 200, protein: 22, carbs:  8, fat: 10, ingredients: ['Fish', 'Tomato', 'Onion', 'Mustard', 'Turmeric', 'Coconut'] } },
  { id: 'm44', category: 'Main Course Non-Veg', categoryHi: 'मुख्य व्यंजन (नॉन-वेज)', name: 'Fish Curry (4Pc)',      nameHi: 'फिश करी (4 पीस)',     price: 269, emoji: '🐟', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 400, protein: 44, carbs: 16, fat: 20, ingredients: ['Fish', 'Tomato', 'Onion', 'Mustard', 'Turmeric', 'Coconut'] } },
  { id: 'm45', category: 'Main Course Non-Veg', categoryHi: 'मुख्य व्यंजन (नॉन-वेज)', name: 'Fish Curry (8Pc)',      nameHi: 'फिश करी (8 पीस)',     price: 519, emoji: '🐟', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 800, protein: 88, carbs: 32, fat: 40, ingredients: ['Fish', 'Tomato', 'Onion', 'Mustard', 'Turmeric', 'Coconut'] } },
  { id: 'm46', category: 'Main Course Non-Veg', categoryHi: 'मुख्य व्यंजन (नॉन-वेज)', name: 'Egg Bhurji (2Pc)',      nameHi: 'अंडा भुर्जी (2 पीस)', price: 49,  emoji: '🥚', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 160, protein: 12, carbs:  4, fat: 12, ingredients: ['Eggs', 'Onion', 'Tomato', 'Green Chilli', 'Spices', 'Oil'] } },
  { id: 'm47', category: 'Main Course Non-Veg', categoryHi: 'मुख्य व्यंजन (नॉन-वेज)', name: 'Egg Bhurji (4Pc)',      nameHi: 'अंडा भुर्जी (4 पीस)', price: 95,  emoji: '🥚', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 320, protein: 24, carbs:  8, fat: 24, ingredients: ['Eggs', 'Onion', 'Tomato', 'Green Chilli', 'Spices', 'Oil'] } },
  { id: 'm48', category: 'Main Course Non-Veg', categoryHi: 'मुख्य व्यंजन (नॉन-वेज)', name: 'Egg Bhurji (8Pc)',      nameHi: 'अंडा भुर्जी (8 पीस)', price: 189, emoji: '🥚', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 640, protein: 48, carbs: 16, fat: 48, ingredients: ['Eggs', 'Onion', 'Tomato', 'Green Chilli', 'Spices', 'Oil'] } },
  { id: 'm49', category: 'Main Course Non-Veg', categoryHi: 'मुख्य व्यंजन (नॉन-वेज)', name: 'Omelette (2Pc)',        nameHi: 'ऑमलेट (2 पीस)',       price: 49,  emoji: '🍳', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 180, protein: 14, carbs:  2, fat: 14, ingredients: ['Eggs', 'Onion', 'Green Chilli', 'Coriander', 'Salt', 'Oil'] } },
  { id: 'm50', category: 'Main Course Non-Veg', categoryHi: 'मुख्य व्यंजन (नॉन-वेज)', name: 'Omelette (4Pc)',        nameHi: 'ऑमलेट (4 पीस)',       price: 95,  emoji: '🍳', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 360, protein: 28, carbs:  4, fat: 28, ingredients: ['Eggs', 'Onion', 'Green Chilli', 'Coriander', 'Salt', 'Oil'] } },
  { id: 'm51', category: 'Main Course Non-Veg', categoryHi: 'मुख्य व्यंजन (नॉन-वेज)', name: 'Omelette (8Pc)',        nameHi: 'ऑमलेट (8 पीस)',       price: 189, emoji: '🍳', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 720, protein: 56, carbs:  8, fat: 56, ingredients: ['Eggs', 'Onion', 'Green Chilli', 'Coriander', 'Salt', 'Oil'] } },
  { id: 'm52', category: 'Main Course Non-Veg', categoryHi: 'मुख्य व्यंजन (नॉन-वेज)', name: 'Egg Curry (2Pc)',       nameHi: 'अंडा करी (2 पीस)',    price: 79,  emoji: '🥚', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 200, protein: 14, carbs: 10, fat: 12, ingredients: ['Eggs', 'Tomato', 'Onion', 'Ginger', 'Garlic', 'Spices'] } },
  { id: 'm53', category: 'Main Course Non-Veg', categoryHi: 'मुख्य व्यंजन (नॉन-वेज)', name: 'Egg Curry (4Pc)',       nameHi: 'अंडा करी (4 पीस)',    price: 149, emoji: '🥚', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 400, protein: 28, carbs: 20, fat: 24, ingredients: ['Eggs', 'Tomato', 'Onion', 'Ginger', 'Garlic', 'Spices'] } },
  { id: 'm54', category: 'Main Course Non-Veg', categoryHi: 'मुख्य व्यंजन (नॉन-वेज)', name: 'Egg Curry (8Pc)',       nameHi: 'अंडा करी (8 पीस)',    price: 289, emoji: '🥚', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 800, protein: 56, carbs: 40, fat: 48, ingredients: ['Eggs', 'Tomato', 'Onion', 'Ginger', 'Garlic', 'Spices'] } },

  // ─── Veg Meals ───
  { id: 'm55', category: 'Veg Meals',        categoryHi: 'वेज मील्स',          name: 'Paneer Plain Rice Meal',     nameHi: 'पनीर प्लेन राइस मील',     price: 169, emoji: '🍱', popular: false, tags: ['veg', 'meal'], nutrition: { calories: 550, protein: 20, carbs: 70, fat: 20, ingredients: ['Paneer', 'Rice', 'Dal', 'Salad', 'Pickle', 'Papad'] } },
  { id: 'm56', category: 'Veg Meals',        categoryHi: 'वेज मील्स',          name: 'Paneer Jeera Rice Meal',     nameHi: 'पनीर जीरा राइस मील',      price: 179, emoji: '🍱', popular: false, tags: ['veg', 'meal'], nutrition: { calories: 580, protein: 20, carbs: 74, fat: 22, ingredients: ['Paneer', 'Jeera Rice', 'Dal', 'Salad', 'Pickle', 'Papad'] } },
  { id: 'm57', category: 'Veg Meals',        categoryHi: 'वेज मील्स',          name: 'Paneer Pulav Meal',          nameHi: 'पनीर पुलाव मील',           price: 189, emoji: '🍱', popular: false, tags: ['veg', 'meal'], nutrition: { calories: 600, protein: 20, carbs: 78, fat: 22, ingredients: ['Paneer', 'Pulav', 'Dal', 'Raita', 'Salad', 'Papad'] } },
  { id: 'm58', category: 'Veg Meals',        categoryHi: 'वेज मील्स',          name: 'Paneer Roti Meal',           nameHi: 'पनीर रोटी मील',            price: 169, emoji: '🫓', popular: false, tags: ['veg', 'meal'], nutrition: { calories: 520, protein: 22, carbs: 60, fat: 20, ingredients: ['Paneer', 'Roti', 'Dal', 'Sabzi', 'Salad', 'Pickle'] } },
  { id: 'm59', category: 'Veg Meals',        categoryHi: 'वेज मील्स',          name: 'Standard Veg Thali',         nameHi: 'स्टैंडर्ड वेज थाली',       price: 109, emoji: '🍽️', popular: true,  tags: ['veg', 'meal'], nutrition: { calories: 600, protein: 18, carbs: 82, fat: 20, ingredients: ['Rice', 'Dal', 'Sabzi', 'Roti', 'Salad', 'Papad'] } },
  { id: 'm60', category: 'Veg Meals',        categoryHi: 'वेज मील्स',          name: 'Special Veg Thali',          nameHi: 'स्पेशल वेज थाली',          price: 159, emoji: '🍽️', popular: true,  tags: ['veg', 'meal'], nutrition: { calories: 680, protein: 22, carbs: 88, fat: 24, ingredients: ['Rice', 'Dal', 'Paneer Sabzi', 'Roti', 'Raita', 'Papad', 'Sweet'] } },
  { id: 'm61', category: 'Veg Meals',        categoryHi: 'वेज मील्स',          name: 'Dal Chawal Bhujiya',         nameHi: 'दाल चावल भुजिया',          price: 99,  emoji: '🍚', popular: false, tags: ['veg', 'meal', 'guilt-free'], nutrition: { calories: 480, protein: 14, carbs: 72, fat: 14, ingredients: ['Rice', 'Dal', 'Aloo Bhujiya', 'Salad', 'Pickle'] } },
  { id: 'm62', category: 'Veg Meals',        categoryHi: 'वेज मील्स',          name: 'Dal Chawal Chokha',          nameHi: 'दाल चावल चोखा',            price: 99,  emoji: '🍚', popular: false, tags: ['veg', 'meal', 'guilt-free'], nutrition: { calories: 460, protein: 14, carbs: 70, fat: 12, ingredients: ['Rice', 'Dal', 'Aloo Chokha', 'Salad', 'Pickle'] } },
  { id: 'm63', category: 'Veg Meals',        categoryHi: 'वेज मील्स',          name: 'Roti Sabzi Meal',            nameHi: 'रोटी सब्जी मील',           price: 99,  emoji: '🫓', popular: false, tags: ['veg', 'meal', 'guilt-free'], nutrition: { calories: 420, protein: 14, carbs: 62, fat: 14, ingredients: ['Roti', 'Sabzi', 'Dal', 'Salad', 'Pickle'] } },
  { id: 'm64', category: 'Veg Meals',        categoryHi: 'वेज मील्स',          name: 'Paratha Sabzi Meal',         nameHi: 'पराठा सब्जी मील',          price: 129, emoji: '🫓', popular: false, tags: ['veg', 'meal'], nutrition: { calories: 500, protein: 14, carbs: 70, fat: 18, ingredients: ['Paratha', 'Sabzi', 'Curd', 'Salad', 'Pickle'] } },
  { id: 'm65', category: 'Veg Meals',        categoryHi: 'वेज मील्स',          name: 'Puri Sabzi Meal',            nameHi: 'पूरी सब्जी मील',           price: 129, emoji: '🫓', popular: false, tags: ['veg', 'meal'], nutrition: { calories: 520, protein: 12, carbs: 72, fat: 20, ingredients: ['Puri', 'Aloo Sabzi', 'Pickle', 'Salad', 'Chutney'] } },
  { id: 'm66', category: 'Veg Meals',        categoryHi: 'वेज मील्स',          name: 'Dal Khichdi',                nameHi: 'दाल खिचड़ी',               price: 99,  emoji: '🍚', popular: false, tags: ['veg', 'meal', 'guilt-free'], nutrition: { calories: 400, protein: 14, carbs: 64, fat: 12, ingredients: ['Rice', 'Moong Dal', 'Ghee', 'Turmeric', 'Cumin', 'Ginger'] } },

  // ─── Non-Veg Meals ───
  { id: 'm67', category: 'Non-Veg Meals',    categoryHi: 'नॉन-वेज मील्स',     name: 'Chicken Plain Rice Meal',    nameHi: 'चिकन प्लेन राइस मील',     price: 189, emoji: '🍱', popular: true,  tags: ['non-veg', 'meal', 'high-protein'], nutrition: { calories: 620, protein: 36, carbs: 70, fat: 20, ingredients: ['Chicken Curry', 'Rice', 'Dal', 'Salad', 'Pickle', 'Papad'] } },
  { id: 'm68', category: 'Non-Veg Meals',    categoryHi: 'नॉन-वेज मील्स',     name: 'Chicken Jeera Rice Meal',    nameHi: 'चिकन जीरा राइस मील',      price: 199, emoji: '🍱', popular: false, tags: ['non-veg', 'meal', 'high-protein'], nutrition: { calories: 650, protein: 36, carbs: 74, fat: 22, ingredients: ['Chicken Curry', 'Jeera Rice', 'Dal', 'Salad', 'Pickle', 'Papad'] } },
  { id: 'm69', category: 'Non-Veg Meals',    categoryHi: 'नॉन-वेज मील्स',     name: 'Chicken Pulav Meal',         nameHi: 'चिकन पुलाव मील',           price: 209, emoji: '🍱', popular: false, tags: ['non-veg', 'meal', 'high-protein'], nutrition: { calories: 660, protein: 36, carbs: 78, fat: 22, ingredients: ['Chicken Curry', 'Pulav', 'Raita', 'Salad', 'Papad'] } },
  { id: 'm70', category: 'Non-Veg Meals',    categoryHi: 'नॉन-वेज मील्स',     name: 'Roti Chicken Meal',          nameHi: 'रोटी चिकन मील',            price: 189, emoji: '🫓', popular: false, tags: ['non-veg', 'meal', 'high-protein'], nutrition: { calories: 580, protein: 38, carbs: 58, fat: 22, ingredients: ['Chicken Curry', 'Roti', 'Dal', 'Salad', 'Pickle'] } },
  { id: 'm71', category: 'Non-Veg Meals',    categoryHi: 'नॉन-वेज मील्स',     name: 'Fish Thali',                 nameHi: 'फिश थाली',                 price: 199, emoji: '🐟', popular: false, tags: ['non-veg', 'meal', 'high-protein'], nutrition: { calories: 640, protein: 34, carbs: 72, fat: 22, ingredients: ['Fish Curry', 'Rice', 'Dal', 'Salad', 'Pickle', 'Papad'] } },

  // ─── Rice & Biryani ───
  { id: 'm72', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Plain Rice (Half)',          nameHi: 'प्लेन राइस (हाफ)',         price: 45,  emoji: '🍚', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 180, protein:  4, carbs: 40, fat:  0, ingredients: ['Basmati Rice', 'Water', 'Salt'] } },
  { id: 'm73', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Plain Rice (Full)',          nameHi: 'प्लेन राइस (फुल)',         price: 80,  emoji: '🍚', popular: false, tags: ['veg'],     nutrition: { calories: 360, protein:  8, carbs: 80, fat:  0, ingredients: ['Basmati Rice', 'Water', 'Salt'] } },
  { id: 'm74', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Jeera Rice (Half)',          nameHi: 'जीरा राइस (हाफ)',          price: 65,  emoji: '🍚', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 200, protein:  4, carbs: 42, fat:  4, ingredients: ['Basmati Rice', 'Cumin', 'Ghee', 'Salt', 'Bay Leaf'] } },
  { id: 'm75', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Jeera Rice (Full)',          nameHi: 'जीरा राइस (फुल)',          price: 99,  emoji: '🍚', popular: false, tags: ['veg'],     nutrition: { calories: 400, protein:  8, carbs: 84, fat:  8, ingredients: ['Basmati Rice', 'Cumin', 'Ghee', 'Salt', 'Bay Leaf'] } },
  { id: 'm76', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Ghee Rice (Half)',           nameHi: 'घी राइस (हाफ)',            price: 65,  emoji: '🍚', popular: false, tags: ['veg'],     nutrition: { calories: 240, protein:  4, carbs: 42, fat:  8, ingredients: ['Basmati Rice', 'Ghee', 'Cashew', 'Raisins', 'Bay Leaf'] } },
  { id: 'm77', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Ghee Rice (Full)',           nameHi: 'घी राइस (फुल)',            price: 99,  emoji: '🍚', popular: false, tags: ['veg'],     nutrition: { calories: 480, protein:  8, carbs: 84, fat: 16, ingredients: ['Basmati Rice', 'Ghee', 'Cashew', 'Raisins', 'Bay Leaf'] } },
  { id: 'm78', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Veg Pulav (Half)',           nameHi: 'वेज पुलाव (हाफ)',          price: 69,  emoji: '🍚', popular: false, tags: ['veg'],     nutrition: { calories: 260, protein:  6, carbs: 46, fat:  6, ingredients: ['Basmati Rice', 'Mixed Vegetables', 'Ghee', 'Whole Spices', 'Onion'] } },
  { id: 'm79', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Veg Pulav (Full)',           nameHi: 'वेज पुलाव (फुल)',          price: 129, emoji: '🍚', popular: false, tags: ['veg'],     nutrition: { calories: 480, protein: 12, carbs: 82, fat: 10, ingredients: ['Basmati Rice', 'Mixed Vegetables', 'Ghee', 'Whole Spices', 'Onion'] } },
  { id: 'm80', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Veg Biryani',               nameHi: 'वेज बिरयानी',               price: 139, emoji: '🍲', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 380, protein: 10, carbs: 58, fat: 12, ingredients: ['Basmati Rice', 'Mixed Vegetables', 'Saffron', 'Fried Onions', 'Whole Spices', 'Ghee'] } },
  { id: 'm81', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Chicken Biryani',           nameHi: 'चिकन बिरयानी',              price: 159, emoji: '🍲', popular: true,  tags: ['non-veg', 'high-protein'], nutrition: { calories: 560, protein: 38, carbs: 62, fat: 18, ingredients: ['Basmati Rice', 'Chicken', 'Saffron', 'Fried Onions', 'Yogurt', 'Whole Spices'] } },
  { id: 'm82', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Egg Fried Rice',            nameHi: 'एग फ्राइड राइस',           price: 139, emoji: '🍳', popular: false, tags: ['non-veg'], nutrition: { calories: 420, protein: 16, carbs: 64, fat: 12, ingredients: ['Rice', 'Eggs', 'Spring Onion', 'Soy Sauce', 'Garlic', 'Oil'] } },
  { id: 'm83', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Veg Fried Rice',            nameHi: 'वेज फ्राइड राइस',          price: 129, emoji: '🍚', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 380, protein:  8, carbs: 66, fat: 10, ingredients: ['Rice', 'Mixed Vegetables', 'Soy Sauce', 'Garlic', 'Spring Onion', 'Oil'] } },
  { id: 'm84', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Veg Schezwan Fried Rice',   nameHi: 'वेज शेजवान फ्राइड राइस',   price: 139, emoji: '🌶️', popular: false, tags: ['veg'],     nutrition: { calories: 400, protein:  8, carbs: 68, fat: 12, ingredients: ['Rice', 'Mixed Vegetables', 'Schezwan Sauce', 'Garlic', 'Spring Onion', 'Oil'] } },
  { id: 'm85', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Paneer Fried Rice',         nameHi: 'पनीर फ्राइड राइस',         price: 149, emoji: '🧀', popular: false, tags: ['veg'],     nutrition: { calories: 440, protein: 16, carbs: 66, fat: 14, ingredients: ['Rice', 'Paneer', 'Soy Sauce', 'Garlic', 'Spring Onion', 'Capsicum'] } },
  { id: 'm86', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Paneer Schezwan Fried Rice', nameHi: 'पनीर शेजवान फ्राइड राइस', price: 159, emoji: '🌶️', popular: false, tags: ['veg'],     nutrition: { calories: 460, protein: 16, carbs: 68, fat: 16, ingredients: ['Rice', 'Paneer', 'Schezwan Sauce', 'Garlic', 'Spring Onion', 'Capsicum'] } },
  { id: 'm87', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Chicken Fried Rice',        nameHi: 'चिकन फ्राइड राइस',         price: 159, emoji: '🍗', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 460, protein: 24, carbs: 64, fat: 14, ingredients: ['Rice', 'Chicken', 'Soy Sauce', 'Garlic', 'Spring Onion', 'Egg'] } },
  { id: 'm88', category: 'Rice & Biryani',   categoryHi: 'चावल और बिरयानी',   name: 'Chicken Schezwan Fried Rice', nameHi: 'चिकन शेजवान फ्राइड राइस', price: 169, emoji: '🌶️', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 480, protein: 24, carbs: 66, fat: 16, ingredients: ['Rice', 'Chicken', 'Schezwan Sauce', 'Garlic', 'Spring Onion', 'Capsicum'] } },

  // ─── Noodles ───
  { id: 'm89', category: 'Noodles',          categoryHi: 'नूडल्स',             name: 'Veg Noodles',               nameHi: 'वेज नूडल्स',                price: 129, emoji: '🍜', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 360, protein:  8, carbs: 64, fat:  8, ingredients: ['Noodles', 'Mixed Vegetables', 'Soy Sauce', 'Garlic', 'Spring Onion', 'Oil'] } },
  { id: 'm90', category: 'Noodles',          categoryHi: 'नूडल्स',             name: 'Veg Schezwan Noodles',      nameHi: 'वेज शेजवान नूडल्स',         price: 139, emoji: '🌶️', popular: false, tags: ['veg'],     nutrition: { calories: 380, protein:  8, carbs: 66, fat: 10, ingredients: ['Noodles', 'Mixed Vegetables', 'Schezwan Sauce', 'Garlic', 'Chilli', 'Oil'] } },
  { id: 'm91', category: 'Noodles',          categoryHi: 'नूडल्स',             name: 'Paneer Noodles',            nameHi: 'पनीर नूडल्स',               price: 149, emoji: '🧀', popular: false, tags: ['veg', 'high-protein'],     nutrition: { calories: 420, protein: 16, carbs: 64, fat: 14, ingredients: ['Noodles', 'Paneer', 'Soy Sauce', 'Garlic', 'Spring Onion', 'Capsicum'] } },
  { id: 'm92', category: 'Noodles',          categoryHi: 'नूडल्स',             name: 'Paneer Schezwan Noodles',   nameHi: 'पनीर शेजवान नूडल्स',        price: 159, emoji: '🌶️', popular: false, tags: ['veg'],     nutrition: { calories: 440, protein: 16, carbs: 66, fat: 16, ingredients: ['Noodles', 'Paneer', 'Schezwan Sauce', 'Garlic', 'Chilli', 'Capsicum'] } },
  { id: 'm93', category: 'Noodles',          categoryHi: 'नूडल्स',             name: 'Chicken Noodles',           nameHi: 'चिकन नूडल्स',               price: 159, emoji: '🍗', popular: false, tags: ['non-veg', 'high-protein'], nutrition: { calories: 420, protein: 24, carbs: 60, fat: 14, ingredients: ['Noodles', 'Chicken', 'Soy Sauce', 'Garlic', 'Spring Onion', 'Egg'] } },
  { id: 'm94', category: 'Noodles',          categoryHi: 'नूडल्स',             name: 'Chicken Schezwan Noodles',  nameHi: 'चिकन शेजवान नूडल्स',        price: 169, emoji: '🌶️', popular: true,  tags: ['non-veg', 'high-protein'], nutrition: { calories: 440, protein: 24, carbs: 62, fat: 16, ingredients: ['Noodles', 'Chicken', 'Schezwan Sauce', 'Garlic', 'Chilli', 'Spring Onion'] } },

  // ─── Roti & Paratha ───
  { id: 'm95',  category: 'Roti & Paratha',  categoryHi: 'रोटी और पराठा',     name: 'Plain Roti',                nameHi: 'प्लेन रोटी',                price: 10,  emoji: '🫓', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories:  80, protein:  3, carbs: 16, fat:  1, ingredients: ['Whole Wheat Flour', 'Water', 'Salt'] } },
  { id: 'm96',  category: 'Roti & Paratha',  categoryHi: 'रोटी और पराठा',     name: 'Ghee Roti',                 nameHi: 'घी रोटी',                   price: 15,  emoji: '🫓', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 110, protein:  3, carbs: 16, fat:  4, ingredients: ['Whole Wheat Flour', 'Ghee', 'Water', 'Salt'] } },
  { id: 'm97',  category: 'Roti & Paratha',  categoryHi: 'रोटी और पराठा',     name: 'Butter Roti',               nameHi: 'बटर रोटी',                  price: 12,  emoji: '🧈', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 100, protein:  3, carbs: 16, fat:  3, ingredients: ['Whole Wheat Flour', 'Butter', 'Water', 'Salt'] } },
  { id: 'm98',  category: 'Roti & Paratha',  categoryHi: 'रोटी और पराठा',     name: 'Plain Paratha',             nameHi: 'प्लेन पराठा',               price: 25,  emoji: '🫓', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 180, protein:  4, carbs: 28, fat:  6, ingredients: ['Whole Wheat Flour', 'Oil', 'Water', 'Salt'] } },
  { id: 'm99',  category: 'Roti & Paratha',  categoryHi: 'रोटी और पराठा',     name: 'Aloo Paratha',              nameHi: 'आलू पराठा',                 price: 55,  emoji: '🥔', popular: true,  tags: ['veg'],     nutrition: { calories: 240, protein:  6, carbs: 36, fat:  8, ingredients: ['Whole Wheat Flour', 'Potato', 'Onion', 'Spices', 'Oil', 'Coriander'] } },
  { id: 'm100', category: 'Roti & Paratha',  categoryHi: 'रोटी और पराठा',     name: 'Sattu Paratha',             nameHi: 'सत्तू पराठा',               price: 55,  emoji: '🫓', popular: false, tags: ['veg', 'high-protein'],     nutrition: { calories: 260, protein: 10, carbs: 34, fat: 10, ingredients: ['Whole Wheat Flour', 'Sattu', 'Onion', 'Green Chilli', 'Mustard Oil', 'Coriander'] } },
  { id: 'm101', category: 'Roti & Paratha',  categoryHi: 'रोटी और पराठा',     name: 'Aloo Pyaz Paratha',         nameHi: 'आलू प्याज़ पराठा',           price: 60,  emoji: '🧅', popular: false, tags: ['veg'],     nutrition: { calories: 260, protein:  6, carbs: 38, fat:  8, ingredients: ['Whole Wheat Flour', 'Potato', 'Onion', 'Green Chilli', 'Spices', 'Oil'] } },
  { id: 'm102', category: 'Roti & Paratha',  categoryHi: 'रोटी और पराठा',     name: 'Pyaz Paratha',              nameHi: 'प्याज़ पराठा',               price: 30,  emoji: '🧅', popular: false, tags: ['veg'],     nutrition: { calories: 200, protein:  4, carbs: 30, fat:  7, ingredients: ['Whole Wheat Flour', 'Onion', 'Green Chilli', 'Spices', 'Oil'] } },
  { id: 'm103', category: 'Roti & Paratha',  categoryHi: 'रोटी और पराठा',     name: 'Paneer Paratha',            nameHi: 'पनीर पराठा',                price: 70,  emoji: '🧀', popular: false, tags: ['veg', 'high-protein'],     nutrition: { calories: 300, protein: 12, carbs: 32, fat: 14, ingredients: ['Whole Wheat Flour', 'Paneer', 'Green Chilli', 'Coriander', 'Spices', 'Oil'] } },

  // ─── Dal ───
  { id: 'm104', category: 'Dal',             categoryHi: 'दाल',               name: 'Dal Fry (Half)',            nameHi: 'दाल फ्राई (हाफ)',           price: 50,  emoji: '🫘', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 150, protein:  8, carbs: 22, fat:  4, ingredients: ['Yellow Lentils', 'Onion', 'Tomato', 'Garlic', 'Cumin', 'Ghee'] } },
  { id: 'm105', category: 'Dal',             categoryHi: 'दाल',               name: 'Dal Fry (Full)',            nameHi: 'दाल फ्राई (फुल)',           price: 90,  emoji: '🫘', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories: 300, protein: 16, carbs: 44, fat:  8, ingredients: ['Yellow Lentils', 'Onion', 'Tomato', 'Garlic', 'Cumin', 'Ghee'] } },
  { id: 'm106', category: 'Dal',             categoryHi: 'दाल',               name: 'Dal Tadka (Half)',          nameHi: 'दाल तड़का (हाफ)',           price: 70,  emoji: '🫘', popular: true,  tags: ['veg', 'guilt-free'],     nutrition: { calories: 170, protein:  8, carbs: 24, fat:  6, ingredients: ['Arhar Dal', 'Garlic', 'Cumin', 'Dried Red Chilli', 'Ghee', 'Tomato'] } },
  { id: 'm107', category: 'Dal',             categoryHi: 'दाल',               name: 'Dal Tadka (Full)',          nameHi: 'दाल तड़का (फुल)',           price: 120, emoji: '🫘', popular: true,  tags: ['veg', 'high-protein'],     nutrition: { calories: 340, protein: 16, carbs: 48, fat: 12, ingredients: ['Arhar Dal', 'Garlic', 'Cumin', 'Dried Red Chilli', 'Ghee', 'Tomato'] } },

  // ─── Beverages ───
  { id: 'm108', category: 'Beverages',       categoryHi: 'पेय',               name: 'Lassi',                     nameHi: 'लस्सी',                    price: 60,  emoji: '🥛', popular: true,  tags: ['veg', 'guilt-free'],     nutrition: { calories: 180, protein:  6, carbs: 28, fat:  6, ingredients: ['Yogurt', 'Sugar', 'Cardamom', 'Rose Water', 'Milk'] } },
  { id: 'm109', category: 'Beverages',       categoryHi: 'पेय',               name: 'Sattu',                     nameHi: 'सत्तू',                    price: 40,  emoji: '🥤', popular: false, tags: ['veg', 'high-protein', 'guilt-free'],     nutrition: { calories: 160, protein:  8, carbs: 26, fat:  2, ingredients: ['Roasted Gram Flour', 'Water', 'Lemon', 'Black Salt', 'Cumin'] } },
  { id: 'm110', category: 'Beverages',       categoryHi: 'पेय',               name: 'Soft Drinks',               nameHi: 'सॉफ्ट ड्रिंक्स',           price: 40,  emoji: '🥤', popular: false, tags: ['veg'],     nutrition: { calories: 130, protein:  0, carbs: 34, fat:  0, ingredients: ['Carbonated Water', 'Sugar', 'Natural Flavours'] } },
  { id: 'm111', category: 'Beverages',       categoryHi: 'पेय',               name: 'Mineral Water',             nameHi: 'मिनरल वाटर',               price: 20,  emoji: '💧', popular: false, tags: ['veg', 'guilt-free'],     nutrition: { calories:   0, protein:  0, carbs:  0, fat:  0, ingredients: ['Purified Water'] } },
];

// Add dynamic fields to every menu item
const COOK_TIMES = {
  'Veg Starters': 10, 'Non-Veg Starters': 15,
  'Main Course Veg': 12, 'Main Course Non-Veg': 15,
  'Veg Meals': 12, 'Non-Veg Meals': 15,
  'Rice & Biryani': 20, 'Noodles': 12,
  'Roti & Paratha': 8, 'Dal': 10, 'Beverages': 3,
};
MENU.forEach(item => { item.inStock = true; item.offer = 0; item.cookTime = COOK_TIMES[item.category] || 15; });

// ─── In-Memory State ─────────────────────────────────────────────────────────
let orders = [];         // Confirmed orders
let activeCarts = {};    // Temporary cart sessions
let orderCounter = 1000; // Starting order ID
let invoiceCounter = 0;  // Sequential invoice number (persisted)

// ─── Table Occupancy Tracking ─────────────────────────────────────────────────
// occupiedTables: { 'T1': { customerName, orderId, since } }
let occupiedTables = {};

// ─── SQLite Persistence ───────────────────────────────────────────────────────
const DB_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, 'restaurantos.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    tableNo TEXT NOT NULL,
    status TEXT NOT NULL,
    paymentStatus TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    paidAt TEXT,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS menu_state (
    id TEXT PRIMARY KEY,
    inStock INTEGER NOT NULL DEFAULT 1,
    offer REAL NOT NULL DEFAULT 0,
    image TEXT
  );
  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    phone TEXT,
    restaurant TEXT,
    city TEXT,
    business_type TEXT,
    message TEXT,
    created_at TEXT NOT NULL
  );
`);

try { db.exec('ALTER TABLE menu_state ADD COLUMN image TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE menu_state ADD COLUMN stockCount INTEGER'); } catch (_) {}
try { db.exec('ALTER TABLE menu_state ADD COLUMN popular INTEGER'); } catch (_) {}
db.exec(`CREATE TABLE IF NOT EXISTS custom_menu_items (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);

// Load persisted orderCounter
const counterRow = db.prepare("SELECT value FROM app_config WHERE key='orderCounter'").get();
if (counterRow) orderCounter = parseInt(counterRow.value, 10);
else db.prepare("INSERT INTO app_config (key, value) VALUES ('orderCounter', ?)").run(String(orderCounter));

// Load persisted invoiceCounter
const invCounterRow = db.prepare("SELECT value FROM app_config WHERE key='invoiceCounter'").get();
if (invCounterRow) invoiceCounter = parseInt(invCounterRow.value, 10);
else db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES ('invoiceCounter', ?)").run(String(invoiceCounter));

// Load persisted GST config overrides (set via admin panel)
const gstinRow = db.prepare("SELECT value FROM app_config WHERE key='gstin'").get();
if (gstinRow && gstinRow.value) CONFIG.GSTIN = gstinRow.value;
const invPrefixRow = db.prepare("SELECT value FROM app_config WHERE key='invoicePrefix'").get();
if (invPrefixRow && invPrefixRow.value) CONFIG.INVOICE_PREFIX = invPrefixRow.value;

// Load persisted orders
orders = db.prepare('SELECT data FROM orders').all().map(row => {
  const order = JSON.parse(row.data);
  if (order.items) {
    order.items = order.items.map(item => ({ ...item, quantity: item.quantity ?? item.qty }));
  }
  return order;
});

// Load custom menu items added by admin
db.prepare('SELECT data FROM custom_menu_items').all().forEach(row => {
  try {
    const item = JSON.parse(row.data);
    if (!MENU.find(m => m.id === item.id)) {
      item.inStock = true; item.offer = 0; item.stockCount = null; item.image = null;
      MENU.push(item);
    }
  } catch (_) {}
});

// Apply persisted menu state
db.prepare('SELECT id, inStock, offer, image, stockCount, popular FROM menu_state').all().forEach(row => {
  const item = MENU.find(m => m.id === row.id);
  if (item) {
    item.inStock = !!row.inStock;
    item.offer = row.offer;
    item.image = row.image || null;
    item.stockCount = (row.stockCount !== null && row.stockCount !== undefined) ? row.stockCount : null;
    if (row.popular !== null && row.popular !== undefined) item.popular = !!row.popular;
  }
});

// Sync menu images with Cloudinary:
//   1. Restore URLs for items that already have a Cloudinary upload
//   2. Auto-upload any committed local JPGs that are not yet in Cloudinary
//   Runs on every startup; skips files already uploaded (no re-upload).
if (process.env.CLOUDINARY_CLOUD_NAME) {
  (async () => {
    try {
      // Fetch what's already in Cloudinary
      const result = await cloudinary.api.resources({ type: 'upload', prefix: 'dinefy-menu/', max_results: 200 });
      const existing = new Set(result.resources.map(r => r.public_id.replace('dinefy-menu/', '')));

      // Restore URLs for already-uploaded items
      result.resources.forEach(resource => {
        const itemId = resource.public_id.replace('dinefy-menu/', '');
        const item = MENU.find(m => m.id === itemId);
        if (item && !item.image) {
          item.image = resource.secure_url;
          dbSaveMenuState(item.id, item.inStock, item.offer, item.image, item.stockCount);
        }
      });
      console.log(`[Cloudinary] Restored ${result.resources.length} existing menu image(s)`);

      // Upload local committed JPGs that are missing from Cloudinary
      const uploadsDir = path.join(__dirname, 'public', 'uploads', 'menu');
      const toUpload = MENU.filter(item => {
        if (item.image) return false;                          // already has URL
        if (existing.has(item.id)) return false;              // already in Cloudinary
        const localPath = path.join(uploadsDir, `${item.id}.jpg`);
        return fs.existsSync(localPath);                      // committed file present
      });

      if (toUpload.length === 0) {
        console.log('[Cloudinary] All menu images up to date');
        return;
      }

      console.log(`[Cloudinary] Uploading ${toUpload.length} new menu image(s)…`);
      let uploaded = 0;
      for (const item of toUpload) {
        const localPath = path.join(uploadsDir, `${item.id}.jpg`);
        try {
          const res = await cloudinary.uploader.upload(localPath, {
            public_id: `dinefy-menu/${item.id}`, overwrite: false, resource_type: 'image',
          });
          item.image = res.secure_url;
          dbSaveMenuState(item.id, item.inStock, item.offer, item.image, item.stockCount);
          uploaded++;
        } catch (e) {
          console.error(`[Cloudinary] Failed to upload ${item.id}: ${e.message}`);
        }
      }
      console.log(`[Cloudinary] Auto-uploaded ${uploaded}/${toUpload.length} menu image(s)`);
      if (uploaded > 0) io.emit('menu:updated', { menu: MENU });
    } catch (e) {
      console.error('[Cloudinary] Image sync failed:', e.message);
    }
  })();
}

// Rebuild occupiedTables from active (non-completed/paid/cancelled) orders
const INACTIVE_STATUSES = new Set(['completed', 'paid', 'cancelled']);
orders.forEach(order => {
  if (!INACTIVE_STATUSES.has(order.status) && order.tableNo && !occupiedTables[order.tableNo]) {
    occupiedTables[order.tableNo] = { customerName: order.customerName, orderId: order.id, since: order.createdAt };
  }
});

// ─── DB Write Helpers ─────────────────────────────────────────────────────────
const _insertOrder = db.prepare(
  'INSERT OR REPLACE INTO orders (id, tableNo, status, paymentStatus, createdAt, updatedAt, paidAt, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);
const _updateOrder = db.prepare(
  'UPDATE orders SET status=?, paymentStatus=?, updatedAt=?, paidAt=?, data=? WHERE id=?'
);
const _upsertMenuState = db.prepare(
  'INSERT OR REPLACE INTO menu_state (id, inStock, offer, image, stockCount, popular) VALUES (?, ?, ?, ?, ?, ?)'
);
const _upsertCounter = db.prepare(
  "INSERT OR REPLACE INTO app_config (key, value) VALUES ('orderCounter', ?)"
);

function dbSaveOrder(order) {
  _insertOrder.run(order.id, order.tableNo, order.status, order.paymentStatus,
    order.createdAt, order.updatedAt, order.paidAt || null, JSON.stringify(order));
  scheduleCloudinaryBackup();
}

function dbUpdateOrder(order) {
  _updateOrder.run(order.status, order.paymentStatus, order.updatedAt,
    order.paidAt || null, JSON.stringify(order), order.id);
  scheduleCloudinaryBackup();
}

function dbSaveMenuState(itemId, inStock, offer, image, stockCount, popular) {
  _upsertMenuState.run(
    itemId, inStock ? 1 : 0, offer, image || null,
    (stockCount !== undefined && stockCount !== null) ? stockCount : null,
    (popular !== undefined && popular !== null) ? (popular ? 1 : 0) : null
  );
  scheduleCloudinaryBackup();
}

// ─── Cloudinary DB Snapshot (survives Render ephemeral filesystem resets) ────
let _backupTimer = null;
function scheduleCloudinaryBackup() {
  if (!process.env.CLOUDINARY_CLOUD_NAME) return;
  clearTimeout(_backupTimer);
  _backupTimer = setTimeout(doCloudinaryBackup, 4000); // debounce 4s
}

async function doCloudinaryBackup() {
  try {
    const snapshot = {
      v: 2,
      savedAt: new Date().toISOString(),
      orders,
      orderCounter,
      invoiceCounter,
      menuState:   db.prepare('SELECT * FROM menu_state').all(),
      customItems: db.prepare('SELECT * FROM custom_menu_items').all(),
      appConfig:   db.prepare('SELECT * FROM app_config').all(),
    };
    const buf = Buffer.from(JSON.stringify(snapshot), 'utf8');
    await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { public_id: 'dinefy-db/snapshot', overwrite: true, resource_type: 'raw' },
        (err, result) => err ? reject(err) : resolve(result)
      ).end(buf);
    });
    console.log(`[Cloudinary] Snapshot saved — ${orders.length} orders, ${Math.round(buf.length / 1024)}KB`);
  } catch (e) {
    console.error('[Cloudinary] Backup failed:', e.message);
  }
}

async function restoreFromCloudinarySnapshot() {
  if (!process.env.CLOUDINARY_CLOUD_NAME) return;
  try {
    const resource = await cloudinary.api.resource('dinefy-db/snapshot', { resource_type: 'raw' });
    const raw = await new Promise((resolve, reject) => {
      const _https = require('https');
      _https.get(resource.secure_url, res => {
        let buf = '';
        res.on('data', d => buf += d);
        res.on('end', () => resolve(buf));
        res.on('error', reject);
      }).on('error', reject);
    });
    const snap = JSON.parse(raw);
    if (!snap || snap.v !== 2) { console.log('[Cloudinary] Snapshot version mismatch, skipping'); return; }

    let restoredOrders = 0;
    // Restore orders not already in memory/DB
    (snap.orders || []).forEach(order => {
      if (!orders.find(o => o.id === order.id)) {
        if (order.items) order.items = order.items.map(i => ({ ...i, quantity: i.quantity ?? i.qty }));
        orders.push(order);
        _insertOrder.run(order.id, order.tableNo, order.status, order.paymentStatus,
          order.createdAt, order.updatedAt, order.paidAt || null, JSON.stringify(order));
        restoredOrders++;
      }
    });

    // Restore counters
    if ((snap.orderCounter || 0) > orderCounter) {
      orderCounter = snap.orderCounter;
      _upsertCounter.run(String(orderCounter));
    }
    if ((snap.invoiceCounter || 0) > invoiceCounter) {
      invoiceCounter = snap.invoiceCounter;
      db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES ('invoiceCounter', ?)").run(String(invoiceCounter));
    }

    // Restore menu state (images, stock, offers)
    (snap.menuState || []).forEach(row => {
      try {
        db.prepare('INSERT OR REPLACE INTO menu_state (id, inStock, offer, image, stockCount, popular) VALUES (?, ?, ?, ?, ?, ?)').run(
          row.id, row.inStock ?? 1, row.offer ?? 0, row.image ?? null, row.stockCount ?? null, row.popular ?? null
        );
        const item = MENU.find(m => m.id === row.id);
        if (item) {
          item.inStock = !!row.inStock; item.offer = row.offer || 0;
          item.image = row.image || null; item.stockCount = row.stockCount ?? null;
          if (row.popular != null) item.popular = !!row.popular;
        }
      } catch (_) {}
    });

    // Restore custom menu items
    (snap.customItems || []).forEach(row => {
      try {
        db.prepare('INSERT OR IGNORE INTO custom_menu_items (id, data) VALUES (?, ?)').run(row.id, row.data);
        const item = JSON.parse(row.data);
        if (!MENU.find(m => m.id === item.id)) {
          item.inStock = true; item.offer = 0; item.stockCount = null; item.image = null;
          MENU.push(item);
        }
      } catch (_) {}
    });

    // Restore occupied tables from active orders
    orders.forEach(order => {
      if (!['completed', 'paid', 'cancelled'].includes(order.status) && order.tableNo && !occupiedTables[order.tableNo]) {
        occupiedTables[order.tableNo] = { customerName: order.customerName, orderId: order.id, since: order.createdAt };
      }
    });

    console.log(`[Cloudinary] Restored from snapshot: ${restoredOrders} orders, ${(snap.menuState||[]).length} menu states, ${(snap.customItems||[]).length} custom items`);

    // Push fresh state to any already-connected clients
    io.emit('menu:updated', { menu: MENU });
    io.emit('orders:restored', { orders });
  } catch (e) {
    if (e.http_code === 404 || (e.message || '').includes('404')) {
      console.log('[Cloudinary] No snapshot found — fresh start');
    } else {
      console.error('[Cloudinary] Restore failed:', e.message);
    }
  }
}

function dbSaveCounter() {
  _upsertCounter.run(String(orderCounter));
}

function getTablesStatus() {
  const ALL_TABLES = ['T1','T2','T3','T4','T5','T6','T7','T8','T9','T10'];
  return ALL_TABLES.map(tableId => {
    if (occupiedTables[tableId]) {
      return { tableId, occupied: true, customerName: occupiedTables[tableId].customerName, orderId: occupiedTables[tableId].orderId, since: occupiedTables[tableId].since };
    }
    // Reserve table if an active cart has items for this table
    const cart = Object.values(activeCarts).find(c => c.tableNo === tableId && (c.items || []).length > 0);
    if (cart) {
      return { tableId, occupied: true, sessionId: cart.sessionId, customerName: cart.customerName || '', orderId: null, since: cart.lastUpdate };
    }
    return { tableId, occupied: false, customerName: null, orderId: null, since: null };
  });
}

function broadcastTablesStatus() {
  io.emit('tables:status', { tables: getTablesStatus() });
}

// ─── Invoice Helpers ─────────────────────────────────────────────────────────
function getFinancialYear() {
  const istMs = Date.now() + (5.5 * 60 * 60 * 1000);
  const ist = new Date(istMs);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth() + 1;
  if (month >= 4) return `${String(year).slice(2)}${String(year + 1).slice(2)}`;
  return `${String(year - 1).slice(2)}${String(year).slice(2)}`;
}

function assignInvoiceNo(order) {
  invoiceCounter++;
  db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES ('invoiceCounter', ?)").run(String(invoiceCounter));
  order.invoiceNo = `${CONFIG.INVOICE_PREFIX}-${getFinancialYear()}-${String(invoiceCounter).padStart(4, '0')}`;
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
  const cgst  = round2(taxableAmount * 0.025);
  const sgst  = round2(taxableAmount * 0.025);
  const gst   = round2(cgst + sgst);   // kept for backward compat
  const total = round2(taxableAmount + gst);

  return {
    subtotal,
    discountPercent: safeDiscount,
    discountAmount,
    discountedSubtotal,
    serviceCharge,
    cgst,
    sgst,
    gst,
    gstRate: CONFIG.GST_RATE,
    total,
    itemCount: items.reduce((s, i) => s + Math.max(0, Math.floor(i.quantity)), 0),
  };
}

function round2(val) {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

function generateOrderId() {
  orderCounter++;
  dbSaveCounter();
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
        broadcastTablesStatus();
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
// POST — PIN sent in request body (never visible in URL or server logs)
app.post('/api/auth', authLimiter, (req, res) => {
  const { pin, role } = req.body;
  if (!pin || !role) return res.status(400).json({ success: false, error: 'Missing pin or role' });
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

// ── Demo Seed ─────────────────────────────────────────────────────────────────
// POST /api/demo-seed — inject a few realistic demo orders (dev/demo use only)
app.post('/api/demo-seed', (req, res) => {
  if (orders.length > 0) return res.json({ success: false, message: 'Orders already exist — clear first' });

  const now = Date.now();
  const seed = [
    {
      table: 'T2', name: 'Rahul Sharma', phone: '9876543210',
      items: [{ id: 'm4', qty: 1 }, { id: 'm13', qty: 2 }, { id: 'm20', qty: 1 }],
      status: 'completed', paymentStatus: 'paid', paymentMethod: 'cash', cashTendered: 1000,
      minsAgo: 45,
    },
    {
      table: 'T5', name: 'Priya Singh', phone: '9123456780',
      items: [{ id: 'm6', qty: 1 }, { id: 'm16', qty: 1 }, { id: 'm22', qty: 3 }],
      status: 'ready', paymentStatus: 'unpaid',
      minsAgo: 20,
    },
    {
      table: 'T3', name: 'Amit Kumar', phone: '9988776655',
      items: [{ id: 'm2', qty: 2 }, { id: 'm14', qty: 1 }],
      status: 'preparing', paymentStatus: 'unpaid',
      minsAgo: 10,
    },
    {
      table: 'T7', name: 'Sneha Patel', phone: '9871234560',
      items: [{ id: 'm8', qty: 1 }, { id: 'm19', qty: 2 }, { id: 'm23', qty: 1 }],
      status: 'pending', paymentStatus: 'unpaid',
      minsAgo: 2,
    },
  ];

  seed.forEach(s => {
    const items = s.items.map(si => {
      const m = MENU.find(x => x.id === si.id);
      if (!m) return null;
      return { id: m.id, name: m.name, nameHi: m.nameHi, emoji: m.emoji, price: m.price, category: m.category, quantity: si.qty };
    }).filter(Boolean);
    if (!items.length) return;

    const billing = calculateBill(items, { applyServiceCharge: true, discountPercent: 0 });
    const ts = new Date(now - s.minsAgo * 60 * 1000).toISOString();
    const orderId = `ORD-${++orderCounter}`;
    _upsertCounter.run(orderCounter);

    const order = {
      id: orderId,
      sessionId: 'demo-' + orderId,
      customerName: s.name,
      customerEmail: '',
      customerPhone: s.phone,
      tableNo: s.table,
      items,
      billing,
      status: s.status,
      paymentStatus: s.paymentStatus,
      paymentMethod: s.paymentMethod || null,
      cashTendered: s.cashTendered || null,
      change: s.cashTendered ? round2(s.cashTendered - billing.total) : null,
      paidAt: s.paymentStatus === 'paid' ? ts : null,
      createdAt: ts,
      updatedAt: ts,
      statusHistory: [{ status: 'pending', timestamp: ts }],
    };

    orders.push(order);
    dbSaveOrder(order);

    if (s.status !== 'completed' && s.status !== 'cancelled') {
      occupiedTables[s.table] = { customerName: s.name, orderId, since: ts };
    }
  });

  broadcastTablesStatus();
  io.emit('init', {
    orders,
    menu: MENU,
    activeCarts: {},
    tables: Object.keys(CONFIG).filter(k => k.startsWith('T')),
    config: {
      gstRate: CONFIG.GST_RATE, serviceChargeRate: CONFIG.SERVICE_CHARGE_RATE,
      maxDiscountPercent: CONFIG.MAX_DISCOUNT_PERCENT,
      upiVpa: CONFIG.UPI_VPA, upiName: CONFIG.UPI_NAME,
      shopName: CONFIG.SHOP_NAME, shopTagline: CONFIG.SHOP_TAGLINE, gstNo: CONFIG.GSTIN, gstin: CONFIG.GSTIN, sacCode: CONFIG.SAC_CODE, invoicePrefix: CONFIG.INVOICE_PREFIX,
    },
  });

  res.json({ success: true, seeded: seed.length, message: `${seed.length} demo orders created` });
});

app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    data: {
      gstRate: CONFIG.GST_RATE,
      serviceChargeRate: CONFIG.SERVICE_CHARGE_RATE,
      maxDiscountPercent: CONFIG.MAX_DISCOUNT_PERCENT,
      upiVpa: CONFIG.UPI_VPA,
      upiName: CONFIG.UPI_NAME,
      shopName: CONFIG.SHOP_NAME,
      shopTagline: CONFIG.SHOP_TAGLINE,
      gstNo: CONFIG.GSTIN, gstin: CONFIG.GSTIN, sacCode: CONFIG.SAC_CODE, invoicePrefix: CONFIG.INVOICE_PREFIX,
    },
  });
});

// ── Customer order history by phone ───────────────────────────────────────────
app.get('/api/customer/history', (req, res) => {
  const phone = (req.query.phone || '').replace(/\D/g, '');
  if (phone.length < 10) return res.json({ success: false, error: 'Invalid phone' });
  const rows = db.prepare(
    "SELECT data FROM orders WHERE json_extract(data, '$.customerPhone') = ? ORDER BY json_extract(data, '$.createdAt') DESC LIMIT 3"
  ).all(phone);
  res.json({ success: true, history: rows.map(r => JSON.parse(r.data)) });
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

// ── Contact Form Lead Capture ─────────────────────────────
app.post('/api/contact', (req, res) => {
  const { name, phone, restaurant, city, business_type, message } = req.body;
  if (!name || !phone || !restaurant) return res.status(400).json({ error: 'Missing required fields' });
  const created_at = new Date().toISOString();
  db.prepare(`INSERT INTO leads (name, phone, restaurant, city, business_type, message, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(name, phone, restaurant || '', city || '', business_type || '', message || '', created_at);
  res.json({ success: true });
});

// ── Leads Viewer ──────────────────────────────────────────
app.get('/leads', (req, res) => {
  // Basic Auth — password from LEADS_PASSWORD env variable
  const pwd = process.env.LEADS_PASSWORD;
  if (!pwd) return res.status(500).send('LEADS_PASSWORD env variable not set.');
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const pass = decoded.includes(':') ? decoded.split(':').slice(1).join(':') : decoded;
    if (pass === pwd) {
      // authenticated — fall through
    } else {
      res.setHeader('WWW-Authenticate', 'Basic realm="Dinefy Leads"');
      return res.status(401).send('Wrong password.');
    }
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Dinefy Leads"');
    return res.status(401).send('Authentication required.');
  }

  const rows = db.prepare('SELECT * FROM leads ORDER BY id DESC').all();
  const fmt = iso => {
    const d = new Date(iso);
    return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const rows_html = rows.length
    ? rows.map(r => `
      <tr>
        <td>${r.id}</td>
        <td><strong>${r.name}</strong></td>
        <td><a href="tel:${r.phone}">${r.phone}</a></td>
        <td>${r.restaurant}</td>
        <td>${r.city}</td>
        <td>${r.business_type}</td>
        <td style="color:#8a8580;font-size:12px">${r.message || '—'}</td>
        <td style="white-space:nowrap;font-size:12px">${fmt(r.created_at)}</td>
      </tr>`).join('')
    : '<tr><td colspan="8" style="text-align:center;color:#8a8580;padding:40px">No leads yet.</td></tr>';

  const csv = ['id,name,phone,restaurant,city,business_type,message,date',
    ...rows.map(r => [r.id, r.name, r.phone, r.restaurant, r.city, r.business_type, `"${(r.message||'').replace(/"/g,'""')}"`, r.created_at].join(','))
  ].join('\n');
  const csvB64 = Buffer.from(csv).toString('base64');

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<title>Dinefy — Leads</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d0d;color:#f0ede8;font-family:'DM Sans',sans-serif;padding:32px 5vw}
h1{font-family:'Playfair Display',serif;color:#c9a84c;font-size:28px;margin-bottom:6px}
.sub{color:#8a8580;font-size:14px;margin-bottom:28px}
.bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px}
.count{background:#1e1e1e;border:1px solid #2a2a2a;border-radius:20px;padding:4px 14px;font-size:13px;color:#c9a84c}
.dl{background:#c9a84c;color:#000;font-size:13px;font-weight:700;padding:8px 20px;border-radius:50px;text-decoration:none;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8a8580;border-bottom:1px solid #2a2a2a}
td{padding:11px 12px;border-bottom:1px solid #1e1e1e;vertical-align:top}
tr:hover td{background:#161616}
a{color:#c9a84c}
@media(max-width:700px){table,thead,tbody,th,td,tr{display:block}thead{display:none}td{padding:6px 0;border:none}td::before{content:attr(data-label);font-size:10px;color:#8a8580;display:block;margin-bottom:2px}tr{background:#161616;border:1px solid #2a2a2a;border-radius:10px;margin-bottom:10px;padding:12px 14px}}
</style>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=DM+Sans:wght@400;600&display=swap" rel="stylesheet"/>
</head><body>
<h1>Dinefy Leads</h1>
<p class="sub">Contact form submissions from /website_landing_page</p>
<div class="bar">
  <span class="count">${rows.length} lead${rows.length !== 1 ? 's' : ''}</span>
  <a class="dl" href="data:text/csv;base64,${csvB64}" download="dinefy-leads.csv">⬇ Download CSV</a>
</div>
<table>
<thead><tr><th>#</th><th>Name</th><th>Phone</th><th>Restaurant</th><th>City</th><th>Type</th><th>Message</th><th>Date</th></tr></thead>
<tbody>${rows_html}</tbody>
</table>
</body></html>`);
});

// ── App Routes ────────────────────────────────────────────
app.get('/customer', (req, res) => res.sendFile(path.join(__dirname, 'public/customer/index.html')));
app.get('/customer/', (req, res) => res.sendFile(path.join(__dirname, 'public/customer/index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));
app.get('/admin/', (req, res) => res.sendFile(path.join(__dirname, 'public/admin/index.html')));
app.get('/waiter', (req, res) => res.sendFile(path.join(__dirname, 'public/waiter/index.html')));
app.get('/waiter/', (req, res) => res.sendFile(path.join(__dirname, 'public/waiter/index.html')));
app.get('/website_landing_page', (req, res) => res.sendFile(path.join(__dirname, 'public/website_landing_page.html')));
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

// ─── Reports API ──────────────────────────────────────────────────────────────
app.get('/api/reports/daily', (req, res) => {
  const date = req.query.date || todayIST();
  res.json({ success: true, data: generateDailyReport(date) });
});

app.get('/api/reports/daily/pdf', async (req, res) => {
  const date = req.query.date || todayIST();
  try {
    const pdfBuffer = await generateReportPDF(generateDailyReport(date));
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="report-${date}.pdf"`,
      'Content-Length': pdfBuffer.length,
    });
    res.end(pdfBuffer);
  } catch (e) {
    console.error('[ReportPDF]', e);
    res.status(500).json({ success: false, error: 'Failed to generate PDF' });
  }
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
      upiVpa: CONFIG.UPI_VPA,
      upiName: CONFIG.UPI_NAME,
      shopName: CONFIG.SHOP_NAME,
      shopTagline: CONFIG.SHOP_TAGLINE,
      gstNo: CONFIG.GSTIN, gstin: CONFIG.GSTIN, sacCode: CONFIG.SAC_CODE, invoicePrefix: CONFIG.INVOICE_PREFIX,
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
    broadcastTablesStatus();

    if (typeof ack === 'function') ack({ success: true, billing });
  });

  // ── Place Order (Customer) ──
  socket.on('order:place', (data, ack) => {
    const { sessionId, items, customerName, customerEmail, customerPhone, tableNo, applyServiceCharge, discountPercent, eventId } = data;

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
      customerEmail: (customerEmail || '').trim(),
      customerPhone: (customerPhone || '').trim(),
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
    dbSaveOrder(order);

    // Mark table as occupied
    occupiedTables[order.tableNo] = {
      customerName: order.customerName,
      orderId: order.id,
      since: getTimestamp(),
    };
    broadcastTablesStatus();

    clearCartTimeout(sessionId);
    delete activeCarts[sessionId];

    // Decrement stock counts and auto-OOS when depleted
    const lowStockAlerts = [];
    let menuChanged = false;
    order.items.forEach(ordered => {
      const menuItem = MENU.find(m => m.id === ordered.id);
      if (menuItem && menuItem.stockCount !== null) {
        menuItem.stockCount = Math.max(0, menuItem.stockCount - ordered.quantity);
        if (menuItem.stockCount === 0) {
          menuItem.inStock = false;
          console.log(`[Stock] ${menuItem.name} depleted → OOS`);
        } else if (menuItem.stockCount < 3) {
          lowStockAlerts.push({ id: menuItem.id, name: menuItem.name, stockCount: menuItem.stockCount });
        }
        dbSaveMenuState(menuItem.id, menuItem.inStock, menuItem.offer, menuItem.image, menuItem.stockCount);
        menuChanged = true;
      }
    });
    if (menuChanged) io.emit('menu:updated', { menu: MENU });
    if (lowStockAlerts.length > 0) io.emit('menu:low_stock', { items: lowStockAlerts });

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
    if (status === 'preparing' && !order.prepStartedAt) order.prepStartedAt = getTimestamp();
    order.updatedAt = getTimestamp();
    order.statusHistory.push({ status, timestamp: getTimestamp() });
    dbUpdateOrder(order);

    // Auto-free table when order is completed or cancelled
    if (status === 'completed' || status === 'cancelled') {
      delete occupiedTables[order.tableNo];
      broadcastTablesStatus();
    }

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
    order.paymentMethod = 'cash';
    order.status = 'completed';
    order.paidAt = getTimestamp();
    order.cashTendered = round2(cash);
    order.change = change;
    order.updatedAt = getTimestamp();
    order.statusHistory.push({ status: 'paid', timestamp: getTimestamp() });
    assignInvoiceNo(order);
    dbUpdateOrder(order);

    // Free the table
    delete occupiedTables[order.tableNo];
    broadcastTablesStatus();

    io.emit('order:updated', order);
    io.emit('order:paid', { orderId, change, total: order.billing.total });

    if (typeof ack === 'function') ack({ success: true, order, change });

    console.log(`[Payment] Cash order paid: ${orderId}, Invoice: ${order.invoiceNo}, Change: ₹${change}`);
    emailReceipt(order);
  });

  // ── Update UPI Config (Admin) ──
  socket.on('config:update_upi', (data, ack) => {
    CONFIG.UPI_VPA  = (data.upiVpa  || '').trim();
    CONFIG.UPI_NAME = (data.upiName || 'Restaurant').trim();
    io.emit('config:updated', { upiVpa: CONFIG.UPI_VPA, upiName: CONFIG.UPI_NAME });
    if (typeof ack === 'function') ack({ success: true });
    console.log(`[Config] UPI updated: ${CONFIG.UPI_VPA}`);
  });

  // ── Update GST Config (Admin) ──
  socket.on('config:update_gst', (data, ack) => {
    CONFIG.GSTIN           = (data.gstin          || '').trim().toUpperCase();
    CONFIG.INVOICE_PREFIX  = (data.invoicePrefix  || 'FS').trim().toUpperCase();
    // Persist to DB so it survives restarts
    db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES ('gstin', ?)").run(CONFIG.GSTIN);
    db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES ('invoicePrefix', ?)").run(CONFIG.INVOICE_PREFIX);
    io.emit('config:updated', { gstin: CONFIG.GSTIN, invoicePrefix: CONFIG.INVOICE_PREFIX });
    if (typeof ack === 'function') ack({ success: true });
    console.log(`[Config] GST updated: GSTIN=${CONFIG.GSTIN}, Prefix=${CONFIG.INVOICE_PREFIX}`);
  });

  // ── Process UPI Payment (Admin) ──
  socket.on('order:payment-upi', (data, ack) => {
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

    if (order.paymentStatus === 'paid') {
      if (typeof ack === 'function') ack({ success: false, error: 'Order already paid' });
      return;
    }

    if (order.status !== 'completed' && order.status !== 'ready') {
      if (typeof ack === 'function') ack({ success: false, error: 'Order must be Ready or Completed before payment' });
      return;
    }

    order.paymentStatus = 'paid';
    order.status = 'completed';
    order.paidAt = getTimestamp();
    order.paymentMethod = 'upi';
    order.updatedAt = getTimestamp();
    order.statusHistory.push({ status: 'paid', timestamp: getTimestamp() });
    assignInvoiceNo(order);
    dbUpdateOrder(order);

    // Free the table
    delete occupiedTables[order.tableNo];
    broadcastTablesStatus();

    io.emit('order:updated', order);
    io.emit('order:paid', { orderId, change: 0, total: order.billing.total });

    if (typeof ack === 'function') ack({ success: true, order });

    console.log(`[Payment] UPI Order paid: ${orderId}`);
    emailReceipt(order);
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
    dbUpdateOrder(order);

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
    order.prepStartedAt = order.prepStartedAt || getTimestamp();
    order.updatedAt = getTimestamp();
    order.statusHistory.push({ status: 'preparing', timestamp: getTimestamp() });
    dbUpdateOrder(order);

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

    // Mark OOS items as out of stock across the whole menu
    (oosItemIds || []).forEach(id => {
      const menuItem = MENU.find(m => m.id === id);
      if (menuItem) { menuItem.inStock = false; dbSaveMenuState(id, false, menuItem.offer, menuItem.image, menuItem.stockCount); }
    });
    dbUpdateOrder(order);
    io.emit('menu:updated', { menu: MENU });

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
      order.prepStartedAt = order.prepStartedAt || getTimestamp();
      order.updatedAt = getTimestamp();
      order.statusHistory.push({ status: 'preparing', timestamp: getTimestamp() });
      dbUpdateOrder(order);
      io.emit('order:updated', order);
      if (typeof ack === 'function') ack({ success: true, order });
      console.log(`[Order] Review proceed: ${orderId} → preparing`);
    } else if (choice === 'cancel') {
      order.reviewResponse = 'cancel';
      order.status = 'cancelled';
      order.updatedAt = getTimestamp();
      order.statusHistory.push({ status: 'cancelled', timestamp: getTimestamp() });
      dbUpdateOrder(order);
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
      dbUpdateOrder(order);
      // Do NOT free the table — customer is reordering at same table
      io.emit('order:updated', order);
      if (typeof ack === 'function') ack({ success: true, order });
      console.log(`[Order] Review modify: ${orderId} → cancelled (table kept)`);
    } else {
      if (typeof ack === 'function') ack({ success: false, error: 'Invalid choice' });
    }
  });

  // ── Add Items to Existing Order (Customer) ──
  socket.on('order:add_items', (data, ack) => {
    const { orderId, items, eventId } = data;

    if (isDuplicate(eventId)) {
      if (typeof ack === 'function') ack({ success: true, duplicate: true });
      return;
    }

    if (!items || items.length === 0) {
      if (typeof ack === 'function') ack({ success: false, error: 'No items provided' });
      return;
    }

    const order = orders.find(o => o.id === orderId);
    if (!order) {
      if (typeof ack === 'function') ack({ success: false, error: 'Order not found' });
      return;
    }

    const allowedStatuses = ['pending', 'preparing'];
    if (!allowedStatuses.includes(order.status)) {
      if (typeof ack === 'function') ack({ success: false, error: 'Cannot add items at this stage' });
      return;
    }

    // Merge items: increase quantity if item already in order, else append
    // Also track in pendingKotItems so kitchen knows what's new
    if (!order.pendingKotItems) order.pendingKotItems = [];
    const addedAt = getTimestamp();

    items.forEach(newItem => {
      const qty = Math.max(1, Math.floor(newItem.quantity || 1));
      const menuItem = MENU.find(m => m.id === newItem.id);

      // Merge into main order items
      const existing = order.items.find(i => i.id === newItem.id);
      if (existing) {
        existing.quantity += qty;
      } else {
        order.items.push({
          id: newItem.id,
          name: newItem.name || (menuItem && menuItem.name) || newItem.id,
          nameHi: newItem.nameHi || (menuItem && menuItem.nameHi) || '',
          price: newItem.price || (menuItem && menuItem.price) || 0,
          emoji: newItem.emoji || (menuItem && menuItem.emoji) || '',
          quantity: qty,
          note: newItem.note || '',
          cookTime: newItem.cookTime || (menuItem && menuItem.cookTime) || 15,
        });
      }

      // Track in pendingKotItems (merge if same item added multiple times)
      const pendingExisting = order.pendingKotItems.find(i => i.id === newItem.id);
      if (pendingExisting) {
        pendingExisting.quantity += qty;
      } else {
        order.pendingKotItems.push({
          id: newItem.id,
          name: newItem.name || (menuItem && menuItem.name) || newItem.id,
          emoji: newItem.emoji || (menuItem && menuItem.emoji) || '',
          quantity: qty,
          note: newItem.note || '',
          addedAt,
        });
      }
    });

    // Recalculate billing (preserve existing discount/service charge settings)
    order.billing = calculateBill(order.items, {
      applyServiceCharge: order.billing.serviceCharge > 0,
      discountPercent: order.billing.discountPercent || 0,
    });
    order.updatedAt = getTimestamp();

    // Decrement stock for newly added items
    const lowStockAlerts = [];
    let menuChanged = false;
    items.forEach(added => {
      const menuItem = MENU.find(m => m.id === added.id);
      if (menuItem && menuItem.stockCount !== null) {
        const qty = Math.max(1, Math.floor(added.quantity || 1));
        menuItem.stockCount = Math.max(0, menuItem.stockCount - qty);
        if (menuItem.stockCount === 0) {
          menuItem.inStock = false;
          console.log(`[Stock] ${menuItem.name} depleted → OOS`);
        } else if (menuItem.stockCount < 3) {
          lowStockAlerts.push({ id: menuItem.id, name: menuItem.name, stockCount: menuItem.stockCount });
        }
        dbSaveMenuState(menuItem.id, menuItem.inStock, menuItem.offer, menuItem.image, menuItem.stockCount);
        menuChanged = true;
      }
    });
    if (menuChanged) io.emit('menu:updated', { menu: MENU });
    if (lowStockAlerts.length > 0) io.emit('menu:low_stock', { items: lowStockAlerts });

    dbUpdateOrder(order);
    io.emit('order:updated', order);
    if (typeof ack === 'function') ack({ success: true, order });
    console.log(`[Order] Items added to ${orderId}: ${items.map(i => i.name).join(', ')}`);
  });

  // ── Clear Pending KOT Items (Admin prints add-on KOT) ──
  socket.on('order:addon_kot_cleared', (data, ack) => {
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

    order.pendingKotItems = [];
    order.updatedAt = getTimestamp();
    dbUpdateOrder(order);
    io.emit('order:updated', order);
    if (typeof ack === 'function') ack({ success: true, order });
    console.log(`[Order] Add-on KOT cleared for ${orderId}`);
  });

  // ── Manual Table Free (Admin) ──
  socket.on('table:free', (data, ack) => {
    const { tableId } = data;
    if (!tableId) {
      if (typeof ack === 'function') ack({ success: false, error: 'Missing tableId' });
      return;
    }
    delete occupiedTables[tableId];
    // Also clear any active carts for this table
    Object.keys(activeCarts).forEach(sid => {
      if (activeCarts[sid].tableNo === tableId) {
        clearCartTimeout(sid);
        delete activeCarts[sid];
      }
    });
    io.emit('admin:cart_update', { activeCarts: getPublicCarts() });
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
    dbSaveMenuState(item.id, item.inStock, item.offer, item.image, item.stockCount);
    io.emit('menu:updated', { menu: MENU });
    if (typeof ack === 'function') ack({ success: true });
    console.log(`[Menu] ${item.name} → ${inStock ? 'In Stock' : 'Out of Stock'}`);
  });

  socket.on('menu:set_offer', (data, ack) => {
    const { itemId, offerPercent } = data;
    const item = MENU.find(m => m.id === itemId);
    if (!item) { if (typeof ack === 'function') ack({ success: false, error: 'Item not found' }); return; }
    item.offer = Math.min(Math.max(0, parseFloat(offerPercent) || 0), 50);
    dbSaveMenuState(item.id, item.inStock, item.offer, item.image, item.stockCount);
    io.emit('menu:updated', { menu: MENU });
    if (typeof ack === 'function') ack({ success: true });
    console.log(`[Menu] ${item.name} → offer: ${item.offer}%`);
  });

  // ── Stock Count Management ──
  socket.on('menu:set_stock', (data, ack) => {
    const { itemId, stockCount } = data;
    const item = MENU.find(m => m.id === itemId);
    if (!item) { if (typeof ack === 'function') ack({ success: false, error: 'Item not found' }); return; }
    const count = parseInt(stockCount, 10);
    item.stockCount = isNaN(count) || count < 0 ? null : count;
    if (item.stockCount === 0) item.inStock = false;
    else if (item.stockCount > 0) item.inStock = true;
    dbSaveMenuState(item.id, item.inStock, item.offer, item.image, item.stockCount);
    io.emit('menu:updated', { menu: MENU });
    if (typeof ack === 'function') ack({ success: true });
    console.log(`[Menu] ${item.name} → stockCount: ${item.stockCount}`);
  });

  socket.on('menu:set_popular', (data, ack) => {
    const { itemId, popular } = data;
    const item = MENU.find(m => m.id === itemId);
    if (!item) { if (typeof ack === 'function') ack({ success: false, error: 'Item not found' }); return; }
    item.popular = !!popular;
    dbSaveMenuState(item.id, item.inStock, item.offer, item.image, item.stockCount, item.popular);
    io.emit('menu:updated', { menu: MENU });
    if (typeof ack === 'function') ack({ success: true });
  });

  socket.on('menu:reset_stock', (data, ack) => {
    // Reset all items: clear stockCount (unlimited), restore inStock=true
    MENU.forEach(item => {
      item.stockCount = null;
      item.inStock = true;
      dbSaveMenuState(item.id, item.inStock, item.offer, item.image, item.stockCount);
    });
    io.emit('menu:updated', { menu: MENU });
    if (typeof ack === 'function') ack({ success: true });
    console.log('[Menu] All stock counts reset to unlimited');
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


// ─── Menu Image Upload ────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Images only'));
  },
});

app.post('/api/admin/menu/:id/image', upload.single('image'), async (req, res) => {
  const item = MENU.find(m => m.id === req.params.id);
  if (!item) return res.json({ success: false, error: 'Item not found' });
  if (!req.file) return res.json({ success: false, error: 'No file uploaded' });

  try {
    const resizedBuffer = await sharp(req.file.buffer)
      .resize(600, 400, { fit: 'cover' })
      .jpeg({ quality: 82 })
      .toBuffer();

    // Try Cloudinary first, fall back to local storage
    if (process.env.CLOUDINARY_CLOUD_NAME) {
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { public_id: `dinefy-menu/${req.params.id}`, overwrite: true, resource_type: 'image' },
          (err, result) => err ? reject(err) : resolve(result)
        ).end(resizedBuffer);
      });
      item.image = result.secure_url;
    } else {
      // Local storage fallback
      const filename = `${req.params.id}.jpg`;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), resizedBuffer);
      item.image = `/uploads/menu/${filename}`;
    }

    dbSaveMenuState(item.id, item.inStock, item.offer, item.image, item.stockCount);
    io.emit('menu:updated', { menu: MENU });
    res.json({ success: true, imageUrl: item.image });
  } catch (e) {
    console.error('Image upload error:', e);
    res.json({ success: false, error: 'Upload failed' });
  }
});

// ─── Set Menu Image from URL (for seeding) ──────────────────────────────────
app.post('/api/admin/menu/:id/image-url', express.json(), async (req, res) => {
  const item = MENU.find(m => m.id === req.params.id);
  if (!item) return res.json({ success: false, error: 'Item not found' });
  const { url } = req.body;
  if (!url) return res.json({ success: false, error: 'No URL provided' });

  try {
    // Fetch image from URL (follows redirects across http/https)
    const _https = require('https');
    const _http  = require('http');

    const imageBuffer = await new Promise((resolve, reject) => {
      const request = (fetchUrl, redirectCount = 0) => {
        if (redirectCount > 10) return reject(new Error('Too many redirects'));
        const mod = fetchUrl.startsWith('https') ? _https : _http;
        mod.get(fetchUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            let loc = response.headers.location;
            // Handle relative redirects
            if (loc.startsWith('/')) {
              const u = new URL(fetchUrl);
              loc = u.origin + loc;
            }
            return request(loc, redirectCount + 1);
          }
          if (response.statusCode !== 200) {
            return reject(new Error(`HTTP ${response.statusCode}`));
          }
          const chunks = [];
          response.on('data', c => chunks.push(c));
          response.on('end', () => resolve(Buffer.concat(chunks)));
          response.on('error', reject);
        }).on('error', reject);
      };
      request(url);
    });

    const resizedBuffer = await sharp(imageBuffer)
      .resize(600, 400, { fit: 'cover' })
      .jpeg({ quality: 82 })
      .toBuffer();

    const filename = `${req.params.id}.jpg`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), resizedBuffer);
    item.image = `/uploads/menu/${filename}`;

    dbSaveMenuState(item.id, item.inStock, item.offer, item.image, item.stockCount);
    res.json({ success: true, imageUrl: item.image });
  } catch (e) {
    console.error(`Image URL fetch error for ${req.params.id}:`, e.message);
    res.json({ success: false, error: 'Failed to fetch image: ' + e.message });
  }
});

app.delete('/api/admin/menu/:id/image', async (req, res) => {
  const item = MENU.find(m => m.id === req.params.id);
  if (!item) return res.json({ success: false, error: 'Item not found' });

  if (process.env.CLOUDINARY_CLOUD_NAME) {
    try { await cloudinary.uploader.destroy(`dinefy-menu/${req.params.id}`); } catch (_) {}
  } else {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, `${req.params.id}.jpg`)); } catch (_) {}
  }

  item.image = null;
  dbSaveMenuState(item.id, item.inStock, item.offer, null, item.stockCount);
  io.emit('menu:updated', { menu: MENU });
  res.json({ success: true });
});

// ─── Custom Menu Items CRUD ───────────────────────────────────────────────────
const _customItemRow = db.prepare("SELECT MAX(CAST(SUBSTR(id,4) AS INTEGER)) as mx FROM custom_menu_items WHERE id LIKE 'cx_%'").get();
let customItemCounter = (_customItemRow && _customItemRow.mx) ? _customItemRow.mx : 0;

app.post('/api/admin/menu/items', express.json(), (req, res) => {
  const { name, nameHi, category, price, emoji, tags, popular } = req.body;
  if (!name || !String(name).trim()) return res.json({ success: false, error: 'Name is required' });
  if (!category || !String(category).trim()) return res.json({ success: false, error: 'Category is required' });
  if (!price || isNaN(parseFloat(price)) || parseFloat(price) <= 0) return res.json({ success: false, error: 'Valid price is required' });

  customItemCounter++;
  const id = `cx_${customItemCounter}`;
  const item = {
    id, custom: true,
    name: String(name).trim(),
    nameHi: String(nameHi || name).trim(),
    category: String(category).trim(),
    categoryHi: String(category).trim(),
    price: parseFloat(price),
    emoji: emoji || '🍽️',
    popular: !!popular,
    tags: Array.isArray(tags) ? tags : ['veg'],
    inStock: true, offer: 0, cookTime: 15, stockCount: null, image: null,
  };
  MENU.push(item);
  db.prepare('INSERT INTO custom_menu_items (id, data) VALUES (?, ?)').run(id, JSON.stringify(item));
  dbSaveMenuState(id, true, 0, null, null, item.popular);
  io.emit('menu:updated', { menu: MENU });
  scheduleCloudinaryBackup();
  console.log(`[Menu] Custom item added: ${item.name} (${id})`);
  res.json({ success: true, item });
});

app.put('/api/admin/menu/items/:id', express.json(), (req, res) => {
  const item = MENU.find(m => m.id === req.params.id);
  if (!item) return res.json({ success: false, error: 'Item not found' });
  const { name, nameHi, category, price, emoji, tags, popular } = req.body;
  if (name !== undefined) { item.name = String(name).trim(); item.nameHi = String(nameHi || name).trim(); }
  if (category !== undefined) { item.category = String(category).trim(); item.categoryHi = String(category).trim(); }
  if (price !== undefined && !isNaN(parseFloat(price)) && parseFloat(price) > 0) item.price = parseFloat(price);
  if (emoji !== undefined) item.emoji = emoji || item.emoji;
  if (tags !== undefined && Array.isArray(tags)) item.tags = tags;
  if (popular !== undefined) item.popular = !!popular;
  if (item.custom) {
    db.prepare('INSERT OR REPLACE INTO custom_menu_items (id, data) VALUES (?, ?)').run(item.id, JSON.stringify(item));
  }
  dbSaveMenuState(item.id, item.inStock, item.offer, item.image, item.stockCount, item.popular);
  io.emit('menu:updated', { menu: MENU });
  console.log(`[Menu] Item updated: ${item.name} (${item.id})`);
  res.json({ success: true, item });
});

app.delete('/api/admin/menu/items/:id', (req, res) => {
  const idx = MENU.findIndex(m => m.id === req.params.id && m.custom);
  if (idx === -1) return res.json({ success: false, error: 'Item not found or cannot be deleted' });
  const [removed] = MENU.splice(idx, 1);
  db.prepare('DELETE FROM custom_menu_items WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM menu_state WHERE id=?').run(req.params.id);
  io.emit('menu:updated', { menu: MENU });
  scheduleCloudinaryBackup();
  console.log(`[Menu] Custom item deleted: ${removed.name} (${removed.id})`);
  res.json({ success: true });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
server.listen(CONFIG.PORT, () => {
  const networkUrl = `http://${LOCAL_IP}:${CONFIG.PORT}`;
  const publicBase = PUBLIC_URL || networkUrl;

  console.log(`\n⚡  Dinefy Server is running!\n`);
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

  // Restore DB from Cloudinary snapshot (handles Render ephemeral filesystem)
  restoreFromCloudinarySnapshot().catch(e => console.error('[Cloudinary] Startup restore error:', e.message));
});
