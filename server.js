require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const path = require('path');
const { db, initDB } = require('./db/database');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'gaming-cafe-jwt-secret-dev-only';
const OWNER_EMAIL = 'rishiraj.thadeshwar@gmail.com';

// ── IST Helpers (UTC+5:30) ────────────────────────────────────────────────────
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function nowIST()   { return new Date(Date.now() + IST_OFFSET_MS); }
function todayIST() { return nowIST().toISOString().split('T')[0]; }

// ── Pricing & Menu ──────────────────────────────────────────────────────────
const PS5_RATES = {
  1: parseFloat(process.env.PS5_RATE_1) || 79,
  2: parseFloat(process.env.PS5_RATE_2) || 149,
  3: parseFloat(process.env.PS5_RATE_3) || 199,
  4: parseFloat(process.env.PS5_RATE_4) || 249,
};

const RATES = {
  PC:  parseFloat(process.env.PC_RATE) || 79,
  PS5: PS5_RATES[1], // default (1-player rate) for display
};

const MENU = {
  chips: [
    { name: 'Lays',    price: 30 },
    { name: 'Doritos', price: 40 },
  ],
  drinks: [
    { name: 'Water',    price: 20  },
    { name: 'Red Bull', price: 120 },
    { name: 'Monster',  price: 100 },
  ],
};

const MACHINES = [
  { id: 'PC1', type: 'PC',  name: 'PC 1' },
  { id: 'PC2', type: 'PC',  name: 'PC 2' },
  { id: 'PC3', type: 'PC',  name: 'PC 3' },
  { id: 'PC4', type: 'PC',  name: 'PC 4' },
  { id: 'PC5', type: 'PC',  name: 'PC 5' },
  { id: 'PC6', type: 'PC',  name: 'PC 6' },
  { id: 'PS1', type: 'PS5', name: 'PlayStation 1' },
  { id: 'PS2', type: 'PS5', name: 'PlayStation 2' },
];

// ── Email ────────────────────────────────────────────────────────────────────
// Supports:
//   - Gmail/Outlook/Yahoo/iCloud/Zoho  → set EMAIL_USER + EMAIL_PASS
//   - SendGrid (API key, no email needed) → set EMAIL_PASS=SG.xxx, EMAIL_FROM=you@domain.com
//   - Any SMTP provider               → set EMAIL_HOST + EMAIL_PORT + EMAIL_USER + EMAIL_PASS
let transporter = null;

if (process.env.EMAIL_PASS) {
  // SendGrid: EMAIL_USER is optional ("apikey" is the fixed username)
  const isSendGrid = process.env.EMAIL_PASS.startsWith('SG.');

  if (isSendGrid) {
    transporter = nodemailer.createTransport({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: { user: 'apikey', pass: process.env.EMAIL_PASS },
    });
    console.log('[EMAIL] Using SendGrid');
  } else if (process.env.EMAIL_HOST) {
    // Custom SMTP
    transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT) || 587,
      secure: process.env.EMAIL_SECURE === 'true',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
    console.log(`[EMAIL] Using custom SMTP: ${process.env.EMAIL_HOST}`);
  } else if (process.env.EMAIL_USER) {
    // Auto-detect provider from email domain
    const service = detectEmailService(process.env.EMAIL_USER);
    if (service) {
      transporter = nodemailer.createTransport({
        service,
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      });
      console.log(`[EMAIL] Using ${service}`);
    } else {
      console.warn(`\n[EMAIL] Domain not recognized for: ${process.env.EMAIL_USER}`);
      console.warn('[EMAIL] Add EMAIL_HOST=smtp.yourprovider.com to .env');
      console.warn('[EMAIL] OTPs will print to console instead.\n');
    }
  }
}

function detectEmailService(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  const serviceMap = {
    'gmail.com':      'gmail',
    'googlemail.com': 'gmail',
    'outlook.com':    'hotmail',
    'hotmail.com':    'hotmail',
    'live.com':       'hotmail',
    'yahoo.com':      'yahoo',
    'yahoo.in':       'yahoo',
    'icloud.com':     'iCloud',
    'me.com':         'iCloud',
    'zoho.com':       'Zoho',
  };
  return serviceMap[domain] || null;
}

