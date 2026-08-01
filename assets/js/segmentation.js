/**
 * segmentation.js
 * -----------------------------------------------------------------------
 * Runs subject/background segmentation entirely inside the browser using
 * transformers.js (WebGPU with automatic WASM fallback). This never
 * calls the Hugging Face Inference API, so it is free and unlimited no
 * matter how many images you process — it only costs the one-time model
 * download (cached by the service worker after the first run).
 *
 * Only used in "Composite Mode". Fast Mode (instruction-based editing)
 * never touches this file.
 */

import { CDN, MODELS } from './constants.js';

let pipelinePromise = null;

async function loadPipeline(onProgress) {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import(CDN.transformers);
      // Let transformers.js pick WebGPU when available; it falls back to
      // WASM automatically on browsers/devices without WebGPU support.
      env.allowLocalModels = false;
      const segmenter = await pipeline('background-removal', MODELS.segmentation.id, {
        progress_callback: (p) => {
          if (onProgress && p.status === 'progress') {
            onProgress(Math.round((p.loaded / p.total) * 100) || 0);
          }
        },
      });
      return segmenter;
    })();
  }
  return pipelinePromise;
}

/**
 * @param {HTMLCanvasElement|HTMLImageElement} imageSource
 * @param {(pct:number)=>void} [onModelLoadProgress]
 * @returns {Promise<{maskCanvas: HTMLCanvasElement}>} an 8-bit alpha mask
 *   the same size as the input, white = subject (keep), black = background
 *   (replace).
 */
export async function extractSubjectMask(imageSource, onModelLoadProgress) {
  const { RawImage } = await import(CDN.transformers);
  const segmenter = await loadPipeline(onModelLoadProgress);

  const rawImage = imageSource instanceof HTMLCanvasElement
    ? await RawImage.fromCanvas(imageSource)
    : await RawImage.fromURL(imageSource.src);

  const [result] = await segmenter(rawImage);
  // `result` from the background-removal pipeline is a RawImage whose
  // alpha channel already encodes the subject mask.
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = result.width;
  maskCanvas.height = result.height;
  const ctx = maskCanvas.getContext('2d');
  const imgData = ctx.createImageData(result.width, result.height);

  const channels = result.channels; // typically 4 (RGBA) after this pipeline
  for (let i = 0, p = 0; i < result.data.length; i += channels, p += 4) {
    const alpha = channels === 4 ? result.data[i + 3] : 255;
    imgData.data[p] = alpha;
    imgData.data[p + 1] = alpha;
    imgData.data[p + 2] = alpha;
    imgData.data[p + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return { maskCanvas };
}

/**
 * Composites the original subject over a new backdrop using the alpha
 * mask, with a soft feathered edge and a synthetic contact shadow so the
 * cutout doesn't look "pasted." Everything here is plain Canvas 2D — no
 * network, no API call.
 */
export function compositeOntoBackdrop(originalCanvas, maskCanvas, backdropImage) {
  const w = originalCanvas.width;
  const h = originalCanvas.height;

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');

  // 1. Draw the new backdrop, cropped/scaled to cover the frame (like
  //    CSS background-size: cover) so proportions stay natural.
  const scale = Math.max(w / backdropImage.width, h / backdropImage.height);
  const bw = backdropImage.width * scale;
  const bh = backdropImage.height * scale;
  ctx.drawImage(backdropImage, (w - bw) / 2, (h - bh) / 2, bw, bh);

  // 2. Feather the mask slightly so the cutout edge doesn't look
  //    razor-sharp against the new background.
  const feathered = document.createElement('canvas');
  feathered.width = w;
  feathered.height = h;
  const fctx = feathered.getContext('2d');
  fctx.filter = 'blur(1.5px)';
  fctx.drawImage(maskCanvas, 0, 0, w, h);
  fctx.filter = 'none';

  // 3. Synthetic contact shadow: a soft, dark, blurred silhouette offset
  //    slightly down from the subject, drawn BEFORE the subject itself.
  const shadow = document.createElement('canvas');
  shadow.width = w;
  shadow.height = h;
  const sctx = shadow.getContext('2d');
  sctx.filter = 'blur(14px)';
  sctx.globalAlpha = 0.35;
  sctx.drawImage(feathered, 0, Math.round(h * 0.012));
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = '#000000';
  sctx.fillRect(0, 0, w, h);
  ctx.drawImage(shadow, 0, 0);

  // 4. Cut the subject out of the original photo using the feathered
  //    mask as an alpha channel, then draw it on top.
  const subject = document.createElement('canvas');
  subject.width = w;
  subject.height = h;
  const subCtx = subject.getContext('2d');
  subCtx.drawImage(originalCanvas, 0, 0);
  subCtx.globalCompositeOperation = 'destination-in';
  subCtx.drawImage(feathered, 0, 0);
  ctx.drawImage(subject, 0, 0);

  return out;
}
