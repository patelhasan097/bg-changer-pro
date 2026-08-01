/**
 * ui.js
 * -----------------------------------------------------------------------
 * All DOM wiring lives here. Every other module is DOM-free and only
 * exposes data + callbacks, so this file is the single translation layer
 * between "app state" and "what the person sees." It's long because a
 * production UI has a lot of small states to handle (empty vault, locked
 * vault, mid-batch, all-failed, etc.) — but nothing in it is a stub.
 */

import { LIMITS, JOB_STATUS, TOKEN_STATUS } from './constants.js';
import * as storage from './storage.js';
import * as tokenManager from './tokenManager.js';
import * as queue from './queue.js';
import * as zipExport from './zipExport.js';

// ---------------------------------------------------------------------
// DOM cache
// ---------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let dom = {};
let state = {
  batchMode: 'batch', // 'batch' | 'single'
  pendingFiles: [], // File[] selected but not yet started
};

function cacheDom() {
  dom = {
    navButtons: $all('.nav-btn'),
    navTokenBadge: $('#nav-token-badge'),
    views: { workspace: $('#view-workspace'), settings: $('#view-settings') },

    batchModeToggle: $('#batch-mode-toggle'),
    procModeToggle: $('#proc-mode-toggle'),

    dropzone: $('#dropzone'),
    fileInput: $('#file-input'),
    dropzoneHint: $('#dropzone-hint'),
    thumbGrid: $('#thumb-grid'),
    imageCountLabel: $('#image-count-label'),

    promptInput: $('#prompt-input'),
    promptExamples: $('#prompt-examples'),
    startBtn: $('#start-btn'),

    processingPanel: $('#processing-panel'),
    progressFill: $('#progress-fill'),
    statTotal: $('#stat-total'),
    statDone: $('#stat-done'),
    statFailed: $('#stat-failed'),
    statRemaining: $('#stat-remaining'),
    statPercent: $('#stat-percent'),
    contactSheet: $('#contact-sheet'),
    retryFailedBtn: $('#retry-failed-btn'),
    downloadZipBtn: $('#download-zip-btn'),
    downloadAllBtn: $('#download-all-btn'),
    newBatchBtn: $('#new-batch-btn'),

    vaultStatus: $('#vault-status'),
    unlockVaultBtn: $('#unlock-vault-btn'),
    setPinBtn: $('#set-pin-btn'),
    removePinBtn: $('#remove-pin-btn'),
    addTokenBtn: $('#add-token-btn'),
    tokenDashboard: $('#token-dashboard'),

    editModelInput: $('#edit-model-input'),
    backdropModelInput: $('#backdrop-model-input'),
    concurrencyRange: $('#concurrency-range'),
    concurrencyValue: $('#concurrency-value'),
    saveAdvancedBtn: $('#save-advanced-btn'),

    tokenModal: $('#token-modal'),
    tokenLabelInput: $('#token-label-input'),
    tokenValueInput: $('#token-value-input'),
    tokenPinRow: $('#token-pin-row'),
    tokenPinInput: $('#token-pin-input'),
    tokenModalForm: $('#token-modal-form'),
    tokenModalCancel: $('#token-modal-cancel'),

    pinModal: $('#pin-modal'),
    pinModalTitle: $('#pin-modal-title'),
    pinModalForm: $('#pin-modal-form'),
    pinInput: $('#pin-input'),
    pinConfirmRow: $('#pin-confirm-row'),
    pinConfirmInput: $('#pin-confirm-input'),
    pinModalCancel: $('#pin-modal-cancel'),
    pinModalError: $('#pin-modal-error'),

    confirmModal: $('#confirm-modal'),
    confirmModalMessage: $('#confirm-modal-message'),
    confirmModalOk: $('#confirm-modal-ok'),
    confirmModalCancel: $('#confirm-modal-cancel'),

    toastContainer: $('#toast-container'),
  };
}

// ---------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------
export function showToast(message, kind = 'info', timeout = 4200) {
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.setAttribute('role', 'status');
  el.textContent = message;
  dom.toastContainer.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast--in'));
  setTimeout(() => {
    el.classList.remove('toast--in');
    setTimeout(() => el.remove(), 250);
  }, timeout);
}

