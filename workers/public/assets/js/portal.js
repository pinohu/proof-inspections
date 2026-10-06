/* Proof Inspections — customer portal.
 * Passwordless sign-in (email + 6-char code), order list, order detail.
 */
(function () {
  'use strict';

  var LS_TOKEN = 'pi_portal_token';
  var LS_EMAIL = 'pi_portal_email';

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function token() {
    try { return localStorage.getItem(LS_TOKEN) || ''; } catch (e) { return ''; }
  }
  function setToken(t) {
    try {
      if (t) localStorage.setItem(LS_TOKEN, t);
      else localStorage.removeItem(LS_TOKEN);
    } catch (e) {}
  }

  async function api(path, opts) {
    opts = opts || {};
    var headers = { 'Accept': 'application/json' };
    var t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    if (opts.body) headers['Content-Type'] = 'application/json';
    var res = await fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401) {
      setToken('');
      showSignin();
      throw new Error('signed out');
    }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Request failed');
    return data;
  }

  function show(id) {
    ['view-signin', 'view-orders', 'view-detail'].forEach(function (v) {
      $(v).hidden = v !== id;
    });
    $('nav-signout').hidden = id === 'view-signin';
    window.scrollTo(0, 0);
  }

  function showSignin() { show('view-signin'); }

  function alertBox(id, msg, kind) {
    var el = $(id);
    if (!msg) { el.className = 'form-alert'; el.textContent = ''; return; }
    el.className = 'form-alert show ' + (kind || 'error');
    el.textContent = msg;
  }

  /* ---------------- sign in ---------------- */

  var pendingEmail = '';

  $('form-email').addEventListener('submit', async function (e) {
    e.preventDefault();
    var email = $('in-email').value.trim();
    if (!email) { alertBox('signin-alert', 'Enter your email address.'); return; }
    alertBox('signin-alert', '');
    var btn = $('btn-send-code');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Sending…';
    try {
      await api('/auth/request-code', { method: 'POST', body: { email: email } });
      pendingEmail = email;
      try { localStorage.setItem(LS_EMAIL, email); } catch (err) {}
      $('code-email-label').textContent = email;
      $('step-email').hidden = true;
      $('step-code').hidden = false;
      $('in-code').focus();
    } catch (err) {
      alertBox('signin-alert', err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send sign-in code';
    }
  });

  $('form-code').addEventListener('submit', async function (e) {
    e.preventDefault();
    var code = $('in-code').value.trim();
    if (code.length < 6) { alertBox('code-alert', 'Enter the 6-character code from your email.'); return; }
    alertBox('code-alert', '');
    var btn = $('btn-verify-code');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Signing in…';
    try {
      var data = await api('/auth/verify-code', { method: 'POST', body: { email: pendingEmail, code: code } });
      setToken(data.token);
      await loadOrders();
    } catch (err) {
      alertBox('code-alert', err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  $('btn-resend').addEventListener('click', async function () {
    if (!pendingEmail) return;
    alertBox('code-alert', '');
    try {
      await api('/auth/request-code', { method: 'POST', body: { email: pendingEmail } });
      alertBox('code-alert', 'New code sent — check your email.', 'info');
    } catch (err) {
      alertBox('code-alert', err.message);
    }
  });

  $('nav-signout').addEventListener('click', async function () {
    try { await api('/auth/logout', { method: 'POST' }); } catch (e) {}
    setToken('');
    $('step-email').hidden = false;
    $('step-code').hidden = true;
    $('in-code').value = '';
    showSignin();
  });

  /* ---------------- order list ---------------- */

  var STATUS_LABEL = {
    pending: 'Order received',
    dispatched: 'Inspector dispatched',
    in_progress: 'Inspection in progress',
    complete: 'Report ready',
  };
  var STATUS_CLASS = {
    pending: 'wait',
    dispatched: 'wait',
    in_progress: 'live',
    complete: 'live',
  };

  function statusPill(status) {
    var label = STATUS_LABEL[status] || status;
    var cls = STATUS_CLASS[status] || 'wait';
    var live = status === 'in_progress' || status === 'complete';
    return '<span class="status-pill ' + cls + '">' +
      (live ? '<span class="pulse"></span>' : '') + esc(label) + '</span>';
  }

  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) { return ''; }
  }

  function fmtType(t) {
    var map = {
      insurance: 'Insurance', 'pre-listing': 'Pre-listing', 'rental-turnover': 'Rental turnover',
      'storm-damage': 'Storm damage', general: 'General condition',
    };
    return map[t] || t;
  }

  async function loadOrders() {
    show('view-orders');
    var list = $('orders-list');
    list.innerHTML = '<div class="spinner" style="margin:40px auto"></div>';
    $('orders-empty').hidden = true;
    try {
      var data = await api('/portal/orders');
      renderOrders(data.orders || []);
    } catch (err) {
      if (err.message === 'signed out') return;
      list.innerHTML = '<div class="error-state"><h3>Could not load your inspections</h3><p>' +
        esc(err.message) + '</p><button class="btn btn-secondary" onclick="location.reload()">Retry</button></div>';
    }
  }

  function renderOrders(orders) {
    var list = $('orders-list');
    if (!orders.length) {
      list.innerHTML = '';
      $('orders-empty').hidden = false;
      return;
    }
    $('orders-empty').hidden = true;
    list.innerHTML = orders.map(function (o) {
      return '<button class="order-card" data-id="' + esc(o.id) + '">' +
        '<div class="order-card-top">' + statusPill(o.status) +
        (o.paid ? '<span class="paid-badge">Paid</span>' : '<span class="paid-badge unpaid">Payment pending</span>') + '</div>' +
        '<div class="order-card-addr">' + esc(o.propertyAddress) + '</div>' +
        '<div class="order-card-meta">' + esc(fmtType(o.inspectionType)) + ' · Ordered ' + esc(fmtDate(o.createdAt)) + '</div>' +
        '<span class="order-card-go">View details →</span>' +
        '</button>';
    }).join('');
    list.querySelectorAll('.order-card').forEach(function (card) {
      card.addEventListener('click', function () { loadDetail(card.getAttribute('data-id')); });
    });
  }

  /* ---------------- order detail ---------------- */

  $('btn-back').addEventListener('click', loadOrders);

  var TIMELINE_LABEL = {
    created: ['Order placed', 'Your inspection request was received.'],
    paid: ['Payment confirmed', 'Payment received — your inspection is queued for dispatch.'],
    dispatched: ['Inspector dispatched', 'A licensed inspector has been assigned to your property.'],
    evidence_received: ['Evidence captured', 'The inspector documented the property. Photos are being sealed.'],
    completed: ['Report ready', 'Your signed proof bundle is ready below.'],
  };

  async function loadDetail(orderId) {
    show('view-detail');
    var box = $('detail-content');
    box.innerHTML = '<div class="spinner" style="margin:40px auto"></div>';
    try {
      var data = await api('/portal/orders/' + encodeURIComponent(orderId));
      renderDetail(data);
    } catch (err) {
      if (err.message === 'signed out') return;
      box.innerHTML = '<div class="error-state"><h3>Could not load this order</h3><p>' +
        esc(err.message) + '</p></div>';
    }
  }

  function renderDetail(data) {
    var o = data.order;
    var box = $('detail-content');
    var html = '<div class="detail-card"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:18px">' +
      '<h3 style="margin:0">' + esc(o.propertyAddress) + '</h3>' + statusPill(o.status) + '</div>' +
      '<div class="detail-grid">' +
      detailItem('Inspection type', esc(fmtType(o.inspectionType))) +
      detailItem('Ordered', esc(fmtDate(o.createdAt))) +
      detailItem('Order ID', '<code style="font-family:var(--mono);font-size:12.5px">' + esc(o.id.slice(0, 8)) + '…</code>') +
      detailItem('Payment', o.paid ? 'Paid ' + esc(fmtMoney(o.amountCents)) : 'Pending') +
      (o.contractorName ? detailItem('Inspector', esc(o.contractorName)) : '') +
      '</div></div>';

    // Timeline
    var timeline = data.timeline && data.timeline.length ? data.timeline : defaultTimeline(o);
    html += '<div class="timeline-card"><h3 style="margin:0 0 20px">Progress</h3><ul class="timeline">' +
      timeline.map(function (t) {
        var meta = TIMELINE_LABEL[t.event] || [t.event, t.detail || ''];
        return '<li class="done"><div class="tl-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>' +
          '<div class="tl-body"><h4>' + esc(meta[0]) + '</h4><p>' + esc(t.detail || meta[1]) + '</p>' +
          '<div class="tl-time">' + esc(fmtDateTime(t.createdAt)) + '</div></div></li>';
      }).join('') + '</ul></div>';

    // Proof bundle
    if (data.proof) {
      html += '<div class="proof-card-box"><div class="proof-box">' +
        '<h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>Your proof bundle is ready</h3>' +
        '<p>Every photo, timestamp, and GPS coordinate below is cryptographically signed. Download the bundle and verify it yourself — no trust required.</p>' +
        '<div class="digest-row"><span class="lbl">Digest</span><code>' + esc(data.proof.bundleHash) + '</code></div>' +
        '<div class="proof-actions">' +
        '<a class="btn btn-primary" href="' + esc(data.proof.proofUrl) + '" download>Download proof bundle</a>' +
        '<a class="btn btn-secondary" href="/track/' + esc(o.id) + '">Open tracking page</a>' +
        '</div></div></div>';
    } else if (o.status === 'complete') {
      html += '<div class="detail-card"><p style="margin:0;color:var(--muted)">Your report is being finalized — the proof bundle will appear here shortly.</p></div>';
    }

    box.innerHTML = html;
  }

  function detailItem(k, v) {
    return '<div class="detail-item"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
  }

  function defaultTimeline(o) {
    var t = [{ event: 'created', detail: null, createdAt: o.createdAt }];
    return t;
  }

  function fmtMoney(cents) {
    return '$' + (Number(cents || 0) / 100).toFixed(2);
  }

  function fmtDateTime(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  /* ---------------- init ---------------- */

  (function init() {
    var savedEmail = '';
    try { savedEmail = localStorage.getItem(LS_EMAIL) || ''; } catch (e) {}
    if (savedEmail) $('in-email').value = savedEmail;
    if (token()) {
      loadOrders().catch(function () { showSignin(); });
    } else {
      showSignin();
    }
  })();
})();
