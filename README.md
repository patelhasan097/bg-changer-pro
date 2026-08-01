# Platelight — AI Background Studio

A installable, 100% client-side PWA that batch-replaces the **background**
of food photos with AI, while keeping the dish itself untouched. Built for
photo teams processing large volumes of cloud-kitchen / menu photography.
No backend, no database, no build step — it's plain HTML/CSS/JS and it
deploys straight to GitHub Pages.

---

## 1. Read this before you rely on it for daily production work

This section is deliberately upfront and unglamorous, because the app
can't be honest about what it does if the README oversells it.

### Hugging Face's free quota is per-*account*, not per-token
Hugging Face's serverless "Inference Providers" credits are granted to
your **account**, not to an individual access token. Generating 5 tokens
from the *same* account gives you 5 keys into the *same* shared pool —
rotating between them buys you nothing. The token-rotation system in this
app only multiplies your real quota if each token belongs to a **different
Hugging Face account**, some of which may be your own additional accounts
and some of which may belong to colleagues who agree to lend a token for
your shared workload. Whether that fits your business and Hugging Face's
terms of service is your call to make — the app just rotates fairly
between whatever tokens you give it. A PRO subscription ($9/mo at the time
this was written) also multiplies a single account's allotment
substantially, which is usually the simpler and more clearly
ToS-compliant way to raise real throughput. Check
[huggingface.co/pricing](https://huggingface.co/pricing) for current
numbers before you plan a 1000-images/day workflow around this.

### "1 API call per image" — and how this app beats that
The brief asked for exactly one Hugging Face call per image. This app
does that in **Fast Mode**, and does better in **Composite Mode**:

- **Fast Mode** — one instruction-based image-edit call per photo
  (`Qwen/Qwen-Image-Edit-2509`). You send one photo + one sentence
  ("change the background to X, keep the food identical") and get one
  edited photo back.
- **Composite Mode** — the food is cut out of the photo **locally, for
  free**, using an in-browser AI model (no API call at all). A new
  backdrop is generated with **one API call for the whole batch**, not
  one per photo, since your batch normally shares a single background
  prompt — then every photo's cutout is composited onto that backdrop
  entirely on-device. The dish's pixels are never touched, let alone
  re-generated, so there is zero hallucination risk on the food, at the
  cost of 1 API call for the *entire batch* instead of per image.

Composite Mode is the better fit for the "food must be pixel-identical"
requirement; Fast Mode is simpler and handles reflections/interactions
between the dish and a glossy new surface more organically since the
model can subtly reconcile lighting. Try both and see which your reviewers
prefer — it's a toggle in the Workspace, no code change needed.

### Model licensing
- `Qwen/Qwen-Image-Edit-2509` — Apache-2.0, fine for commercial use.
- `black-forest-labs/FLUX.1-schnell` (Composite Mode backdrop) —
  Apache-2.0, fine for commercial use.
- `onnx-community/BEN2-ONNX` (Composite Mode local segmentation) — MIT,
  fine for commercial use.
- If you swap in a different model in Settings → Advanced (for example a
  FLUX.1 **Kontext [dev]** or BRIA RMBG variant some tutorials recommend),
  check its license first — several popular editing/segmentation models
  are **non-commercial only** unless you buy a separate commercial license
  from their maker. Using one anyway for a paid client's photography is a
  licensing problem the app can't detect for you.

### Hugging Face's provider layer shifts over time
Which third-party provider serves a given model changes periodically. If
a call suddenly starts failing with a "model not supported" style error,
open the model's page on huggingface.co, check the **Inference Providers**
panel for what's currently live, and update the model ID / provider in
Settings → Advanced.

None of this is a reason not to use the app — it's the difference between
a tool that works the first week and one that keeps working the first
year.

---

## 2. Features

- **Batch mode** — up to 10 images + one shared prompt.
- **Single image mode** — one image, one prompt, one download.
- **Fast Mode / Composite Mode** toggle (see above).
- **Up to 5 Hugging Face tokens**, PIN-encrypted (AES-GCM via Web Crypto)
  or lightly obfuscated if you skip the PIN.
- **Automatic token rotation** — round-robin by least-recently-used,
  skipping anything exhausted or erroring.
- **Live token dashboard** — status, last used, call count, error count,
  and an *approximate* remaining-quota ring (Hugging Face doesn't expose
  exact remaining quota via API, so this is a locally-tracked counter
  against an editable assumed monthly allotment — not a guarantee).
- **Smart queue** — configurable concurrency (1–3 in parallel), automatic
  retry with exponential backoff on transient errors, automatic token
  switch on quota/auth errors, "Retry Failed" without re-running
  already-succeeded images.
- **ZIP download**, individual downloads, or "download all" one-by-one.
- **Installable PWA** — offline app shell, cached static assets & CDN
  libraries, add-to-home-screen on mobile and desktop.

---

## 3. Project structure

```
├── index.html                  Page shell — all views/modals live here
├── style.css                   Full visual design (dark "studio" theme)
├── script.js                   Entry point: boots the UI, registers the SW
├── sw.js                       Service worker (offline + caching)
├── manifest.json               PWA manifest
├── assets/
│   ├── icons/                  App icons (192, 512, maskable 512)
│   └── js/
│       ├── constants.js        Model IDs, storage keys, limits — edit here first
│       ├── crypto.js           AES-GCM encryption for the token vault
│       ├── storage.js          localStorage layer (tokens, settings, history)
│       ├── tokenManager.js     Rotation logic + dashboard stats
│       ├── segmentation.js     Client-side background cutout (Composite Mode)
│       ├── hfApi.js            All Hugging Face API calls + error classification
│       ├── imageUtils.js       File/Canvas/Blob helpers
│       ├── queue.js            Batch engine: concurrency, retries, mode orchestration
│       ├── zipExport.js        ZIP + individual downloads (JSZip)
│       └── ui.js               All DOM rendering & event wiring
└── README.md
```

Every module has one job. `queue.js` is the only file that decides *when*
a call happens; `hfApi.js` is the only file that *makes* the call;
`ui.js` is the only file that touches the DOM. If something's broken,
that split tells you which file to open.

---

## 4. Getting your Hugging Face token(s)

1. Create a free account at [huggingface.co](https://huggingface.co/join).
2. Go to **Settings → Access Tokens** → **New token** → give it
   **Read** or **Write** scope (Read is enough for inference calls) →
   copy the value (starts with `hf_`).
3. In Platelight, go to **Settings → + Add Token**, paste it in, save.
4. Repeat with additional accounts if you want real rotation (see the
   quota caveat above) — up to 5 tokens total.

---

## 5. Deploying to GitHub Pages

1. Create a new GitHub repository and push this folder's contents to it
   (this folder itself, not a parent folder — `index.html` should sit at
   the repo root, or at the root of whichever branch/folder you point
   Pages at).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to `Deploy from a
   branch`, pick your branch (e.g. `main`) and folder (`/root`), save.
4. Wait a minute for the first build, then open the URL GitHub shows you.
5. Open it, add a token in Settings, and you're processing images.

To update after a change: bump `CACHE_VERSION` at the top of `sw.js`
first (e.g. `platelight-v2`) so returning visitors' browsers pick up the
new files instead of serving a stale cached copy, then push.

---

## 6. Using it day to day

1. **Workspace** tab → pick **Batch** (up to 10) or **Single**.
2. Pick **Fast Mode** or **Composite Mode** (see section 1 for the
   trade-off — Composite Mode is stricter about pixel-identical food).
3. Drag in your photos, or click the dropzone to browse.
4. Type (or pick an example chip for) a background description, e.g.
   *"Dark rustic wooden table with premium restaurant lighting, keeping
   the food exactly the same."*
5. **Start Processing**. Watch the contact sheet — each thumbnail gets a
   status ring; failed ones show why.
6. When it's done: **Download ZIP**, **Download All Individually**, or
   grab single images straight off their card. **Retry Failed** re-runs
   only the photos that didn't make it — nothing that already succeeded
   is re-sent.

---

## 7. Security notes

- Tokens never leave your browser — there is no backend to send them to.
- With a PIN set, tokens are encrypted at rest with AES-GCM (Web Crypto),
  keyed by PBKDF2 over your PIN with a random salt per token. The PIN
  itself is **never stored** — only kept in memory for the current
  browser tab session after you unlock, so you're not re-prompted before
  every single call in a 1000-image batch. Reload the tab and it's locked
  again.
- Without a PIN, tokens are stored with a light reversible obfuscation
  only (clearly labelled as such in Settings) — anyone with access to
  that browser profile's devtools could recover them. Set a PIN if that
  matters to you.
- This is a client-side app: anyone with physical/remote access to your
  unlocked browser profile can see whatever the page can see. Treat it
  like any other browser-stored credential.

---

## 8. Known limitations

- Very large batches (dozens of images at once) are capped at 10 per
  batch by design, matching the described workflow — run multiple
  batches back to back for larger volumes.
- Composite Mode's local segmentation model is general-purpose; unusual
  plating (glass, very thin utensils, translucent garnish) may need a
  manual touch-up afterward.
- The "approximate remaining calls" number on the token dashboard is a
  locally-tracked counter against an assumed monthly credit figure you
  can edit — it is **not** read from Hugging Face's account API (which
  doesn't expose it), so treat it as a rough guide, not a bill.
- All processing happens in the active browser tab; closing the tab
  mid-batch stops it (nothing runs server-side).