// ---------------------------------------------------------------------
// Simple confirm dialog (returns a Promise<boolean>)
// ---------------------------------------------------------------------
function confirmDialog(message) {
  return new Promise((resolve) => {
    dom.confirmModalMessage.textContent = message;
    dom.confirmModal.showModal();
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    function cleanup(result) {
      dom.confirmModalOk.removeEventListener('click', onOk);
      dom.confirmModalCancel.removeEventListener('click', onCancel);
      dom.confirmModal.close();
      resolve(result);
    }
    dom.confirmModalOk.addEventListener('click', onOk, { once: true });
    dom.confirmModalCancel.addEventListener('click', onCancel, { once: true });
  });
}

// ---------------------------------------------------------------------
// PIN prompt (generic) — returns a Promise<string|null>
// ---------------------------------------------------------------------
function pinDialog({ title, needConfirm = false }) {
  return new Promise((resolve) => {
    dom.pinModalTitle.textContent = title;
    dom.pinConfirmRow.hidden = !needConfirm;
    dom.pinInput.value = '';
    dom.pinConfirmInput.value = '';
    dom.pinModalError.textContent = '';
    dom.pinModal.showModal();
    dom.pinInput.focus();

    function onSubmit(e) {
      e.preventDefault();
      const pin = dom.pinInput.value.trim();
      if (pin.length < 4) {
        dom.pinModalError.textContent = 'PIN must be at least 4 characters.';
        return;
      }
      if (needConfirm && pin !== dom.pinConfirmInput.value.trim()) {
        dom.pinModalError.textContent = 'PINs do not match.';
        return;
      }
      cleanup();
      dom.pinModal.close();
      resolve(pin);
    }
    function onCancel() {
      cleanup();
      dom.pinModal.close();
      resolve(null);
    }
    function cleanup() {
      dom.pinModalForm.removeEventListener('submit', onSubmit);
      dom.pinModalCancel.removeEventListener('click', onCancel);
    }
    dom.pinModalForm.addEventListener('submit', onSubmit);
    dom.pinModalCancel.addEventListener('click', onCancel, { once: true });
  });
}

// ---------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------
function switchView(name) {
  for (const [key, el] of Object.entries(dom.views)) {
    el.hidden = key !== name;
  }
  dom.navButtons.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.nav === name));
  if (name === 'settings') renderTokenDashboard(tokenManager.getDashboardSnapshot());
}

function wireNav() {
  dom.navButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.nav));
  });
  dom.navTokenBadge.addEventListener('click', () => switchView('settings'));
}

// ---------------------------------------------------------------------
// Mode toggles
// ---------------------------------------------------------------------
function wireModeToggles() {
  $all('button', dom.batchModeToggle).forEach((btn) => {
    btn.addEventListener('click', () => {
      state.batchMode = btn.dataset.batchmode;
      $all('button', dom.batchModeToggle).forEach((b) => b.classList.toggle('is-active', b === btn));
      dom.fileInput.multiple = state.batchMode === 'batch';
      dom.dropzoneHint.textContent =
        state.batchMode === 'batch'
          ? `Drag up to ${LIMITS.maxBatchImages} photos here, or click to browse`
          : 'Drag one photo here, or click to browse';
      clearPendingFiles();
    });
  });

  $all('button', dom.procModeToggle).forEach((btn) => {
    btn.addEventListener('click', () => {
      storage.saveSettings({ mode: btn.dataset.procmode });
      $all('button', dom.procModeToggle).forEach((b) => b.classList.toggle('is-active', b === btn));
    });
  });
}

function applySettingsToModeToggle() {
  const settings = storage.getSettings();
  $all('button', dom.procModeToggle).forEach((b) =>
    b.classList.toggle('is-active', b.dataset.procmode === settings.mode)
  );
  dom.editModelInput.value = settings.editModelId || '';
  dom.backdropModelInput.value = settings.backdropModelId || '';
  dom.concurrencyRange.value = settings.concurrency;
  dom.concurrencyValue.textContent = settings.concurrency;
}

