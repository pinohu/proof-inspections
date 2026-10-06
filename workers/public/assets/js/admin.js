/* Proof Inspections — admin dashboard
 * Vanilla JS. All data from the API; no placeholder content.
 */
(function () {
  "use strict";

  var TOKEN_KEY = "pi_admin_token";
  var EMAIL_KEY = "pi_admin_email";
  var PAGE_SIZE = 25;

  /* ---------------- helpers ---------------- */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function money(cents) {
    var n = Number(cents || 0) / 100;
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit"
    });
  }

  function shortId(id) {
    return String(id || "").slice(0, 8);
  }

  var STATUS_LABELS = {
    pending: "Pending",
    dispatched: "Dispatched",
    in_progress: "In progress",
    complete: "Complete"
  };

  function statusPill(status) {
    var key = String(status || "pending");
    var label = STATUS_LABELS[key] || key;
    return '<span class="pill pill-' + esc(key) + '">' + esc(label) + "</span>";
  }

  function paidBadge(paid) {
    return paid
      ? '<span class="paid-badge">Paid</span>'
      : '<span class="paid-badge unpaid">Unpaid</span>';
  }

  function loadingHTML(msg) {
    return '<div class="spin-row"><span class="spinner" aria-hidden="true"></span>' + esc(msg || "Loading…") + "</div>";
  }

  function emptyHTML(title, msg) {
    return '<div class="panel-empty"><h4>' + esc(title) + "</h4><p>" + esc(msg) + "</p></div>";
  }

  function errorHTML(title, msg) {
    return '<div class="panel-error"><h4>' + esc(title) + "</h4><p>" + esc(msg) + "</p>" +
      '<button type="button" class="btn btn-sm btn-primary retry-btn">Try again</button></div>';
  }

  function setAlert(el, kind, msg) {
    if (!el) return;
    el.className = "form-alert show " + (kind || "info");
    el.textContent = msg;
  }
  function clearAlert(el) {
    if (!el) return;
    el.className = "form-alert";
    el.textContent = "";
  }

  /* ---------------- API client ---------------- */

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function getEmail() { return localStorage.getItem(EMAIL_KEY); }

  function api(path, options) {
    options = options || {};
    var headers = { "Content-Type": "application/json" };
    var token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    return fetch(path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then(function (res) {
      if (res.status === 401) {
        signOut();
        var err = new Error("Your session expired. Please sign in again.");
        err.code = 401;
        throw err;
      }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var msg = (data && (data.error || data.message)) || ("Request failed (" + res.status + ")");
          var err2 = new Error(msg);
          err2.code = res.status;
          throw err2;
        }
        return data;
      });
    });
  }

  /* ---------------- auth ---------------- */

  var authView = $("#auth-view");
  var appView = $("#app-view");
  var stepEmail = $("#step-email");
  var stepCode = $("#step-code");

  function showAuth() {
    authView.hidden = false;
    appView.hidden = true;
  }

  function showApp() {
    authView.hidden = true;
    appView.hidden = false;
    $("#admin-email").textContent = getEmail() || "";
  }

  function signOut() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EMAIL_KEY);
    stepCode.hidden = true;
    stepEmail.hidden = false;
    var emailInput = $("#auth-email");
    var codeInput = $("#auth-code");
    if (emailInput) emailInput.value = "";
    if (codeInput) codeInput.value = "";
    clearAlert($("#email-alert"));
    clearAlert($("#code-alert"));
    showAuth();
  }

  var pendingEmail = "";

  function showStepCode(email) {
    pendingEmail = email;
    $("#code-email").textContent = email;
    stepEmail.hidden = true;
    stepCode.hidden = false;
    clearAlert($("#code-alert"));
    var codeInput = $("#auth-code");
    codeInput.value = "";
    setTimeout(function () { codeInput.focus(); }, 50);
  }

  function initAuth() {
    $("#email-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var email = $("#auth-email").value.trim();
      if (!email || email.indexOf("@") < 0) {
        setAlert($("#email-alert"), "error", "Enter a valid email address.");
        return;
      }
      var btn = $("#send-code-btn");
      btn.disabled = true;
      btn.textContent = "Sending…";
      clearAlert($("#email-alert"));
      api("/auth/request-code", { method: "POST", body: { email: email } })
        .then(function () { showStepCode(email); })
        .catch(function (err) {
          setAlert($("#email-alert"), "error", err.message || "Could not send the code. Try again.");
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = "Send code";
        });
    });

    $("#code-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var code = $("#auth-code").value.trim();
      if (code.length !== 6) {
        setAlert($("#code-alert"), "error", "Enter the 6-character code from your email.");
        return;
      }
      var btn = $("#verify-btn");
      btn.disabled = true;
      btn.textContent = "Signing in…";
      clearAlert($("#code-alert"));
      api("/auth/verify-code", { method: "POST", body: { email: pendingEmail, code: code } })
        .then(function (data) {
          if (data.role !== "admin") {
            setAlert($("#code-alert"), "error", "This account is not authorized for the admin dashboard.");
            return;
          }
          localStorage.setItem(TOKEN_KEY, data.token);
          localStorage.setItem(EMAIL_KEY, pendingEmail);
          boot();
        })
        .catch(function (err) {
          setAlert($("#code-alert"), "error", err.message || "That code didn't work. Try again.");
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = "Sign in";
        });
    });

    $("#back-to-email").addEventListener("click", function () {
      stepCode.hidden = true;
      stepEmail.hidden = false;
      clearAlert($("#email-alert"));
    });

    $("#signout-btn").addEventListener("click", signOut);
  }

  /* ---------------- tabs ---------------- */

  var loadedTabs = {};

  function switchTab(name) {
    $all(".tab-btn").forEach(function (btn) {
      var active = btn.dataset.tab === name;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    $all(".view").forEach(function (v) { v.classList.remove("active"); });
    $("#view-" + name).classList.add("active");
    if (!loadedTabs[name]) {
      loadedTabs[name] = true;
      renderers[name]();
    }
  }

  function initTabs() {
    $all(".tab-btn").forEach(function (btn) {
      btn.addEventListener("click", function () { switchTab(btn.dataset.tab); });
    });
  }

  /* ---------------- overview ---------------- */

  function renderOverview() {
    var el = $("#view-overview");
    el.innerHTML =
      '<div class="view-head"><div><h2>Overview</h2><p>Live snapshot of orders, revenue, and pipeline.</p></div></div>' +
      '<div id="overview-body">' + loadingHTML("Loading overview…") + "</div>";

    function load() {
      api("/admin/overview").then(function (data) {
        var t = data.totals || {};
        var byStatus = t.byStatus || {};
        var orders = data.recentOrders || [];

        var kpis =
          '<div class="kpi-grid">' +
          kpi("Total orders", fmtNum(t.orders)) +
          kpi("Revenue (paid)", money(t.revenueCents), true) +
          kpi("Pending", fmtNum(byStatus.pending)) +
          kpi("In progress", fmtNum(byStatus.in_progress)) +
          kpi("Completed", fmtNum(byStatus.complete)) +
          "</div>";

        var chart = barChart(byStatus);

        var recent = orders.length
          ? '<div class="table-wrap"><table class="tbl"><thead><tr>' +
            "<th>Order</th><th>Property</th><th>Customer</th><th>Status</th><th>Amount</th>" +
            "</tr></thead><tbody>" +
            orders.map(function (o) {
              return "<tr>" +
                '<td class="mono">' + esc(shortId(o.id)) + "</td>" +
                '<td class="cell-main">' + esc(o.propertyAddress) + "</td>" +
                '<td><div class="cell-main">' + esc(o.customerName || "—") + '</div><div class="cell-sub">' + esc(o.customerEmail) + "</div></td>" +
                "<td>" + statusPill(o.status) + "</td>" +
                '<td class="num">' + money(o.amountCents) + "</td>" +
                "</tr>";
            }).join("") +
            "</tbody></table></div>"
          : emptyHTML("No orders yet", "New inspection orders will appear here.");

        el.innerHTML =
          '<div class="view-head"><div><h2>Overview</h2><p>Live snapshot of orders, revenue, and pipeline.</p></div></div>' +
          kpis +
          '<div class="panel-grid">' +
          '<div class="panel"><h3>Orders by status</h3>' + chart + "</div>" +
          '<div class="panel"><h3>Recent orders</h3>' + recent + "</div>" +
          "</div>";
      }).catch(function (err) {
        if (err.code === 401) return;
        el.innerHTML =
          '<div class="view-head"><div><h2>Overview</h2></div></div>' +
          errorHTML("Couldn't load overview", err.message || "Something went wrong.");
        bindRetry(el, load);
      });
    }

    load();
  }

  function fmtNum(n) {
    return Number(n || 0).toLocaleString("en-US");
  }

  function kpi(label, value, isMoney) {
    return '<div class="kpi-card"><div class="kpi-label">' + esc(label) + "</div>" +
      '<div class="kpi-value' + (isMoney ? " money" : "") + '">' + esc(value) + "</div></div>";
  }

  function barChart(byStatus) {
    var keys = ["pending", "dispatched", "in_progress", "complete"];
    var max = 1;
    keys.forEach(function (k) { max = Math.max(max, Number(byStatus[k] || 0)); });
    return '<div class="bar-chart">' + keys.map(function (k) {
      var count = Number(byStatus[k] || 0);
      var pct = Math.round((count / max) * 100);
      return '<div class="bar-row">' +
        '<div class="bar-name">' + esc(STATUS_LABELS[k]) + "</div>" +
        '<div class="bar-track"><div class="bar-fill b-' + esc(k) + '" style="width:' + pct + '%"></div></div>' +
        '<div class="bar-count">' + count + "</div>" +
        "</div>";
    }).join("") + "</div>";
  }

  function bindRetry(container, fn) {
    var btn = $(".retry-btn", container);
    if (btn) btn.addEventListener("click", function () {
      container.querySelectorAll(".panel-error").forEach(function (e) {
        e.outerHTML = loadingHTML("Loading…");
      });
      fn();
    });
  }

  /* ---------------- orders ---------------- */

  var ordersState = { q: "", status: "", offset: 0, total: 0, contractors: null };

  function renderOrders() {
    var el = $("#view-orders");
    el.innerHTML =
      '<div class="view-head"><div><h2>Orders</h2><p>Search, filter, and dispatch inspection orders.</p></div></div>' +
      '<div class="toolbar">' +
        '<div class="search-box">' +
          '<span class="search-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></span>' +
          '<input type="text" id="orders-q" placeholder="Search address, email, or order ID…" />' +
        "</div>" +
        '<select id="orders-status" aria-label="Filter by status">' +
          '<option value="">All statuses</option>' +
          '<option value="pending">Pending</option>' +
          '<option value="dispatched">Dispatched</option>' +
          '<option value="in_progress">In progress</option>' +
          '<option value="complete">Complete</option>' +
        "</select>" +
      "</div>" +
      '<div id="orders-body">' + loadingHTML("Loading orders…") + "</div>";

    var qInput = $("#orders-q");
    var statusSel = $("#orders-status");
    qInput.value = ordersState.q;
    statusSel.value = ordersState.status;

    var debounce = null;
    qInput.addEventListener("input", function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () {
        ordersState.q = qInput.value.trim();
        ordersState.offset = 0;
        loadOrders();
      }, 300);
    });
    statusSel.addEventListener("change", function () {
      ordersState.status = statusSel.value;
      ordersState.offset = 0;
      loadOrders();
    });

    loadOrders();
  }

  function loadOrders() {
    var body = $("#orders-body");
    body.innerHTML = loadingHTML("Loading orders…");

    var params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(ordersState.offset)
    });
    if (ordersState.q) params.set("q", ordersState.q);
    if (ordersState.status) params.set("status", ordersState.status);

    var needContractors = ordersState.contractors === null;
    var contractorsP = needContractors
      ? api("/admin/contractors").then(function (d) { ordersState.contractors = d.contractors || []; })
      : Promise.resolve();

    Promise.all([api("/admin/orders?" + params.toString()), contractorsP])
      .then(function (results) {
        var data = results[0];
        var orders = data.orders || [];
        ordersState.total = Number(data.total || 0);
        renderOrdersTable(body, orders);
      })
      .catch(function (err) {
        if (err.code === 401) return;
        body.innerHTML = errorHTML("Couldn't load orders", err.message || "Something went wrong.");
        bindRetry(body, loadOrders);
      });
  }

  function renderOrdersTable(body, orders) {
    if (!orders.length) {
      body.innerHTML = emptyHTML("No orders found", "Try a different search or filter.");
      return;
    }

    var contractors = (ordersState.contractors || []).filter(function (c) { return c.active; });

    var rows = orders.map(function (o) {
      return "<tr>" +
        '<td class="mono">' + esc(shortId(o.id)) + "</td>" +
        '<td class="cell-main">' + esc(o.propertyAddress) + "</td>" +
        '<td><div class="cell-main">' + esc(o.customerName || "—") + '</div><div class="cell-sub">' + esc(o.customerEmail) + "</div></td>" +
        '<td class="cell-sub">' + esc(o.inspectionType || "—") + "</td>" +
        "<td>" + statusPill(o.status) + "</td>" +
        "<td>" + paidBadge(o.paid) + "</td>" +
        '<td class="cell-sub">' + esc(o.contractorName || "—") + "</td>" +
        '<td class="cell-sub">' + esc(fmtDate(o.createdAt)) + "</td>" +
        '<td><button type="button" class="btn-xs dispatch-toggle" data-order="' + esc(o.id) + '">Dispatch</button></td>' +
        "</tr>" +
        '<tr class="dispatch-row" data-dispatch-for="' + esc(o.id) + '" hidden>' +
        "<td colspan=\"9\">" +
          '<div class="dispatch-box">' +
            '<select aria-label="Choose contractor">' +
              '<option value="">Select contractor…</option>' +
              contractors.map(function (c) {
                var sel = o.contractorId && o.contractorId === c.id ? " selected" : "";
                return '<option value="' + esc(c.id) + '"' + sel + ">" + esc(c.name) + "</option>";
              }).join("") +
            "</select>" +
            '<button type="button" class="btn btn-primary btn-sm dispatch-confirm" data-order="' + esc(o.id) + '">Assign</button>' +
            '<button type="button" class="btn-xs dispatch-cancel">Cancel</button>' +
          "</div>" +
        "</td>" +
        "</tr>";
    }).join("");

    var total = ordersState.total;
    var start = total === 0 ? 0 : ordersState.offset + 1;
    var end = Math.min(ordersState.offset + PAGE_SIZE, total);

    body.innerHTML =
      '<div class="table-wrap"><table class="tbl"><thead><tr>' +
      "<th>Order</th><th>Property</th><th>Customer</th><th>Type</th>" +
      "<th>Status</th><th>Paid</th><th>Contractor</th><th>Created</th><th></th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
      '<div class="pagination">' +
        '<div class="page-info">' + start + "–" + end + " of " + total.toLocaleString("en-US") + " orders</div>" +
        '<div class="page-btns">' +
          '<button type="button" class="btn-xs" id="page-prev"' + (ordersState.offset === 0 ? " disabled" : "") + ">&larr; Prev</button>" +
          '<button type="button" class="btn-xs" id="page-next"' + (ordersState.offset + PAGE_SIZE >= total ? " disabled" : "") + ">Next &rarr;</button>" +
        "</div>" +
      "</div>";

    var prev = $("#page-prev", body);
    var next = $("#page-next", body);
    if (prev) prev.addEventListener("click", function () {
      ordersState.offset = Math.max(0, ordersState.offset - PAGE_SIZE);
      loadOrders();
    });
    if (next) next.addEventListener("click", function () {
      ordersState.offset += PAGE_SIZE;
      loadOrders();
    });

    $all(".dispatch-toggle", body).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var row = $('tr[data-dispatch-for="' + btn.dataset.order + '"]', body);
        if (row) row.hidden = !row.hidden;
      });
    });
    $all(".dispatch-cancel", body).forEach(function (btn) {
      btn.addEventListener("click", function () {
        btn.closest("tr").hidden = true;
      });
    });
    $all(".dispatch-confirm", body).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var row = btn.closest("tr");
        var sel = $("select", row);
        var contractorId = sel.value;
        if (!contractorId) {
          sel.focus();
          return;
        }
        btn.disabled = true;
        btn.textContent = "Assigning…";
        api("/admin/orders/" + encodeURIComponent(btn.dataset.order) + "/dispatch", {
          method: "POST",
          body: { contractor_id: contractorId }
        }).then(function () {
          loadOrders();
        }).catch(function (err) {
          btn.disabled = false;
          btn.textContent = "Assign";
          alert(err.message || "Dispatch failed. Try again.");
        });
      });
    });
  }

  /* ---------------- contractors ---------------- */

  function renderContractors() {
    var el = $("#view-contractors");
    el.innerHTML =
      '<div class="view-head"><div><h2>Contractors</h2><p>Manage who receives dispatched inspections.</p></div></div>' +
      '<form class="add-form" id="add-contractor-form">' +
        "<h3>Add contractor</h3>" +
        '<div class="field"><label for="c-name">Name</label><input type="text" id="c-name" placeholder="Jane Smith" required /></div>' +
        '<div class="field"><label for="c-email">Email</label><input type="email" id="c-email" placeholder="jane@example.com" required /></div>' +
        '<div class="field"><label for="c-phone">Phone</label><input type="tel" id="c-phone" placeholder="(814) 555-0100" /></div>' +
        '<div class="field"><label>&nbsp;</label><button type="submit" class="btn btn-primary btn-sm" id="add-c-btn">Add contractor</button></div>' +
        '<div class="form-alert" id="add-c-alert" style="grid-column:1/-1;margin-bottom:0" role="alert"></div>' +
      "</form>" +
      '<div id="contractors-body">' + loadingHTML("Loading contractors…") + "</div>";

    $("#add-contractor-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var name = $("#c-name").value.trim();
      var email = $("#c-email").value.trim();
      var phone = $("#c-phone").value.trim();
      if (!name || email.indexOf("@") < 0) {
        setAlert($("#add-c-alert"), "error", "Name and a valid email are required.");
        return;
      }
      var btn = $("#add-c-btn");
      btn.disabled = true;
      btn.textContent = "Adding…";
      clearAlert($("#add-c-alert"));
      api("/admin/contractors", {
        method: "POST",
        body: { name: name, email: email, phone: phone || undefined }
      }).then(function () {
        $("#c-name").value = "";
        $("#c-email").value = "";
        $("#c-phone").value = "";
        ordersState.contractors = null; // refresh dispatch dropdowns
        loadContractors();
      }).catch(function (err) {
        setAlert($("#add-c-alert"), "error", err.message || "Could not add contractor.");
      }).finally(function () {
        btn.disabled = false;
        btn.textContent = "Add contractor";
      });
    });

    loadContractors();
  }

  function loadContractors() {
    var body = $("#contractors-body");
    // Job stats live on the overview payload (contractorStats); the contractors
    // endpoint only carries identity + active flag.
    Promise.all([api("/admin/contractors"), api("/admin/overview")])
      .then(function (results) {
      var list = (results[0] && results[0].contractors) || [];
      var stats = ((results[1] && results[1].contractorStats) || []);
      var statsById = {};
      stats.forEach(function (s) {
        statsById[s.contractorId] = s;
      });
      ordersState.contractors = list;
      if (!list.length) {
        body.innerHTML = emptyHTML("No contractors yet", "Add your first contractor above to start dispatching orders.");
        return;
      }
      var rows = list.map(function (c) {
        var s = statsById[c.id] || {};
        return "<tr>" +
          '<td class="cell-main">' + esc(c.name) + "</td>" +
          '<td class="cell-sub">' + esc(c.email) + "</td>" +
          '<td class="cell-sub">' + esc(c.phone || "—") + "</td>" +
          '<td><label class="switch"><input type="checkbox" class="active-toggle" data-id="' + esc(c.id) + '"' +
            (c.active ? " checked" : "") + ' aria-label="Active: ' + esc(c.name) + '"><span class="track"></span></label></td>' +
          '<td class="num">' + fmtNum(s.assigned) + "</td>" +
          '<td class="num">' + fmtNum(s.completed) + "</td>" +
          '<td class="cell-sub">' + esc(fmtDate(c.createdAt)) + "</td>" +
          "</tr>";
      }).join("");
      body.innerHTML =
        '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        "<th>Name</th><th>Email</th><th>Phone</th><th>Active</th>" +
        "<th>Jobs assigned</th><th>Jobs completed</th><th>Added</th>" +
        "</tr></thead><tbody>" + rows + "</tbody></table></div>";

      $all(".active-toggle", body).forEach(function (toggle) {
        toggle.addEventListener("change", function () {
          var id = toggle.dataset.id;
          var active = toggle.checked;
          toggle.disabled = true;
          api("/admin/contractors/" + encodeURIComponent(id), {
            method: "PATCH",
            body: { active: active }
          }).then(function (data) {
            // keep local copy fresh for dispatch dropdowns
            if (data.contractor && ordersState.contractors) {
              ordersState.contractors = ordersState.contractors.map(function (c) {
                return c.id === data.contractor.id ? data.contractor : c;
              });
            }
          }).catch(function (err) {
            toggle.checked = !active;
            alert(err.message || "Could not update contractor.");
          }).finally(function () {
            toggle.disabled = false;
          });
        });
      });
    }).catch(function (err) {
      if (err.code === 401) return;
      body.innerHTML = errorHTML("Couldn't load contractors", err.message || "Something went wrong.");
      bindRetry(body, loadContractors);
    });
  }

  /* ---------------- emails ---------------- */

  function renderEmails() {
    var el = $("#view-emails");
    el.innerHTML =
      '<div class="view-head"><div><h2>Emails</h2><p>Recent transactional emails sent by the system. Read-only.</p></div></div>' +
      '<div id="emails-body">' + loadingHTML("Loading email log…") + "</div>";

    function load() {
      api("/admin/email-log?limit=50").then(function (data) {
        var body = $("#emails-body");
        var list = data.emails || [];
        if (!list.length) {
          body.innerHTML = emptyHTML("No emails logged yet", "System-sent emails will appear here.");
          return;
        }
        var rows = list.map(function (m) {
          var dot = m.status === "sent" ? "dot-sent" : m.status === "failed" ? "dot-failed" : "dot-queued";
          return "<tr>" +
            '<td class="cell-main">' + esc(m.toEmail) + "</td>" +
            '<td class="cell-sub">' + esc(m.template || "—") + "</td>" +
            '<td class="cell-main">' + esc(m.subject || "—") + "</td>" +
            '<td><span class="dot ' + dot + '" aria-hidden="true"></span><span class="cell-sub">' + esc(m.status || "—") + "</span></td>" +
            '<td class="cell-sub">' + esc(fmtDate(m.createdAt)) + "</td>" +
            "</tr>";
        }).join("");
        body.innerHTML =
          '<div class="table-wrap"><table class="tbl"><thead><tr>' +
          "<th>To</th><th>Template</th><th>Subject</th><th>Status</th><th>Time</th>" +
          "</tr></thead><tbody>" + rows + "</tbody></table></div>";
      }).catch(function (err) {
        if (err.code === 401) return;
        var body2 = $("#emails-body");
        body2.innerHTML = errorHTML("Couldn't load email log", err.message || "Something went wrong.");
        bindRetry(body2, load);
      });
    }

    load();
  }

  /* ---------------- boot ---------------- */

  var renderers = {
    overview: renderOverview,
    orders: renderOrders,
    contractors: renderContractors,
    emails: renderEmails
  };

  function boot() {
    showApp();
    loadedTabs = {};
    switchTab("overview");
  }

  function init() {
    initAuth();
    initTabs();
    if (getToken()) {
      // Verify the stored token is still good before showing the app.
      api("/admin/overview")
        .then(function () { boot(); })
        .catch(function (err) {
          if (err.code === 401) { signOut(); return; }
          // Token works, but overview failed — still boot; overview shows its own error state.
          boot();
        });
    } else {
      showAuth();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
