'use strict';

/**
 * Minimal RFC 7578 multipart/form-data parser (binary-safe).
 *
 * We intentionally avoid adding multer/busboy as dependencies: this parser
 * covers exactly what the evidence endpoint needs (text fields + file
 * uploads) with strict size limits, and nothing more.
 *
 * @param {Buffer} body        Raw request body.
 * @param {string} boundary    Boundary token from the Content-Type header.
 * @param {object} [limits]    { maxFiles, maxFileSize, maxFields, maxFieldSize }
 * @returns {{ fields: Record<string, string|string[]>, files: Array<{fieldname, filename, mimeType, data: Buffer}> }}
 * @throws on malformed input or exceeded limits.
 */
function parseMultipart(body, boundary, limits = {}) {
  const {
    maxFiles = 20,
    maxFileSize = 15 * 1024 * 1024,
    maxFields = 50,
    maxFieldSize = 1024 * 1024,
  } = limits;

  if (!boundary || /[\r\n]/.test(boundary)) {
    throw new Error('multipart: invalid boundary');
  }
  const delimiter = Buffer.from('--' + boundary);
  const closeDelimiter = Buffer.from('--' + boundary + '--');

  const fields = {};
  const files = [];
  let fieldCount = 0;

  let pos = 0;
  // The body must start with the delimiter (preamble tolerated).
  let start = body.indexOf(delimiter, pos);
  if (start === -1) throw new Error('multipart: no boundary found');

  for (;;) {
    const isClose = body.subarray(start, start + closeDelimiter.length).equals(closeDelimiter);
    if (isClose) break;

    // Skip past delimiter + CRLF.
    pos = start + delimiter.length;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else if (body[pos] === 0x0a) pos += 1;

    // Headers end at blank line.
    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) throw new Error('multipart: malformed part headers');
    const headerText = body.subarray(pos, headerEnd).toString('latin1');
    const dataStart = headerEnd + 4;

    // Next delimiter begins the following part (preceded by CRLF).
    let next = body.indexOf(delimiter, dataStart);
    if (next === -1) throw new Error('multipart: unterminated part');
    let dataEnd = next;
    // Strip the CRLF that precedes the delimiter (part of framing, not data).
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2;
    else if (body[dataEnd - 1] === 0x0a) dataEnd -= 1;

    const disposition = /content-disposition:\s*form-data;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(headerText);
    if (!disposition) {
      start = next; // skip parts without a usable disposition
      continue;
    }
    const fieldname = disposition[1];
    const filename = disposition[2];
    const contentType = /content-type:\s*([^\r\n;]+)/i.exec(headerText);

    const data = body.subarray(dataStart, dataEnd);
    if (filename !== undefined) {
      if (files.length >= maxFiles) throw new Error('multipart: too many files');
      if (data.length > maxFileSize) throw new Error('multipart: file too large: ' + filename);
      files.push({
        fieldname,
        filename,
        mimeType: contentType ? contentType[1].trim().toLowerCase() : 'application/octet-stream',
        data: Buffer.from(data), // copy: subarray views share memory
      });
    } else {
      if (fieldCount >= maxFields) throw new Error('multipart: too many fields');
      if (data.length > maxFieldSize) throw new Error('multipart: field too large: ' + fieldname);
      fieldCount += 1;
      const value = data.toString('utf8');
      if (fields[fieldname] === undefined) fields[fieldname] = value;
      else if (Array.isArray(fields[fieldname])) fields[fieldname].push(value);
      else fields[fieldname] = [fields[fieldname], value];
    }
    start = next;
  }

  return { fields, files };
}

/** Extract the boundary token from a Content-Type header value. */
function boundaryFromContentType(contentType) {
  const m = /boundary=([^;]+)/i.exec(contentType || '');
  if (!m) return null;
  let b = m[1].trim();
  if (b.startsWith('"') && b.endsWith('"')) b = b.slice(1, -1);
  return b || null;
}

module.exports = { parseMultipart, boundaryFromContentType };