// ---------------------------------------------------------------------
// Upload / dropzone / thumbnails
// ---------------------------------------------------------------------
function wireDropzone() {
  dom.dropzone.addEventListener('click', () => dom.fileInput.click());
  dom.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') dom.fileInput.click();
  });
  ['dragenter', 'dragover'].forEach((evt) =>
    dom.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dom.dropzone.classList.add('is-dragover');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dom.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dom.dropzone.classList.remove('is-dragover');
    })
  );
  dom.dropzone.addEventListener('drop', (e) => {
    addFiles(e.dataTransfer.files);
  });
  dom.fileInput.addEventListener('change', (e) => {
    addFiles(e.target.files);
    dom.fileInput.value = '';
  });
}

function addFiles(fileList) {
  const incoming = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
  if (!incoming.length) return;

  const limit = state.batchMode === 'single' ? 1 : LIMITS.maxBatchImages;
  let combined = state.batchMode === 'single' ? incoming.slice(0, 1) : [...state.pendingFiles, ...incoming];
  if (combined.length > limit) {
    showToast(`Only the first ${limit} images were kept (limit for this mode).`, 'warn');
    combined = combined.slice(0, limit);
  }
  state.pendingFiles = combined;
  renderThumbGrid();
}

function clearPendingFiles() {
  state.pendingFiles = [];
  renderThumbGrid();
}

function renderThumbGrid() {
  dom.thumbGrid.innerHTML = '';
  dom.thumbGrid.hidden = state.pendingFiles.length === 0;
  state.pendingFiles.forEach((file, idx) => {
    const card = document.createElement('div');
    card.className = 'thumb-card';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(img.src);
    img.alt = file.name;
    const remove = document.createElement('button');
    remove.className = 'thumb-card__remove';
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.textContent = '✕';
    remove.addEventListener('click', () => {
      state.pendingFiles.splice(idx, 1);
      renderThumbGrid();
    });
    const name = document.createElement('span');
    name.className = 'thumb-card__name';
    name.textContent = file.name;
    card.append(img, remove, name);
    dom.thumbGrid.appendChild(card);
  });
  dom.imageCountLabel.textContent = state.pendingFiles.length
    ? `${state.pendingFiles.length} image${state.pendingFiles.length > 1 ? 's' : ''} ready`
    : '';
  dom.startBtn.disabled = state.pendingFiles.length === 0;
}

function wirePromptExamples() {
  $all('button', dom.promptExamples).forEach((btn) => {
    btn.addEventListener('click', () => {
      dom.promptInput.value = btn.dataset.example;
      dom.promptInput.focus();
    });
  });
}

// ---------------------------------------------------------------------
// Processing / contact sheet
// ---------------------------------------------------------------------
function statusLabel(status) {
  return {
    [JOB_STATUS.QUEUED]: 'Queued',
    [JOB_STATUS.PROCESSING]: 'Processing…',
    [JOB_STATUS.RETRYING]: 'Retrying…',
    [JOB_STATUS.DONE]: 'Done',
    [JOB_STATUS.FAILED]: 'Failed',
  }[status] || status;
}

function renderContactSheet(jobs) {
  dom.contactSheet.innerHTML = '';
  jobs.forEach((job) => {
    const card = document.createElement('div');
    card.className = `job-card job-card--${job.status}`;
    card.dataset.jobId = job.id;

    const imgWrap = document.createElement('div');
    imgWrap.className = 'job-card__image';
    const img = document.createElement('img');
    img.src = job.resultURL || job.thumbnail;
    img.alt = job.fileName;
    imgWrap.appendChild(img);

    const ring = document.createElement('div');
    ring.className = 'job-card__ring';
    ring.innerHTML = ringSVG(job.status);
    imgWrap.appendChild(ring);

    const meta = document.createElement('div');
    meta.className = 'job-card__meta';
    const name = document.createElement('span');
    name.className = 'job-card__name';
    name.textContent = job.fileName;
    const status = document.createElement('span');
    status.className = 'job-card__status';
    status.textContent = job.status === JOB_STATUS.FAILED ? (job.error || 'Failed') : statusLabel(job.status);
    meta.append(name, status);

    if (job.status === JOB_STATUS.DONE) {
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'job-card__download';
      dl.textContent = 'Download';
      dl.addEventListener('click', () => zipExport.downloadOne(job));
      meta.appendChild(dl);
    }

    card.append(imgWrap, meta);
    dom.contactSheet.appendChild(card);
  });
}

