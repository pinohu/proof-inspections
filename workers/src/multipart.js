/**
 * Minimal RFC 7578 multipart/form-data parser (binary-safe) — Workers edition.
 *
 * Port of api/multipart.js to Uint8Array (no Node Buffer). Covers exactly
 * what the evidence endpoint needs: text fields + file uploads, with strict
 * size limits, and nothing more.
 *
 * @param {Uint8Array} body      Raw request body.
 * @param {string} boundary      Boundary token from the Content-Type header.
 * @param {object} [limits]      { maxFiles, maxFileSize, maxFields, maxFieldSize }
 * @returns {{ fields: Record<string, string|string[]>, files: Array<{fieldname, filename, mimeType, data: Uint8Array}> }}
 * @throws on malformed input or exceeded limits.
 */
export function parseMultipart(body, boundary, limits = {}) {
  const {
    maxFiles = 20,
    maxFileSize = 15 * 1024 * 1024,
    maxFields = 50,
    maxFieldSize = 1024 * 1024,
  } = limits;

  if (!boundary || /[\r\n]/.test(boundary)) {
    throw new Error('multipart: invalid boundary');
  }
  const te = new TextEncoder();
  const delimiter = te.encode('--' + boundary);
  const closeDelimiter = te.encode('--' + boundary + '--');

  const fields = {};
  const files = [];
  let fieldCount = 0;

  /** Byte-search for a needle subarray starting at `from`. */
  function indexOfSubarray(haystack, needle, from) {
    const nlen = needle.length;
    if (nlen === 0) return from;
    outer: for (let i = from; i <= haystack.length - nlen; i++) {
      for (let j = 0; j < nlen; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  function subarraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  let start = indexOfSubarray(body, delimiter, 0);
  if (start === -1) throw new Error('multipart: no boundary found');

  const td = new TextDecoder('latin1');
  const tdUtf8 = new TextDecoder('utf8');
  const CRLFCRLF = [0x0d, 0x0a, 0x0d, 0x0a];

  for (;;) {
    const isClose = subarraysEqual(body.subarray(start, start + closeDelimiter.length), closeDelimiter);
    if (isClose) break;

    // Skip past delimiter + CRLF.
    let pos = start + delimiter.length;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    else if (body[pos] === 0x0a) pos += 1;

    // Headers end at blank line.
    const headerEnd = indexOfSubarray(body, CRLFCRLF, pos);
    if (headerEnd === -1) throw new Error('multipart: malformed part headers');
    const headerText = td.decode(body.subarray(pos, headerEnd));
    const dataStart = headerEnd + 4;

    // Next delimiter begins the following part (preceded by CRLF).
    const next = indexOfSubarray(body, delimiter, dataStart);
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
        data: data.slice(), // copy: subarray views share memory
      });
    } else {
      if (fieldCount >= maxFields) throw new Error('multipart: too many fields');
      if (data.length > maxFieldSize) throw new Error('multipart: field too large: ' + fieldname);
      fieldCount += 1;
      const value = tdUtf8.decode(data);
      if (fields[fieldname] === undefined) fields[fieldname] = value;
      else if (Array.isArray(fields[fieldname])) fields[fieldname].push(value);
      else fields[fieldname] = [fields[fieldname], value];
    }
    start = next;
  }

  return { fields, files };
}

/** Extract the boundary token from a Content-Type header value. */
export function boundaryFromContentType(contentType) {
  const m = /boundary=([^;]+)/i.exec(contentType || '');
  if (!m) return null;
  let b = m[1].trim();
  if (b.startsWith('"') && b.endsWith('"')) b = b.slice(1, -1);
  return b || null;
}
