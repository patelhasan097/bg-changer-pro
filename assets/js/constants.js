/**
 * constants.js
 * -----------------------------------------------------------------------
 * Single source of truth for every "magic value" in the app: model IDs,
 * storage keys, default limits and CDN URLs. Nothing in here talks to the
 * network or the DOM — it's just data, so it's safe to import from any
 * other module without creating circular dependencies.
 *
 * WHY THESE MODELS SPECIFICALLY (read this before you swap one out):
 *
 *  - EDIT_MODEL (Qwen/Qwen-Image-Edit-2509): instruction-based image
 *    editor. You send ONE photo + ONE sentence ("change the background
 *    to X, keep the food identical") and get ONE new photo back — no
 *    mask required. It is Apache-2.0 licensed, so it's safe to use in a
 *    paid, commercial workflow. This is the ONE-CALL-PER-IMAGE path.
 *
 *  - BACKDROP_MODEL (black-forest-labs/FLUX.1-schnell): plain
 *    text-to-image, Apache-2.0. Used only in "Composite Mode" to paint a
 *    brand new backdrop from the prompt. It never sees the food photo,
 *    so it cannot hallucinate the dish — the dish is pasted on top of it
 *    locally afterwards (see segmentation.js + queue.js).
 *
 *  - SEGMENTATION_MODEL (onnx-community/BEN2-ONNX, MIT licensed): runs
 *    100% inside the browser via transformers.js / WebGPU. It never
 *    calls the Hugging Face API, so it costs zero quota no matter how
 *    many images you run. It is only used in "Composite Mode".
 *
 * Swap any of these in Settings -> Advanced without touching code, in
 * case Hugging Face reshuffles which provider serves which model (this
 * happens periodically — check the model's "Inference Providers" widget
 * on huggingface.co before a big shoot).
 */

export const CDN = {
  // Pinned versions on purpose — an unpinned CDN import can change under
  // you overnight. Bump these deliberately, test, then commit.
  hfInference: 'https://cdn.jsdelivr.net/npm/@huggingface/inference@4.13.23/+esm',
  transformers: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0',
  jszip: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
};

export const MODELS = {
  // Fast Mode — one instruction-based edit call per image.
  edit: {
    id: 'Qwen/Qwen-Image-Edit-2509',
    provider: 'auto',
    license: 'Apache-2.0 (commercial use OK)',
  },
  // Composite Mode — one text-to-image call per UNIQUE prompt in the batch
  // (reused across every photo that shares that prompt).
  backdrop: {
    id: 'black-forest-labs/FLUX.1-schnell',
    provider: 'auto',
    license: 'Apache-2.0 (commercial use OK)',
  },
  // Composite Mode — local only, never billed against your HF quota.
  segmentation: {
    id: 'onnx-community/BEN2-ONNX',
    license: 'MIT (commercial use OK)',
  },
};

export const STORAGE_KEYS = {
  tokens: 'fbg.tokens.v1',
  settings: 'fbg.settings.v1',
  history: 'fbg.history.v1',
  vaultCheck: 'fbg.vaultcheck.v1',
};

export const LIMITS = {
  maxTokens: 5,
  maxBatchImages: 10,
  maxConcurrent: 3,
  maxRetries: 3,
  retryBaseDelayMs: 1500,
  maxImageDimension: 2048, // longest edge sent to the API; keeps payloads/quota sane
  jpegQuality: 0.92,
};

// Hugging Face does not expose exact remaining quota through the API.
// This is an editable, approximate monthly credit assumption per token
// used only to render the dashboard's progress rings — it is never used
// to block a request. See tokenManager.js.
export const DEFAULT_ASSUMED_MONTHLY_CREDITS = 100000;

export const TOKEN_STATUS = {
  IDLE: 'idle',
  ACTIVE: 'active',
  EXHAUSTED: 'exhausted',
  ERROR: 'error',
};

export const JOB_STATUS = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  DONE: 'done',
  FAILED: 'failed',
  RETRYING: 'retrying',
};
