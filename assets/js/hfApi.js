/**
 * hfApi.js
 * -----------------------------------------------------------------------
 * The only module that talks to Hugging Face. Uses the official
 * `@huggingface/inference` client (loaded from a pinned CDN URL) instead
 * of hand-rolled fetch calls, because the exact request shape for
 * image tasks differs by provider and the SDK already normalizes that
 * for us — see constants.js CDN.hfInference.
 *
 * Every exported function throws a `ClassifiedError` on failure so the
 * queue/token manager can decide what to do next without re-guessing
 * what went wrong.
 *
 * IMPORTANT CAVEAT (please read):
 * Hugging Face's serverless Inference Providers layer changes fairly
 * often — which third-party provider serves a given model, and even
 * whether a model is served at all, can shift week to week. If a call
 * here starts failing with a 404 / "not supported" style error, open the
 * model's page on huggingface.co and check the "Inference Providers"
 * panel for a currently-live provider name, then set it in
 * Settings -> Advanced (or edit MODELS in constants.js).
 */

import { CDN } from './constants.js';

let clientCache = new Map(); // token -> InferenceClient instance

async function getClient(token) {
  if (!clientCache.has(token)) {
    const { InferenceClient } = await import(CDN.hfInference);
    clientCache.set(token, new InferenceClient(token));
  }
  return clientCache.get(token);
}

export class ClassifiedError extends Error {
  constructor(message, kind, cause) {
    super(message);
    this.kind = kind; // 'quota' | 'transient' | 'fatal'
    this.cause = cause;
  }
}

/** Best-effort classification since the SDK's error shape isn't fully
 *  documented for every provider. We check every field we plausibly can
 *  before falling back to a safe "transient" guess. */
function classify(err) {
  const status =
    err?.status ??
    err?.httpResponse?.status ??
    err?.response?.status ??
    null;
  const msg = String(err?.message || err || '').toLowerCase();

  if (status === 401 || status === 403 || msg.includes('invalid') && msg.includes('token')) {
    return new ClassifiedError('Token rejected (invalid or revoked).', 'fatal', err);
  }
  if (
    status === 402 ||
    status === 429 ||
    msg.includes('quota') ||
    msg.includes('credit') ||
    msg.includes('exceeded') ||
    msg.includes('rate limit')
  ) {
    return new ClassifiedError('Quota/rate limit hit for this token.', 'quota', err);
  }
  if (status === 503 || msg.includes('loading') || msg.includes('warm')) {
    return new ClassifiedError('Model is cold-starting, worth a retry shortly.', 'transient', err);
  }
  if (status >= 500 || msg.includes('timeout') || msg.includes('network') || msg.includes('fetch')) {
    return new ClassifiedError('Transient network/server error.', 'transient', err);
  }
  return new ClassifiedError(err?.message || 'Unknown error calling Hugging Face.', 'transient', err);
}

function buildEditInstruction(userPrompt) {
  // Turn the user's plain description into a stronger preservation
  // instruction. The model still only gets ONE call.
  return (
    `Change ONLY the background/surface/setting to: ${userPrompt}. ` +
    `Keep the food, plate, cutlery, garnish, textures, shadows on the food, ` +
    `and camera framing exactly the same — do not alter, regenerate, or ` +
    `move the dish itself in any way.`
  );
}

/**
 * Fast Mode: one instruction-based edit call.
 * @param {string} token
 * @param {Blob} imageBlob
 * @param {string} userPrompt
 * @param {{id:string, provider:string}} model
 * @returns {Promise<Blob>} the edited image
 */
export async function editImage(token, imageBlob, userPrompt, model) {
  try {
    const client = await getClient(token);
    const result = await client.imageToImage({
      inputs: imageBlob,
      model: model.id,
      provider: model.provider || 'auto',
      parameters: { prompt: buildEditInstruction(userPrompt) },
    });
    return result;
  } catch (err) {
    throw classify(err);
  }
}

/**
 * Composite Mode: one text-to-image call PER UNIQUE PROMPT (the caller
 * is responsible for reusing the result across every photo that shares
 * the same backdrop prompt — see queue.js).
 * @param {string} token
 * @param {string} userPrompt
 * @param {{id:string, provider:string}} model
 * @returns {Promise<Blob>} the generated backdrop image
 */
export async function generateBackdrop(token, userPrompt, model) {
  try {
    const client = await getClient(token);
    const result = await client.textToImage({
      inputs: `${userPrompt}, empty surface with no objects or food on it, ` +
        `professional studio product-photography backdrop, soft directional ` +
        `light, shallow depth of field, high detail, photorealistic`,
      model: model.id,
      provider: model.provider || 'auto',
    });
    return result;
  } catch (err) {
    throw classify(err);
  }
}

/** Drop a cached client (e.g. after a token is removed from the vault). */
export function forgetClient(token) {
  clientCache.delete(token);
}
