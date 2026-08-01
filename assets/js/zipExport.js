/**
 * zipExport.js
 * -----------------------------------------------------------------------
 * Bundles completed job results into a single ZIP (via JSZip, loaded
 * lazily from CDN) or triggers individual file downloads. Pure browser
 * APIs — no server round-trip.
 */

import { CDN } from './constants.js';
import { safeFileName } from './imageUtils.js';

let jsZipLoadPromise = null;

function loadJSZip() {
  if (!jsZipLoadPromise) {
    jsZipLoadPromise = new Promise((resolve, reject) => {
      if (window.JSZip) return resolve(window.JSZip);
      const script = document.createElement('script');
      script.src = CDN.jszip;
      script.onload = () => resolve(window.JSZip);
      script.onerror = () => reject(new Error('Failed to load JSZip from CDN.'));
      document.head.appendChild(script);
    });
  }
  return jsZipLoadPromise;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** @param {Array<{fileName:string, resultBlob:Blob}>} doneJobs */
export function downloadOne(job) {
  if (!job.resultBlob) return;
  triggerDownload(job.resultBlob, safeFileName(job.fileName));
}

export async function downloadAllIndividually(doneJobs) {
  for (const job of doneJobs) {
    downloadOne(job);
    // Small stagger so the browser doesn't block "multiple download" popups.
    await new Promise((r) => setTimeout(r, 350));
  }
}

export async function downloadZip(doneJobs, zipName = 'background-changed-photos.zip') {
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const usedNames = new Set();

  doneJobs.forEach((job, i) => {
    if (!job.resultBlob) return;
    let name = safeFileName(job.fileName);
    if (usedNames.has(name)) {
      name = safeFileName(`${job.fileName}_${i + 1}`);
    }
    usedNames.add(name);
    zip.file(name, job.resultBlob);
  });

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  triggerDownload(blob, zipName);
}
