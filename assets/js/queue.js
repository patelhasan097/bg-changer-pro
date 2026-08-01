/**
 * queue.js
 * -----------------------------------------------------------------------
 * The batch engine. Owns the list of jobs (one per uploaded photo), runs
 * up to `concurrency` of them in parallel, retries transient failures
 * with backoff, and rotates to the next Hugging Face token on quota or
 * auth failures. Nothing in here touches the DOM — ui.js subscribes via
 * onProgress()/onJobUpdate() and renders whatever it receives.
 *
 * API OPTIMIZATION, laid out explicitly because it's the whole point of
 * the app:
 *  - Fast Mode:      1 edit call per image.                    (N calls)
 *  - Composite Mode: 1 backdrop call per UNIQUE prompt in the   (usually 1
 *                    batch, reused for every photo that shares  call total
 *                    it, plus free local segmentation/compositing per batch)
 *  - A job that already produced a result is never re-sent (idempotent —
 *    re-running "Retry Failed" only touches jobs still in the FAILED state).
 *  - Failed jobs go through exponential backoff before their next attempt
 *    so a flaky moment doesn't turn into a call storm.
 */

import { LIMITS, JOB_STATUS, MODELS } from './constants.js';
import * as tokenManager from './tokenManager.js';
import * as hfApi from './hfApi.js';
import * as storage from './storage.js';
import { loadImage, drawToCanvas, canvasToBlob, canvasToThumbnail, blobToObjectURL, safeFileName } from './imageUtils.js';
import { extractSubjectMask, compositeOntoBackdrop } from './segmentation.js';

const listeners = { progress: new Set(), job: new Set() };
let jobs = [];
let running = false;
let backdropCache = new Map(); // prompt -> {canvas, image} (Composite Mode only)

export function onProgress(fn) {
  listeners.progress.add(fn);
  return () => listeners.progress.delete(fn);
}
export function onJobUpdate(fn) {
  listeners.job.add(fn);
  return () => listeners.job.delete(fn);
}

function emitProgress() {
  const total = jobs.length;
  const done = jobs.filter((j) => j.status === JOB_STATUS.DONE).length;
  const failed = jobs.filter((j) => j.status === JOB_STATUS.FAILED).length;
  const processing = jobs.filter((j) => j.status === JOB_STATUS.PROCESSING).length;
  const remaining = total - done - failed;
  const snapshot = {
    total,
    done,
    failed,
    processing,
    remaining,
    percent: total ? Math.round(((done + failed) / total) * 100) : 0,
  };
  for (const fn of listeners.progress) fn(snapshot);
}

function emitJob(job) {
  for (const fn of listeners.job) fn(publicJob(job));
}

function publicJob(job) {
  const { file, canvas, ...rest } = job;
  return rest;
}

/** Reset the queue and load a fresh set of files + shared prompt. */
export async function loadBatch(files, prompt) {
  jobs = [];
  backdropCache = new Map();
  const list = Array.from(files).slice(0, LIMITS.maxBatchImages);
  for (const file of list) {
    const img = await loadImage(file);
    const canvas = drawToCanvas(img);
    jobs.push({
      id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      file,
      canvas,
      fileName: file.name,
      prompt,
      thumbnail: canvasToThumbnail(canvas),
      status: JOB_STATUS.QUEUED,
      attempts: 0,
      error: null,
      resultBlob: null,
      resultURL: null,
    });
  }
  jobs.forEach(emitJob);
  emitProgress();
  return jobs.map(publicJob);
}

