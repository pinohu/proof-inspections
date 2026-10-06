/* Proof Inspections — order form with Stripe payment.
 *
 * Flow:
 *   1. Validate form -> POST /orders -> orderId
 *   2. POST /orders/:id/payment-intent -> clientSecret
 *   3. Mount Stripe Payment Element, customer enters card
 *   4. stripe.confirmPayment({ redirect: 'if_required' })
 *   5. On success -> showConfirmation(orderId)
 *
 * Requires window.PROOF_STRIPE_KEY (publishable key) set before this
 * script loads. See assets/js/config.js.
 */
(function () {
  "use strict";

  var form = document.getElementById("order-form");
  if (!form) return;

  var alertBox = document.getElementById("order-alert");
  var submitBtn = document.getElementById("order-submit");
  var formWrap = document.getElementById("order-form-wrap");
  var payWrap = document.getElementById("order-pay");
  var confirmWrap = document.getElementById("order-confirm");

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var PHONE_RE = /^[+\d][\d\s().-]{6,}$/;

  var stripe = null;
  var elements = null;
  var currentOrderId = null;

  function setInvalid(name, invalid) {
    var field = form.querySelector('[data-field="' + name + '"]');
    if (field) field.classList.toggle("invalid", !!invalid);
  }

  function showAlert(kind, msg) {
    alertBox.className = "form-alert show " + kind;
    alertBox.textContent = msg;
  }

  function clearAlert() {
    alertBox.className = "form-alert";
    alertBox.textContent = "";
  }

  function validate(data) {
    var ok = true;
    var checks = {
      customerName: data.customerName.trim().length >= 2,
      customerPhone: PHONE_RE.test(data.customerPhone.trim()),
      customerEmail: EMAIL_RE.test(data.customerEmail.trim()),
      propertyAddress: data.propertyAddress.trim().length >= 8,
      inspectionType: !!data.inspectionType,
    };
    Object.keys(checks).forEach(function (k) {
      setInvalid(k, !checks[k]);
      if (!checks[k]) ok = false;
    });
    return ok;
  }

  function apiPost(path, body) {
    return fetch(window.PROOF_API.url(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? "{}" : JSON.stringify(body),
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          var msg = "Server returned " + res.status;
          try {
            var j = JSON.parse(t);
            if (j.error && j.error.message) msg += ": " + j.error.message;
          } catch (e) { if (t) msg += ": " + t.slice(0, 200); }
          throw new Error(msg);
        });
      }
      return res.json();
    });
  }

  // Live-clear invalid state as the user fixes fields
  form.addEventListener("input", function (e) {
    var field = e.target.closest("[data-field]");
    if (field) field.classList.remove("invalid");
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    clearAlert();

    var data = {
      customerName: form.customerName.value,
      customerPhone: form.customerPhone.value,
      customerEmail: form.customerEmail.value,
      propertyAddress: form.propertyAddress.value,
      inspectionType: form.inspectionType.value,
      notes: form.notes.value.trim() || undefined,
    };

    if (!validate(data)) {
      showAlert("error", "Please fix the highlighted fields and try again.");
      var firstBad = form.querySelector(".field.invalid input, .field.invalid select");
      if (firstBad) firstBad.focus();
      return;
    }

    if (!window.PROOF_API.stripeKey) {
      showAlert(
        "error",
        "Online payment is not configured yet. Please call us to complete your order by phone."
      );
      return;
    }
    if (typeof window.Stripe !== "function") {
      showAlert("error", "Payment library failed to load. Please check your connection and try again.");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span> Placing your order…';

    // Step 1: create the order.
    apiPost("/orders", data)
      .then(function (res) {
        var order = res.order || res;
        if (!order || !order.id) throw new Error("Unexpected response from server.");
        currentOrderId = order.id;
        // Step 2: create the PaymentIntent.
        return apiPost("/orders/" + encodeURIComponent(currentOrderId) + "/payment-intent");
      })
      .then(function (pi) {
        if (pi.alreadyPaid) {
          showConfirmation(currentOrderId);
          return null;
        }
        if (!pi.clientSecret) throw new Error("Payment setup failed (no client secret).");
        return mountPayment(pi.clientSecret);
      })
      .catch(function (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Place order — $199";
        showAlert("error", "We couldn't start your payment just now. " + err.message);
      });
  });

  function mountPayment(clientSecret) {
    formWrap.hidden = true;
    payWrap.hidden = false;
    payWrap.scrollIntoView({ behavior: "smooth", block: "center" });

    stripe = window.Stripe(window.PROOF_API.stripeKey);
    elements = stripe.elements({ clientSecret: clientSecret });
    var paymentElement = elements.create("payment");
    paymentElement.mount("#payment-element");

    var payBtn = document.getElementById("pay-submit");
    var backBtn = document.getElementById("pay-back");
    var payAlert = document.getElementById("pay-alert");

    function payError(msg) {
      payAlert.className = "form-alert show error";
      payAlert.textContent = msg;
    }

    backBtn.addEventListener("click", function () {
      payWrap.hidden = true;
      formWrap.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Place order — $199";
      try { paymentElement.unmount(); } catch (e) {}
      elements = null;
    });

    payBtn.addEventListener("click", function () {
      payAlert.className = "form-alert";
      payAlert.textContent = "";
      payBtn.disabled = true;
      payBtn.innerHTML = '<span class="spinner"></span> Processing payment…';

      stripe
        .confirmPayment({
          elements: elements,
          confirmParams: {
            // Stay on the page; the webhook is the server-side source of truth.
            return_url: window.location.origin + "/track/" + encodeURIComponent(currentOrderId),
          },
          redirect: "if_required",
        })
        .then(function (result) {
          if (result.error) {
            payBtn.disabled = false;
            payBtn.textContent = "Pay $199";
            payError(result.error.message || "Payment failed. Please try another card.");
            return;
          }
          var pi = result.paymentIntent;
          if (pi && (pi.status === "succeeded" || pi.status === "processing")) {
            showConfirmation(currentOrderId);
          } else {
            payBtn.disabled = false;
            payBtn.textContent = "Pay $199";
            payError("Payment status: " + (pi ? pi.status : "unknown") + ". Please try again.");
          }
        });
    });
  }

  function showConfirmation(orderId) {
    formWrap.hidden = true;
    payWrap.hidden = true;
    confirmWrap.hidden = false;
    document.getElementById("confirm-order-id").textContent = orderId;
    var trackUrl = "/track/" + encodeURIComponent(orderId);
    var trackLink = document.getElementById("confirm-track-link");
    trackLink.href = trackUrl;
    try { sessionStorage.setItem("proof_last_order", orderId); } catch (e) {}

    var copyBtn = document.getElementById("copy-order-id");
    copyBtn.addEventListener("click", function () {
      var done = function () {
        copyBtn.textContent = "Copied!";
        setTimeout(function () { copyBtn.textContent = "Copy"; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(orderId).then(done, done);
      } else {
        var ta = document.createElement("textarea");
        ta.value = orderId;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(ta);
        done();
      }
    });

    confirmWrap.scrollIntoView({ behavior: "smooth", block: "center" });
    try {
      history.replaceState(null, "", "/order-confirmation/" + encodeURIComponent(orderId));
    } catch (e) {}
  }
})();
