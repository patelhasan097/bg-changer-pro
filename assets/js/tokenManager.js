/**
 * tokenManager.js
 * -----------------------------------------------------------------------
 * Owns the "which token do we use next" decision and the live stats that
 * back the dashboard. It is deliberately dumb about *why* a call failed —
 * hfApi.js classifies the error and tells us here whether to mark the
 * token exhausted, errored, or leave it alone for a transient blip.
 *
 * IMPORTANT REALITY CHECK — read this before relying on rotation:
 * Hugging Face's free "Inference Providers" credit allotment is granted
 * per ACCOUNT, not per token. Five tokens generated from the SAME
 * Hugging Face account all draw from one shared pool, so rotating
 * between them buys you nothing. Rotation only multiplies your quota if
 * each token belongs to a DIFFERENT Hugging Face account (or if some are
 * PRO accounts, which get a much bigger allotment). That's a business
 * decision, not a code one — this module just rotates whatever tokens
 * you give it, fairly and transparently.
 */

import { TOKEN_STATUS } from './constants.js';
import * as storage from './storage.js';

const listeners = new Set();

function emit() {
  const snapshot = getDashboardSnapshot();
  for (const fn of listeners) fn(snapshot);
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Everything the UI needs to draw the live token dashboard. */
export function getDashboardSnapshot() {
  return storage.listTokenRecords().map((t) => {
    const used = t.callCount || 0;
    const assumed = t.assumedMonthlyCredits || 1;
    const remainingApprox = Math.max(assumed - used, 0);
    const percentUsed = assumed > 0 ? Math.min(100, Math.round((used / assumed) * 100)) : 0;
    return {
      id: t.id,
      label: t.label,
      status: t.status,
      lastUsedAt: t.lastUsedAt,
      callCount: used,
      errorCount: t.errorCount || 0,
      assumedMonthlyCredits: assumed,
      remainingApprox,
      percentUsed,
    };
  });
}

/**
 * Picks the next usable token, skipping anything marked exhausted or
 * errored. Idle tokens are preferred over ones already mid-request
 * (status ACTIVE) so that several jobs starting at nearly the same
 * moment spread across different tokens instead of piling onto
 * whichever one happens to look "least recently used" before its
 * in-flight call has had a chance to update that timestamp. Ties among
 * equally-idle tokens go to whichever was used longest ago.
 */
export function pickNextToken() {
  const all = storage.listTokenRecords();
  if (all.length === 0) return null;

  const usable = all.filter(
    (t) => t.status !== TOKEN_STATUS.EXHAUSTED && t.status !== TOKEN_STATUS.ERROR
  );
  if (usable.length === 0) return null;

  usable.sort((a, b) => {
    const aBusy = a.status === TOKEN_STATUS.ACTIVE ? 1 : 0;
    const bBusy = b.status === TOKEN_STATUS.ACTIVE ? 1 : 0;
    if (aBusy !== bBusy) return aBusy - bBusy;
    return (a.lastUsedAt || 0) - (b.lastUsedAt || 0);
  });
  return usable[0];
}

export function markTokenActive(id) {
  storage.updateTokenStats(id, { status: TOKEN_STATUS.ACTIVE });
  emit();
}

/**
 * Picks the next usable token AND marks it ACTIVE in one synchronous
 * step. Use this (not pickNextToken + a later markTokenActive) at the
 * start of any actual API call: several jobs can start within the same
 * synchronous burst (see queue.js's runPool), and only reserving
 * atomically like this stops them all from picking the same idle token
 * before any of their status updates has had a chance to land.
 */
export function reserveNextToken() {
  const token = pickNextToken();
  if (!token) return null;
  markTokenActive(token.id);
  return token;
}

export function markCallSucceeded(id) {
  const vault = storage.getVault();
  const t = vault.tokens.find((x) => x.id === id);
  const callCount = (t?.callCount || 0) + 1;
  storage.updateTokenStats(id, {
    status: TOKEN_STATUS.IDLE,
    lastUsedAt: Date.now(),
    callCount,
    consecutiveErrors: 0,
  });
  emit();
}

/**
 * @param {string} id
 * @param {'quota'|'transient'|'fatal'} kind - quota = mark exhausted;
 *   transient = bump error count but keep in rotation; fatal = mark
 *   errored (e.g. invalid token / 401) and pull from rotation.
 */
export function markCallFailed(id, kind) {
  const vault = storage.getVault();
  const t = vault.tokens.find((x) => x.id === id);
  const errorCount = (t?.errorCount || 0) + 1;
  const consecutiveErrors = (t?.consecutiveErrors || 0) + 1;

  let status = TOKEN_STATUS.IDLE;
  if (kind === 'quota') status = TOKEN_STATUS.EXHAUSTED;
  else if (kind === 'fatal') status = TOKEN_STATUS.ERROR;
  else if (consecutiveErrors >= 3) status = TOKEN_STATUS.ERROR; // 3 transient misses in a row -> stop trusting it

  storage.updateTokenStats(id, {
    status,
    lastUsedAt: Date.now(),
    errorCount,
    consecutiveErrors: kind === 'transient' ? consecutiveErrors : 0,
  });
  emit();
}

export function resetToken(id) {
  storage.updateTokenStats(id, {
    status: TOKEN_STATUS.IDLE,
    consecutiveErrors: 0,
  });
  emit();
}

export function hasAnyUsableToken() {
  return pickNextToken() !== null;
}

export function tokenCount() {
  return storage.listTokenRecords().length;
}

export { emit as refreshDashboard };
