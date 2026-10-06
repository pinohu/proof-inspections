'use strict';

/**
 * Service entrypoint: key management, database, and HTTP server.
 *
 * Key management (MVP):
 *   - On first boot, an Ed25519 signing keypair is generated and stored at
 *     <DATA_DIR>/keys/. Override with PROOF_INSPECTIONS_PRIVATE_KEY_PEM.
 *   - The public key is published at /.well-known/proof-inspections-key and
 *     embedded in every proof bundle (bundles are self-certifying).
 *   - ROADMAP: move the private key to a KMS/HSM before handling real
 *     customer evidence at scale. File-based keys are a bootstrap only.
 */

const fs = require('node:fs');
const path = require('node:path');
const attestation = require('../lib/attestation');
const { openDatabase } = require('./db');
const { createApp } = require('./server');

const DATA_DIR = process.env.PROOF_INSPECTIONS_DATA_DIR
  || path.join(__dirname, '..', 'data');
const PORT = Number(process.env.PORT || 3000);

function loadOrCreateKeypair(dataDir) {
  const keysDir = path.join(dataDir, 'keys');
  fs.mkdirSync(keysDir, { recursive: true });

  const envKey = process.env.PROOF_INSPECTIONS_PRIVATE_KEY_PEM;
  if (envKey) {
    const privateKeyPem = envKey.replace(/\\n/g, '\n');
    return {
      privateKeyPem,
      publicKeyPem: attestation.publicKeyFromPrivate(privateKeyPem),
    };
  }

  const privPath = path.join(keysDir, 'ed25519-private.pem');
  const pubPath = path.join(keysDir, 'ed25519-public.pem');
  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    return {
      privateKeyPem: fs.readFileSync(privPath, 'utf8'),
      publicKeyPem: fs.readFileSync(pubPath, 'utf8'),
    };
  }

  const keypair = attestation.generateKeypair();
  fs.writeFileSync(privPath, keypair.privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(pubPath, keypair.publicKeyPem, { mode: 0o644 });
  console.log('[proof-inspections] generated new Ed25519 signing keypair at ' + privPath);
  console.log('[proof-inspections] BACK UP THIS KEY — proofs cannot be re-signed without it.');
  return keypair;
}

function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const keypair = loadOrCreateKeypair(DATA_DIR);
  const { stmts } = openDatabase(path.join(DATA_DIR, 'proof-inspections.db'));
  const app = createApp({ stmts, attestation, keypair, dataDir: DATA_DIR });
  app.listen(PORT, () => {
    console.log(`[proof-inspections] listening on :${PORT} (data: ${DATA_DIR})`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { loadOrCreateKeypair, DATA_DIR };