export function getJobs() {
  return jobs.map(publicJob);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generates (or reuses) the one backdrop image for a given prompt.
 *
 * IMPORTANT CONCURRENCY DETAIL: with several jobs running in parallel
 * (see runPool), two jobs sharing the same prompt could both reach this
 * function before either finishes generating a backdrop, which would
 * silently turn "1 call per batch" into "1 call per parallel worker."
 * To prevent that, the in-flight PROMISE itself (not just the eventual
 * result) is stored in backdropCache synchronously, before any `await`
 * runs. Because an async function's body executes synchronously up to
 * its first await, every concurrent caller that reaches this function
 * while a request is already in flight sees the cache already populated
 * and simply awaits the same promise instead of starting a new request.
 */
async function ensureBackdrop(prompt, mode) {
  if (mode !== 'composite') return null;
  if (backdropCache.has(prompt)) return backdropCache.get(prompt);

  const inFlight = (async () => {
    const token = tokenManager.reserveNextToken();
    if (!token) throw new Error('ALL_TOKENS_EXHAUSTED');
    let raw;
    try {
      raw = await revealOrThrow(token.id);
    } catch (err) {
      tokenManager.resetToken(token.id); // reservation was never actually used
      backdropCache.delete(prompt);
      throw err;
    }
    try {
      const settings = storage.getSettings();
      const modelId = settings.backdropModelId || undefined;
      const model = modelId ? { id: modelId, provider: 'auto' } : MODELS.backdrop;
      const blob = await hfApi.generateBackdrop(raw, prompt, model);
      tokenManager.markCallSucceeded(token.id);
      const img = await loadImage(blob);
      return { image: img };
    } catch (err) {
      tokenManager.markCallFailed(token.id, err.kind || 'transient');
      backdropCache.delete(prompt); // let a later attempt try again
      throw err;
    }
  })();

  // Synchronous — runs before this function's first (and only) await,
  // guaranteeing every concurrent caller sees it in time.
  backdropCache.set(prompt, inFlight);
  return inFlight;
}

/** Reveals a token's secret, but tells VAULT_LOCKED apart from a genuine
 *  token problem so we never penalize a token for a locked vault. */
async function revealOrThrow(tokenId) {
  try {
    return await storage.revealToken(tokenId);
  } catch (err) {
    if (err.message === 'VAULT_LOCKED') {
      const lockedErr = new Error('VAULT_LOCKED');
      lockedErr.doNotPenalizeToken = true;
      throw lockedErr;
    }
    throw err;
  }
}

async function runFastMode(job) {
  const token = tokenManager.reserveNextToken();
  if (!token) throw new Error('ALL_TOKENS_EXHAUSTED');
  let raw;
  try {
    raw = await revealOrThrow(token.id);
  } catch (err) {
    tokenManager.resetToken(token.id); // reservation was never actually used
    throw err;
  }
  try {
    const settings = storage.getSettings();
    const modelId = settings.editModelId || undefined;
    const model = modelId ? { id: modelId, provider: 'auto' } : MODELS.edit;
    const inputBlob = await canvasToBlob(job.canvas);
    const resultBlob = await hfApi.editImage(raw, inputBlob, job.prompt, model);
    tokenManager.markCallSucceeded(token.id);
    return resultBlob;
  } catch (err) {
    tokenManager.markCallFailed(token.id, err.kind || 'transient');
    throw err;
  }
}

async function runCompositeMode(job, onMaskProgress) {
  const backdrop = await ensureBackdrop(job.prompt, 'composite');
  const { maskCanvas } = await extractSubjectMask(job.canvas, onMaskProgress);
  const composited = compositeOntoBackdrop(job.canvas, maskCanvas, backdrop.image);
  return canvasToBlob(composited);
}

async function processJob(job) {
  job.status = JOB_STATUS.PROCESSING;
  job.attempts += 1;
  emitJob(job);
  emitProgress();

  const settings = storage.getSettings();
  try {
    const resultBlob =
      settings.mode === 'composite' ? await runCompositeMode(job) : await runFastMode(job);
    job.resultBlob = resultBlob;
    job.resultURL = blobToObjectURL(resultBlob);
    job.status = JOB_STATUS.DONE;
    job.error = null;
  } catch (err) {
    const noRetry = err.message === 'ALL_TOKENS_EXHAUSTED' || err.message === 'VAULT_LOCKED';
    const message =
      err.message === 'ALL_TOKENS_EXHAUSTED' ? 'All Hugging Face tokens are exhausted or invalid.' :
      err.message === 'VAULT_LOCKED' ? 'Token vault is PIN-locked — unlock it in Settings and press Retry Failed.' :
      (err.message || 'Unknown processing error.');

    if (job.attempts < LIMITS.maxRetries && !noRetry) {
      job.status = JOB_STATUS.RETRYING;
      emitJob(job);
      await delay(LIMITS.retryBaseDelayMs * Math.pow(2, job.attempts - 1));
      return processJob(job);
    }
    job.status = JOB_STATUS.FAILED;
    job.error = message;
  }
  emitJob(job);
  emitProgress();
}

/** Simple async pool: runs `worker` over `items` with max N in flight. */
async function runPool(items, concurrency, worker) {
  const queue = [...items];
  const workers = new Array(Math.min(concurrency, queue.length || 1)).fill(null).map(async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item) await worker(item);
    }
  });
  await Promise.all(workers);
}

/** Start (or resume) processing every job still in QUEUED/FAILED state. */
export async function start({ retryFailedOnly = false } = {}) {
  if (running) return;
  running = true;
  const settings = storage.getSettings();
  const concurrency = Math.max(1, Math.min(settings.concurrency || LIMITS.maxConcurrent, LIMITS.maxConcurrent));

  const targets = jobs.filter((j) =>
    retryFailedOnly ? j.status === JOB_STATUS.FAILED : (j.status === JOB_STATUS.QUEUED || j.status === JOB_STATUS.FAILED)
  );
  if (retryFailedOnly) targets.forEach((j) => (j.attempts = 0));

  await runPool(targets, concurrency, processJob);
  running = false;

  storage.appendHistory({
    total: jobs.length,
    done: jobs.filter((j) => j.status === JOB_STATUS.DONE).length,
    failed: jobs.filter((j) => j.status === JOB_STATUS.FAILED).length,
    mode: settings.mode,
  });
}

export function isRunning() {
  return running;
}

export function clear() {
  jobs.forEach((j) => j.resultURL && URL.revokeObjectURL(j.resultURL));
  jobs = [];
  backdropCache = new Map();
  emitProgress();
}

export { safeFileName };
