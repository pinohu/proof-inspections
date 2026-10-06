#!/usr/bin/env node
/**
 * deploy.mjs — build + deploy proof-inspections to Cloudflare Workers.
 *
 * Replicates the live deploy pattern:
 *   1. esbuild-bundle src/index.js (ESM, neutral platform)
 *   2. Inline every file under public/ into a `const ASSETS = {...}` map
 *      (text files as UTF-8 strings, binaries as base64)
 *   3. Prepend ASSETS + serveAsset(); append the production wrapper export
 *      that serves inlined assets for non-API paths before delegating to
 *      the app. (Matches the live worker byte-for-byte in structure.)
 *   4. Upload via the Cloudflare Scripts API with the custom.cloudflare
 *      credential. Secrets and bindings already on the script are preserved
 *      (they are omitted from the upload metadata, same as wrangler).
 *
 * Usage:
 *   node tools/deploy.mjs --dry-run        # build only, write /tmp/proof-worker.js
 *   node tools/deploy.mjs                  # build + deploy to proof-inspections
 *   node tools/deploy.mjs --script NAME    # deploy to a different script name
 *
 * The credential is resolved via the skill-creator dynamic_credentials
 * surrogate — never handled as a raw value here.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const SRC_ENTRY = join(ROOT, 'src', 'index.js');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const scriptIdx = args.indexOf('--script');
const SCRIPT_NAME = scriptIdx >= 0 && args[scriptIdx + 1] ? args[scriptIdx + 1] : 'proof-inspections';
const ACCOUNT_ID = 'e44866724f9412887af0d84c924e32c0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const TEXT_EXTS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.webmanifest', '.svg', '.txt']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function buildAssets() {
  const assets = {};
  for (const file of walk(PUBLIC_DIR)) {
    const rel = '/' + relative(PUBLIC_DIR, file).split('\\').join('/');
    const ext = extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const buf = readFileSync(file);
    if (TEXT_EXTS.has(ext)) {
      assets[rel] = { text: buf.toString('utf8'), type };
    } else {
      assets[rel] = { b64: buf.toString('base64'), type };
    }
  }
  return assets;
}

function serveAssetSrc() {
  return `
function serveAsset(path) {
  let p = path;
  if (p === "/") p = "/index.html";
  if (p === "/track" || p.startsWith("/track/")) p = "/track.html";
  if (p === "/portal" || p.startsWith("/portal/")) p = "/portal.html";
  if (p === "/admin" || p.startsWith("/admin/")) p = "/admin.html";
  if (p === "/contractor" || p === "/contractor/") p = "/contractor/index.html";
  const a = ASSETS[p];
  if (!a) return null;
  let body;
  if (a.text !== undefined) { body = a.text; }
  else { const bin = Uint8Array.from(atob(a.b64), c => c.charCodeAt(0)); body = bin; }
  return new Response(body, {
    headers: {
      "Content-Type": a.type,
      "Cache-Control": a.type.startsWith("text/html") ? "no-cache" : "public, max-age=3600",
    },
  });
}
`;
}

function wrapperSrc() {
  return `
const __workerModule = __bundledApp;
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && !url.pathname.startsWith("/orders") && !url.pathname.startsWith("/proof") && !url.pathname.startsWith("/.well-known") && !url.pathname.startsWith("/webhooks") && !url.pathname.startsWith("/auth") && !url.pathname.startsWith("/portal/orders") && !url.pathname.startsWith("/contractor/jobs") && !url.pathname.startsWith("/admin/") && url.pathname !== "/health") {
      const asset = serveAsset(url.pathname);
      if (asset) return asset;
    }
    return __workerModule.fetch(request, env, ctx);
  },
};
`;
}

async function main() {
  // 1. Bundle with esbuild (npx or global).
  const { execSync } = await import('node:child_process');
  const bundled = execSync(
    `esbuild ${JSON.stringify(SRC_ENTRY)} --bundle --format=esm --platform=neutral --minify=false`,
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
  ).toString('utf8');

  // 2. Inline assets.
  const assets = buildAssets();
  console.log(`inlined ${Object.keys(assets).length} static assets`);

  // 3. Assemble: ASSETS + serveAsset + bundled app (renamed export) + wrapper.
  //    The bundle ends with `export default {...}` — rewrite to a const.
  let app = bundled.replace(/export\s+default\s*\{/, 'const __bundledApp = {');
  if (app === bundled) {
    // esbuild may emit `export{...}` form; handle the common shapes.
    const m = bundled.match(/export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*\}/);
    if (m) app = bundled.replace(m[0], `const __bundledApp = ${m[1]};`);
    else throw new Error('could not locate default export in bundle');
  }
  const finalJs =
    `const ASSETS = ${JSON.stringify(assets)};\n` +
    serveAssetSrc() + '\n' +
    app + '\n' +
    wrapperSrc();

  const outPath = '/tmp/proof-worker.js';
  writeFileSync(outPath, finalJs);
  console.log(`bundle: ${(finalJs.length / 1024).toFixed(1)} KB -> ${outPath}`);

  if (DRY_RUN) { console.log('dry run — not deploying'); return; }

  // 4. Upload via the Cloudflare Scripts API.
  const boundary = '----proofdeploy' + Date.now().toString(36);
  const meta = JSON.stringify({
    main_module: 'worker.js',
    compatibility_date: '2026-10-01',
    // NOTE: bindings (KV, secrets) are intentionally omitted — Cloudflare
    // preserves the script's existing bindings when they are not specified.
  });
  const workerJs = readFileSync(outPath);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\nContent-Type: application/javascript+module\r\n\r\n`),
    workerJs,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const { default: dc } = await import('/opt/hatch/skills/skill-creator/bin/dynamic_credentials.py').catch(() => ({}));
  // Use the python surrogate helper via a small inline bridge instead:
  const bridge = `
import json, sys, urllib.request
sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
import dynamic_credentials as dc
url = "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}"
body = open("/tmp/proof-deploy-body.bin", "rb").read()
req = urllib.request.Request(url, data=body, method="PUT")
req.add_header("Content-Type", "multipart/form-data; boundary=${boundary}")
req.add_header("User-Agent", "proof-inspections-deploy/0.2")
dc.add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
try:
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = json.loads(resp.read())
        print("deploy ok:", data.get("success"))
        print(json.dumps(data.get("result", {}).get("script", {}), indent=1)[:500])
except Exception as e:
    print("DEPLOY FAILED:", type(e).__name__, str(e)[:500])
    sys.exit(1)
`;
  writeFileSync('/tmp/proof-deploy-body.bin', body);
  writeFileSync('/tmp/proof-deploy-bridge.py', bridge);
  execSync('python3 /tmp/proof-deploy-bridge.py', { stdio: 'inherit' });
  console.log('deployed to script:', SCRIPT_NAME);
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
