/**
 * imageUtils.js
 * -----------------------------------------------------------------------
 * Small, dependency-free helpers for moving between File / HTMLImageElement
 * / Canvas / Blob. Shared by queue.js (pre-processing before an API call),
 * segmentation.js (compositing) and ui.js (thumbnails).
 */

import { LIMITS } from './constants.js';

/** Load a File/Blob into a decoded HTMLImageElement. */
export function loadImage(fileOrBlob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fileOrBlob);
    const img = new Image();
    img.onload = () => {
      resolve(img);
      // Caller owns the URL lifetime for `img.src` re-use; revoke lazily
      // on the next tick so decode has definitely finished everywhere.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode image file.'));
    };
    img.src = url;
  });
}

/** Draw an image onto a canvas, downscaling so the longest edge never
 *  exceeds LIMITS.maxImageDimension (keeps payload size + quota sane). */
export function drawToCanvas(img, maxDimension = LIMITS.maxImageDimension) {
  let { width, height } = img;
  const longest = Math.max(width, height);
  if (longest > maxDimension) {
    const scale = maxDimension / longest;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);
  return canvas;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = LIMITS.jpegQuality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export function canvasToThumbnail(canvas, maxSide = 220) {
  const scale = maxSide / Math.max(canvas.width, canvas.height);
  const w = Math.round(canvas.width * scale);
  const h = Math.round(canvas.height * scale);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').drawImage(canvas, 0, 0, w, h);
  return out.toDataURL('image/jpeg', 0.8);
}

export function blobToObjectURL(blob) {
  return URL.createObjectURL(blob);
}

export function safeFileName(base, ext = 'jpg') {
  const cleaned = base.replace(/\.[^/.]+$/, '').replace(/[^a-z0-9_\-]+/gi, '_');
  return `${cleaned || 'image'}_bg.${ext}`;
}
