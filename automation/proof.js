"use strict";
/**
 * proof.js — cryptographic proof hash over canonical inspection evidence.
 *
 * The proof binds: order id, property, inspector, timestamps, GPS, notes,
 * and per-photo digests into a single SHA-256. Anyone can recompute it from
 * the report's listed fields; a mismatch means the evidence was altered.
 *
 * This is the MVP attestation. Upgrade path: have the PIFN signer sign the
 * canonical payload (proof.canonical) and store the signature alongside.
 */
const crypto = require("crypto");

/** Deterministic JSON: sorted keys, no whitespace. */
function canonicalize(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonicalize(value[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function computeProof(order) {
  const insp = order.inspection || {};
  const payload = {
    orderId: order.id,
    inspectionType: order.inspectionType,
    property: {
      address: order.property.address || "",
      city: order.property.city || "",
      state: order.property.state || "",
      zip: order.property.zip || "",
    },
    inspectorId: insp.inspectorId || "",
    completedAt: insp.completedAt || "",
    gps: { lat: insp.gps ? insp.gps.lat : null, lng: insp.gps ? insp.gps.lng : null },
    notes: insp.notes || "",
    photos: (insp.photos || []).map((p) => ({
      digest: p.sha256 || p.digest || "",
      caption: p.caption || "",
      capturedAt: p.capturedAt || "",
    })),
  };
  const canonical = canonicalize(payload);
  return {
    hash: sha256Hex(canonical),
    canonical,
    algorithm: "SHA-256",
    computedAt: new Date().toISOString(),
  };
}

function verificationInstructions() {
  return (
    "How to verify this report:\n" +
    "1. Take the inspection fields listed above (order ID, property, inspector ID, " +
    "completion time, GPS, notes, and each photo's SHA-256 digest).\n" +
    "2. Arrange them as canonical JSON with alphabetically sorted keys and no whitespace.\n" +
    "3. Compute SHA-256 over that string.\n" +
    "4. The result must equal the Proof Hash printed on this report. " +
    "Any mismatch means the evidence was altered after signing."
  );
}

module.exports = { canonicalize, sha256Hex, computeProof, verificationInstructions };
