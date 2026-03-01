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
const path       = require('path');
const QRCode     = require('qrcode');
const os         = require('os');
const fs         = require('fs');
const PDFDocument = require('pdfkit');
const Database   = require('better-sqlite3');

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
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(30).text('ZingPOS', ML, 22);
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
       .text('Powered by ZingPOS', ML, y, { width: CW, align: 'center' });

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

  return { date: dateStr, summary, topItems, tableRevenue, hourlyOrders, paymentBreakdown: { cash: totalRevenue } };
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
    doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(28).text('ZingPOS', ML, 20);
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

    sumRow('Total Revenue',    rs(s.totalRevenue),    true, GOLD);
    sumRow('Total Orders',     String(s.ordersCount));
    sumRow('Paid Orders',      String(s.paidCount));
    sumRow('Avg Order Value',  rs(s.avgOrderValue));
    sumRow('GST Collected',    rs(s.totalGST));
    sumRow('Service Charge',   rs(s.totalServiceCharge));
    if (s.totalDiscount > 0) sumRow('Total Discounts', rs(s.totalDiscount));

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
       .text('ZingPOS — Automated Daily Sales Report', ML, y, { width: CW, align: 'center' });
    y += 13;
    doc.fillColor(GOLD).fontSize(8)
       .text('Powered by ZingPOS', ML, y, { width: CW, align: 'center' });

    doc.end();
  });
}