async function sendOTPEmail(otp, username, role) {
  if (!transporter) {
    console.log(`\n[DEV] OTP for "${username}" (${role}): ${otp}\n`);
    return;
  }
  await transporter.sendMail({
    from: `"The Site Gaming" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
    to: OWNER_EMAIL,
    subject: `New Staff Registration Request – ${username}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;background:#0d0d0d;color:#fff;padding:32px;border-radius:12px;">
        <h2 style="color:#A6FF00;margin:0 0 16px;">New Registration Request</h2>
        <p>Someone wants to create a <strong>${role}</strong> account:</p>
        <table style="width:100%;margin:16px 0;">
          <tr><td style="color:#888;">Username</td><td><strong>${username}</strong></td></tr>
          <tr><td style="color:#888;">Role</td><td><strong>${role}</strong></td></tr>
        </table>
        <div style="background:#1a1a1a;border:2px solid #A6FF00;border-radius:8px;padding:20px;text-align:center;margin:20px 0;">
          <p style="margin:0;color:#888;font-size:12px;">APPROVAL OTP</p>
          <p style="margin:8px 0;font-size:36px;letter-spacing:8px;color:#A6FF00;font-weight:700;">${otp}</p>
          <p style="margin:0;color:#888;font-size:12px;">Expires in 10 minutes</p>
        </div>
        <p style="color:#888;font-size:13px;">Share this OTP with the person only if you approve this registration.</p>
      </div>
    `,
  });
}

// ── Daily Report ─────────────────────────────────────────────────────────────
const CAFE_EMAIL = [
  'rishiraj.thadeshwar@gmail.com',
  'sandeepdevanpalli44@gmail.com',
  'jaygori12@gmail.com',
];

function getDailyReportData(dateStr) {
  const sessions = db.prepare(`
    SELECT
      s.id, s.machine_id, s.machine_type, s.customer_name,
      s.players, s.start_time, s.end_time, s.status,
      s.planned_hours, s.rate_per_hour, s.free_half_hour,
      (SELECT json_group_array(json_object(
        'item_name', o.item_name, 'item_type', o.item_type,
        'quantity',  o.quantity,  'unit_price', o.unit_price
      )) FROM orders o WHERE o.session_id = s.id) AS orders_json
    FROM sessions s
    WHERE date(datetime(s.start_time, '+5 hours', '30 minutes')) = ?
    ORDER BY s.machine_id, s.start_time
  `).all(dateStr);

  sessions.forEach(s => {
    try { s.orders = JSON.parse(s.orders_json || '[]').filter(o => o.item_name); }
    catch { s.orders = []; }
    delete s.orders_json;

    const startMs = new Date(s.start_time).getTime();
    const endMs   = s.end_time
      ? new Date(s.end_time).getTime()
      : startMs + s.planned_hours * 3600000;

    s.billable_hours   = s.planned_hours;
    s.discount_pct     = s.billable_hours >= 3 ? 10 : 0;
    const freeHalfCredit = s.free_half_hour ? s.rate_per_hour * 0.5 : 0;
    s.session_cost     = Math.max(0, s.billable_hours * s.rate_per_hour * (1 - s.discount_pct / 100) - freeHalfCredit);
    s.order_total      = s.orders.reduce((t, o) => t + o.quantity * o.unit_price, 0);
    s.grand_total      = s.session_cost + s.order_total;
    s.end_display      = s.end_time || new Date(endMs).toISOString();
  });

  return sessions;
}

function fmtTime(isoString) {
  return new Date(isoString).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  });
}

function buildDailyReportHtml(dateStr, sessions) {
  const totalRevenue      = sessions.reduce((t, s) => t + s.grand_total,   0);
  const totalOrderRevenue = sessions.reduce((t, s) => t + s.order_total,   0);
  const totalGaming       = totalRevenue - totalOrderRevenue;
  const machinesUsed      = [...new Set(sessions.map(s => s.machine_id))].length;

  const displayDate = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata',
  });

  // Group by machine
  const groups = {};
  for (const m of MACHINES) groups[m.id] = { machine: m, sessions: [] };
  for (const s of sessions)  groups[s.machine_id]?.sessions.push(s);

  const machineBlocks = Object.values(groups)
    .filter(g => g.sessions.length > 0)
    .map(g => {
      const machineTotal = g.sessions.reduce((t, s) => t + s.grand_total, 0);
      const isPS = g.machine.type === 'PS5';
      const accentColor = isPS ? '#8B1EFF' : '#A6FF00';

      const sessionRows = g.sessions.map(s => {
        const customer = s.customer_name || 'Walk-in';
        const statusTag = s.status === 'active'
          ? '<span style="color:#ffaa00;font-size:10px;margin-left:4px;">(active)</span>'
          : '';

        const orderRows = s.orders.map(o => `
          <tr>
            <td style="padding:3px 8px 3px 24px;color:#666;font-size:11px;" colspan="2">↳ ${o.item_name} × ${o.quantity}</td>
            <td style="padding:3px 8px;color:#666;font-size:11px;text-align:right;">₹${(o.quantity * o.unit_price).toFixed(0)}</td>
            <td style="padding:3px 8px;color:#666;font-size:11px;text-align:right;"></td>
            <td style="padding:3px 8px;color:#666;font-size:11px;text-align:right;"></td>
          </tr>`).join('');

        return `
          <tr style="border-top:1px solid #222;">
            <td style="padding:9px 8px;color:#ccc;font-size:12px;">${customer}${s.players > 1 ? ` <span style="color:#666;">(${s.players}P)</span>` : ''}${statusTag}</td>
            <td style="padding:9px 8px;color:#666;font-size:11px;white-space:nowrap;">${fmtTime(s.start_time)} – ${fmtTime(s.end_display)}</td>
            <td style="padding:9px 8px;color:#aaa;font-size:11px;text-align:right;white-space:nowrap;">${s.billable_hours}h × ₹${s.rate_per_hour}${s.discount_pct > 0 ? ` <span style="color:#ffaa00;font-size:10px;">-${s.discount_pct}%</span>` : ''}${s.free_half_hour ? ` <span style="color:#ffaa00;font-size:10px;">-½hr free</span>` : ''}</td>
            <td style="padding:9px 8px;color:#A6FF00;font-size:12px;text-align:right;">₹${s.session_cost.toFixed(0)}</td>
            <td style="padding:9px 8px;color:${s.order_total > 0 ? '#bb88ff' : '#444'};font-size:12px;text-align:right;">₹${s.order_total.toFixed(0)}</td>
            <td style="padding:9px 8px;color:#fff;font-weight:700;font-size:12px;text-align:right;">₹${s.grand_total.toFixed(0)}</td>
          </tr>
          ${orderRows}`;
      }).join('');

      return `
        <tr>
          <td colspan="6" style="padding:12px 8px 4px;background:#0f0f0f;">
            <span style="color:${accentColor};font-weight:700;font-size:13px;">${g.machine.name}</span>
            <span style="color:#444;font-size:11px;margin-left:8px;">${g.sessions.length} session${g.sessions.length > 1 ? 's' : ''} · ₹${machineTotal.toFixed(0)}</span>
          </td>
        </tr>
        ${sessionRows}`;
    }).join('');

  const noSessions = sessions.length === 0 ? `
    <tr><td colspan="6" style="padding:40px;text-align:center;color:#444;font-size:13px;">No sessions recorded.</td></tr>` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:680px;margin:0 auto;padding:28px 12px;">

  <!-- Header -->
  <div style="text-align:center;margin-bottom:28px;">
    <div style="font-size:26px;font-weight:900;color:#A6FF00;letter-spacing:3px;">THE SITE</div>
    <div style="color:#555;font-size:12px;margin-top:2px;letter-spacing:1px;">GAMING CAFE · DAILY REPORT</div>
    <div style="color:#ddd;font-size:15px;font-weight:600;margin-top:10px;">${displayDate}</div>
  </div>

  <!-- Summary Cards -->
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
    <tr>
      <td width="33%" style="padding:4px;">
        <div style="background:#161616;border:1px solid #222;border-radius:10px;padding:16px;text-align:center;">
          <div style="color:#444;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;">Sessions</div>
          <div style="color:#fff;font-size:30px;font-weight:800;margin-top:6px;">${sessions.length}</div>
        </div>
      </td>
      <td width="33%" style="padding:4px;">
        <div style="background:#161616;border:1px solid #222;border-radius:10px;padding:16px;text-align:center;">
          <div style="color:#444;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;">Revenue</div>
          <div style="color:#A6FF00;font-size:30px;font-weight:800;margin-top:6px;">₹${Math.round(totalRevenue).toLocaleString('en-IN')}</div>
        </div>
      </td>
      <td width="33%" style="padding:4px;">
        <div style="background:#161616;border:1px solid #222;border-radius:10px;padding:16px;text-align:center;">
          <div style="color:#444;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;">Machines</div>
          <div style="color:#fff;font-size:30px;font-weight:800;margin-top:6px;">${machinesUsed}<span style="font-size:14px;color:#444;">/8</span></div>
        </div>
      </td>
    </tr>
  </table>

  <!-- Revenue Breakdown -->
  <div style="background:#161616;border:1px solid #222;border-radius:10px;padding:14px 18px;margin-bottom:20px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="color:#888;font-size:12px;padding:4px 0;">Gaming</td>
        <td style="color:#A6FF00;font-size:12px;font-weight:600;text-align:right;padding:4px 0;">₹${Math.round(totalGaming).toLocaleString('en-IN')}</td>
      </tr>
      <tr>
        <td style="color:#888;font-size:12px;padding:4px 0;">Food &amp; Drinks</td>
        <td style="color:#bb88ff;font-size:12px;font-weight:600;text-align:right;padding:4px 0;">₹${Math.round(totalOrderRevenue).toLocaleString('en-IN')}</td>
      </tr>
      <tr><td colspan="2" style="border-top:1px solid #222;padding:0;height:8px;"></td></tr>
      <tr>
        <td style="color:#fff;font-size:13px;font-weight:700;padding:4px 0;">Grand Total</td>
        <td style="color:#fff;font-size:13px;font-weight:700;text-align:right;padding:4px 0;">₹${Math.round(totalRevenue).toLocaleString('en-IN')}</td>
      </tr>
    </table>
  </div>

  <!-- Sessions Table -->
  <div style="background:#161616;border:1px solid #222;border-radius:10px;overflow:hidden;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <thead>
        <tr style="background:#0f0f0f;">
          <th style="padding:10px 8px;color:#444;font-size:10px;letter-spacing:1px;text-align:left;font-weight:600;">CUSTOMER</th>
          <th style="padding:10px 8px;color:#444;font-size:10px;letter-spacing:1px;text-align:left;font-weight:600;">TIME</th>
          <th style="padding:10px 8px;color:#444;font-size:10px;letter-spacing:1px;text-align:right;font-weight:600;">HRS · RATE</th>
          <th style="padding:10px 8px;color:#444;font-size:10px;letter-spacing:1px;text-align:right;font-weight:600;">GAMING</th>
          <th style="padding:10px 8px;color:#444;font-size:10px;letter-spacing:1px;text-align:right;font-weight:600;">F&amp;D</th>
          <th style="padding:10px 8px;color:#444;font-size:10px;letter-spacing:1px;text-align:right;font-weight:600;">TOTAL</th>
        </tr>
      </thead>
      <tbody>
        ${noSessions}
        ${machineBlocks}
      </tbody>
      <tfoot>
        <tr style="background:#0f0f0f;border-top:2px solid #222;">
          <td colspan="3" style="padding:12px 8px;color:#555;font-size:11px;">${sessions.length} sessions · ${machinesUsed} machine${machinesUsed !== 1 ? 's' : ''}</td>
          <td style="padding:12px 8px;color:#A6FF00;font-weight:700;font-size:12px;text-align:right;">₹${Math.round(totalGaming).toLocaleString('en-IN')}</td>
          <td style="padding:12px 8px;color:#bb88ff;font-weight:700;font-size:12px;text-align:right;">₹${Math.round(totalOrderRevenue).toLocaleString('en-IN')}</td>
          <td style="padding:12px 8px;color:#fff;font-weight:800;font-size:13px;text-align:right;">₹${Math.round(totalRevenue).toLocaleString('en-IN')}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <!-- Edible Sales Summary -->
  ${(() => {
    const itemTotals = {};
    sessions.forEach(s => {
      (s.orders || []).forEach(o => {
        if (!itemTotals[o.item_name]) itemTotals[o.item_name] = { qty: 0, revenue: 0, type: o.item_type };
        itemTotals[o.item_name].qty     += o.quantity;
        itemTotals[o.item_name].revenue += o.quantity * o.unit_price;
      });
    });
    const items = Object.entries(itemTotals);
    if (!items.length) return '';

    const rows = items.map(([name, data]) => `
      <tr style="border-top:1px solid #222;">
        <td style="padding:8px;color:#ccc;font-size:12px;">${name}</td>
        <td style="padding:8px;color:#555;font-size:11px;text-align:center;">${data.type === 'chips' ? '🍟 Chips' : '🥤 Drink'}</td>
        <td style="padding:8px;color:#aaa;font-size:12px;text-align:center;">${data.qty}</td>
        <td style="padding:8px;color:#bb88ff;font-size:12px;text-align:right;font-weight:600;">₹${data.revenue.toFixed(0)}</td>
      </tr>`).join('');

    return `
    <div style="background:#161616;border:1px solid #222;border-radius:10px;overflow:hidden;margin-top:20px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <thead>
          <tr style="background:#0f0f0f;">
            <th style="padding:10px 8px;color:#444;font-size:10px;letter-spacing:1px;text-align:left;font-weight:600;">ITEM</th>
            <th style="padding:10px 8px;color:#444;font-size:10px;letter-spacing:1px;text-align:center;font-weight:600;">TYPE</th>
            <th style="padding:10px 8px;color:#444;font-size:10px;letter-spacing:1px;text-align:center;font-weight:600;">QTY SOLD</th>
            <th style="padding:10px 8px;color:#444;font-size:10px;letter-spacing:1px;text-align:right;font-weight:600;">REVENUE</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr style="background:#0f0f0f;border-top:2px solid #222;">
            <td colspan="2" style="padding:10px 8px;color:#555;font-size:11px;">Edible Sales Total</td>
            <td style="padding:10px 8px;color:#aaa;font-weight:700;font-size:12px;text-align:center;">${items.reduce((t,[,d])=>t+d.qty,0)}</td>
            <td style="padding:10px 8px;color:#bb88ff;font-weight:800;font-size:13px;text-align:right;">₹${items.reduce((t,[,d])=>t+d.revenue,0).toFixed(0)}</td>
          </tr>
        </tfoot>
      </table>
    </div>`;
  })()}

  <!-- Footer -->
  <div style="text-align:center;margin-top:24px;color:#333;font-size:11px;">
    Auto-generated by The Site · Gaming Cafe Manager
  </div>

</div>
</body></html>`;
}

async function sendDailyReport(dateStr) {
  const sessions = getDailyReportData(dateStr);
  const html     = buildDailyReportHtml(dateStr, sessions);

  const displayDate = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  });

  const mailOpts = {
    from:    `"The Site Gaming" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
    to:      CAFE_EMAIL,
    subject: `The Site — Daily Report · ${displayDate} · ₹${Math.round(sessions.reduce((t, s) => t + s.grand_total, 0)).toLocaleString('en-IN')}`,
    html,
  };

  if (!transporter) {
    console.log(`\n[REPORT] Email not configured — printing subject instead:`);
    console.log(`  ${mailOpts.subject}`);
    console.log(`  ${sessions.length} sessions found for ${dateStr}\n`);
    return { skipped: true, sessions: sessions.length };
  }

  await transporter.sendMail(mailOpts);
  console.log(`[REPORT] Daily report for ${dateStr} sent to ${CAFE_EMAIL}`);
  return { sent: true, sessions: sessions.length };
}

function scheduleDailyReport() {
  function msUntilNext2359() {
    const nowIST_  = nowIST();
    const target   = new Date(nowIST_);
    target.setHours(23, 59, 0, 0);
    if (target <= nowIST_) target.setDate(target.getDate() + 1);
    return target.getTime() - nowIST_.getTime();
  }

  function runAndReschedule() {
    const dateStr = todayIST();
    sendDailyReport(dateStr).catch(err =>
      console.error('[REPORT] Failed to send daily report:', err.message)
    );
    setTimeout(runAndReschedule, msUntilNext2359());
  }

  setTimeout(runAndReschedule, msUntilNext2359());
  const mins = Math.round(msUntilNext2359() / 60000);
  console.log(`[REPORT] Daily report scheduled at 11:59 PM (in ~${mins} min)`);
}

// ── Auth Middleware ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session. Please login again.' });
  }
}

function ownerOnly(req, res, next) {
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'Owner access required' });
  }
  next();
}

// ── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/auth/register', async (req, res) => {
  const { username, password, role = 'employee' } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (!['owner', 'employee'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + IST_OFFSET_MS + 10 * 60 * 1000).toISOString();
  const passwordHash = bcrypt.hashSync(password, 10);

  const result = db.prepare(`
    INSERT INTO otp_requests (username, password_hash, otp, requested_role, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(username.trim(), passwordHash, otp, role, expiresAt);

  try {
    await sendOTPEmail(otp, username.trim(), role);
    res.json({
      requestId: result.lastInsertRowid,
      message: 'OTP sent to owner email. Ask the owner to share it with you.',
    });
  } catch (err) {
    console.error('Email send error:', err.message);
    res.json({
      requestId: result.lastInsertRowid,
      message: 'OTP sent (check server console if email is not configured).',
    });
  }
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { requestId, otp } = req.body;
  if (!requestId || !otp) {
    return res.status(400).json({ error: 'Request ID and OTP are required' });
  }

  const request = db.prepare(`
    SELECT * FROM otp_requests WHERE id = ? AND status = 'pending'
  `).get(requestId);

  if (!request) {
    return res.status(404).json({ error: 'Registration request not found or already used' });
  }
  if (new Date(request.expires_at) < new Date()) {
    return res.status(400).json({ error: 'OTP has expired. Please register again.' });
  }
  if (request.otp !== otp.trim()) {
    return res.status(400).json({ error: 'Incorrect OTP' });
  }

  try {
    db.prepare(`
      INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)
    `).run(request.username, request.password_hash, request.requested_role);

    db.prepare(`UPDATE otp_requests SET status = 'used' WHERE id = ?`).run(requestId);

    res.json({ message: 'Account created! You can now log in.' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    throw err;
  }
});

// ── Machine Routes ───────────────────────────────────────────────────────────
app.get('/api/machines', auth, (req, res) => {
  const machines = MACHINES.map(machine => {
    const session = db.prepare(`
      SELECT s.*,
        (SELECT json_group_array(json_object(
          'id', o.id, 'item_name', o.item_name, 'item_type', o.item_type,
          'quantity', o.quantity, 'unit_price', o.unit_price, 'created_at', o.created_at
        )) FROM orders o WHERE o.session_id = s.id) AS orders_json
      FROM sessions s
      WHERE s.machine_id = ? AND s.status = 'active'
      ORDER BY s.start_time DESC LIMIT 1
    `).get(machine.id);

    if (session) {
      try {
        session.orders = JSON.parse(session.orders_json || '[]').filter(o => o.id !== null);
      } catch {
        session.orders = [];
      }
      delete session.orders_json;
    }

    return {
      ...machine,
      rate: machine.type === 'PS5' ? PS5_RATES[1] : RATES.PC,
      ps5Rates: machine.type === 'PS5' ? PS5_RATES : undefined,
      session: session || null,
      status: session ? 'occupied' : 'available',
    };
  });

  res.json({ machines, menu: MENU, rates: RATES, offers: { freeHalfHour: process.env.OFFER_FREE_HALF_HOUR === 'true' } });
});

app.post('/api/sessions', auth, (req, res) => {
  const { machine_id, customer_name, customer_phone, planned_hours, players, free_half_hour } = req.body;

  const machine = MACHINES.find(m => m.id === machine_id);
  if (!machine) return res.status(404).json({ error: 'Machine not found' });

  const existing = db.prepare(`
    SELECT id FROM sessions WHERE machine_id = ? AND status = 'active'
  `).get(machine_id);
  if (existing) return res.status(409).json({ error: 'Machine is already in use' });

  const hrs = Math.round(parseFloat(planned_hours));
  if (!hrs || hrs < 1) {
    return res.status(400).json({ error: 'Minimum session is 1 hour' });
  }

  // PS5 player count validation
  const playerCount = parseInt(players) || 1;
  if (machine.type === 'PS5' && (playerCount < 1 || playerCount > 4)) {
    return res.status(400).json({ error: 'PS5 sessions require 1–4 players' });
  }

  const rate = machine.type === 'PS5' ? (PS5_RATES[playerCount] || PS5_RATES[1]) : RATES.PC;
  const startTime = new Date().toISOString();

  const freeHalf = free_half_hour ? 1 : 0;
  const result = db.prepare(`
    INSERT INTO sessions (machine_id, machine_type, customer_name, customer_phone, players, start_time, planned_hours, rate_per_hour, free_half_hour, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(machine_id, machine.type, customer_name?.trim() || '', customer_phone?.trim() || '', playerCount, startTime, hrs, rate, freeHalf, req.user.id);

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(result.lastInsertRowid);
  session.orders = [];
  res.json({ session });
});

app.put('/api/sessions/:id', auth, (req, res) => {
  const { planned_hours, customer_name, customer_phone } = req.body;
  const sessionId = parseInt(req.params.id);

  const session = db.prepare(`
    SELECT * FROM sessions WHERE id = ? AND status = 'active'
  `).get(sessionId);
  if (!session) return res.status(404).json({ error: 'Active session not found' });

  if (planned_hours !== undefined) {
    const elapsed = (Date.now() - new Date(session.start_time).getTime()) / 3600000;
    const hrs = Math.round(parseFloat(planned_hours));
    if (hrs < Math.ceil(elapsed)) {
      return res.status(400).json({
        error: `Hours cannot be less than elapsed time (min ${Math.ceil(elapsed)}h)`,
      });
    }
  }

  db.prepare(`
    UPDATE sessions SET
      planned_hours   = COALESCE(?, planned_hours),
      customer_name   = COALESCE(?, customer_name),
      customer_phone  = COALESCE(?, customer_phone)
    WHERE id = ?
  `).run(
    planned_hours  !== undefined ? parseFloat(planned_hours)  : null,
    customer_name  !== undefined ? customer_name.trim()       : null,
    customer_phone !== undefined ? customer_phone.trim()      : null,
    sessionId
  );

  const updated = db.prepare(`
    SELECT s.*,
      (SELECT json_group_array(json_object(
        'id', o.id, 'item_name', o.item_name, 'item_type', o.item_type,
        'quantity', o.quantity, 'unit_price', o.unit_price, 'created_at', o.created_at
      )) FROM orders o WHERE o.session_id = s.id) AS orders_json
    FROM sessions s WHERE s.id = ?
  `).get(sessionId);

  try {
    updated.orders = JSON.parse(updated.orders_json || '[]').filter(o => o.id !== null);
  } catch {
    updated.orders = [];
  }
  delete updated.orders_json;

  res.json({ session: updated });
});

app.post('/api/sessions/:id/orders', auth, (req, res) => {
  const { item_name, item_type, quantity = 1 } = req.body;
  const sessionId = parseInt(req.params.id);

  const session = db.prepare(`
    SELECT id FROM sessions WHERE id = ? AND status = 'active'
  `).get(sessionId);
  if (!session) return res.status(404).json({ error: 'Active session not found' });

  const allItems = [...MENU.chips, ...MENU.drinks];
  const menuItem = allItems.find(i => i.name === item_name);
  if (!menuItem) return res.status(400).json({ error: 'Item not on menu' });

  const qty = Math.max(1, parseInt(quantity));
  const result = db.prepare(`
    INSERT INTO orders (session_id, item_name, item_type, quantity, unit_price)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, item_name, item_type, qty, menuItem.price);

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
  res.json({ order });
});

app.put('/api/sessions/:id/orders/:item', auth, (req, res) => {
  const sessionId = parseInt(req.params.id);
  const itemName  = decodeURIComponent(req.params.item);
  const { quantity } = req.body;

  const session = db.prepare(`SELECT id FROM sessions WHERE id = ? AND status = 'active'`).get(sessionId);
  if (!session) return res.status(404).json({ error: 'Active session not found' });

  if (quantity <= 0) {
    db.prepare(`DELETE FROM orders WHERE session_id = ? AND item_name = ?`).run(sessionId, itemName);
  } else {
    const existing = db.prepare(`SELECT id FROM orders WHERE session_id = ? AND item_name = ?`).get(sessionId, itemName);
    if (existing) {
      db.prepare(`UPDATE orders SET quantity = ? WHERE session_id = ? AND item_name = ?`).run(quantity, sessionId, itemName);
    } else {
      const allItems = [...MENU.chips, ...MENU.drinks];
      const menuItem = allItems.find(i => i.name === itemName);
      if (!menuItem) return res.status(400).json({ error: 'Item not on menu' });
      const itemType = MENU.chips.some(i => i.name === itemName) ? 'chips' : 'drinks';
      db.prepare(`INSERT INTO orders (session_id, item_name, item_type, quantity, unit_price) VALUES (?, ?, ?, ?, ?)`)
        .run(sessionId, itemName, itemType, quantity, menuItem.price);
    }
  }
  res.json({ ok: true });
});

app.post('/api/sessions/:id/extend', auth, (req, res) => {
  const sessionId = parseInt(req.params.id);

  const session = db.prepare(`SELECT * FROM sessions WHERE id = ? AND status = 'active'`).get(sessionId);
  if (!session) return res.status(404).json({ error: 'Active session not found' });

  const price = session.machine_type === 'PS5'
    ? Math.round(session.rate_per_hour * 0.6)
    : parseFloat(process.env.PC_EXTEND_RATE) || 50;

  // Count existing extensions to label them
  const extCount = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE session_id = ? AND item_type = 'extension'`).get(sessionId).c;
  const label = extCount === 0 ? '+30 min' : `+30 min ×${extCount + 1}`;

  db.prepare(`INSERT INTO orders (session_id, item_name, item_type, quantity, unit_price) VALUES (?, ?, 'extension', 1, ?)`)
    .run(sessionId, label, price);

  res.json({ ok: true, price, label });
});

app.post('/api/sessions/:id/checkout', auth, (req, res) => {
  const sessionId = parseInt(req.params.id);

  const session = db.prepare(`
    SELECT * FROM sessions WHERE id = ? AND status = 'active'
  `).get(sessionId);
  if (!session) return res.status(404).json({ error: 'Active session not found' });

  const orders = db.prepare('SELECT * FROM orders WHERE session_id = ?').all(sessionId);
  const endTime = new Date().toISOString();

  const actualHours     = (new Date(endTime) - new Date(session.start_time)) / 3600000;
  const roundedBillable = session.planned_hours; // bill exactly what was set; employee adjusts manually if needed
  const discount        = roundedBillable >= 3 ? 0.10 : 0;
  const freeHalfCredit  = session.free_half_hour ? session.rate_per_hour * 0.5 : 0;
  const sessionCost     = Math.max(0, roundedBillable * session.rate_per_hour * (1 - discount) - freeHalfCredit);
  const orderTotal      = orders.reduce((s, o) => s + o.quantity * o.unit_price, 0);
  const customAmount    = parseFloat(req.body?.custom_amount) || 0;
  const customComment   = req.body?.custom_comment || '';
  const grandTotal      = customAmount > 0 ? customAmount : sessionCost + orderTotal;

  db.prepare(`
    UPDATE sessions SET status = 'completed', end_time = ? WHERE id = ?
  `).run(endTime, sessionId);

  res.json({
    invoice: {
      machine_id:     session.machine_id,
      machine_type:   session.machine_type,
      customer_name:  session.customer_name,
      players:        session.players || 1,
      start_time:     session.start_time,
      end_time:       endTime,
      planned_hours:  session.planned_hours,
      actual_hours:   parseFloat(actualHours.toFixed(2)),
      billable_hours: roundedBillable,
      rate_per_hour:  session.rate_per_hour,
      discount_pct:   discount * 100,
      free_half_hour: session.free_half_hour ? 1 : 0,
      free_half_credit: freeHalfCredit,
      session_cost:    sessionCost,
      orders,
      order_total:     orderTotal,
      grand_total:     grandTotal,
      custom_amount:   customAmount > 0 ? customAmount : null,
      custom_comment:  customAmount > 0 ? customComment : null,
    },
  });
});

// ── Analytics Route ──────────────────────────────────────────────────────────
app.get('/api/analytics', auth, ownerOnly, (req, res) => {
  const date = req.query.date || todayIST();

  const sessions = db.prepare(`
    SELECT
      s.id, s.machine_id, s.machine_type, s.customer_name,
      s.start_time, s.planned_hours, s.end_time, s.status, s.rate_per_hour,
      s.free_half_hour,
      COALESCE((
        SELECT SUM(o.quantity * o.unit_price) FROM orders o WHERE o.session_id = s.id
      ), 0) AS order_total,
      (s.planned_hours * s.rate_per_hour) AS session_cost
    FROM sessions s
    WHERE date(datetime(s.start_time, '+5 hours', '30 minutes')) = ?
    ORDER BY s.machine_id, s.start_time
  `).all(date);

  const summary = {
    total_sessions: sessions.length,
    total_revenue: sessions.reduce((sum, s) => {
      const discount       = s.planned_hours >= 3 ? 0.10 : 0;
      const freeHalfCredit = s.free_half_hour ? s.rate_per_hour * 0.5 : 0;
      const sessionCost    = Math.max(0, s.planned_hours * s.rate_per_hour * (1 - discount) - freeHalfCredit);
      return sum + sessionCost + s.order_total;
    }, 0),
    machines_used: [...new Set(sessions.map(s => s.machine_id))].length,
  };

  res.json({ sessions, summary, date, machines: MACHINES });
});

// ── Report API (manual trigger, owner only) ───────────────────────────────────
app.post('/api/report/send', auth, ownerOnly, async (req, res) => {
  const dateStr = req.body?.date || todayIST();
  try {
    const result = await sendDailyReport(dateStr);
    res.json({ message: `Report for ${dateStr} ${result.skipped ? 'logged to console (email not configured)' : 'sent to ' + CAFE_EMAIL}`, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
initDB();
scheduleDailyReport();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`The Site – PC/PS Gaming → http://localhost:${PORT}`);
});
