# RestaurantOS v2.0.0
### Production-Grade Real-Time Restaurant Ordering System

---

## Quick Start

```bash
npm install
npm start
```

Open:
- **Customer App**: http://localhost:3000/customer
- **Admin POS**: http://localhost:3000/admin

For development with auto-reload:
```bash
npm run dev
```

---

## Architecture

```
restaurantos/
├── server.js                  # Backend: Express + Socket.io
├── package.json
└── public/
    ├── customer/
    │   └── index.html         # Customer ordering interface
    └── admin/
        └── index.html         # Admin POS dashboard
```

---

## What's Production-Hardened

### Real-Time Stability
- Event deduplication via unique `eventId` per socket emission
- Socket acknowledgment callbacks on all mutations
- Automatic reconnect with exponential backoff
- Cart broadcast debouncing (400ms) prevents flooding
- Server-side duplicate prevention Set (30s TTL)

### Billing Engine
- Centralized `calculateBill()` on server — single source of truth
- Proper `round2()` using `Number.EPSILON` for float safety
- GST (8%), Service Charge (10%), Discount (max 30%) all configurable
- No negative discounts, no over-discounts, no negative quantities
- Payment blocked unless order is `ready` or `completed`
- Double-payment prevention

### Customer App
- Debounced cart broadcasting (400ms)
- Disabled "Place Order" button when cart empty
- Loading spinner + disabled state during submission
- Full form validation before submission
- Success overlay with auto-clear
- Error banners (not browser alerts)
- Real-time bill recalculation on every cart change
- Reconnect banner on socket disconnect

### Admin POS
- New order shake + glow animation
- Web Audio API notification sound (no file dependency)
- Sound toggle with persistent state
- Status transition buttons — only valid transitions enabled
- Live cart preview chips with 5-minute auto-expiry
- Revenue, order count, pending count auto-update
- Status filter tabs
- Discount editing from admin side
- Payment change calculation preview
- `timeAgo` auto-refresh every 30 seconds

### UI/UX
- 8px grid spacing system
- 44px minimum touch targets
- Status color coding: Pending→Orange, Preparing→Blue, Ready→Green, Completed→Grey, Paid→Teal
- Smooth animations (slide-in, bump, shake, fade)
- No horizontal overflow
- Tablet-optimized layouts (1280×800, 1920×1080)

---

## Config (server.js)

```js
const CONFIG = {
  GST_RATE: 0.08,              // 8%
  SERVICE_CHARGE_RATE: 0.10,   // 10%
  MAX_DISCOUNT_PERCENT: 30,    // 30% max
  CART_TIMEOUT_MS: 5 * 60000, // 5 minutes
  PORT: 3000,
};
```

---

## Socket Events Reference

| Event | Direction | Description |
|-------|-----------|-------------|
| `cart:update` | Client→Server | Broadcast cart state |
| `order:place` | Client→Server | Submit order |
| `order:status_update` | Admin→Server | Change order status |
| `order:payment` | Admin→Server | Process payment |
| `order:apply_discount` | Admin→Server | Apply/change discount |
| `order:new` | Server→All | New order notification |
| `order:updated` | Server→All | Order changed |
| `order:paid` | Server→All | Payment processed |
| `admin:cart_update` | Server→All | Cart sessions update |
| `cart:expired` | Server→All | Cart session timed out |
| `init` | Server→Client | Initial state sync |

---

*Powered by RestaurantOS — Seamless Dining Experience*
