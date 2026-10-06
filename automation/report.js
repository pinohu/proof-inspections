"use strict";
/**
 * report.js — generate the professional PDF inspection report.
 *
 * Contents: property address, inspection type, date, inspector ID, GPS,
 * notes, photo thumbnails, cryptographic proof hash + verification
 * instructions. Saved to <reportsDir>/<orderId>.pdf and served by the API
 * at GET /reports/:orderId.pdf.
 */
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const config = require("./config");
const audit = require("./audit");
const proof = require("./proof");

function reportPath(orderId) {
  return path.join(config.reportsDir, orderId + ".pdf");
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York" });
  } catch (e) {
    return iso || "";
  }
}

function drawHeader(doc, order) {
  doc.fontSize(22).font("Helvetica-Bold").text(config.businessName, { align: "left" });
  doc.fontSize(11).font("Helvetica").fillColor("#555555")
    .text("Cryptographically-Attested Inspection Report", { align: "left" });
  doc.moveDown(0.5);
  doc.strokeColor("#cccccc").lineWidth(1)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke();
  doc.fillColor("#000000").moveDown(0.5);
}

function field(doc, label, value) {
  doc.font("Helvetica-Bold").fontSize(10).text(label + ": ", { continued: true });
  doc.font("Helvetica").text(value === null || value === undefined || value === "" ? "—" : String(value));
}

function drawPhotos(doc, photos) {
  doc.fontSize(14).font("Helvetica-Bold").text("Photo Evidence");
  doc.moveDown(0.3);
  if (!photos || photos.length === 0) {
    doc.fontSize(10).font("Helvetica").text("No photos attached.");
    return;
  }
  const perRow = 2;
  const gap = 12;
  const thumbW = (doc.page.width - doc.page.margins.left - doc.page.margins.right - gap) / perRow;
  let x = doc.page.margins.left;
  let y = doc.y;
  let col = 0;
  photos.forEach((p, i) => {
    const imgPath = p.localPath || p.file;
    let drew = false;
    if (imgPath && fs.existsSync(imgPath)) {
      try {
        if (y + 150 > doc.page.height - doc.page.margins.bottom) {
          doc.addPage(); y = doc.page.margins.top;
        }
        doc.image(imgPath, x, y, { fit: [thumbW, 130] });
        drew = true;
      } catch (e) { drew = false; }
    }
    const capY = drew ? y + 135 : y;
    doc.fontSize(8).font("Helvetica").fillColor("#333333")
      .text(`Photo ${i + 1}: ${p.caption || "untitled"}`, x, capY, { width: thumbW });
    if (p.sha256 || p.digest) {
      doc.fontSize(7).fillColor("#777777")
        .text(`sha256: ${(p.sha256 || p.digest).slice(0, 32)}…`, x, doc.y, { width: thumbW });
    }
    doc.fillColor("#000000");
    col++;
    if (col >= perRow) { col = 0; x = doc.page.margins.left; y = doc.y + gap; doc.y = y; }
    else { x += thumbW + gap; }
  });
  doc.y = Math.max(doc.y, y + (col === 0 ? 0 : 160));
  doc.moveDown(0.5);
}

/**
 * Generate the PDF for a verified order. Returns the file path.
 * Requires order.inspection and order.proof (computed by lifecycle.verifyOrder).
 */
function generateReport(store, orderId) {
  const order = store.getOrder(orderId);
  if (!order) throw new Error("order not found: " + orderId);
  if (!order.inspection) throw new Error("no inspection data for order " + orderId);
  if (!order.proof) throw new Error("no proof computed for order " + orderId);
  if (order.report && order.report.path && fs.existsSync(order.report.path)) {
    return order.report.path; // idempotent
  }

  const outPath = reportPath(orderId);
  fs.mkdirSync(config.reportsDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "LETTER" });
    const stream = fs.createWriteStream(outPath);
    stream.on("error", reject);
    stream.on("finish", () => {
      store.updateOrder(
        orderId,
        { report: { path: outPath, generatedAt: new Date().toISOString() } },
        "report.generated",
        "PDF written to " + outPath
      );
      audit.log("report.ok", orderId, "pdf=" + outPath);
      resolve(outPath);
    });
    doc.pipe(stream);

    const insp = order.inspection;
    drawHeader(doc, order);

    doc.fontSize(14).font("Helvetica-Bold").text("Inspection Summary");
    doc.moveDown(0.3);
    doc.fontSize(10);
    field(doc, "Order ID", order.id);
    field(doc, "Property", [order.property.address, order.property.city, order.property.state, order.property.zip].filter(Boolean).join(", "));
    field(doc, "Inspection type", order.inspectionType);
    field(doc, "Inspection date", fmtDate(insp.completedAt));
    field(doc, "Inspector ID", insp.inspectorId);
    field(doc, "Contractor", order.contractor ? `${order.contractor.name} (${order.contractor.id})` : "—");
    const gps = insp.gps || {};
    field(doc, "GPS", gps.lat != null && gps.lng != null ? `${gps.lat}, ${gps.lng}` : "—");
    field(doc, "Customer", order.customer.name || "—");
    doc.moveDown(0.5);

    doc.fontSize(14).font("Helvetica-Bold").text("Inspector Notes");
    doc.moveDown(0.2);
    doc.fontSize(10).font("Helvetica").text(insp.notes || "No notes recorded.", { align: "left" });
    doc.moveDown(0.5);

    drawPhotos(doc, insp.photos || []);

    if (doc.y > doc.page.height - 220) doc.addPage();
    doc.fontSize(14).font("Helvetica-Bold").text("Cryptographic Proof");
    doc.moveDown(0.2);
    doc.fontSize(10).font("Helvetica")
      .text("This report's evidence is bound by the following SHA-256 proof hash. " +
            "Any alteration to the inspection data invalidates the hash.");
    doc.moveDown(0.2);
    doc.font("Courier").fontSize(9).text(order.proof.hash, { align: "left" });
    doc.font("Helvetica").fontSize(10);
    field(doc, "Algorithm", order.proof.algorithm);
    field(doc, "Computed at", fmtDate(order.proof.computedAt));
    doc.moveDown(0.3);
    doc.fontSize(10).text(proof.verificationInstructions());
    doc.moveDown(1);
    doc.fontSize(8).fillColor("#777777")
      .text(`${config.businessName} — report generated automatically ${fmtDate(new Date().toISOString())}.`, { align: "center" });

    doc.end();
  });
}

module.exports = { generateReport, reportPath };
