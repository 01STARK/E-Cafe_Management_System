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
    if (state.analyticsTab === 'graph') loadAnalytics();
    else loadSessionCards();
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
      <input type="text" id="customer-name" placeholder="Walk-in customer" maxlength="60" />
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
  const sessionCost = Math.max(0, baseHours * s.rate_per_hour * (1 - discount) - freeHalf);
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
          <label>Extend <span style="color:var(--text-dim)">(× 15 min · ₹15)</span></label>
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
        <div class="menu-category"><h5>Chips</h5>${chipsHtml}</div>
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
  const discount    = hrs >= 3 ? 0.10 : 0;
  const freeHalf    = machine.session.free_half_hour ? machine.session.rate_per_hour * 0.5 : 0;
  const sessionCost = Math.max(0, hrs * machine.session.rate_per_hour * (1 - discount) - freeHalf);
  const el = document.getElementById('session-cost-label');
  const eh = document.getElementById('session-cost-hrs');
  const ev = document.getElementById('session-cost-val');
  if (el) el.innerHTML = `Session${discount > 0 ? ' <span style="color:var(--warning);font-size:0.7rem">-10%</span>' : ''}${freeHalf > 0 ? ' <span style="color:var(--warning);font-size:0.7rem">½free</span>' : ''}`;
  if (eh) eh.textContent = `${hrs}h`;
  if (ev) ev.innerHTML = `${(freeHalf > 0 || discount > 0) ? `<span style="text-decoration:line-through;color:var(--text-muted);font-size:0.8rem;margin-right:2px;">₹${(hrs * machine.session.rate_per_hour).toFixed(0)}</span>` : ''}₹${sessionCost.toFixed(0)}`;
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
  const discount    = baseHrs >= 3 ? 0.10 : 0;
  const sessionCost = baseHrs * s.rate_per_hour * (1 - discount);
  const prevOrders   = (s.orders || []).reduce((t, o) => t + o.quantity * o.unit_price, 0);
  const pendingCost  = calcPendingCost();

  const totalEl    = document.getElementById('running-total');
  const checkoutEl = document.getElementById('checkout-total');
  const pendingRow = document.getElementById('pending-orders-row');
  const pendingVal = document.getElementById('pending-orders-val');

  const customAmt = parseFloat(document.getElementById('custom-amount')?.value) || 0;
  const displayTotal = customAmt > 0 ? `₹${customAmt.toFixed(0)}` : `₹${(sessionCost + prevOrders + pendingCost).toFixed(0)}`;

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
  const customAmt = parseFloat(document.getElementById('custom-amount')?.value) || 0;
  const customComment = (document.getElementById('custom-comment')?.value || '').trim();
  if (customAmt > 0 && !customComment) {
    showToast('Please enter a comment for the custom amount', 'error');
    document.getElementById('custom-comment')?.focus();
    return;
  }

  // Save any pending orders first
  const machine = getMachineFromModal();
  if (machine?.session) {
    const hrs = parseFloat(document.getElementById('session-hours')?.value);
    const pending = Object.entries(state.pendingOrders).filter(([, qty]) => qty > 0);
    try {
      if (hrs) await api('PUT', `/api/sessions/${sessionId}`, { planned_hours: hrs });
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

  // Store checkout context and open payment modal
  state.pendingCheckout = { sessionId, customAmt, customComment };
  document.getElementById('payment-total-val').textContent = `₹${total.toFixed(0)}`;
  document.getElementById('pay-cash').value = total.toFixed(0);
  document.getElementById('pay-online').value = 0;
  document.getElementById('payment-modal').classList.add('active');
}

async function confirmPayment() {
  const { sessionId, customAmt, customComment } = state.pendingCheckout || {};
  if (!sessionId) return;

  const cashAmt   = parseFloat(document.getElementById('pay-cash')?.value) || 0;
  const onlineAmt = parseFloat(document.getElementById('pay-online')?.value) || 0;

  const btn = document.getElementById('payment-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Processing…';

  try {
    const body = {
      ...(customAmt > 0 ? { custom_amount: customAmt, custom_comment: customComment } : {}),
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
  const total = parseFloat(document.getElementById('payment-total-val')?.textContent?.replace(/[^\d.]/g, '')) || 0;
  const cashEl   = document.getElementById('pay-cash');
  const onlineEl = document.getElementById('pay-online');
  if (source === 'cash') {
    const cash = Math.min(Math.max(parseFloat(cashEl.value) || 0, 0), total);
    cashEl.value   = cash;
    onlineEl.value = parseFloat((total - cash).toFixed(2));
  } else {
    const online = Math.min(Math.max(parseFloat(onlineEl.value) || 0, 0), total);
    onlineEl.value = online;
    cashEl.value   = parseFloat((total - online).toFixed(2));
  }
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
      <h4>Food &amp; Drinks</h4>
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
  if (tab === 'sessions') loadSessionCards();
  else                    loadAnalytics();
}

function setAnalyticsPeriod(period) {
  state.analyticsPeriod = period;
  document.querySelectorAll('.period-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.period === period)
  );
  loadSessionCards();
}

// ── Send Report ──────────────────────────────────────────────────────────────
async function sendDailyReport() {
  const btn    = document.getElementById('send-report-btn');
  const period = state.analyticsPeriod || '1D';
  const isSessionsTab = state.analyticsTab === 'sessions';

  let payload, label;
  if (isSessionsTab && period !== '1D') {
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

// ── Sessions Tab ─────────────────────────────────────────────────────────────
async function loadSessionCards() {
  const period = state.analyticsPeriod || '1D';
  const container = document.getElementById('session-cards-container');
  if (!container) return;
  container.innerHTML = '<div class="no-data" style="padding:32px 0;">Loading…</div>';

  try {
    const data = await api('GET', `/api/analytics/range?period=${period}`);
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

  const groups = {};
  sessions.forEach(s => {
    const day = new Date(new Date(s.start_time).getTime() + IST_OFFSET_MS).toISOString().split('T')[0];
    if (!groups[day]) groups[day] = [];
    groups[day].push(s);
  });

  let html = '';
  Object.entries(groups).sort(([a], [b]) => b.localeCompare(a)).forEach(([day, daySessions]) => {
    const dayRevenue = daySessions.reduce((t, s) => {
      const disc = s.planned_hours >= 3 ? 0.10 : 0;
      const fhc  = s.free_half_hour ? s.rate_per_hour * 0.5 : 0;
      return t + Math.max(0, s.planned_hours * s.rate_per_hour * (1 - disc) - fhc) + (s.order_total || 0);
    }, 0);

    if (period !== '1D') {
      html += `<div class="session-day-header">
        <span>${fmtDate(day + 'T12:00:00Z')}</span>
        <span>₹${Math.round(dayRevenue).toLocaleString('en-IN')} · ${daySessions.length} session${daySessions.length > 1 ? 's' : ''}</span>
      </div>`;
    }

    daySessions.forEach(s => {
      const disc        = s.planned_hours >= 3 ? 0.10 : 0;
      const fhc         = s.free_half_hour ? s.rate_per_hour * 0.5 : 0;
      const sessionCost = Math.max(0, s.planned_hours * s.rate_per_hour * (1 - disc) - fhc);
      const total       = sessionCost + (s.order_total || 0);
      const isPS5       = s.machine_type === 'PS5';

      html += `<div class="session-card">
        <div class="session-card-left">
          <span class="session-card-machine ${isPS5 ? 'ps5' : 'pc'}">${s.machine_id}</span>
          <div class="session-card-info">
            <span class="session-card-name">${s.customer_name?.trim() || 'Walk-in'}</span>
            <span class="session-card-time">${fmtTime(s.start_time)}${s.end_time ? ' – ' + fmtTime(s.end_time) : ''} · ${s.planned_hours}h</span>
            <span class="session-card-rate">${s.players || 1} Player${(s.players || 1) > 1 ? 's' : ''}${s.free_half_hour ? ' · ½hr free' : ''}${disc > 0 ? ' · -10%' : ''}</span>
          </div>
        </div>
        <div class="session-card-total">₹${Math.round(total).toLocaleString('en-IN')}</div>
      </div>`;
    });
  });

  container.innerHTML = html;
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

  if (!sessions.length) {
    container.innerHTML = '<div class="no-data">No sessions recorded for this date.</div>';
    return;
  }

  // Time slots: 5:00 AM to 1:30 AM next day IST = 20.5 hours × 2 = 41 half-hour slots
  const OPEN_HOUR  = 5;     // 5 AM IST
  const CLOSE_HOUR = 25.5;  // 1:30 AM next day IST
  const SLOTS      = (CLOSE_HOUR - OPEN_HOUR) * 2; // 41

  // Build occupancy map: machine_id → Set<slot_index>
  const occupancy = {};
  machines.forEach(m => { occupancy[m.id] = new Set(); });

  // dayBase = 5:00 AM IST on the selected date (stored as UTC, IST = UTC+5:30)
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const dayBase = new Date(date + 'T00:00:00Z');
  dayBase.setTime(dayBase.getTime() - IST_OFFSET_MS + OPEN_HOUR * 3600000);

  sessions.forEach(s => {
    const startMs = new Date(s.start_time).getTime();
    const endMs   = s.end_time
      ? new Date(s.end_time).getTime()
      : startMs + s.planned_hours * 3600000;

    const startSlot = Math.floor((startMs - dayBase.getTime()) / (30 * 60000));
    const endSlot   = Math.ceil((endMs   - dayBase.getTime()) / (30 * 60000));

    for (let slot = Math.max(0, startSlot); slot < Math.min(SLOTS, endSlot); slot++) {
      if (occupancy[s.machine_id]) occupancy[s.machine_id].add(slot);
    }
  });

  // Determine machine type for coloring
  const machineTypeMap = {};
  machines.forEach(m => { machineTypeMap[m.id] = m.type; });

  // Build table
  const machineIds = machines.map(m => m.id);
  let html = `
    <div class="occ-grid-wrap">
      <div class="occ-legend">
        <div class="occ-legend-item"><div class="occ-legend-box pc"></div>PC Active</div>
        <div class="occ-legend-item"><div class="occ-legend-box ps5"></div>PS5 Active</div>
        <div class="occ-legend-item"><div class="occ-legend-box av"></div>Available</div>
      </div>
      <table class="occ-table">
        <thead>
          <tr>
            <th style="width:60px">Time</th>
            ${machineIds.map(id => `<th>${id.replace('PS', 'PS ')}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
  `;

  for (let slot = 0; slot < SLOTS; slot++) {
    const totalMinutes = OPEN_HOUR * 60 + slot * 30;
    const displayHour  = totalMinutes >= 1440
      ? Math.floor((totalMinutes - 1440) / 60)
      : Math.floor(totalMinutes / 60);
    const displayMin   = totalMinutes % 60;
    const ampm         = totalMinutes >= 1440
      ? (totalMinutes - 1440 < 720 ? 'AM' : 'PM')
      : (totalMinutes < 720 ? 'AM' : 'PM');
    const h12          = displayHour === 0 ? 12 : displayHour > 12 ? displayHour - 12 : displayHour;
    const timeLabel    = displayMin === 0
      ? `${h12}${ampm}`
      : `${h12}:${String(displayMin).padStart(2,'0')}`;

    const isHour = slot % 2 === 0;
    html += `<tr${isHour ? '' : ' style="opacity:0.6"'}>
      <td class="time-label">${timeLabel}</td>
      ${machineIds.map(id => {
        const isOcc = occupancy[id]?.has(slot);
        const type  = machineTypeMap[id];
        const cls   = isOcc ? (type === 'PS5' ? 'occ-ps5' : 'occ-pc') : '';
        return `<td><div class="occ-cell ${cls}"></div></td>`;
      }).join('')}
    </tr>`;
  }

  html += `</tbody></table></div>`;
  container.innerHTML = html;
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
