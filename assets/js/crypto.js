/**
 * crypto.js
 * -----------------------------------------------------------------------
 * Real client-side encryption for the token vault, using the browser's
 * native Web Crypto API (SubtleCrypto). No library, no network call.
 *
 * Design:
 *  - The user picks a short PIN/passphrase the first time they save a
 *    token. We derive an AES-GCM key from it with PBKDF2 (100k rounds)
 *    and a random salt.
 *  - Every encrypted blob stores its own salt + IV alongside the
 *    ciphertext (all three are safe to keep in plain localStorage —
 *    only the PIN, which is never stored anywhere, can decrypt it).
 *  - If the user skips the PIN, we fall back to a lightweight
 *    obfuscation (base64 + byte XOR) purely to avoid tokens sitting in
 *    localStorage as human-readable plaintext. This is NOT real
 *    encryption and is clearly labelled as such in the UI — a browser
 *    devtools user can always reverse it. Real secrecy requires the PIN.
 */

const PBKDF2_ITERATIONS = 100000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function deriveKey(pin, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Encrypt plaintext with a PIN. Returns a self-contained payload object. */
export async function encryptWithPin(plaintext, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    textEncoder.encode(plaintext)
  );
  return {
    mode: 'aes-gcm',
    salt: bufToB64(salt),
    iv: bufToB64(iv),
    data: bufToB64(cipherBuf),
  };
}

/** Decrypt a payload produced by encryptWithPin. Throws on wrong PIN. */
export async function decryptWithPin(payload, pin) {
  const salt = new Uint8Array(b64ToBuf(payload.salt));
  const iv = new Uint8Array(b64ToBuf(payload.iv));
  const key = await deriveKey(pin, salt);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    b64ToBuf(payload.data)
  );
  return textDecoder.decode(plainBuf);
}

/** Lightweight, non-secret obfuscation for the "skip PIN" path. */
export function obfuscate(plaintext) {
  const key = 0x5a;
  const bytes = textEncoder.encode(plaintext);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key;
  return { mode: 'xor', data: bufToB64(out.buffer) };
}

export function deobfuscate(payload) {
  const key = 0x5a;
  const bytes = new Uint8Array(b64ToBuf(payload.data));
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key;
  return textDecoder.decode(out);
}

/** A short probe string we can decrypt-check to confirm a PIN is correct
 *  without ever storing the PIN itself. */
export async function makeVaultCheck(pin) {
  return encryptWithPin('fbg-vault-ok', pin);
}

export async function verifyVaultCheck(payload, pin) {
  try {
    const result = await decryptWithPin(payload, pin);
    return result === 'fbg-vault-ok';
  } catch {
    return false;
  }
}
