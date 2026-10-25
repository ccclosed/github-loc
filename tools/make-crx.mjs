#!/usr/bin/env node
// Сборка подписанного CRX3 из dist/github-loc.
// CRX3: "Cr24" | версия 3 (uint32 LE) | длина заголовка (uint32 LE) | protobuf CrxFileHeader | zip
// Подпись: RSA-SHA256 по ("CRX3 SignedData\0" + uint32LE(len(signed_header_data)) + signed_header_data + zip).
import { createHash, createSign, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = resolve(ROOT, 'dist');
const SRC = join(DIST, 'github-loc');
const KEY = join(ROOT, 'tools/extension-key.pem');
const CRX = join(DIST, 'github-loc.crx');

// ------------------------------------------------------------------ protobuf (минимум)

function varint(n) {
  const out = [];
  let value = BigInt(n);
  while (value >= 0x80n) {
    out.push(Number((value & 0x7fn) | 0x80n));
    value >>= 7n;
  }
  out.push(Number(value));
  return Buffer.from(out);
}

function lenDelimited(fieldNumber, payload) {
  const tag = varint((fieldNumber << 3) | 2);
  return Buffer.concat([tag, varint(payload.length), payload]);
}

// SignedData { bytes crx_id = 1; }  — ровно 16 байт
function encodeSignedData(crxId) {
  return lenDelimited(1, crxId);
}

// AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
function encodeKeyProof(publicKey, signature) {
  return Buffer.concat([lenDelimited(1, publicKey), lenDelimited(2, signature)]);
}

// CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2; bytes signed_header_data = 10000; }
function encodeCrxHeader(proof, signedHeaderData) {
  return Buffer.concat([lenDelimited(2, proof), lenDelimited(10000, signedHeaderData)]);
}

// ------------------------------------------------------------------ id расширения

function extensionIdFromPublicKey(publicKeyDer) {
  const hash = createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
  return [...hash]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .split('')
    .map((ch) => String.fromCharCode(97 + parseInt(ch, 16)))
    .join('');
}

// ------------------------------------------------------------------ сборка

mkdirSync(DIST, { recursive: true });

const zipPath = join(DIST, 'github-loc.zip');
rmSync(zipPath, { force: true });
execFileSync('zip', ['-qr', zipPath, '.'], { cwd: SRC });
const zip = readFileSync(zipPath);

const privateKeyPem = readFileSync(KEY, 'utf8');
const publicKeyDer = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });
const extId = extensionIdFromPublicKey(publicKeyDer);

const crxId = createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
const signedHeaderData = encodeSignedData(crxId);

const signer = createSign('sha256');
signer.update(Buffer.from('CRX3 SignedData\0', 'binary'));
const lenBuf = Buffer.alloc(4);
lenBuf.writeUInt32LE(signedHeaderData.length, 0);
signer.update(lenBuf);
signer.update(signedHeaderData);
signer.update(zip);
const signature = signer.sign(privateKeyPem);

const header = encodeCrxHeader(encodeKeyProof(publicKeyDer, signature), signedHeaderData);

const prefix = Buffer.alloc(12);
prefix.write('Cr24', 0, 'binary');
prefix.writeUInt32LE(3, 4);
prefix.writeUInt32LE(header.length, 8);

writeFileSync(CRX, Buffer.concat([prefix, header, zip]));

const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
if (manifest.key) {
  const manifestKey = Buffer.from(manifest.key, 'base64');
  if (!manifestKey.equals(publicKeyDer)) {
    console.error('[ghloc] ВНИМАНИЕ: ключ в manifest.json не совпадает с tools/extension-key.pem');
    process.exitCode = 1;
  }
}

console.log(`[ghloc] CRX3: ${CRX} (${statSync(CRX).size} Б)`);
console.log(`[ghloc] id расширения: ${extId}`);
writeFileSync(join(DIST, 'extension-id.txt'), `${extId}\n`);
export { extId };