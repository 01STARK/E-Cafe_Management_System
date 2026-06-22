'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════
const EXPIRY_WARN_MINS = 10;   // show alert & turn red when ≤ this many minutes remain

const state = {
  user:            null,
  token:           null,
  machines:        [],
  menu:            null,
  pendingOrders:   {},   // { itemName: additionalQty }
  savedOrderCounts:{},   // { itemName: totalSavedQty }
  otpRequestId:    null,
  refreshTimer:    null,
  countdownTimer:  null,
  alertedMachines: new Set(), // machine IDs that have already triggered an expiry toast
};

// ═══════════════════════════════════════════════════════════════════════════════
// MIXED PRICING HELPER
// Each 1-hour block is billed at the rate applicable when that block STARTS:
// before 4:00 PM IST → happy hour rate; at/after 4:00 PM → normal rate.
// ═══════════════════════════════════════════════════════════════════════════════
function calcMixedCost(startTimeISO, plannedHours, machineType, playerCount, freeHalfHour) {
  const IST_MS    = 5.5 * 60 * 60 * 1000;
  const players   = playerCount || 1;
  const happyRate    = state.offers?.happyHourRate    ?? 49;
  const ps5HappyRate = state.offers?.ps5HappyHourRate ?? 59;
  const pcRate       = state.rates?.PC ?? 59;
  const ps5Rates     = state.offers?.ps5Rates ?? { 1: 79, 2: 149, 3: 199, 4: 249 };

  function isHHAt(iso) {
    const ms   = new Date(iso).getTime() + IST_MS;
    const mins = Math.floor(ms / 60000) % (24 * 60);
    return mins > 9 * 60 + 59 && mins < 16 * 60;
  }
  function rateAt(i) {
    const slotISO = new Date(new Date(startTimeISO).getTime() + i * 3600000).toISOString();
    const hh = isHHAt(slotISO);
    if (machineType === 'PS5') return hh ? ps5HappyRate * players : (ps5Rates[players] || ps5Rates[1]);
    return hh ? happyRate : pcRate;
  }

  const full = Math.floor(plannedHours);
  const frac = plannedHours - full;
  let raw = 0;
  for (let i = 0; i < full; i++) raw += rateAt(i);
  if (frac > 0) raw += rateAt(full) * frac;

  const discount       = plannedHours >= 3 ? 0.10 : 0;
  const freeHalfCredit = freeHalfHour ? rateAt(0) * 0.5 : 0;
  return Math.max(0, raw * (1 - discount) - freeHalfCredit);
}