function ringSVG(status) {
  const color =
    status === JOB_STATUS.DONE ? 'var(--ok)' :
    status === JOB_STATUS.FAILED ? 'var(--danger)' :
    'var(--accent-amber)';
  const spin = status === JOB_STATUS.PROCESSING || status === JOB_STATUS.RETRYING ? 'ring--spin' : '';
  return `<svg class="${spin}" viewBox="0 0 40 40" width="28" height="28">
    <circle cx="20" cy="20" r="16" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="4"/>
    <circle cx="20" cy="20" r="16" fill="none" stroke="${color}" stroke-width="4"
      stroke-dasharray="${status === JOB_STATUS.DONE ? '100 0' : '28 72'}" stroke-linecap="round"/>
  </svg>`;
}

function updateProgressUI(snapshot) {
  dom.statTotal.textContent = snapshot.total;
  dom.statDone.textContent = snapshot.done;
  dom.statFailed.textContent = snapshot.failed;
  dom.statRemaining.textContent = snapshot.remaining;
  dom.statPercent.textContent = `${snapshot.percent}%`;
  dom.progressFill.style.width = `${snapshot.percent}%`;
  dom.retryFailedBtn.hidden = snapshot.failed === 0;
  const finished = snapshot.total > 0 && snapshot.remaining === 0 && snapshot.processing === 0;
  dom.downloadZipBtn.disabled = !finished || snapshot.done === 0;
  dom.downloadAllBtn.disabled = !finished || snapshot.done === 0;
}

// ---------------------------------------------------------------------
// Start / retry / download actions
// ---------------------------------------------------------------------
async function handleStart() {
  const prompt = dom.promptInput.value.trim();
  if (!prompt) {
    showToast('Describe the new background first.', 'warn');
    dom.promptInput.focus();
    return;
  }
  if (!tokenManager.hasAnyUsableToken()) {
    showToast('Add at least one Hugging Face token in Settings before processing.', 'error');
    switchView('settings');
    return;
  }
  if (storage.isVaultLocked() && !storage.getSessionPin()) {
    showToast('Your token vault is PIN-locked. Unlock it in Settings first.', 'error');
    switchView('settings');
    return;
  }
  dom.processingPanel.hidden = false;
  dom.processingPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  await queue.loadBatch(state.pendingFiles, prompt);
  renderContactSheet(queue.getJobs());
  await queue.start();
}

async function handleRetryFailed() {
  await queue.start({ retryFailedOnly: true });
}

function handleNewBatch() {
  queue.clear();
  clearPendingFiles();
  dom.promptInput.value = '';
  dom.processingPanel.hidden = true;
}

function wireProcessingActions() {
  dom.startBtn.addEventListener('click', handleStart);
  dom.retryFailedBtn.addEventListener('click', handleRetryFailed);
  dom.newBatchBtn.addEventListener('click', handleNewBatch);
  dom.downloadZipBtn.addEventListener('click', () => {
    const done = queue.getJobs().filter((j) => j.status === JOB_STATUS.DONE);
    zipExport.downloadZip(done);
  });
  dom.downloadAllBtn.addEventListener('click', () => {
    const done = queue.getJobs().filter((j) => j.status === JOB_STATUS.DONE);
    zipExport.downloadAllIndividually(done);
  });

  queue.onProgress(updateProgressUI);
  queue.onJobUpdate((job) => {
    renderContactSheet(queue.getJobs());
  });
}

// ---------------------------------------------------------------------
// Token dashboard (Settings)
// ---------------------------------------------------------------------
function statusText(status) {
  return {
    [TOKEN_STATUS.IDLE]: 'Ready',
    [TOKEN_STATUS.ACTIVE]: 'In use',
    [TOKEN_STATUS.EXHAUSTED]: 'Exhausted',
    [TOKEN_STATUS.ERROR]: 'Error',
  }[status] || status;
}

