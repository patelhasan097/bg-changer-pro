/**
 * storage.js
 * -----------------------------------------------------------------------
 * The only module allowed to touch localStorage directly. Everything
 * else goes through the functions here, so if we ever need to change the
 * storage backend (say, IndexedDB for bigger histories) this is the one
 * file that changes.
 *
 * Token vault shape actually written to localStorage:
 * {
 *   locked: boolean,            // true if a PIN was set
 *   vaultCheck: {...} | null,   // only present when locked
 *   tokens: [
 *     {
 *       id, label, createdAt,
 *       payload: {...},         // output of encryptWithPin() or obfuscate()
 *       status, lastUsedAt, callCount, errorCount, consecutiveErrors
 *     }, ...
 *   ]
 * }
 *
 * The raw token string is NEVER kept anywhere in memory longer than one
 * request cycle — tokenManager.js decrypts on demand and discards it
 * immediately after use.
 */

import { STORAGE_KEYS, TOKEN_STATUS, DEFAULT_ASSUMED_MONTHLY_CREDITS } from './constants.js';
import { encryptWithPin, decryptWithPin, obfuscate, deobfuscate, makeVaultCheck, verifyVaultCheck } from './crypto.js';

// ---------------------------------------------------------------------
// Session PIN cache (memory only, never persisted)
// ---------------------------------------------------------------------
// Re-prompting for a PIN before every single one of a thousand daily API
// calls would make the vault unusable in practice. Instead, the PIN is
// verified once per browser tab session (see checkVaultPin) and kept
// ONLY in this in-memory variable — it is gone the moment the tab is
// closed or reloaded, and it is never written to localStorage.
let sessionPin = null;

export function setSessionPin(pin) {
  sessionPin = pin;
}
export function getSessionPin() {
  return sessionPin;
}
export function clearSessionPin() {
  sessionPin = null;
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.error(`[storage] failed to read ${key}`, err);
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.error(`[storage] failed to write ${key}`, err);
    return false;
  }
}

// ---------------------------------------------------------------------
// Token vault
// ---------------------------------------------------------------------

function emptyVault() {
  return { locked: false, vaultCheck: null, tokens: [] };
}

export function getVault() {
  return readJSON(STORAGE_KEYS.tokens, emptyVault());
}

function saveVault(vault) {
  return writeJSON(STORAGE_KEYS.tokens, vault);
}

export function isVaultLocked() {
  return getVault().locked;
}

/** Set (or change) the PIN protecting the vault. Re-encrypts every token
 *  currently stored so they all move to the new PIN atomically. */
export async function setVaultPin(newPin, currentPin = null) {
  const vault = getVault();
  const plainTokens = [];
  for (const t of vault.tokens) {
    let raw;
    if (t.payload.mode === 'aes-gcm') {
      if (!currentPin) throw new Error('Current PIN required to re-encrypt existing tokens.');
      raw = await decryptWithPin(t.payload, currentPin);
    } else {
      raw = deobfuscate(t.payload);
    }
    plainTokens.push({ ...t, raw });
  }
  for (const t of plainTokens) {
    t.payload = await encryptWithPin(t.raw, newPin);
    delete t.raw;
  }
  vault.locked = true;
  vault.vaultCheck = await makeVaultCheck(newPin);
  vault.tokens = plainTokens;
  saveVault(vault);
}

/** Remove PIN protection, falling back to obfuscation-only storage. */
export async function removeVaultPin(currentPin) {
  const vault = getVault();
  for (const t of vault.tokens) {
    const raw = await decryptWithPin(t.payload, currentPin);
    t.payload = obfuscate(raw);
  }
  vault.locked = false;
  vault.vaultCheck = null;
  saveVault(vault);
}

export async function checkVaultPin(pin) {
  const vault = getVault();
  if (!vault.locked) return true;
  return verifyVaultCheck(vault.vaultCheck, pin);
}

/** Add a new token. Returns the created record's id. */
export async function addToken(rawToken, label, pin = null) {
  const vault = getVault();
  if (vault.tokens.length >= 5) {
    throw new Error('Maximum of 5 tokens already saved.');
  }
  const payload = vault.locked ? await encryptWithPin(rawToken, pin) : obfuscate(rawToken);
  const record = {
    id: `tok_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    label: label || `Token ${vault.tokens.length + 1}`,
    createdAt: Date.now(),
    payload,
    status: TOKEN_STATUS.IDLE,
    lastUsedAt: null,
    callCount: 0,
    errorCount: 0,
    consecutiveErrors: 0,
    assumedMonthlyCredits: DEFAULT_ASSUMED_MONTHLY_CREDITS,
  };
  vault.tokens.push(record);
  saveVault(vault);
  return record.id;
}

export function removeToken(id) {
  const vault = getVault();
  vault.tokens = vault.tokens.filter((t) => t.id !== id);
  saveVault(vault);
}

export function renameToken(id, label) {
  const vault = getVault();
  const t = vault.tokens.find((x) => x.id === id);
  if (t) {
    t.label = label;
    saveVault(vault);
  }
}

export function setAssumedCredits(id, credits) {
  const vault = getVault();
  const t = vault.tokens.find((x) => x.id === id);
  if (t) {
    t.assumedMonthlyCredits = credits;
    saveVault(vault);
  }
}

/** Decrypt one token's raw value on demand. Caller must discard it ASAP.
 *  When the vault is PIN-locked and no explicit pin is passed, falls back
 *  to the in-memory session PIN set by unlocking the vault once in
 *  Settings — see setSessionPin() above. */
export async function revealToken(id, pin = null) {
  const vault = getVault();
  const t = vault.tokens.find((x) => x.id === id);
  if (!t) throw new Error('Token not found.');
  if (t.payload.mode !== 'aes-gcm') return deobfuscate(t.payload);
  const effectivePin = pin || sessionPin;
  if (!effectivePin) throw new Error('VAULT_LOCKED');
  return decryptWithPin(t.payload, effectivePin);
}

/** Patch a token record's live stats (status, counters, timestamps). */
export function updateTokenStats(id, patch) {
  const vault = getVault();
  const t = vault.tokens.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, patch);
  saveVault(vault);
}

export function listTokenRecords() {
  // Never includes the decrypted secret — safe to hand to the UI layer.
  return getVault().tokens.map(({ payload, ...rest }) => rest);
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------

function defaultSettings() {
  return {
    mode: 'fast', // 'fast' (instruction edit) | 'composite' (mask + backdrop)
    editModelId: null, // null = use constants.MODELS.edit default
    backdropModelId: null,
    concurrency: 3,
    theme: 'studio-dark',
  };
}

export function getSettings() {
  return { ...defaultSettings(), ...readJSON(STORAGE_KEYS.settings, {}) };
}

export function saveSettings(patch) {
  const current = getSettings();
  const next = { ...current, ...patch };
  writeJSON(STORAGE_KEYS.settings, next);
  return next;
}

// ---------------------------------------------------------------------
// History (lightweight log of past batch runs, for the dashboard)
// ---------------------------------------------------------------------

export function appendHistory(entry) {
  const history = readJSON(STORAGE_KEYS.history, []);
  history.unshift({ ...entry, at: Date.now() });
  writeJSON(STORAGE_KEYS.history, history.slice(0, 50));
}

export function getHistory() {
  return readJSON(STORAGE_KEYS.history, []);
}