// ═══════════════════════════════════════════════════════════════════════════════
// API HELPER
// ═══════════════════════════════════════════════════════════════════════════════
async function api(method, endpoint, data) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (state.token) opts.headers['Authorization'] = `Bearer ${state.token}`;
  if (data)        opts.body = JSON.stringify(data);

  const res  = await fetch(endpoint, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  const savedToken = localStorage.getItem('gz_token');
  const savedUser  = localStorage.getItem('gz_user');

  if (savedToken && savedUser) {
    state.token = savedToken;
    state.user  = JSON.parse(savedUser);
    showApp();
  } else {
    showAuthView('login');
  }

  // Keyboard: close modal on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeModal('machine-modal');
      closeModal('invoice-modal');
      closeModal('payment-modal');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════
function showAuthView(view) {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  document.querySelectorAll('.auth-card').forEach(c => c.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  clearFormErrors();
}

function showApp() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  // Set user info in sidebar
  document.getElementById('user-name').textContent   = state.user.username;
  document.getElementById('user-role').textContent   = state.user.role;
  document.getElementById('user-avatar').textContent = state.user.username[0].toUpperCase();

  // Show/hide owner-only elements
  const isOwner = state.user.role === 'owner';
  document.querySelectorAll('.owner-only').forEach(el => {
    el.style.display = isOwner ? '' : 'none';
  });

  switchView('dashboard', document.querySelector('.nav-item[data-view="dashboard"]'));
  startSessionWatcher();
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const btn      = document.getElementById('login-btn');

  setLoading(btn, true);
  clearFormErrors('login-error');

  try {
    const data  = await api('POST', '/api/auth/login', { username, password });
    state.token = data.token;
    state.user  = data.user;
    localStorage.setItem('gz_token', data.token);
    localStorage.setItem('gz_user', JSON.stringify(data.user));
    showApp();
  } catch (err) {
    showFormError('login-error', err.message);
  } finally {
    setLoading(btn, false);
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  const role     = document.getElementById('reg-role').value;
  const btn      = document.getElementById('reg-btn');

  if (!username || username.length < 3) {
    return showFormError('reg-error', 'Username must be at least 3 characters');
  }
  if (password.length < 6) {
    return showFormError('reg-error', 'Password must be at least 6 characters');
  }

  setLoading(btn, true);
  clearFormErrors('reg-error');

  try {
    const data = await api('POST', '/api/auth/register', { username, password, role });
    state.otpRequestId = data.requestId;
    showToast(data.message, 'success');
    showAuthView('otp');
  } catch (err) {
    showFormError('reg-error', err.message);
  } finally {
    setLoading(btn, false);
  }
}

async function handleVerifyOTP(e) {
  e.preventDefault();
  const otp = document.getElementById('otp-input').value.trim();
  const btn = document.getElementById('otp-btn');

  if (!state.otpRequestId) {
    return showFormError('otp-error', 'No pending registration. Please register first.');
  }
  if (otp.length !== 6) {
    return showFormError('otp-error', 'Enter the 6-digit OTP');
  }

  setLoading(btn, true);
  clearFormErrors('otp-error');

  try {
    const data = await api('POST', '/api/auth/verify-otp', {
      requestId: state.otpRequestId, otp,
    });
    showToast(data.message, 'success');
    state.otpRequestId = null;
    showAuthView('login');
  } catch (err) {
    showFormError('otp-error', err.message);
  } finally {
    setLoading(btn, false);
  }
}

function handleLogout() {
  state.token = null;
  state.user  = null;
  localStorage.removeItem('gz_token');
  localStorage.removeItem('gz_user');
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  showAuthView('login');
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════════
function switchView(viewName, el) {
  document.querySelectorAll('.app-view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${viewName}`).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');

  if (viewName === 'dashboard') loadDashboard();
  if (viewName === 'analytics') {
    if (state.analyticsTab === 'graph')       loadAnalytics();
    else if (state.analyticsTab === 'charts') loadCharts();
    else                                      loadSessionCards();
  }

  closeSidebar();
}

function toggleSidebar() {
  const sidebar  = document.getElementById('sidebar');
  const overlay  = document.getElementById('sidebar-overlay');
  const isOpen   = sidebar.classList.contains('open');
  sidebar.classList.toggle('open', !isOpen);
  overlay.classList.toggle('active', !isOpen);
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('active');
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════
async function loadDashboard() {
  try {
    const data    = await api('GET', '/api/machines');
    state.machines = data.machines;
    state.menu     = data.menu;
    state.rates    = data.rates || {};
    state.offers   = data.offers || {};
    renderMachineStatuses();
    updateStatusBar();
  } catch (err) {
    if (err.message.includes('401') || err.message.includes('session')) {
      handleLogout();
    } else {
      showToast(err.message, 'error');
    }
  }
}

function renderMachineStatuses() {
  const now = Date.now();
  state.machines.forEach(machine => {
    const el = document.getElementById(machine.id);
    if (!el) return;
    el.classList.remove('occupied', 'available', 'expiring-soon', 'overtime');
    el.classList.add(machine.status);

    if (machine.session) {
      const start    = new Date(machine.session.start_time);
      const endTime  = new Date(start.getTime() + machine.session.planned_hours * 3600000);
      const minsLeft = (endTime.getTime() - now) / 60000;

      if (minsLeft <= 0) {
        el.classList.add('overtime');
        const overMins = Math.floor(Math.abs(minsLeft));
        el.title = `${machine.session.customer_name || 'Walk-in'} · ${fmt12(start)} → ${fmt12(endTime)} 🔴 OVERTIME ${overMins}m`;
      } else if (minsLeft <= EXPIRY_WARN_MINS) {
        el.classList.add('expiring-soon');
        el.title = `${machine.session.customer_name || 'Walk-in'} · ${fmt12(start)} → ${fmt12(endTime)} ⚠ ${Math.ceil(minsLeft)}m left`;
      } else {
        el.title = `${machine.session.customer_name || 'Walk-in'} · ${fmt12(start)} → ${fmt12(endTime)}`;
      }
    } else {
      el.title = `${machine.name} – Available. Click to start session.`;
    }
  });
}

function checkExpiryAlerts() {
  const now = Date.now();
  state.machines.forEach(machine => {
    if (!machine.session) {
      state.alertedMachines.delete(machine.id);
      return;
    }
    const start    = new Date(machine.session.start_time);
    const endTime  = new Date(start.getTime() + machine.session.planned_hours * 3600000);
    const minsLeft = (endTime.getTime() - now) / 60000;

    const name = machine.session.customer_name ? `${machine.name} (${machine.session.customer_name})` : machine.name;
    if (minsLeft <= 0 && !state.alertedMachines.has(machine.id + '_ot')) {
      state.alertedMachines.add(machine.id + '_ot');
      showToast(`${name}: OVERTIME!`, 'error');
    } else if (minsLeft > 0 && minsLeft <= EXPIRY_WARN_MINS && !state.alertedMachines.has(machine.id)) {
      state.alertedMachines.add(machine.id);
      showToast(`${name}: ${Math.ceil(minsLeft)} min left`, 'warning');
    } else if (minsLeft > EXPIRY_WARN_MINS) {
      // Reset both alerts if hours were extended
      state.alertedMachines.delete(machine.id);
      state.alertedMachines.delete(machine.id + '_ot');
    }
  });
  renderMachineStatuses();
}

function startSessionWatcher() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(checkExpiryAlerts, 60_000);

  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(updateMachineCountdowns, 1000);
}

function updateMachineCountdowns() {
  const now = Date.now();
  state.machines.forEach(machine => {
    const el = document.getElementById(machine.id);
    if (!el) return;
    const isPS     = machine.type === 'PS5';
    const labelEl  = el.querySelector(isPS ? '.ps-text' : '.machine-label');
    if (!labelEl) return;
    if (!machine.session) {
      labelEl.innerHTML = isPS ? `PLAY<br/>STATION<br/>${machine.id.replace('PS', '')}` : machine.name;
      return;
    }
    const endMs    = new Date(machine.session.start_time).getTime() + machine.session.planned_hours * 3600000;
    const diffMs   = endMs - now;
    const diffMins = diffMs / 60000;
    const text     = diffMs <= 0
      ? (Math.round(-diffMins) > 0 ? `+${Math.round(-diffMins)}m OT` : 'OT')
      : fmtHrs(diffMins / 60);
    labelEl.innerHTML = isPS ? `PS ${machine.id.replace('PS', '')}<br/>${text}` : text;
  });
}

function updateStatusBar() {
  const active   = state.machines.filter(m => m.status === 'occupied').length;
  const total    = state.machines.length;
  const text     = `${active} Active · ${total - active} Available`;
  document.getElementById('status-bar').textContent = text;
  document.getElementById('mobile-status').textContent = `${active}/${total} Active`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MACHINE MODAL
// ═══════════════════════════════════════════════════════════════════════════════
function openMachineModal(machineId) {
  const machine = state.machines.find(m => m.id === machineId);
  if (!machine) return;

  state.pendingOrders = {};
  state.savedOrderCounts = {};

  const modal = document.getElementById('machine-modal');
  const title = document.getElementById('modal-title');
  const badge = document.getElementById('modal-badge');
  const body  = document.getElementById('modal-body');

  title.textContent = machine.name;

  const modalBox = modal.querySelector('.modal-box');
  if (machine.session) {
    const isPS5 = machine.type === 'PS5';
    badge.textContent  = isPS5 ? 'PS5 · Active' : 'PC · Active';
    badge.className    = `modal-badge ${isPS5 ? 'occupied-ps' : 'occupied-pc'}`;
    body.innerHTML     = buildSessionBody(machine);
    modalBox.classList.add('modal-box-session');
  } else {
    badge.textContent = `${machine.type} · Available`;
    badge.className   = 'modal-badge available';
    body.innerHTML    = buildStartBody(machine);
    modalBox.classList.remove('modal-box-session');
    setupCustomerAutocomplete();
  }

  modal.classList.add('active');
  updateCostPreview(machine);
}

// ── Start Session Form ───────────────────────────────────────────────────────
function buildStartBody(machine) {
  const isPS5 = machine.type === 'PS5';
  const ps5Rates = machine.ps5Rates || {};
  const playerSelector = isPS5 ? `
    <div class="form-group">
      <label>Number of Players</label>
      <div class="player-selector">
        <button type="button" class="player-btn active" data-count="1" onclick="selectPlayers(this, 1)">
          <span class="player-btn-count">1</span>
          <span class="player-btn-price">₹${ps5Rates[1] || ''}/hr</span>
        </button>
        <button type="button" class="player-btn" data-count="2" onclick="selectPlayers(this, 2)">
          <span class="player-btn-count">2</span>
          <span class="player-btn-price">₹${ps5Rates[2] || ''}/hr</span>
        </button>
        <button type="button" class="player-btn" data-count="3" onclick="selectPlayers(this, 3)">
          <span class="player-btn-count">3</span>
          <span class="player-btn-price">₹${ps5Rates[3] || ''}/hr</span>
        </button>
        <button type="button" class="player-btn" data-count="4" onclick="selectPlayers(this, 4)">
          <span class="player-btn-count">4</span>
          <span class="player-btn-price">₹${ps5Rates[4] || ''}/hr</span>
        </button>
      </div>
      <input type="hidden" id="player-count" value="1" />
    </div>
  ` : '';

  return `
    <div class="form-group">
      <label>Customer Name <span style="color:var(--text-dim)">(optional)</span></label>
      <div class="autocomplete-wrap">
        <input type="text" id="customer-name" placeholder="Walk-in customer" maxlength="60" autocomplete="off" />
        <div class="autocomplete-dropdown" id="customer-dropdown"></div>
      </div>
    </div>
    <div class="form-group">
      <label>Phone <span style="color:var(--text-dim)">(optional)</span></label>
      <input type="tel" id="customer-phone" placeholder="e.g. 9876543210" maxlength="15" />
    </div>

    ${playerSelector}

    <div class="form-group">
      <label>Duration (Hours)</label>
      <div class="hours-control">
        <button class="btn-icon" type="button" onclick="adjustHours(-1, 1)">−</button>
        <input type="number" id="session-hours" value="1" min="1" max="12" step="1"
               oninput="updateCostPreview(getMachine('${machine.id}'))" />
        <button class="btn-icon" type="button" onclick="adjustHours(1, 1)">+</button>
      </div>
    </div>

    ${state.offers?.freeHalfHour ? `
    <div class="form-group" style="margin-bottom:10px;">
      <label class="checkbox-label">
        <input type="checkbox" id="free-half-hour" onchange="updateCostPreview(getMachine('${machine.id}'))" />
        <span>First ½ hour free</span>
      </label>
    </div>` : ''}

    ${state.offers?.happyHour ? `
    <div style="background:rgba(166,255,0,0.08);border:1px solid var(--accent);border-radius:8px;padding:7px 12px;margin-bottom:10px;display:flex;align-items:center;gap:8px;">
      <span style="font-size:1rem;">⚡</span>
      <span style="color:var(--accent);font-size:0.82rem;font-weight:600;letter-spacing:0.5px;">HAPPY HOURS · ₹${state.offers.happyHourRate}/hr · 10AM – 4PM</span>
    </div>` : ''}

    <div class="cost-preview">
      <span>Session Cost</span>
      <span class="cost" id="cost-preview">₹${machine.rate}</span>
    </div>
    <p class="rate-info" id="rate-info">Rate: ₹${machine.rate}/hour · Billed in whole hours</p>

    <button class="btn-primary full-width" onclick="startSession('${machine.id}')">
      Start Session
    </button>
  `;
}

// ── Customer Autocomplete ────────────────────────────────────────────────────
function setupCustomerAutocomplete() {
  const nameInput = document.getElementById('customer-name');
  const phoneInput = document.getElementById('customer-phone');
  const dropdown = document.getElementById('customer-dropdown');
  if (!nameInput || !dropdown) return;

  let debounceTimer;

  nameInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = nameInput.value.trim();
    if (!q) { closeDropdown(); return; }
    debounceTimer = setTimeout(async () => {
      try {
        const results = await api('GET', `/api/customers/search?q=${encodeURIComponent(q)}`);
        if (!results.length) { closeDropdown(); return; }
        dropdown.innerHTML = results.map((c, i) =>
          `<div class="autocomplete-item" data-index="${i}" data-name="${escHtml(c.name)}" data-phone="${escHtml(c.phone || '')}">
            <span class="autocomplete-item-name">${escHtml(c.name)}</span>
            <span class="autocomplete-item-phone">${escHtml(c.phone || '—')}</span>
          </div>`
        ).join('');
        dropdown.querySelectorAll('.autocomplete-item').forEach(item => {
          item.addEventListener('mousedown', e => {
            e.preventDefault();
            nameInput.value = item.dataset.name;
            phoneInput.value = item.dataset.phone;
            closeDropdown();
          });
        });
        dropdown.classList.add('open');
      } catch (_) { closeDropdown(); }
    }, 200);
  });

  nameInput.addEventListener('blur', () => setTimeout(closeDropdown, 150));

  function closeDropdown() {
    dropdown.classList.remove('open');
    dropdown.innerHTML = '';
  }

  function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
}

// ── Active Session Form ──────────────────────────────────────────────────────
function renderSummaryOrderRows(orders) {
  const exts    = (orders || []).filter(o => o.item_type === 'extension');
  const regular = (orders || []).filter(o => o.item_type !== 'extension' && o.quantity > 0);
  const extCount = exts.reduce((t, o) => t + o.quantity, 0);
  const extTotal = exts.reduce((t, o) => t + o.quantity * o.unit_price, 0);

  const regularRows = regular.map(o => `
    <div class="summary-row">
      <span class="s-label">${o.item_name}</span>
      <span class="s-qty">${o.quantity}x</span>
      <span class="s-amt">₹${(o.quantity * o.unit_price).toFixed(0)}</span>
    </div>`).join('');

  const extRow = extCount > 0 ? `
    <div class="summary-row">
      <span class="s-label">+15 min</span>
      <span class="s-qty">${extCount}x</span>
      <span class="s-amt">₹${extTotal.toFixed(0)}</span>
    </div>` : '';

  return regularRows + extRow;
}

function buildSessionBody(machine) {
  const s       = machine.session;
  const start   = new Date(s.start_time);
  const endTime = new Date(start.getTime() + s.planned_hours * 3600000);
  const elapsed = (Date.now() - start.getTime()) / 3600000;
  const minHrs  = Math.max(1, Math.ceil(elapsed));

  const extCount    = (s.orders || []).filter(o => o.item_type === 'extension').length;
  const baseHours   = s.planned_hours - extCount * 0.25;
  const discount    = baseHours >= 3 ? 0.10 : 0;
  const freeHalf    = s.free_half_hour ? s.rate_per_hour * 0.5 : 0;
  const sessionCost = calcMixedCost(s.start_time, baseHours, s.machine_type, s.players, s.free_half_hour);
  const orderCost   = (s.orders || []).reduce((t, o) => t + o.quantity * o.unit_price, 0);

  state.savedOrderCounts = {};
  (s.orders || []).forEach(o => {
    state.savedOrderCounts[o.item_name] = (state.savedOrderCounts[o.item_name] || 0) + o.quantity;
  });

  const chipsHtml  = buildMenuItems(state.menu.chips,  'chips');
  const drinksHtml = buildMenuItems(state.menu.drinks, 'drinks');

  const orderRows = renderSummaryOrderRows(s.orders);

  const total = sessionCost + orderCost;

  return `
    <div class="session-layout">

      <!-- LEFT: info + hours + extend -->
      <div class="session-col-left">
        <div class="session-info">
          <div class="info-row">
            <span>Customer</span>
            <input type="text" id="customer-name" value="${s.customer_name || ''}" placeholder="Walk-in"
              maxlength="60" style="background:transparent;border:none;border-bottom:1px solid var(--border);
              color:var(--text);text-align:right;width:140px;font-size:0.9rem;outline:none;padding:2px 0;"
              onchange="updateCustomerInfo(${s.id})" />
          </div>
          <div class="info-row">
            <span>Phone</span>
            <input type="tel" id="customer-phone" value="${s.customer_phone || ''}" placeholder="—"
              maxlength="15" style="background:transparent;border:none;border-bottom:1px solid var(--border);
              color:var(--text);text-align:right;width:140px;font-size:0.9rem;outline:none;padding:2px 0;"
              onchange="updateCustomerInfo(${s.id})" />
          </div>
          <div class="info-row"><span>Start Time</span><span>${fmt12(start)}</span></div>
          <div class="info-row"><span>End Time</span><span id="valid-until">${fmt12(endTime)}</span></div>
          <div class="info-row">
            <span>Remaining</span>
            <span id="elapsed-time" style="color:${elapsed >= s.planned_hours ? 'var(--danger)' : elapsed >= s.planned_hours - 10/60 ? 'var(--warning)' : 'inherit'}">${elapsed >= s.planned_hours ? `+${fmtHrs(elapsed - s.planned_hours)} OT` : fmtHrs(s.planned_hours - elapsed)}</span>
          </div>
          <div class="info-row"><span>Rate</span><span>₹${s.rate_per_hour}/hr${s.free_half_hour ? ' <span style="color:var(--warning);font-size:0.75rem;">½hr free</span>' : ''}</span></div>
          ${machine.type === 'PS5' ? `<div class="info-row"><span>Players</span><span>${s.players || 1} player${(s.players || 1) > 1 ? 's' : ''}</span></div>` : ''}
        </div>

        <div class="form-group">
          <label>Booked Hours <span style="color:var(--text-dim)">(min ${minHrs}h)</span></label>
          <div class="hours-control">
            <button class="btn-icon" type="button" onclick="adjustSessionHours(-1, ${minHrs}, '${s.start_time}')">−</button>
            <input type="number" id="session-hours" value="${baseHours}" min="${minHrs}" max="24" step="1"
                   oninput="onHoursChange('${s.start_time}')" />
            <button class="btn-icon" type="button" onclick="adjustSessionHours(1, ${minHrs}, '${s.start_time}')">+</button>
          </div>
        </div>

        <div class="form-group" style="margin-top:8px;">
          <label>Extend <span style="color:var(--text-dim)">(× 15 min · ₹${Math.ceil(s.rate_per_hour / 4)})</span></label>
          <div class="hours-control">
            <button class="btn-icon" type="button" onclick="removeExtension(${s.id}, '${machine.id}')">−</button>
            <input type="text" id="ext-count-display" readonly value="${extCount}"
                   style="text-align:center;pointer-events:none;" />
            <button class="btn-icon" type="button" onclick="extendSession(${s.id}, '${machine.id}')">+</button>
          </div>
        </div>

      </div>

      <!-- MIDDLE: Add Items (single column) -->
      <div class="session-col-items">
        <div class="items-section-title">Add Items</div>
        <div class="menu-category"><h5>Snacks</h5>${chipsHtml}</div>
        <div class="menu-category"><h5>Drinks</h5>${drinksHtml}</div>
      </div>

      <!-- RIGHT: Summary + Checkout -->
      <div class="session-col-summary">
        <div class="summary-title">Summary</div>
        <div class="summary-panel">
          <div class="summary-row">
            <span class="s-label" id="session-cost-label">Session${discount > 0 ? ' <span style="color:var(--warning);font-size:0.7rem">-10%</span>' : ''}${freeHalf > 0 ? ' <span style="color:var(--warning);font-size:0.7rem">½free</span>' : ''}</span>
            <span class="s-qty" id="session-cost-hrs">${baseHours}h</span>
            <span class="s-amt" id="session-cost-val">${(freeHalf > 0 || discount > 0) ? `<span style="text-decoration:line-through;color:var(--text-muted);font-size:0.8rem;margin-right:2px;">₹${(baseHours * s.rate_per_hour).toFixed(0)}</span>` : ''}₹${sessionCost.toFixed(0)}</span>
          </div>
          <div id="order-items-list">${orderRows}</div>
          <div id="pending-orders-row" style="display:none">
            <div id="pending-items-list" style="font-size:0.78rem;color:var(--text-muted);padding:2px 0;"></div>
            <div class="summary-row">
              <span class="s-label">Pending</span><span class="s-qty"></span>
              <span class="s-amt" id="pending-orders-val">₹0</span>
            </div>
          </div>
          <div class="summary-divider"></div>
          <div class="summary-total-row">
            <span>Total</span>
            <span id="running-total">₹${total.toFixed(0)}</span>
          </div>
        </div>

        <div class="modal-checkout-bar">
          <input type="number" id="custom-amount" placeholder="Enter custom amount (optional)" min="0"
            oninput="onCustomAmountInput(this)" />
          <input type="text" id="custom-comment" placeholder="Comment (required)" maxlength="120"
            style="display:none;" />
          <button class="btn-checkout" onclick="checkout('${s.id}')">
            End Session &nbsp;·&nbsp; <span id="checkout-total">₹${total.toFixed(0)}</span>
          </button>
        </div>
      </div>

    </div>
  `;
}

function buildMenuItems(items, type) {
  return items.map(item => {
    const key     = slugify(item.name);
    const saved   = state.savedOrderCounts[item.name] || 0;
    const pending = state.pendingOrders[item.name] || 0;
    return `
      <div class="menu-item">
        <span>${item.name}<br/><small style="color:var(--text-muted)">₹${item.price}</small></span>
        <div class="qty-control">
          <button class="btn-sm" type="button"
            onclick="adjustOrder('${item.name}','${type}',-1)">−</button>
          <span class="qty" id="qty-${key}">${saved + pending}</span>
          <button class="btn-sm" type="button"
            onclick="adjustOrder('${item.name}','${type}',1)">+</button>
        </div>
      </div>
    `;
  }).join('');
}

function buildOrderHistory(orders) {
  if (!orders.length) return '';
  return `
    <div class="orders-history">
      <h4>Orders</h4>
      ${orders.map(o => `
        <div class="order-row">
          <span>${o.item_name} ×${o.quantity}</span>
          <span>₹${(o.quantity * o.unit_price).toFixed(0)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function buildOrderSummary(orders) {
  // Merge saved orders + pending orders
  const totals = {};
  orders.forEach(o => {
    totals[o.item_name] = (totals[o.item_name] || 0) + o.quantity;
  });
  Object.entries(state.pendingOrders).forEach(([name, qty]) => {
    if (qty > 0) totals[name] = (totals[name] || 0) + qty;
  });
  const entries = Object.entries(totals).filter(([, qty]) => qty > 0);
  if (!entries.length) return '<div style="color:var(--text-dim);font-size:0.8rem;margin-top:8px;">No items yet</div>';
  return entries.map(([name, qty]) => `
    <div class="order-row" style="font-size:0.82rem;padding:4px 0;">
      <span>${name}</span>
      <span style="color:var(--primary)">×${qty}</span>
    </div>
  `).join('');
}

// ── Hours Controls ───────────────────────────────────────────────────────────
function adjustHours(delta, min) {
  const input = document.getElementById('session-hours');
  if (!input) return;
  const current = parseInt(input.value) || 1;
  const next    = Math.max(min, current + delta);
  input.value   = next;
  const machine = getMachine(document.getElementById('modal-title').textContent.trim());
  updateCostPreview(machine);
}

function adjustSessionHours(delta, min, startTimeISO) {
  const input = document.getElementById('session-hours');
  if (!input) return;
  const current = parseInt(input.value) || min;
  const next    = Math.max(min, current + delta);
  input.value   = next;
  onHoursChange(startTimeISO);
}

function onHoursChange(startTimeISO) {
  // hrs = base hours (input no longer includes extensions)
  const hrs     = parseFloat(document.getElementById('session-hours')?.value) || 1;
  const machine = getMachineFromModal();
  if (!machine?.session) return;
  const extCount       = (machine.session.orders || []).filter(o => o.item_type === 'extension').length;
  const actualPlanned  = hrs + extCount * 0.25;

  const start = new Date(startTimeISO);
  const end   = new Date(start.getTime() + actualPlanned * 3600000);
  const validUntilEl = document.getElementById('valid-until');
  if (validUntilEl) validUntilEl.textContent = fmt12(end);

  // Update cost (hrs is already base hours)
  const s           = machine.session;
  const discount    = hrs >= 3 ? 0.10 : 0;
  const freeHalf    = s.free_half_hour ? s.rate_per_hour * 0.5 : 0;
  const sessionCost = calcMixedCost(s.start_time, hrs, s.machine_type, s.players, s.free_half_hour);
  const rawCost     = calcMixedCost(s.start_time, hrs, s.machine_type, s.players, false);
  const el = document.getElementById('session-cost-label');
  const eh = document.getElementById('session-cost-hrs');
  const ev = document.getElementById('session-cost-val');
  if (el) el.innerHTML = `Session${discount > 0 ? ' <span style="color:var(--warning);font-size:0.7rem">-10%</span>' : ''}${freeHalf > 0 ? ' <span style="color:var(--warning);font-size:0.7rem">½free</span>' : ''}`;
  if (eh) eh.textContent = `${hrs}h`;
  if (ev) ev.innerHTML = `${(freeHalf > 0 || discount > 0) ? `<span style="text-decoration:line-through;color:var(--text-muted);font-size:0.8rem;margin-right:2px;">₹${rawCost.toFixed(0)}</span>` : ''}₹${sessionCost.toFixed(0)}`;
  updateRunningTotal();

  // Save to server — always send total planned (base + extensions)
  clearTimeout(onHoursChange._timer);
  onHoursChange._timer = setTimeout(async () => {
    try {
      const oldHrs = machine.session.planned_hours;
      await api('PUT', `/api/sessions/${machine.session.id}`, { planned_hours: actualPlanned });
      machine.session.planned_hours = actualPlanned;
      if (actualPlanned < oldHrs) {
        const data = await api('GET', '/api/machines');
        state.machines = data.machines;
        openMachineModal(machine.id);
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, 600);
}

function updateCostPreview(machine) {
  if (!machine) return;
  const hrs        = parseFloat(document.getElementById('session-hours')?.value) || 1;
  const players    = parseInt(document.getElementById('player-count')?.value) || 1;
  const rate       = (machine.ps5Rates && machine.ps5Rates[players]) || machine.rate;
  const discount   = hrs >= 3 ? 0.10 : 0;
  const freeHalf   = document.getElementById('free-half-hour')?.checked ? rate * 0.5 : 0;
  const cost       = Math.max(0, hrs * rate * (1 - discount) - freeHalf);
  const el         = document.getElementById('cost-preview');
  const info       = document.getElementById('rate-info');
  if (el) el.innerHTML = `${discount > 0 ? `<span style="text-decoration:line-through;color:var(--text-muted);font-size:0.85rem;margin-right:4px;">₹${(hrs * rate).toFixed(0)}</span>` : ''}₹${cost.toFixed(0)}${discount > 0 ? ' <span style="color:var(--warning);font-size:0.75rem">-10%</span>' : ''}${freeHalf > 0 ? ' <span style="color:var(--warning);font-size:0.75rem">-½hr free</span>' : ''}`;
  const happyLabel = state.offers?.happyHour ? ' · Happy Hours rate' : '';
  if (info) info.textContent = `Rate: ₹${rate}/hour · Billed in whole hours${happyLabel}${hrs >= 3 ? ' · 10% discount applied' : ' · 10% off on 3h+'}${freeHalf > 0 ? ' · First ½hr free' : ''}`;
}

// ── Order Controls ───────────────────────────────────────────────────────────
async function adjustOrder(itemName, _itemType, delta) {
  const key      = slugify(itemName);
  const machine  = getMachineFromModal();
  if (!machine?.session) return;
  const sessionId = machine.session.id;

  const saved = state.savedOrderCounts[itemName] || 0;
  const next  = Math.max(0, saved + delta);

  state.savedOrderCounts[itemName] = next;

  const qtyEl = document.getElementById(`qty-${key}`);
  if (qtyEl) qtyEl.textContent = next;

  try {
    await api('PUT', `/api/sessions/${sessionId}/orders/${encodeURIComponent(itemName)}`, { quantity: next });
    // Refresh session data to reflect updated orders
    const data = await api('GET', '/api/machines');
    state.machines = data.machines;
    const updated = state.machines.find(m => m.id === machine.id);
    if (updated?.session) {
      state.savedOrderCounts = {};
      (updated.session.orders || []).forEach(o => {
        state.savedOrderCounts[o.item_name] = (state.savedOrderCounts[o.item_name] || 0) + o.quantity;
      });
    }
  } catch (err) {
    showToast(err.message, 'error');
    // Revert on error
    state.savedOrderCounts[itemName] = saved;
    if (qtyEl) qtyEl.textContent = saved;
  }

  updateRunningTotal();
}

function selectPlayers(btn, count) {
  document.querySelectorAll('.player-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const hidden = document.getElementById('player-count');
  if (hidden) hidden.value = count;

  const machine = getMachineFromModal();
  if (machine?.ps5Rates) {
    const rate = machine.ps5Rates[count] || machine.ps5Rates[1];
    const rateInfo = document.getElementById('rate-info');
    if (rateInfo) rateInfo.textContent = `Rate: ₹${rate}/hour · Billed in whole hours`;
    updateCostPreview(machine);
  }
}

function updateRunningTotal() {
  const machine = getMachineFromModal();
  if (!machine?.session) return;

  const s = machine.session;
  const extCount = (s.orders || []).filter(o => o.item_type === 'extension').length;
  // session-hours input now shows base hours (without extensions)
  const baseHrs  = parseFloat(document.getElementById('session-hours')?.value) || (s.planned_hours - extCount * 0.25);
  const sessionCost = calcMixedCost(s.start_time, baseHrs, s.machine_type, s.players, s.free_half_hour);
  const prevOrders   = (s.orders || []).reduce((t, o) => t + o.quantity * o.unit_price, 0);
  const pendingCost  = calcPendingCost();

  const totalEl    = document.getElementById('running-total');
  const checkoutEl = document.getElementById('checkout-total');
  const pendingRow = document.getElementById('pending-orders-row');
  const pendingVal = document.getElementById('pending-orders-val');

  const _customEl = document.getElementById('custom-amount');
  const _hasCustom = _customEl?.value !== '';
  const customAmt  = _hasCustom ? (parseFloat(_customEl.value) || 0) : null;
  const displayTotal = _hasCustom ? `₹${customAmt.toFixed(0)}` : `₹${(sessionCost + prevOrders + pendingCost).toFixed(0)}`;

  if (pendingRow) pendingRow.style.display = pendingCost > 0 ? '' : 'none';
  if (pendingVal) pendingVal.textContent = `₹${pendingCost.toFixed(0)}`;
  if (totalEl)    totalEl.textContent = displayTotal;
  if (checkoutEl) checkoutEl.textContent = displayTotal;

  // Re-render saved order item rows
  const orderItemsEl = document.getElementById('order-items-list');
  if (orderItemsEl) {
    const orders = getMachineFromModal()?.session?.orders || [];
    orderItemsEl.innerHTML = renderSummaryOrderRows(orders);
  }

  // Update pending items list
  const pendingItemsEl = document.getElementById('pending-items-list');
  if (pendingItemsEl) {
    const items = Object.entries(state.pendingOrders).filter(([, qty]) => qty > 0);
    pendingItemsEl.innerHTML = items.map(([name, qty]) => `<span style="margin-right:8px;">${name} ×${qty}</span>`).join('');
  }

  // Refresh order summary column
  const summaryEl = document.getElementById('order-summary-list');
  if (summaryEl) {
    const machine2 = getMachineFromModal();
    summaryEl.innerHTML = buildOrderSummary(machine2?.session?.orders || []);
  }
}

function onCustomAmountInput(input) {
  const commentEl = document.getElementById('custom-comment');
  if (!commentEl) return;
  commentEl.style.display = input.value ? '' : 'none';
  if (!input.value) commentEl.value = '';
  updateRunningTotal();
}

function calcPendingCost() {
  if (!state.menu) return 0;
  const allItems = [...state.menu.chips, ...state.menu.drinks];
  return Object.entries(state.pendingOrders).reduce((total, [name, qty]) => {
    const item = allItems.find(i => i.name === name);
    return total + (item ? item.price * qty : 0);
  }, 0);
}

// ── Session Actions ──────────────────────────────────────────────────────────
async function updateCustomerInfo(sessionId) {
  const name  = document.getElementById('customer-name')?.value.trim();
  const phone = document.getElementById('customer-phone')?.value.trim();
  try {
    await api('PUT', `/api/sessions/${sessionId}`, { customer_name: name, customer_phone: phone });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function startSession(machineId) {
  const machine      = getMachine(machineId);
  const customerName = document.getElementById('customer-name')?.value.trim() || '';
  const customerPhone = document.getElementById('customer-phone')?.value.trim() || '';
  const hrs          = parseInt(document.getElementById('session-hours')?.value);
  const players      = parseInt(document.getElementById('player-count')?.value) || 1;
  const freeHalfHour = document.getElementById('free-half-hour')?.checked ? 1 : 0;

  if (!hrs || hrs < 1) return showToast('Minimum session is 1 hour', 'error');

  try {
    await api('POST', '/api/sessions', {
      machine_id:      machineId,
      customer_name:   customerName,
      customer_phone:  customerPhone,
      planned_hours:   hrs,
      players,
      free_half_hour:  freeHalfHour,
    });
    closeModal('machine-modal');
    showToast(`Session started on ${machine?.name || machineId}`, 'success');
    await loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function saveSession(sessionId, machineId) {
  const hrs = parseInt(document.getElementById('session-hours')?.value);
  const machine = getMachine(machineId);

  if (!machine?.session) return;

  const elapsed = (Date.now() - new Date(machine.session.start_time).getTime()) / 3600000;
  if (hrs && hrs < Math.ceil(elapsed)) {
    return showToast(`Hours cannot be less than elapsed time (min ${Math.ceil(elapsed)}h)`, 'error');
  }

  try {
    // Save hours update
    await api('PUT', `/api/sessions/${sessionId}`, { planned_hours: hrs });

    // Save pending orders
    const pending = Object.entries(state.pendingOrders).filter(([, qty]) => qty > 0);
    if (pending.length > 0) {
      const allItems = [...state.menu.chips, ...state.menu.drinks];
      for (const [name, qty] of pending) {
        const item = allItems.find(i => i.name === name);
        await api('POST', `/api/sessions/${sessionId}/orders`, {
          item_name: name,
          item_type: item ? (state.menu.chips.some(c => c.name === name) ? 'chips' : 'drinks') : 'other',
          quantity:  qty,
        });
      }
    }

    state.pendingOrders = {};
    closeModal('machine-modal');
    showToast('Session updated', 'success');
    await loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function extendSession(sessionId, machineId) {
  try {
    const res = await api('POST', `/api/sessions/${sessionId}/extend`);
    showToast(`Extended +15 min · ₹${res.price} charged`, 'success');
    const data = await api('GET', '/api/machines');
    state.machines = data.machines;
    openMachineModal(machineId);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function removeExtension(sessionId, machineId) {
  const machine = state.machines.find(m => m.id === machineId);
  if (!machine?.session) return;
  const exts = (machine.session.orders || []).filter(o => o.item_type === 'extension');
  if (!exts.length) { showToast('No extensions to remove', 'error'); return; }
  try {
    const newHrs = machine.session.planned_hours - 0.25;
    await api('PUT', `/api/sessions/${sessionId}`, { planned_hours: newHrs });
    showToast('Extension removed', 'success');
    const data = await api('GET', '/api/machines');
    state.machines = data.machines;
    openMachineModal(machineId);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function checkout(sessionId) {
  const _custEl    = document.getElementById('custom-amount');
  const hasCustom  = _custEl?.value !== '';
  const customAmt  = hasCustom ? (parseFloat(_custEl.value) || 0) : null;
  const customComment = (document.getElementById('custom-comment')?.value || '').trim();
  if (hasCustom && !customComment) {
    showToast('Please enter a comment for the custom amount', 'error');
    document.getElementById('custom-comment')?.focus();
    return;
  }

  // Save any pending orders first
  const machine = getMachineFromModal();
  if (machine?.session) {
    const hrs = parseFloat(document.getElementById('session-hours')?.value) || 1;
    const extCount = (machine.session.orders || []).filter(o => o.item_type === 'extension').length;
    const baseHours = machine.session.planned_hours - extCount * 0.25;
    const elapsed = (Date.now() - new Date(machine.session.start_time).getTime()) / 3600000;
    const pending = Object.entries(state.pendingOrders).filter(([, qty]) => qty > 0);
    try {
      if (hrs !== baseHours) {
        const safeHrs = Math.max(hrs, Math.ceil(elapsed));
        await api('PUT', `/api/sessions/${sessionId}`, { planned_hours: safeHrs });
      }
      if (pending.length > 0 && state.menu) {
        for (const [name, qty] of pending) {
          await api('POST', `/api/sessions/${sessionId}/orders`, {
            item_name: name,
            item_type: state.menu.chips.some(c => c.name === name) ? 'chips' : 'drinks',
            quantity:  qty,
          });
        }
      }
    } catch { /* ignore — proceed to checkout */ }
  }

  // Determine effective total for payment modal
  const total = customAmt > 0
    ? customAmt
    : parseFloat(document.getElementById('running-total')?.textContent?.replace(/[^\d.]/g, '')) || 0;

  // Reset button — disabled until user enters an amount
  const payBtn = document.getElementById('payment-confirm-btn');
  if (payBtn) { payBtn.disabled = true; payBtn.textContent = 'End Session'; }

  // Store checkout context and open payment modal
  state.pendingCheckout = { sessionId, customAmt, customComment, hasCustom };
  document.getElementById('payment-total-val').textContent = `₹${total.toFixed(0)}`;
  document.getElementById('pay-cash').value = '';
  document.getElementById('pay-online').value = '';
  document.getElementById('payment-modal').classList.add('active');
}

async function confirmPayment() {
  const { sessionId, customAmt, customComment, hasCustom } = state.pendingCheckout || {};
  if (!sessionId) return;

  const total     = parseFloat(document.getElementById('payment-total-val')?.textContent?.replace(/[^\d.]/g, '')) || 0;
  const cashRaw   = parseFloat(document.getElementById('pay-cash')?.value) || 0;
  const onlineAmt = parseFloat(document.getElementById('pay-online')?.value) || 0;
  const cashAmt   = Math.min(cashRaw, total);

  const btn = document.getElementById('payment-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Processing…';

  try {
    const body = {
      ...(hasCustom ? { custom_amount: customAmt, custom_comment: customComment } : {}),
      ...(cashAmt   > 0 ? { cash_amount: cashAmt }     : {}),
      ...(onlineAmt > 0 ? { online_amount: onlineAmt } : {}),
    };
    const data = await api('POST', `/api/sessions/${sessionId}/checkout`, Object.keys(body).length ? body : undefined);
    closeModal('payment-modal');
    closeModal('machine-modal');
    showInvoice(data.invoice);
    await loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'End Session';
  }
}

function onPaymentInput(source) {
  const total     = parseFloat(document.getElementById('payment-total-val')?.textContent?.replace(/[^\d.]/g, '')) || 0;
  const cashEl    = document.getElementById('pay-cash');
  const onlineEl  = document.getElementById('pay-online');
  const changeRow = document.getElementById('change-row');
  const changeVal = document.getElementById('change-val');

  if (source === 'cash') {
    const cash = Math.max(parseFloat(cashEl.value) || 0, 0);
    if (cash > total) {
      onlineEl.value = '';
      const change = cash - total;
      if (changeRow) changeRow.style.display = 'flex';
      if (changeVal) changeVal.textContent = `₹${Math.round(change)}`;
    } else {
      onlineEl.value = parseFloat((total - cash).toFixed(2)) || '';
      if (changeRow) changeRow.style.display = 'none';
    }
  } else {
    const online = Math.min(Math.max(parseFloat(onlineEl.value) || 0, 0), total);
    onlineEl.value = online;
    cashEl.value   = parseFloat((total - online).toFixed(2)) || '';
    if (changeRow) changeRow.style.display = 'none';
  }

  const cash   = parseFloat(cashEl.value)   || 0;
  const online = parseFloat(onlineEl.value) || 0;
  const btn = document.getElementById('payment-confirm-btn');
  if (btn) btn.disabled = total > 0 && (cash + online) <= 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVOICE
// ═══════════════════════════════════════════════════════════════════════════════
function showInvoice(inv) {
  const start  = new Date(inv.start_time);
  const end    = new Date(inv.end_time);
  const isPS5  = inv.machine_type === 'PS5';

  const ordersHtml = inv.orders.length > 0
    ? `
      <table class="invoice-table">
        ${inv.orders.map(o => `
          <tr>
            <td>${o.item_name}</td>
            <td style="color:var(--text-muted);text-align:center">×${o.quantity}</td>
            <td>₹${(o.quantity * o.unit_price).toFixed(0)}</td>
          </tr>
        `).join('')}
      </table>
    `
    : '<p style="color:var(--text-muted);font-size:0.85rem;">No items ordered</p>';

  document.getElementById('invoice-body').innerHTML = `
    <div class="invoice-header">
      <div class="invoice-logo">The Site</div>
      <div class="invoice-sub">Gaming Cafe · Tax Invoice</div>
      <div class="invoice-machine">${isPS5 ? '🎮' : '💻'} ${inv.machine_id.replace('PS', 'PlayStation ')}</div>
      ${inv.customer_name ? `<div style="color:var(--text-muted);font-size:0.85rem;">Customer: ${inv.customer_name}</div>` : ''}
      ${isPS5 ? `<div style="color:var(--secondary);font-size:0.82rem;margin-top:4px;">Players: ${inv.players || 1}</div>` : ''}
    </div>

    <div class="invoice-section">
      <h4>Session Details</h4>
      <table class="invoice-table">
        <tr><td>Start Time</td><td>${fmt12(start)} on ${fmtDate(start)}</td></tr>
        <tr><td>End Time</td><td>${fmt12(end)}</td></tr>
        <tr><td>Duration</td><td>${fmtHrs(inv.actual_hours)} (actual)</td></tr>
        <tr><td>Billed Hours</td><td>${fmtHrs(inv.billable_hours)}</td></tr>
        <tr><td>Rate</td><td>₹${inv.rate_per_hour}/hr</td></tr>
        ${inv.discount_pct > 0 ? `<tr><td style="color:var(--warning)">Discount</td><td style="color:var(--warning)">-${inv.discount_pct}% (3h+ offer)</td></tr>` : ''}
        <tr>
          <td><strong>Session Subtotal</strong></td>
          <td><strong>₹${inv.session_cost.toFixed(0)}</strong></td>
        </tr>
      </table>
    </div>

    <div class="invoice-section">
      <h4>Food &amp; Beverages</h4>
      ${ordersHtml}
      ${inv.order_total > 0 ? `
        <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:0.88rem;font-weight:700;">
          <span>Items Subtotal</span>
          <span>₹${inv.order_total.toFixed(0)}</span>
        </div>
      ` : ''}
    </div>

    <div class="invoice-total">
      <span>Grand Total</span>
      <span>₹${inv.grand_total.toFixed(0)}</span>
    </div>
    ${inv.custom_amount != null ? `
    <div style="margin-top:8px;padding:8px 10px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:6px;">
      <div style="color:#f59e0b;font-size:0.78rem;font-weight:700;letter-spacing:0.05em;">OVERRIDE APPLIED</div>
      <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:0.85rem;">
        <span style="color:var(--text-muted)">Custom charge</span>
        <span style="color:#f59e0b;font-weight:700;">₹${inv.custom_amount.toFixed(0)}</span>
      </div>
      ${inv.custom_comment ? `<div style="margin-top:6px;color:var(--text-muted);font-size:0.78rem;font-style:italic;">Reason: ${inv.custom_comment}</div>` : ''}
    </div>
    ` : ''}
    ${(inv.cash_amount || inv.online_amount) ? `
    <div style="display:flex;gap:16px;margin-top:8px;font-size:0.82rem;color:var(--text-muted);">
      ${inv.cash_amount   ? `<span>Cash ₹${inv.cash_amount.toFixed(0)}</span>`     : ''}
      ${inv.online_amount ? `<span>Online ₹${inv.online_amount.toFixed(0)}</span>` : ''}
    </div>
    ` : ''}

    <div class="invoice-actions">
      <button class="btn-secondary" style="flex:1"
        onclick="closeModal('invoice-modal'); loadDashboard();">Close</button>
      <button class="btn-primary" style="flex:1" onclick="window.print()">
        Print Receipt
      </button>
    </div>
  `;

  document.getElementById('invoice-modal').classList.add('active');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYTICS — TABS & PERIOD
// ═══════════════════════════════════════════════════════════════════════════════
state.analyticsTab    = 'sessions';
state.analyticsPeriod = '1D';

function switchAnalyticsTab(tab) {
  state.analyticsTab = tab;
  document.querySelectorAll('.analytics-tab').forEach(t =>
    t.classList.toggle('active', t.id === `tab-${tab}`)
  );
  document.querySelectorAll('.analytics-pane').forEach(p =>
    p.classList.toggle('active', p.id === `analytics-pane-${tab}`)
  );
  if (tab === 'sessions')     loadSessionCards();
  else if (tab === 'charts') loadCharts();
  else                       loadAnalytics();
}

function setAnalyticsPeriod(period) {
  state.analyticsPeriod = period;
  document.querySelectorAll('.period-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.period === period)
  );
  const customRange = document.getElementById('custom-date-range');
  if (customRange) customRange.style.display = period === 'custom' ? 'flex' : 'none';
  if (period !== 'custom') loadSessionCards();
}

// ── Send Report ──────────────────────────────────────────────────────────────
async function sendDailyReport() {
  const btn    = document.getElementById('send-report-btn');
  const period = state.analyticsPeriod || '1D';
  const isSessionsTab = state.analyticsTab === 'sessions';

  let payload, label;
  if (isSessionsTab && period === 'custom') {
    const from = document.getElementById('custom-from')?.value;
    const to   = document.getElementById('custom-to')?.value;
    if (!from || !to) { showToast('Select a custom date range first', 'error'); return; }
    payload = { from, to };
    label   = `${from} to ${to}`;
  } else if (isSessionsTab && period !== '1D') {
    payload = { period };
    label   = period === '1W' ? 'Last 7 days' : period === '1M' ? 'Last 30 days' : 'Last year';
  } else {
    const dateStr = isSessionsTab
      ? new Date().toISOString().split('T')[0]
      : (document.getElementById('analytics-date')?.value || new Date().toISOString().split('T')[0]);
    payload = { date: dateStr };
    label   = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  setLoading(btn, true);
  try {
    const result = await api('POST', '/api/report/send', payload);
    if (result.skipped) {
      showToast('Email not configured on server — check console', 'error');
    } else {
      showToast(`Report (${label}) sent ✓`, 'success');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setLoading(btn, false);
  }
}

// ── Charts Tab ───────────────────────────────────────────────────────────────
const CHART_COLORS = {
  pc:      '#A6FF00',
  ps5:     '#831EFF',
  fnd:     '#f59e0b',
  regular: '#A6FF00',
  newCust: '#831EFF',
  bar:     'rgba(166,255,0,0.8)',
  barBorder: '#A6FF00',
};

function destroyChart(key) {
  if (state.charts?.[key]) { state.charts[key].destroy(); state.charts[key] = null; }
}

function setChartPeriod(period) {
  state.chartPeriod = period;
  document.querySelectorAll('.chart-period-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.period === period)
  );
  const cr = document.getElementById('chart-custom-range');
  if (cr) cr.style.display = period === 'custom' ? 'flex' : 'none';
  if (period !== 'custom') loadCharts();
}

function getChartDateRange(period) {
  const IST_MS = 5.5 * 60 * 60 * 1000;
  const nowIST  = new Date(Date.now() + IST_MS);
  const today   = nowIST.toISOString().split('T')[0];

  // Current Sun→Sat week in IST
  const todayUTC = new Date(today + 'T00:00:00Z');
  const dow      = todayUTC.getUTCDay();
  const sunDate  = new Date(todayUTC.getTime() - dow * 86400000);
  const satDate  = new Date(sunDate.getTime() + 6 * 86400000);
  const weekFrom = sunDate.toISOString().split('T')[0];
  const weekTo   = satDate.toISOString().split('T')[0];

  const y = nowIST.getUTCFullYear(), m = nowIST.getUTCMonth();
  const monthFrom = new Date(Date.UTC(y, m, 1)).toISOString().split('T')[0];
  const monthTo   = new Date(Date.UTC(y, m + 1, 0)).toISOString().split('T')[0];

  if (period === '1D') {
    // Pies: today only   Bar: current Sun→Sat
    return {
      pieRange: { from: today,    to: today   },
      barRange: { from: weekFrom, to: weekTo, groupBy: 'day' },
    };
  }
  if (period === '1W') {
    // Pies: current Sun→Sat   Bar: current month by week
    return {
      pieRange: { from: weekFrom,  to: weekTo   },
      barRange: { from: monthFrom, to: monthTo, groupBy: 'week' },
    };
  }
  if (period === '1M') {
    // Pies: current month   Bar: current quarter by month
    const qs    = Math.floor(m / 3) * 3;
    const qFrom = new Date(Date.UTC(y, qs,     1)).toISOString().split('T')[0];
    const qTo   = new Date(Date.UTC(y, qs + 3, 0)).toISOString().split('T')[0];
    return {
      pieRange: { from: monthFrom, to: monthTo },
      barRange: { from: qFrom,     to: qTo,     groupBy: 'month' },
    };
  }
  if (period === '1Y') {
    const yr = { from: `${y}-01-01`, to: `${y}-12-31` };
    return {
      pieRange: yr,
      barRange: { ...yr, groupBy: 'month' },
    };
  }
  if (period === 'custom') {
    const from = document.getElementById('chart-from')?.value;
    const to   = document.getElementById('chart-to')?.value;
    if (!from || !to) return null;
    return {
      pieRange: { from, to },
      barRange: { from, to, groupBy: 'day' },
    };
  }
  return null;
}

async function loadCharts() {
  if (!state.charts) state.charts = {};
  if (window.Chart) {
    Chart.defaults.color       = '#777';
    Chart.defaults.borderColor = '#2e2e2e';
    Chart.defaults.font.family = "'Segoe UI', Arial, sans-serif";
  }

  const period = state.chartPeriod || '1D';
  const ranges = getChartDateRange(period);
  if (!ranges) return;

  const { pieRange, barRange } = ranges;
  const sameRange = pieRange.from === barRange.from && pieRange.to === barRange.to;

  let pieData, barData;
  try {
    if (sameRange) {
      pieData = barData = await api('GET', `/api/analytics/range?from=${pieRange.from}&to=${pieRange.to}`);
    } else {
      [pieData, barData] = await Promise.all([
        api('GET', `/api/analytics/range?from=${pieRange.from}&to=${pieRange.to}`),
        api('GET', `/api/analytics/range?from=${barRange.from}&to=${barRange.to}`),
      ]);
    }
  } catch (err) {
    showToast(err.message, 'error');
    return;
  }

  renderRevenuePie(pieData.sessions, pieRange);
  renderCustomerPie(pieData.sessions, pieRange);
  renderPaymentPie(pieData.sessions, pieRange);
  renderBarChart(barData.sessions, barRange);
}

function fmtRangeLabel(range) {
  const fmt = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return `${fmt(range.from)} – ${fmt(range.to)}`;
}

function renderRevenuePie(sessions, range) {
  destroyChart('revPie');
  let pcRev = 0, ps5Rev = 0, fndRev = 0;
  sessions.forEach(s => {
    const gaming = s.custom_amount != null
      ? s.custom_amount
      : calcMixedCost(s.start_time, s.planned_hours, s.machine_type, s.players, s.free_half_hour);
    if (s.machine_type === 'PS5') ps5Rev += gaming;
    else                          pcRev  += gaming;
    fndRev += (s.order_total || 0);
  });

  const total = pcRev + ps5Rev + fndRev;
  const el = document.getElementById('chart-revenue-breakdown');
  if (!el) return;
  if (total === 0) { el.closest('.chart-canvas-wrap').innerHTML = '<div class="chart-loading">No data for this period</div>'; return; }

  const sub = document.getElementById('chart-rev-subtitle');
  if (sub) sub.textContent = `${fmtRangeLabel(range)} · PC ₹${Math.round(pcRev).toLocaleString('en-IN')} · PS5 ₹${Math.round(ps5Rev).toLocaleString('en-IN')} · F&B ₹${Math.round(fndRev).toLocaleString('en-IN')}`;

  state.charts.revPie = new Chart(el, {
    type: 'doughnut',
    data: {
      labels: ['PC', 'PlayStation', 'Food & Beverages'],
      datasets: [{
        data: [Math.round(pcRev), Math.round(ps5Rev), Math.round(fndRev)],
        backgroundColor: [CHART_COLORS.pc, CHART_COLORS.ps5, CHART_COLORS.fnd],
        borderColor: '#141414',
        borderWidth: 3,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#aaa', padding: 16, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: ctx => ` ₹${ctx.parsed.toLocaleString('en-IN')}  (${Math.round(ctx.parsed / total * 100)}%)`,
          },
        },
      },
    },
  });
}

function renderCustomerPie(sessions, range) {
  destroyChart('custPie');
  const counts = {};
  sessions.forEach(s => {
    const name = s.customer_name?.trim();
    if (!name) return;
    counts[name] = (counts[name] || 0) + 1;
  });
  let regular = 0, newCust = 0;
  Object.values(counts).forEach(c => { if (c > 1) regular++; else newCust++; });

  const el = document.getElementById('chart-customer-split');
  if (!el) return;
  if (regular + newCust === 0) { el.closest('.chart-canvas-wrap').innerHTML = '<div class="chart-loading">No named customers in this period</div>'; return; }

  const sub = document.getElementById('chart-cust-subtitle');
  if (sub) sub.textContent = `${fmtRangeLabel(range)} · ${regular + newCust} customers`;

  state.charts.custPie = new Chart(el, {
    type: 'doughnut',
    data: {
      labels: ['Regular', 'New'],
      datasets: [{
        data: [regular, newCust],
        backgroundColor: [CHART_COLORS.regular, CHART_COLORS.newCust],
        borderColor: '#141414',
        borderWidth: 3,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#aaa', padding: 16, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: ctx => {
              const total = regular + newCust;
              return ` ${ctx.parsed} customer${ctx.parsed !== 1 ? 's' : ''}  (${Math.round(ctx.parsed / total * 100)}%)`;
            },
          },
        },
      },
    },
  });
}

function renderPaymentPie(sessions, range) {
  destroyChart('payPie');
  let cash = 0, online = 0;
  sessions.forEach(s => {
    cash   += s.cash_amount   || 0;
    online += s.online_amount || 0;
  });

  const el = document.getElementById('chart-payment-split');
  if (!el) return;
  if (cash + online === 0) {
    el.closest('.chart-canvas-wrap').innerHTML = '<div class="chart-loading">No payment data for this period</div>';
    return;
  }

  const sub = document.getElementById('chart-payment-subtitle');
  if (sub) sub.textContent = `${fmtRangeLabel(range)} · Cash ₹${Math.round(cash).toLocaleString('en-IN')} · Online ₹${Math.round(online).toLocaleString('en-IN')}`;

  state.charts.payPie = new Chart(el, {
    type: 'doughnut',
    data: {
      labels: ['Cash', 'Online'],
      datasets: [{
        data: [Math.round(cash), Math.round(online)],
        backgroundColor: ['#f59e0b', '#38bdf8'],
        borderColor: '#141414',
        borderWidth: 3,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#aaa', padding: 16, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: ctx => {
              const total = cash + online;
              return ` ₹${ctx.parsed.toLocaleString('en-IN')}  (${Math.round(ctx.parsed / total * 100)}%)`;
            },
          },
        },
      },
    },
  });
}

function renderBarChart(sessions, { from, to, groupBy }) {
  destroyChart('weekBar');
  const IST_MS = 5.5 * 60 * 60 * 1000;

  const sessionRev = s => (s.custom_amount != null
    ? s.custom_amount
    : calcMixedCost(s.start_time, s.planned_hours, s.machine_type, s.players, s.free_half_hour) + (s.order_total || 0));

  let labels = [], values = [], subtitle = '', barTitle = 'Revenue';

  if (groupBy === 'day') {
    const dates = [];
    let cur = new Date(from + 'T00:00:00Z');
    const end = new Date(to + 'T00:00:00Z');
    while (cur <= end) { dates.push(cur.toISOString().split('T')[0]); cur = new Date(cur.getTime() + 86400000); }
    const rev = Object.fromEntries(dates.map(d => [d, 0]));
    sessions.forEach(s => {
      const day = new Date(new Date(s.start_time).getTime() + IST_MS).toISOString().split('T')[0];
      if (rev[day] !== undefined) rev[day] += sessionRev(s);
    });
    labels = dates.map(d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }));
    values = dates.map(d => Math.round(rev[d]));
    barTitle = 'Daily Revenue';
    subtitle = `${fmtRangeLabel({ from, to })} · ₹${values.reduce((a,b)=>a+b,0).toLocaleString('en-IN')} total`;
  }

  if (groupBy === 'week') {
    const [y, mo] = from.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const weeks = [];
    for (let d = 1; d <= daysInMonth; d += 7) {
      const last = Math.min(d + 6, daysInMonth);
      weeks.push({ start: d, end: last, label: `${d}–${last}` });
    }
    const rev = new Array(weeks.length).fill(0);
    sessions.forEach(s => {
      const dayNum = parseInt(new Date(new Date(s.start_time).getTime() + IST_MS).toISOString().split('T')[0].split('-')[2]);
      const wi = Math.min(Math.floor((dayNum - 1) / 7), weeks.length - 1);
      rev[wi] += sessionRev(s);
    });
    labels = weeks.map(w => w.label);
    values = rev.map(v => Math.round(v));
    barTitle = 'Weekly Revenue';
    const monthName = new Date(from + 'T12:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    subtitle = `${monthName} · ₹${values.reduce((a,b)=>a+b,0).toLocaleString('en-IN')} total`;
  }

  if (groupBy === 'month') {
    const monthKeys = [];
    let cur = new Date(from + 'T00:00:00Z');
    const end = new Date(to + 'T00:00:00Z');
    while (cur <= end) {
      const key = cur.toISOString().slice(0, 7);
      if (!monthKeys.includes(key)) monthKeys.push(key);
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    }
    const rev = Object.fromEntries(monthKeys.map(k => [k, 0]));
    sessions.forEach(s => {
      const key = new Date(new Date(s.start_time).getTime() + IST_MS).toISOString().slice(0, 7);
      if (rev[key] !== undefined) rev[key] += sessionRev(s);
    });
    labels = monthKeys.map(k => new Date(k + '-15T12:00:00Z').toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }));
    values = monthKeys.map(k => Math.round(rev[k]));
    barTitle = monthKeys.length <= 3 ? 'Quarterly Revenue' : 'Monthly Revenue';
    subtitle = `${fmtRangeLabel({ from, to })} · ₹${values.reduce((a,b)=>a+b,0).toLocaleString('en-IN')} total`;
  }

  const titleEl = document.getElementById('chart-bar-title');
  if (titleEl) titleEl.textContent = barTitle;
  const labelEl = document.getElementById('chart-week-label');
  if (labelEl) labelEl.textContent = subtitle;

  const el = document.getElementById('chart-weekly-revenue');
  if (!el) return;

  state.charts.weekBar = new Chart(el, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Revenue',
        data: values,
        backgroundColor: CHART_COLORS.bar,
        borderColor: CHART_COLORS.barBorder,
        borderWidth: 1.5,
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ₹${ctx.parsed.y.toLocaleString('en-IN')}` } },
      },
      scales: {
        x: { grid: { color: '#1e1e1e' }, ticks: { color: '#777', font: { size: 11 } } },
        y: {
          grid: { color: '#1e1e1e' },
          ticks: { color: '#777', font: { size: 11 }, callback: v => `₹${v.toLocaleString('en-IN')}` },
          beginAtZero: true,
        },
      },
    },
  });
}

// ── Sessions Tab ─────────────────────────────────────────────────────────────
async function loadSessionCards() {
  const period = state.analyticsPeriod || '1D';
  const container = document.getElementById('session-cards-container');
  if (!container) return;

  let endpoint;
  if (period === 'custom') {
    const from = document.getElementById('custom-from')?.value;
    const to   = document.getElementById('custom-to')?.value;
    if (!from || !to) {
      container.innerHTML = '<div class="no-data">Select a date range and click Apply.</div>';
      return;
    }
    endpoint = `/api/analytics/range?from=${from}&to=${to}`;
  } else {
    endpoint = `/api/analytics/range?period=${period}`;
  }

  container.innerHTML = '<div class="no-data" style="padding:32px 0;">Loading…</div>';
  try {
    const data = await api('GET', endpoint);
    renderSummaryCards(data.summary, period);
    renderSessionCards(data.sessions, period);
  } catch (err) {
    showToast(err.message, 'error');
    container.innerHTML = '<div class="no-data">Failed to load sessions.</div>';
  }
}

function renderSessionCards(sessions, period) {
  const container = document.getElementById('session-cards-container');
  if (!sessions.length) {
    container.innerHTML = '<div class="no-data">No sessions in this period.</div>';
    return;
  }

  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const fmtTime = iso => new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  });
  const fmtDate = iso => new Date(new Date(iso).getTime() + IST_OFFSET_MS)
    .toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

  state.sessionMap = {};
  sessions.forEach(s => { state.sessionMap[s.id] = s; });

  const groups = {};
  sessions.forEach(s => {
    const day = new Date(new Date(s.start_time).getTime() + IST_OFFSET_MS).toISOString().split('T')[0];
    if (!groups[day]) groups[day] = [];
    groups[day].push(s);
  });

  let html = '';
  Object.entries(groups).sort(([a], [b]) => b.localeCompare(a)).forEach(([day, daySessions]) => {
    const dayRevenue = daySessions.reduce((t, s) => {
      if (s.custom_amount != null) return t + s.custom_amount;
      return t + calcMixedCost(s.start_time, s.planned_hours, s.machine_type, s.players, s.free_half_hour) + (s.order_total || 0);
    }, 0);

    if (period !== '1D') {
      html += `<div class="session-day-header">
        <span>${fmtDate(day + 'T12:00:00Z')}</span>
        <span>₹${Math.round(dayRevenue).toLocaleString('en-IN')} · ${daySessions.length} session${daySessions.length > 1 ? 's' : ''}</span>
      </div>`;
    }

    const isSTARK = state.user?.username === 'STARK';
    daySessions.forEach(s => {
      const disc        = s.planned_hours >= 3 ? 0.10 : 0;
      const sessionCost = calcMixedCost(s.start_time, s.planned_hours, s.machine_type, s.players, s.free_half_hour);
      const total       = s.custom_amount != null ? s.custom_amount : sessionCost + (s.order_total || 0);
      const isPS5       = s.machine_type === 'PS5';
      const cash        = s.cash_amount || 0;
      const online      = s.online_amount || 0;
      let payBadge = '';
      if (cash > 0 && online > 0) {
        payBadge = `<span class="pay-badge split">Split</span>`;
      } else if (cash > 0) {
        payBadge = `<span class="pay-badge cash">Cash</span>`;
      } else if (online > 0) {
        payBadge = `<span class="pay-badge online">Online</span>`;
      }

      html += `<div class="session-card session-card-clickable" onclick="showSessionDetail(${s.id})">
        <div class="session-card-left">
          <span class="session-card-machine ${isPS5 ? 'ps5' : 'pc'}">${s.machine_id}</span>
          <div class="session-card-info">
            <span class="session-card-name">${s.customer_name?.trim() || 'Walk-in'}</span>
            <span class="session-card-time">${fmtTime(s.start_time)}${s.end_time ? ' – ' + fmtTime(s.end_time) : ''} · ${s.planned_hours}h</span>
            <span class="session-card-rate">${s.players || 1} Player${(s.players || 1) > 1 ? 's' : ''}${s.free_half_hour ? ' · ½hr free' : ''}${disc > 0 ? ' · -10%' : ''}</span>
          </div>
        </div>
        <div class="session-card-right">
          ${payBadge}
          <div class="session-card-total">₹${Math.round(total).toLocaleString('en-IN')}</div>
          ${isSTARK ? `<button class="session-delete-btn" onclick="event.stopPropagation(); deleteSession(${s.id})" title="Delete session">✕</button>` : ''}
        </div>
      </div>`;
    });
  });

  container.innerHTML = html;
}

function showSessionDetail(sessionId) {
  const s = state.sessionMap?.[sessionId];
  if (!s) return;

  const isPS5  = s.machine_type === 'PS5';
  const disc   = s.planned_hours >= 3 ? 0.10 : 0;
  const fhc    = s.free_half_hour ? s.rate_per_hour * 0.5 : 0;
  const sessionCost = Math.max(0, s.planned_hours * s.rate_per_hour * (1 - disc) - fhc);
  const orderTotal  = s.order_total || 0;
  const grandTotal  = s.custom_amount != null ? s.custom_amount : sessionCost + orderTotal;
  const cash   = s.cash_amount  || 0;
  const online = s.online_amount || 0;

  const fmtTime = iso => new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  });

  const badge = document.getElementById('session-detail-badge');
  if (badge) badge.textContent = s.status === 'active' ? 'Active' : 'Completed';

  document.getElementById('session-detail-body').innerHTML = `
    <div class="invoice-header">
      <div class="invoice-logo">The Site</div>
      <div class="invoice-sub">Gaming Cafe · Session Summary</div>
      <div class="invoice-machine">${isPS5 ? '🎮' : '💻'} ${s.machine_id.replace('PS', 'PlayStation ')}</div>
      ${s.customer_name?.trim() ? `<div style="color:var(--text-muted);font-size:0.85rem;margin-top:2px;">${s.customer_name.trim()}</div>` : ''}
      ${isPS5 ? `<div style="color:var(--secondary);font-size:0.82rem;margin-top:4px;">${s.players || 1} Player${(s.players||1)>1?'s':''}</div>` : ''}
    </div>

    <div class="invoice-section">
      <h4>Session Details</h4>
      <table class="invoice-table">
        <tr><td>Start</td><td>${fmtTime(s.start_time)}</td></tr>
        ${s.end_time ? `<tr><td>End</td><td>${fmtTime(s.end_time)}</td></tr>` : ''}
        <tr><td>Duration</td><td>${s.planned_hours}h</td></tr>
        <tr><td>Rate</td><td>₹${s.rate_per_hour}/hr</td></tr>
        ${disc > 0 ? `<tr><td style="color:var(--warning)">Discount</td><td style="color:var(--warning)">-${disc*100}% (3h+ offer)</td></tr>` : ''}
        ${s.free_half_hour ? `<tr><td style="color:var(--warning)">½hr Free</td><td style="color:var(--warning)">-₹${(s.rate_per_hour*0.5).toFixed(0)}</td></tr>` : ''}
        <tr><td><strong>Gaming Subtotal</strong></td><td><strong>₹${sessionCost.toFixed(0)}</strong></td></tr>
      </table>
    </div>

    ${orderTotal > 0 ? `
    <div class="invoice-section">
      <h4>Food &amp; Beverages</h4>
      <table class="invoice-table">
        <tr><td>F&amp;D Total</td><td>₹${orderTotal.toFixed(0)}</td></tr>
      </table>
    </div>` : ''}

    ${s.custom_amount != null ? `
    <div class="invoice-section">
      <h4>Custom Amount</h4>
      <div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:var(--radius);padding:10px 12px;font-size:0.85rem;">
        <div style="color:#f59e0b;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Override applied</div>
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="color:var(--text-muted);">Calculated was ₹${(sessionCost + orderTotal).toFixed(0)}</span>
          <span style="color:#f59e0b;font-weight:700;font-size:1rem;">₹${s.custom_amount.toFixed(0)}</span>
        </div>
        ${s.custom_comment ? `<div style="margin-top:6px;color:var(--text-muted);font-size:0.78rem;font-style:italic;">Reason: ${s.custom_comment}</div>` : ''}
      </div>
    </div>` : ''}

    <div class="invoice-total">
      <span>Grand Total</span>
      <span>₹${grandTotal.toFixed(0)}</span>
    </div>

    ${(cash > 0 || online > 0) ? `
    <div style="display:flex;gap:10px;margin-top:10px;">
      ${cash > 0 ? `
      <div style="flex:1;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.25);border-radius:var(--radius);padding:10px 14px;text-align:center;">
        <div style="color:#4ade80;font-size:0.7rem;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:4px;">Cash</div>
        <div style="color:#4ade80;font-size:1.05rem;font-weight:800;">₹${cash.toFixed(0)}</div>
      </div>` : ''}
      ${online > 0 ? `
      <div style="flex:1;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.25);border-radius:var(--radius);padding:10px 14px;text-align:center;">
        <div style="color:#818cf8;font-size:0.7rem;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:4px;">Online</div>
        <div style="color:#818cf8;font-size:1.05rem;font-weight:800;">₹${online.toFixed(0)}</div>
      </div>` : ''}
    </div>` : ''}

    <div class="invoice-actions">
      <button class="btn-secondary" style="flex:1" onclick="closeModal('session-detail-modal')">Close</button>
    </div>
  `;

  document.getElementById('session-detail-modal').classList.add('active');
}

async function deleteSession(sessionId) {
  if (!confirm('Permanently delete this session from the database? This cannot be undone.')) return;
  try {
    await api('DELETE', `/api/sessions/${sessionId}`);
    showToast('Session deleted', 'success');
    loadSessionCards();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Graph Tab ────────────────────────────────────────────────────────────────
async function loadAnalytics() {
  const dateInput = document.getElementById('analytics-date');
  if (!dateInput) return;
  if (!dateInput.value) dateInput.value = new Date().toISOString().split('T')[0];
  const date = dateInput.value;

  try {
    const data = await api('GET', `/api/analytics?date=${date}`);
    renderSummaryCards(data.summary, '1D');
    renderOccupancyGrid(data.sessions, data.machines, date);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderSummaryCards(summary, period) {
  const periodLabels = { '1D': 'Today', '1W': '7-Day', '1M': '30-Day', '1Y': 'Yearly' };
  const label = periodLabels[period] || '';
  document.getElementById('s-sessions').textContent       = summary.total_sessions;
  document.getElementById('s-sessions-label').textContent = `${label} Sessions`;
  document.getElementById('s-revenue').textContent        = `₹${Math.round(summary.total_revenue).toLocaleString('en-IN')}`;
  document.getElementById('s-revenue-label').textContent  = `${label} Revenue`;
  document.getElementById('s-machines').textContent       = `${summary.machines_used}/8`;

  const cash   = summary.total_cash   || 0;
  const online = summary.total_online || 0;
  const breakdownEl = document.getElementById('payment-breakdown');
  if (cash > 0 || online > 0) {
    document.getElementById('s-cash').textContent   = `₹${Math.round(cash).toLocaleString('en-IN')}`;
    document.getElementById('s-online').textContent = `₹${Math.round(online).toLocaleString('en-IN')}`;
    breakdownEl.style.display = 'flex';
  } else {
    breakdownEl.style.display = 'none';
  }
}

function renderOccupancyGrid(sessions, machines, date) {
  const container = document.getElementById('occupancy-grid');
  if (!container) return;

  const OPEN_HOUR  = 5;
  const CLOSE_HOUR = 25.5;
  const TOTAL_MINS = (CLOSE_HOUR - OPEN_HOUR) * 60;
  const HOUR_H     = 64;
  const TOTAL_H    = Math.round(TOTAL_MINS / 60 * HOUR_H);

  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const dayBase = new Date(date + 'T00:00:00Z');
  dayBase.setTime(dayBase.getTime() - IST_OFFSET_MS + OPEN_HOUR * 3600000);

  const todayIST = new Date(Date.now() + IST_OFFSET_MS).toISOString().split('T')[0];
  let nowTopPx = -1;
  if (date === todayIST) {
    const minsFromOpen = (Date.now() - dayBase.getTime()) / 60000;
    if (minsFromOpen >= 0 && minsFromOpen <= TOTAL_MINS) nowTopPx = minsFromOpen / 60 * HOUR_H;
  }

  const machineTypeMap = {};
  machines.forEach(m => { machineTypeMap[m.id] = m.type; });
  const machineIds = machines.map(m => m.id);

  const byMachine = {};
  machineIds.forEach(id => { byMachine[id] = []; });
  sessions.forEach(s => { if (byMachine[s.machine_id]) byMachine[s.machine_id].push(s); });

  const fmtMin = totalMin => {
    const h    = Math.floor(totalMin / 60) % 24;
    const m    = totalMin % 60;
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12  = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  };

  let hourLabelsHtml = '';
  let hourLinesHtml  = '';
  for (let i = 0; i <= Math.ceil(CLOSE_HOUR - OPEN_HOUR); i++) {
    const topPx   = i * HOUR_H;
    const absHour = OPEN_HOUR + i;
    const dh      = absHour >= 24 ? absHour - 24 : absHour;
    const ampm    = dh < 12 ? 'AM' : 'PM';
    const h12     = dh === 0 ? 12 : dh > 12 ? dh - 12 : dh;
    hourLabelsHtml += `<div class="cal-hour-label" style="top:${topPx}px">${h12} ${ampm}</div>`;
    hourLinesHtml  += `<div class="cal-hr-line" style="top:${topPx}px"></div>`;
    if (i < Math.ceil(CLOSE_HOUR - OPEN_HOUR))
      hourLinesHtml += `<div class="cal-half-line" style="top:${topPx + HOUR_H / 2}px"></div>`;
  }

  const machineColsHtml = machineIds.map(id => {
    const type = machineTypeMap[id];
    const cls  = type === 'PS5' ? 'cal-event-ps5' : 'cal-event-pc';
    const events = (byMachine[id] || []).map(s => {
      const startMs  = new Date(s.start_time).getTime();
      const endMs    = s.end_time ? new Date(s.end_time).getTime() : startMs + s.planned_hours * 3600000;
      const topPx    = Math.max(0, (startMs - dayBase.getTime()) / 60000 / 60 * HOUR_H);
      const heightPx = Math.max(24, (endMs - startMs) / 60000 / 60 * HOUR_H - 2);
      const startMin = OPEN_HOUR * 60 + Math.round((startMs - dayBase.getTime()) / 60000);
      const endMin   = OPEN_HOUR * 60 + Math.round((endMs   - dayBase.getTime()) / 60000);
      const name     = s.customer_name || 'Walk-in';
      const players  = type === 'PS5' && s.players > 1 ? ` · ${s.players}P` : '';
      return `<div class="cal-event ${cls}" style="top:${topPx.toFixed(1)}px;height:${heightPx.toFixed(1)}px;">
        <div class="cal-event-name">${name}${players}</div>
        <div class="cal-event-time">${fmtMin(startMin)} – ${fmtMin(endMin)}</div>
      </div>`;
    }).join('');
    return `<div class="cal-col">${events}</div>`;
  }).join('');

  const machineHeadersHtml = machineIds.map(id => {
    const type = machineTypeMap[id];
    return `<div class="cal-col-header ${type === 'PS5' ? 'ps5' : 'pc'}">${id.replace('PS', 'PS ')}</div>`;
  }).join('');

  const nowLineHtml = nowTopPx >= 0
    ? `<div class="cal-now-line" style="top:${nowTopPx.toFixed(1)}px"><div class="cal-now-dot"></div></div>`
    : '';

  container.innerHTML = `
    <div class="cal-wrap">
      <div class="cal-header-row">
        <div class="cal-gutter"></div>
        <div class="cal-machine-headers">${machineHeadersHtml}</div>
      </div>
      <div class="cal-scroll-body">
        <div class="cal-body" style="height:${TOTAL_H}px;">
          <div class="cal-time-axis">${hourLabelsHtml}</div>
          <div class="cal-content">
            <div class="cal-grid-lines">${hourLinesHtml}</div>
            <div class="cal-cols">${machineColsHtml}</div>
            ${nowLineHtml}
          </div>
        </div>
      </div>
    </div>
  `;

  const scrollBody = container.querySelector('.cal-scroll-body');
  if (scrollBody) {
    scrollBody.scrollTop = nowTopPx > 0 ? Math.max(0, nowTopPx - 120) : (9 - OPEN_HOUR) * HOUR_H;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function closeModal(modalId) {
  document.getElementById(modalId)?.classList.remove('active');
  state.pendingOrders = {};
}

function handleModalOverlayClick(e) {
  if (e.target === e.currentTarget) {
    closeModal(e.currentTarget.id);
    if (e.currentTarget.id === 'invoice-modal') loadDashboard();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════════════════════
function getMachine(machineId) {
  return state.machines.find(m => m.id === machineId || m.name === machineId);
}

function getMachineFromModal() {
  const titleText = document.getElementById('modal-title')?.textContent?.trim();
  return state.machines.find(m => m.name === titleText);
}

function fmt12(date) {
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
}

function fmtDate(date) {
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

function fmtHrs(hrs) {
  if (hrs < 1) return `${Math.round(hrs * 60)}m`;
  const h = Math.floor(hrs);
  const m = Math.round((hrs - h) * 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function slugify(str) {
  return str.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
}

function togglePwd(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
  btn.style.opacity = input.type === 'text' ? '1' : '0.5';
}

function setLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.dataset.label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Please wait…';
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.label || btn.textContent;
    delete btn.dataset.label;
  }
}

function showFormError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearFormErrors(...ids) {
  const targets = ids.length ? ids : ['login-error', 'reg-error', 'otp-error'];
  targets.forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = ''; el.classList.add('hidden'); }
  });
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="toast-icon"></div><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; }, 3500);
  setTimeout(() => toast.remove(), 3800);
}