function renderTokenDashboard(snapshot) {
  dom.tokenDashboard.innerHTML = '';
  if (snapshot.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = 'No tokens saved yet — add up to 5 Hugging Face access tokens to start processing.';
    dom.tokenDashboard.appendChild(empty);
  }
  snapshot.forEach((t) => {
    const card = document.createElement('div');
    card.className = `token-card token-card--${t.status}`;

    const dial = document.createElement('div');
    dial.className = 'token-card__dial';
    dial.style.setProperty('--pct', t.percentUsed);
    dial.innerHTML = `<span class="token-card__pct">${t.percentUsed}%</span>`;

    const info = document.createElement('div');
    info.className = 'token-card__info';
    info.innerHTML = `
      <strong class="token-card__label">${escapeHTML(t.label)}</strong>
      <span class="token-card__status">${statusText(t.status)}</span>
      <span class="token-card__meta">Calls: ${t.callCount} · Errors: ${t.errorCount}</span>
      <span class="token-card__meta">Last used: ${t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : 'never'}</span>
      <span class="token-card__meta token-card__meta--muted">Approx. remaining: ${t.remainingApprox} (assumed quota, not exact)</span>
    `;

    const actions = document.createElement('div');
    actions.className = 'token-card__actions';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset status';
    resetBtn.addEventListener('click', () => tokenManager.resetToken(t.id));
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'danger';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      const ok = await confirmDialog(`Remove "${t.label}"? This can't be undone.`);
      if (ok) {
        storage.removeToken(t.id);
        renderTokenDashboard(tokenManager.getDashboardSnapshot());
        updateVaultStatusUI();
      }
    });
    actions.append(resetBtn, removeBtn);

    card.append(dial, info, actions);
    dom.tokenDashboard.appendChild(card);
  });
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function updateNavBadge() {
  const snap = tokenManager.getDashboardSnapshot();
  const usable = snap.filter((t) => t.status !== TOKEN_STATUS.EXHAUSTED && t.status !== TOKEN_STATUS.ERROR).length;
  dom.navTokenBadge.textContent = snap.length === 0 ? 'Add a token' : `${usable}/${snap.length} tokens ready`;
  dom.navTokenBadge.classList.toggle('nav-badge--warn', snap.length === 0 || usable === 0);
}

// ---------------------------------------------------------------------
// Vault status + PIN flows
// ---------------------------------------------------------------------
function updateVaultStatusUI() {
  const vault = storage.getVault();
  const hasSession = !!storage.getSessionPin();
  if (!vault.locked) {
    dom.vaultStatus.textContent = 'Not PIN-protected (tokens are lightly obfuscated only).';
    dom.unlockVaultBtn.hidden = true;
    dom.setPinBtn.textContent = 'Set a PIN';
    dom.removePinBtn.hidden = true;
  } else if (hasSession) {
    dom.vaultStatus.textContent = 'PIN-protected — unlocked for this session.';
    dom.unlockVaultBtn.hidden = true;
    dom.setPinBtn.textContent = 'Change PIN';
    dom.removePinBtn.hidden = false;
  } else {
    dom.vaultStatus.textContent = 'PIN-protected — locked. Unlock to process images.';
    dom.unlockVaultBtn.hidden = false;
    dom.setPinBtn.textContent = 'Change PIN';
    dom.removePinBtn.hidden = false;
  }
}

async function handleUnlockVault() {
  const pin = await pinDialog({ title: 'Unlock token vault' });
  if (!pin) return;
  const ok = await storage.checkVaultPin(pin);
  if (!ok) {
    showToast('Incorrect PIN.', 'error');
    return;
  }
  storage.setSessionPin(pin);
  updateVaultStatusUI();
  showToast('Vault unlocked for this session.', 'success');
}

async function handleSetOrChangePin() {
  const vault = storage.getVault();
  let currentPin = null;
  if (vault.locked) {
    currentPin = storage.getSessionPin() || (await pinDialog({ title: 'Enter current PIN' }));
    if (!currentPin) return;
    const ok = await storage.checkVaultPin(currentPin);
    if (!ok) {
      showToast('Incorrect current PIN.', 'error');
      return;
    }
  }
  const newPin = await pinDialog({ title: vault.locked ? 'Set new PIN' : 'Create a PIN', needConfirm: true });
  if (!newPin) return;
  await storage.setVaultPin(newPin, currentPin);
  storage.setSessionPin(newPin);
  updateVaultStatusUI();
  showToast('PIN saved. Your tokens are now encrypted with it.', 'success');
}

