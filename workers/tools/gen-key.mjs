#!/usr/bin/env node
/**
 * Generate an Ed25519 signing keypair for the Workers deployment.
 *
 * Usage: node workers/tools/gen-key.mjs
 * Prints the PKCS#8 PEM private key. Feed it to:
 *   wrangler secret put PROOF_INSPECTIONS_PRIVATE_KEY_PEM
 *
 * The public key is published automatically at
 * /.well-known/proof-inspections-key and embedded in every proof bundle.
 * BACK UP THE PRIVATE KEY — proofs cannot be re-signed without it.
 */
import { generateKeypair } from '../src/attestation.js';

const kp = await generateKeypair();
console.log('# Set as a Worker secret: wrangler secret put PROOF_INSPECTIONS_PRIVATE_KEY_PEM');
console.log(kp.privateKeyPem);
console.error('# Public key (for reference):');
console.error(kp.publicKeyPem);
