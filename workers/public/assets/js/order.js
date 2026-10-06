/* Proof Inspections — order form.
 * POSTs to /orders per the API contract (see assets/js/config.js).
 */
(function () {
  "use strict";

  var form = document.getElementById("order-form");
  if (!form) return;

  var alertBox = document.getElementById("order-alert");
  var submitBtn = document.getElementById("order-submit");
  var formWrap = document.getElementById("order-form-wrap");
  var confirmWrap = document.getElementById("order-confirm");

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var PHONE_RE = /^[+\d][\d\s().-]{6,}$/;

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

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span> Placing your order…';

    fetch(window.PROOF_API.url("/orders"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            throw new Error("Server returned " + res.status + (t ? ": " + t.slice(0, 200) : ""));
          });
        }
        return res.json();
      })
      .then(function (order) {
        if (!order || !order.id) throw new Error("Unexpected response from server.");
        showConfirmation(order.id);
      })
      .catch(function (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Place order — $199";
        showAlert(
          "error",
          "We couldn't place your order just now. " +
            "Please check your connection and try again. (Details: " + err.message + ")"
        );
      });
  });

  function showConfirmation(orderId) {
    formWrap.hidden = true;
    confirmWrap.hidden = false;
    document.getElementById("confirm-order-id").textContent = orderId;
    var trackUrl = "/track/" + encodeURIComponent(orderId);
    var trackLink = document.getElementById("confirm-track-link");
    trackLink.href = trackUrl;
    // Persist for the track page in case the backend route isn't wired yet
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
    // Update the URL so a refresh keeps the confirmation visible
    try {
      history.replaceState(null, "", "/order-confirmation/" + encodeURIComponent(orderId));
    } catch (e) {}
  }
})();