async function handleRemovePin() {
  const currentPin = storage.getSessionPin() || (await pinDialog({ title: 'Enter current PIN to remove protection' }));
  if (!currentPin) return;
  const ok = await storage.checkVaultPin(currentPin);
  if (!ok) {
    showToast('Incorrect PIN.', 'error');
    return;
  }
  const confirmed = await confirmDialog('Remove PIN protection? Tokens will fall back to light obfuscation only.');
  if (!confirmed) return;
  await storage.removeVaultPin(currentPin);
  storage.clearSessionPin();
  updateVaultStatusUI();
  showToast('PIN protection removed.', 'info');
}

function wireVaultControls() {
  dom.unlockVaultBtn.addEventListener('click', handleUnlockVault);
  dom.setPinBtn.addEventListener('click', handleSetOrChangePin);
  dom.removePinBtn.addEventListener('click', handleRemovePin);
}

// ---------------------------------------------------------------------
// Add token modal
// ---------------------------------------------------------------------
function wireTokenModal() {
  dom.addTokenBtn.addEventListener('click', () => {
    if (storage.getVault().tokens.length >= LIMITS.maxTokens) {
      showToast(`Maximum of ${LIMITS.maxTokens} tokens reached.`, 'warn');
      return;
    }
    dom.tokenLabelInput.value = '';
    dom.tokenValueInput.value = '';
    const vault = storage.getVault();
    dom.tokenPinRow.hidden = !vault.locked || !!storage.getSessionPin();
    dom.tokenPinInput.value = '';
    dom.tokenModal.showModal();
    dom.tokenLabelInput.focus();
  });

  dom.tokenModalCancel.addEventListener('click', () => dom.tokenModal.close());

  dom.tokenModalForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = dom.tokenLabelInput.value.trim() || undefined;
    const value = dom.tokenValueInput.value.trim();
    if (!value.startsWith('hf_')) {
      showToast('That doesn\u2019t look like a Hugging Face token (should start with "hf_").', 'warn');
      return;
    }
    const vault = storage.getVault();
    let pin = storage.getSessionPin();
    if (vault.locked && !pin) {
      pin = dom.tokenPinInput.value.trim();
      if (!pin) {
        showToast('Enter the vault PIN to save this token.', 'warn');
        return;
      }
      const ok = await storage.checkVaultPin(pin);
      if (!ok) {
        showToast('Incorrect PIN.', 'error');
        return;
      }
    }
    try {
      await storage.addToken(value, label, pin);
      dom.tokenModal.close();
      renderTokenDashboard(tokenManager.getDashboardSnapshot());
      updateNavBadge();
      showToast('Token saved.', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

// ---------------------------------------------------------------------
// Advanced settings
// ---------------------------------------------------------------------
function wireAdvancedSettings() {
  dom.concurrencyRange.addEventListener('input', () => {
    dom.concurrencyValue.textContent = dom.concurrencyRange.value;
  });
  dom.saveAdvancedBtn.addEventListener('click', () => {
    storage.saveSettings({
      editModelId: dom.editModelInput.value.trim() || null,
      backdropModelId: dom.backdropModelInput.value.trim() || null,
      concurrency: Number(dom.concurrencyRange.value),
    });
    showToast('Advanced settings saved.', 'success');
  });
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
export function initUI() {
  cacheDom();
  wireNav();
  wireModeToggles();
  wireDropzone();
  wirePromptExamples();
  wireProcessingActions();
  wireVaultControls();
  wireTokenModal();
  wireAdvancedSettings();

  applySettingsToModeToggle();
  updateVaultStatusUI();
  renderTokenDashboard(tokenManager.getDashboardSnapshot());
  updateNavBadge();
  tokenManager.onChange(() => {
    updateNavBadge();
    if (!dom.views.settings.hidden) renderTokenDashboard(tokenManager.getDashboardSnapshot());
  });

  switchView('workspace');
  renderThumbGrid();
}