// ─── Menu Data ───────────────────────────────────────────────────────────────
const MENU = [
  // Starters — Chinese
  { id: 'm1',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Veg Spring Roll',          nameHi: 'वेज स्प्रिंग रोल',          price: 180, emoji: '🌯', popular: false, tags: ['guilt-free'],
    nutrition: { calories: 220, protein: 5,  carbs: 28, fat: 10, ingredients: ['Cabbage', 'Carrot', 'Bean Sprouts', 'Spring Onion', 'Flour Wrapper', 'Soy Sauce'] } },
  { id: 'm2',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Chilli Paneer (Dry)',       nameHi: 'चिली पनीर (ड्राई)',          price: 260, emoji: '🧀', popular: true,  tags: ['high-protein'],
    nutrition: { calories: 380, protein: 18, carbs: 22, fat: 22, ingredients: ['Paneer', 'Capsicum', 'Onion', 'Soy Sauce', 'Garlic', 'Cornstarch'] } },
  { id: 'm3',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Veg Manchurian (Dry)',      nameHi: 'वेज मंचूरियन (ड्राई)',       price: 220, emoji: '🥦', popular: false, tags: ['guilt-free'],
    nutrition: { calories: 280, protein: 7,  carbs: 32, fat: 13, ingredients: ['Mixed Vegetables', 'Garlic', 'Ginger', 'Soy Sauce', 'Chilli', 'Cornstarch'] } },
  { id: 'm4',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Chilli Chicken (Dry)',      nameHi: 'चिली चिकन (ड्राई)',          price: 280, emoji: '🍗', popular: true,  tags: ['high-protein'],
    nutrition: { calories: 360, protein: 28, carbs: 18, fat: 18, ingredients: ['Chicken', 'Capsicum', 'Onion', 'Soy Sauce', 'Garlic', 'Green Chilli'] } },
  { id: 'm5',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Chicken Manchurian (Dry)',  nameHi: 'चिकन मंचूरियन (ड्राई)',      price: 300, emoji: '🍜', popular: false, tags: ['high-protein'],
    nutrition: { calories: 340, protein: 26, carbs: 20, fat: 16, ingredients: ['Chicken', 'Garlic', 'Ginger', 'Soy Sauce', 'Spring Onion', 'Cornstarch'] } },
  // Starters — Tandoori
  { id: 'm6',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Paneer Tikka',              nameHi: 'पनीर टिक्का',                price: 280, emoji: '🍢', popular: true,  tags: ['high-protein', 'guilt-free'],
    nutrition: { calories: 320, protein: 20, carbs: 12, fat: 20, ingredients: ['Paneer', 'Bell Peppers', 'Onion', 'Yogurt', 'Tandoori Masala', 'Lemon'] } },
  { id: 'm7',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Tandoori Mushroom',         nameHi: 'तंदूरी मशरूम',               price: 250, emoji: '🍄', popular: false, tags: ['guilt-free'],
    nutrition: { calories: 180, protein: 8,  carbs: 14, fat: 10, ingredients: ['Mushroom', 'Yogurt', 'Tandoori Masala', 'Ginger', 'Garlic', 'Lemon'] } },
  { id: 'm8',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Tandoori Chicken (Half)',   nameHi: 'तंदूरी चिकन (हाफ)',          price: 340, emoji: '🍖', popular: true,  tags: ['high-protein', 'guilt-free'],
    nutrition: { calories: 420, protein: 45, carbs: 8,  fat: 20, ingredients: ['Chicken', 'Yogurt', 'Tandoori Masala', 'Ginger', 'Garlic', 'Chaat Masala'] } },
  { id: 'm9',  category: 'Starters',    categoryHi: 'स्टार्टर',      name: 'Chicken Tikka',             nameHi: 'चिकन टिक्का',                price: 320, emoji: '🥩', popular: false, tags: ['high-protein', 'guilt-free'],
    nutrition: { calories: 380, protein: 38, carbs: 10, fat: 18, ingredients: ['Chicken Breast', 'Yogurt', 'Tikka Masala', 'Ginger', 'Garlic', 'Lemon'] } },
  // Main Course — North Indian
  { id: 'm10', category: 'Main Course', categoryHi: 'मुख्य व्यंजन', name: 'Paneer Butter Masala',      nameHi: 'पनीर बटर मसाला',             price: 300, emoji: '🫕', popular: true,  tags: ['high-protein'],
    nutrition: { calories: 420, protein: 18, carbs: 24, fat: 28, ingredients: ['Paneer', 'Tomato', 'Butter', 'Cream', 'Cashew', 'Cardamom'] } },
  { id: 'm11', category: 'Main Course', categoryHi: 'मुख्य व्यंजन', name: 'Dal Makhani',               nameHi: 'दाल मखनी',                   price: 240, emoji: '🫘', popular: true,  tags: ['high-protein', 'guilt-free'],
    nutrition: { calories: 340, protein: 16, carbs: 38, fat: 14, ingredients: ['Black Lentils', 'Kidney Beans', 'Butter', 'Cream', 'Tomato', 'Garlic'] } },
  { id: 'm12', category: 'Main Course', categoryHi: 'मुख्य व्यंजन', name: 'Butter Chicken',            nameHi: 'बटर चिकन',                   price: 360, emoji: '🍛', popular: true,  tags: ['high-protein'],
    nutrition: { calories: 460, protein: 32, carbs: 22, fat: 26, ingredients: ['Chicken', 'Tomato', 'Butter', 'Cream', 'Cashew', 'Fenugreek'] } },
  { id: 'm13', category: 'Main Course', categoryHi: 'मुख्य व्यंजन', name: 'Mutton Rogan Josh',         nameHi: 'मटन रोगन जोश',               price: 420, emoji: '🥩', popular: false, tags: ['high-protein'],
    nutrition: { calories: 520, protein: 40, carbs: 12, fat: 32, ingredients: ['Mutton', 'Kashmiri Chilli', 'Fennel', 'Cardamom', 'Cinnamon', 'Yogurt'] } },
  // Main Course — Biryani
  { id: 'm14', category: 'Main Course', categoryHi: 'मुख्य व्यंजन', name: 'Veg Biryani',               nameHi: 'वेज बिरयानी',                price: 240, emoji: '🍱', popular: false, tags: ['guilt-free'],
    nutrition: { calories: 380, protein: 10, carbs: 58, fat: 12, ingredients: ['Basmati Rice', 'Mixed Vegetables', 'Saffron', 'Fried Onions', 'Whole Spices', 'Ghee'] } },
  { id: 'm15', category: 'Main Course', categoryHi: 'मुख्य व्यंजन', name: 'Chicken Biryani (Full)',    nameHi: 'चिकन बिरयानी (फुल)',         price: 340, emoji: '🍲', popular: true,  tags: ['high-protein'],
    nutrition: { calories: 560, protein: 38, carbs: 62, fat: 18, ingredients: ['Basmati Rice', 'Chicken', 'Saffron', 'Fried Onions', 'Yogurt', 'Whole Spices'] } },
  { id: 'm16', category: 'Main Course', categoryHi: 'मुख्य व्यंजन', name: 'Mutton Biryani',            nameHi: 'मटन बिरयानी',                price: 420, emoji: '🥘', popular: false, tags: ['high-protein'],
    nutrition: { calories: 620, protein: 40, carbs: 64, fat: 22, ingredients: ['Basmati Rice', 'Mutton', 'Saffron', 'Fried Onions', 'Whole Spices', 'Ghee'] } },
  // Breads
  { id: 'm17', category: 'Breads',      categoryHi: 'रोटी',          name: 'Tandoori Roti',             nameHi: 'तंदूरी रोटी',                price: 25,  emoji: '🫓', popular: false, tags: ['guilt-free'],
    nutrition: { calories: 80,  protein: 3,  carbs: 16, fat: 1,  ingredients: ['Whole Wheat Flour', 'Water', 'Salt'] } },
  { id: 'm18', category: 'Breads',      categoryHi: 'रोटी',          name: 'Butter Naan',               nameHi: 'बटर नान',                    price: 55,  emoji: '🧈', popular: true,  tags: [],
    nutrition: { calories: 180, protein: 5,  carbs: 28, fat: 6,  ingredients: ['Refined Flour', 'Butter', 'Yogurt', 'Yeast', 'Salt'] } },
  { id: 'm19', category: 'Breads',      categoryHi: 'रोटी',          name: 'Garlic Naan',               nameHi: 'लहसुन नान',                  price: 70,  emoji: '🧄', popular: false, tags: [],
    nutrition: { calories: 200, protein: 5,  carbs: 30, fat: 7,  ingredients: ['Refined Flour', 'Garlic', 'Butter', 'Yogurt', 'Coriander', 'Yeast'] } },
  // Beverages
  { id: 'm20', category: 'Beverages',   categoryHi: 'पेय',           name: 'Coke (300ml)',              nameHi: 'कोक (300मिली)',               price: 40,  emoji: '🥤', popular: false, tags: [],
    nutrition: { calories: 130, protein: 0,  carbs: 35, fat: 0,  ingredients: ['Carbonated Water', 'Sugar', 'Caramel Colour', 'Phosphoric Acid', 'Natural Flavours', 'Caffeine'] } },
  { id: 'm21', category: 'Beverages',   categoryHi: 'पेय',           name: 'Sprite (300ml)',            nameHi: 'स्प्राइट (300मिली)',          price: 40,  emoji: '🍋', popular: false, tags: [],
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
    offer REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Load persisted orderCounter
const counterRow = db.prepare("SELECT value FROM app_config WHERE key='orderCounter'").get();
if (counterRow) orderCounter = parseInt(counterRow.value, 10);
else db.prepare("INSERT INTO app_config (key, value) VALUES ('orderCounter', ?)").run(String(orderCounter));

// Load persisted orders
orders = db.prepare('SELECT data FROM orders').all().map(row => JSON.parse(row.data));

// Apply persisted menu state
db.prepare('SELECT id, inStock, offer FROM menu_state').all().forEach(row => {
  const item = MENU.find(m => m.id === row.id);
  if (item) { item.inStock = !!row.inStock; item.offer = row.offer; }
});

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
  'INSERT OR REPLACE INTO menu_state (id, inStock, offer) VALUES (?, ?, ?)'
);
const _upsertCounter = db.prepare(
  "INSERT OR REPLACE INTO app_config (key, value) VALUES ('orderCounter', ?)"
);

function dbSaveOrder(order) {
  _insertOrder.run(order.id, order.tableNo, order.status, order.paymentStatus,
    order.createdAt, order.updatedAt, order.paidAt || null, JSON.stringify(order));
}

function dbUpdateOrder(order) {
  _updateOrder.run(order.status, order.paymentStatus, order.updatedAt,
    order.paidAt || null, JSON.stringify(order), order.id);
}

function dbSaveMenuState(itemId, inStock, offer) {
  _upsertMenuState.run(itemId, inStock ? 1 : 0, offer);
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
    dbUpdateOrder(order);

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
    dbUpdateOrder(order);

    // Free the table
    delete occupiedTables[order.tableNo];
    broadcastTablesStatus();

    io.emit('order:updated', order);
    io.emit('order:paid', { orderId, change, total: order.billing.total });

    if (typeof ack === 'function') ack({ success: true, order, change });

    console.log(`[Payment] Order paid: ${orderId}, Change: ₹${change}`);
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
      if (menuItem) { menuItem.inStock = false; dbSaveMenuState(id, false, menuItem.offer); }
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
    dbSaveMenuState(item.id, item.inStock, item.offer);
    io.emit('menu:updated', { menu: MENU });
    if (typeof ack === 'function') ack({ success: true });
    console.log(`[Menu] ${item.name} → ${inStock ? 'In Stock' : 'Out of Stock'}`);
  });

  socket.on('menu:set_offer', (data, ack) => {
    const { itemId, offerPercent } = data;
    const item = MENU.find(m => m.id === itemId);
    if (!item) { if (typeof ack === 'function') ack({ success: false, error: 'Item not found' }); return; }
    item.offer = Math.min(Math.max(0, parseFloat(offerPercent) || 0), 50);
    dbSaveMenuState(item.id, item.inStock, item.offer);
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
