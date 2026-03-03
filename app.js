(() => {
  "use strict";

  const JSON_URL = "data.json";
  const BIN_URL = "data.bin";
  const BIN_MAGIC = "WREELS";
  const BIN_VERSION = 1;
  const CINEMA_STORAGE_KEY = "weddingReels.cinema";
  const FAVORITES_STORAGE_KEY = "weddingReels.favorites";
  const PASSWORD_STORAGE_KEY = "weddingReels.password";
  const PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;
  const MUTED_STORAGE_KEY = "weddingReels.muted";

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const appEl = document.getElementById("app");
  const reelsEl = document.getElementById("reels");
  const reelTemplate = document.getElementById("reelTemplate");
  const loadingEl = document.getElementById("loading");
  const errorEl = document.getElementById("error");
  const unlockEl = document.getElementById("unlock");
  const unlockForm = document.getElementById("unlockForm");
  const passwordInput = document.getElementById("passwordInput");
  const unlockError = document.getElementById("unlockError");
  const retryBtn = document.getElementById("retryBtn");
  const cinemaBtn = document.getElementById("cinemaBtn");
  const shuffleBtn = document.getElementById("shuffleBtn");
  const updateBtn = document.getElementById("updateBtn");
  const sideprogEl = document.getElementById("sideprog");
  const hintEl = document.getElementById("hint");
  const navfadeEl = document.getElementById("navfade");
  const toastEl = document.getElementById("toast");

  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

  /** @type {{id: string, title: string, description: string}[]} */
  let library = [];
  /** @type {Uint8Array | null} */
  let binCache = null;
  /** @type {string | null} */
  let driveApiKey = null;
  /** @type {Set<string>} */
  let favorites = new Set();
  let muted = true;

  /** @type {{id: string, title: string, description: string}[]} */
  let playlist = [];
  let activeIndex = -1;
  /** @type {IntersectionObserver | null} */
  let reelObserver = null;
  /** @type {Map<Element, number>} */
  let reelVisibility = new Map();
  let wheelLocked = false;
  /** @type {number | null} */
  let wheelUnlockTimer = null;
  /** @type {number | null} */
  let toastTimer = null;
  let loadHelpToastShown = false;
  let hintHidden = false;
  /** @type {number | null} */
  let hintTimer = null;
  /** @type {ServiceWorkerRegistration | null} */
  let swReg = null;
  let swUpdateAvailable = false;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add("toast--visible");
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove("toast--visible"), 1400);
  }

  function readFavorites() {
    try {
      const raw = window.localStorage?.getItem(FAVORITES_STORAGE_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      const ids = parsed
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean);
      return new Set(ids);
    } catch {
      return new Set();
    }
  }

  function writeFavorites() {
    try {
      window.localStorage?.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(Array.from(favorites)));
    } catch {
      // ignore
    }
  }

  favorites = readFavorites();

  function readMutedPreference() {
    try {
      const raw = window.localStorage?.getItem(MUTED_STORAGE_KEY);
      if (raw === "0") return false;
      if (raw === "1") return true;
    } catch {
      // ignore
    }
    return true;
  }

  function writeMutedPreference(value) {
    try {
      window.localStorage?.setItem(MUTED_STORAGE_KEY, value ? "1" : "0");
    } catch {
      // ignore
    }
  }

  function applyMutedPreference(videoEl) {
    if (!videoEl) return;
    videoEl.muted = muted;
    if (muted) videoEl.setAttribute("muted", "");
    else videoEl.removeAttribute("muted");
  }

  muted = readMutedPreference();

  function clearStoredPassword() {
    try {
      window.localStorage?.removeItem(PASSWORD_STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  function readStoredPassword() {
    try {
      const raw = window.localStorage?.getItem(PASSWORD_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;

      const password = typeof parsed.password === "string" ? parsed.password : "";
      const expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0;
      if (!password || !Number.isFinite(expiresAt)) return null;

      if (Date.now() > expiresAt) {
        clearStoredPassword();
        return null;
      }

      return password;
    } catch {
      return null;
    }
  }

  function writeStoredPassword(password) {
    if (!password) return;
    try {
      window.localStorage?.setItem(
        PASSWORD_STORAGE_KEY,
        JSON.stringify({ password, expiresAt: Date.now() + PASSWORD_TTL_MS }),
      );
    } catch {
      // ignore
    }
  }

  function setUpdateAvailable(available) {
    swUpdateAvailable = available;
    if (!updateBtn) return;
    updateBtn.hidden = !available;
  }

  function applyServiceWorkerUpdate() {
    if (!swReg?.waiting) return;
    setUpdateAvailable(false);
    toast("Updating…");
    try {
      swReg.waiting.postMessage({ type: "SKIP_WAITING" });
    } catch {
      // ignore
    }
  }

  function setupServiceWorkerUpdates() {
    if (!("serviceWorker" in navigator)) return;

    let wasControlled = Boolean(navigator.serviceWorker.controller);
    let refreshing = false;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!wasControlled) {
        wasControlled = true;
        return;
      }
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker
      .register("./sw.js")
      .then((reg) => {
        swReg = reg;

        const offerUpdate = () => {
          if (!navigator.serviceWorker.controller) return;
          if (!reg.waiting) return;
          if (swUpdateAvailable) return;
          setUpdateAvailable(true);
          toast("Update ready");
        };

        offerUpdate();

        reg.addEventListener("updatefound", () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener("statechange", () => {
            if (worker.state !== "installed") return;
            offerUpdate();
          });
        });

        const check = () => reg.update().catch(() => {});
        check();
        window.setInterval(check, 60 * 60 * 1000);

        document.addEventListener(
          "visibilitychange",
          () => {
            if (!document.hidden) check();
            if (document.hidden && reg.waiting) applyServiceWorkerUpdate();
          },
          { passive: true },
        );
      })
      .catch(() => {
        // ignore
      });
  }

  function pulseNavFade() {
    if (!navfadeEl) return;
    if (prefersReducedMotion) return;
    navfadeEl.classList.remove("navfade--pulse");
    void navfadeEl.offsetWidth;
    navfadeEl.classList.add("navfade--pulse");
    window.setTimeout(() => navfadeEl.classList.remove("navfade--pulse"), 420);
  }

  function hideHint() {
    if (hintHidden || !hintEl) return;
    hintHidden = true;
    hintEl.classList.add("hint--hidden");
    if (hintTimer) window.clearTimeout(hintTimer);
  }

  function isEditableTarget(target) {
    const el = target instanceof Element ? target : null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
  }

  function isInteractiveTarget(target) {
    const el = target instanceof Element ? target : null;
    if (!el) return false;
    return Boolean(
      el.closest(
        "button, a, input, textarea, select, summary, details, [role='button'], [role='link'], [role='textbox']",
      ),
    );
  }

  function randomInt(maxExclusive) {
    if (maxExclusive <= 0) return 0;
    const cryptoObj = globalThis.crypto;
    if (!cryptoObj?.getRandomValues) return Math.floor(Math.random() * maxExclusive);

    const range = 0x100000000; // 2^32
    const limit = range - (range % maxExclusive);
    const buf = new Uint32Array(1);
    let value = 0;
    do {
      cryptoObj.getRandomValues(buf);
      value = buf[0];
    } while (value >= limit);
    return value % maxExclusive;
  }

  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function buildDriveOpenUrl(id) {
    const safeId = encodeURIComponent(id);
    return `https://drive.google.com/file/d/${safeId}/view`;
  }

  function buildDriveDownloadUrl(id) {
    const safeId = encodeURIComponent(id);
    return `https://drive.google.com/uc?export=download&id=${safeId}`;
  }

  function buildDriveApiMediaUrl(id) {
    if (!driveApiKey) return "";
    const safeId = encodeURIComponent(id);
    const safeKey = encodeURIComponent(driveApiKey);
    return `https://www.googleapis.com/drive/v3/files/${safeId}?alt=media&supportsAllDrives=true&key=${safeKey}`;
  }

  function parseInitialTarget(videos) {
    const raw = (window.location.hash || "").replace(/^#/, "").trim();
    if (!raw) return 0;

    const params = new URLSearchParams(raw.startsWith("v=") || raw.startsWith("i=") ? raw : `v=${raw}`);
    const byId = params.get("v");
    if (byId) {
      const idx = videos.findIndex((v) => v.id === byId);
      if (idx >= 0) return idx;
    }

    const byIndex = params.get("i");
    if (byIndex) {
      const idx = Number.parseInt(byIndex, 10);
      if (Number.isFinite(idx)) return clamp(idx, 0, Math.max(0, videos.length - 1));
    }

    return 0;
  }

  function updateHashForActive() {
    const video = playlist[activeIndex];
    if (!video) return;
    const hash = `#v=${encodeURIComponent(video.id)}`;
    if (window.location.hash === hash) return;
    window.history.replaceState(null, "", hash);
  }

  function updateTitleForActive() {
    const video = playlist[activeIndex];
    document.title = video?.title ? `Wedding Reels — ${video.title}` : "Wedding Reels";
  }

  function updateSideProgress() {
    if (!appEl) return;
    const total = playlist.length;
    if (sideprogEl) sideprogEl.hidden = total <= 1;
    if (total <= 1) hideHint();

    const denom = Math.max(1, total - 1);
    const ratio = clamp(activeIndex, 0, denom) / denom;
    appEl.style.setProperty("--progress", String(ratio));
  }

  function setCinemaMode(enabled, { silent } = { silent: false }) {
    if (!appEl) return;
    appEl.classList.toggle("app--cinema", enabled);
    if (cinemaBtn) {
      cinemaBtn.setAttribute("aria-pressed", String(enabled));
      cinemaBtn.setAttribute("aria-label", enabled ? "Show captions" : "Hide captions");
    }
    try {
      window.localStorage?.setItem(CINEMA_STORAGE_KEY, enabled ? "1" : "0");
    } catch {
      // ignore
    }
    if (!silent) toast(enabled ? "Captions hidden" : "Captions shown");
  }

  function setScrimState({ loading = false, error = false, unlock = false } = {}) {
    if (loadingEl) loadingEl.hidden = !loading;
    if (errorEl) errorEl.hidden = !error;
    if (unlockEl) unlockEl.hidden = !unlock;
  }

  function scrimVisible() {
    return (
      (loadingEl && !loadingEl.hidden) || (errorEl && !errorEl.hidden) || (unlockEl && !unlockEl.hidden)
    );
  }

  function normalizeVideo(input, index) {
    if (!input || typeof input !== "object") return null;
    const id = typeof input.id === "string" ? input.id.trim() : "";
    if (!id) return null;

    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : `Video ${index + 1}`;
    const description = typeof input.description === "string" ? input.description.trim() : "";
    return { id, title, description };
  }

  function applyLibraryConfig(payload) {
    const key = typeof payload?.driveApiKey === "string" ? payload.driveApiKey.trim() : "";
    driveApiKey = key || null;
  }

  function getSourcePreference() {
    const value = new URLSearchParams(window.location.search).get("source");
    if (value === "json" || value === "bin") return value;
    return null;
  }

  function isLikelyDevHost() {
    const host = (window.location.hostname || "").trim();
    if (!host) return true;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;
    if (host.endsWith(".local")) return true;

    const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return false;

    const a = Number.parseInt(match[1], 10);
    const b = Number.parseInt(match[2], 10);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;

    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  function resetLibrary() {
    library = [];
    binCache = null;
    driveApiKey = null;
  }

  async function loadVideosFromJson() {
    const res = await fetch(JSON_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch ${JSON_URL} (${res.status})`);
    const json = await res.json();
    applyLibraryConfig(json);
    const rawVideos = Array.isArray(json?.videos) ? json.videos : null;
    if (!rawVideos?.length) throw new Error(`No videos found in ${JSON_URL}`);

    const normalized = rawVideos.map(normalizeVideo).filter(Boolean);
    if (!normalized.length) throw new Error(`No valid video entries found in ${JSON_URL}`);
    return /** @type {{id: string, title: string, description: string}[]} */ (normalized);
  }

  function parseBinPayload(bytes) {
    const headerLen = 6 + 1 + 4 + 1 + 1;
    if (bytes.length < headerLen + 16 + 12 + 16) throw new Error("Invalid data.bin");

    const magic = decoder.decode(bytes.subarray(0, 6));
    if (magic !== BIN_MAGIC) throw new Error("Invalid data.bin (bad magic)");

    const version = bytes[6];
    if (version !== BIN_VERSION) throw new Error(`Unsupported data.bin version (${version})`);

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const iterations = view.getUint32(7, false);
    const saltLen = bytes[11];
    const ivLen = bytes[12];
    if (saltLen < 8 || saltLen > 64) throw new Error("Invalid data.bin (salt)");
    if (ivLen < 8 || ivLen > 32) throw new Error("Invalid data.bin (iv)");

    let offset = headerLen;
    const salt = bytes.subarray(offset, offset + saltLen);
    offset += saltLen;
    const iv = bytes.subarray(offset, offset + ivLen);
    offset += ivLen;
    const ciphertext = bytes.subarray(offset);
    if (ciphertext.length < 16) throw new Error("Invalid data.bin (ciphertext)");

    return { iterations, salt, iv, ciphertext };
  }

  async function deriveKeyFromPassword({ password, salt, iterations }) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error("WebCrypto is not available in this browser.");

    const keyMaterial = await subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
    return subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
  }

  async function promptForPassword({ errorMessage } = {}) {
    if (!unlockEl || !unlockForm || !passwordInput) throw new Error("Unlock UI not found.");

    setScrimState({ loading: false, error: false, unlock: true });
    if (unlockError) {
      unlockError.hidden = !errorMessage;
      unlockError.textContent = errorMessage || "";
    }

    passwordInput.focus();
    passwordInput.select();

    return await new Promise((resolve) => {
      /** @param {SubmitEvent} event */
      function onSubmit(event) {
        event.preventDefault();
        unlockForm.removeEventListener("submit", onSubmit);
        resolve(String(passwordInput.value || ""));
      }
      unlockForm.addEventListener("submit", onSubmit);
    });
  }

  async function decryptBinToJson(binBytes) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error("WebCrypto is not available in this browser.");

    const payload = parseBinPayload(binBytes);
    let errorMessage = "";

    async function tryDecrypt(password) {
      const key = await deriveKeyFromPassword({
        password,
        salt: payload.salt,
        iterations: payload.iterations,
      });
      const plainBuf = await subtle.decrypt({ name: "AES-GCM", iv: payload.iv }, key, payload.ciphertext);
      const text = decoder.decode(new Uint8Array(plainBuf));
      return JSON.parse(text);
    }

    const storedPassword = readStoredPassword();
    if (storedPassword) {
      try {
        const json = await tryDecrypt(storedPassword);
        writeStoredPassword(storedPassword);
        if (unlockError) unlockError.hidden = true;
        setScrimState({ loading: true, error: false, unlock: false });
        return json;
      } catch {
        clearStoredPassword();
      }
    }

    while (true) {
      const password = await promptForPassword({ errorMessage });
      if (!password) {
        errorMessage = "Password required.";
        continue;
      }

      try {
        const json = await tryDecrypt(password);
        writeStoredPassword(password);

        passwordInput.value = "";
        if (unlockError) unlockError.hidden = true;
        setScrimState({ loading: true, error: false, unlock: false });
        return json;
      } catch {
        errorMessage = "Wrong password. Try again.";
      }
    }
  }

  async function loadVideosFromBin() {
    if (!binCache) {
      const res = await fetch(BIN_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to fetch ${BIN_URL} (${res.status})`);
      binCache = new Uint8Array(await res.arrayBuffer());
    }

    const json = await decryptBinToJson(binCache);
    applyLibraryConfig(json);
    const rawVideos = Array.isArray(json?.videos) ? json.videos : null;
    if (!rawVideos?.length) throw new Error(`No videos found in ${BIN_URL}`);

    const normalized = rawVideos.map(normalizeVideo).filter(Boolean);
    if (!normalized.length) throw new Error(`No valid video entries found in ${BIN_URL}`);
    return /** @type {{id: string, title: string, description: string}[]} */ (normalized);
  }

  async function ensureLibraryLoaded() {
    if (library.length) return library;

    const pref = getSourcePreference();
    if (pref === "json") {
      library = await loadVideosFromJson();
      return library;
    }
    if (pref === "bin") {
      library = await loadVideosFromBin();
      return library;
    }

    if (isLikelyDevHost()) {
      try {
        library = await loadVideosFromJson();
        return library;
      } catch {
        library = await loadVideosFromBin();
        return library;
      }
    }

    try {
      library = await loadVideosFromBin();
      return library;
    } catch {
      library = await loadVideosFromJson();
      return library;
    }
  }

  function clearReels() {
    reelsEl.innerHTML = "";
    if (reelObserver) {
      reelObserver.disconnect();
      reelObserver = null;
    }
    reelVisibility = new Map();
    activeIndex = -1;
    updateSideProgress();
    updateTitleForActive();
  }

  function goToIndex(index) {
    const next = clamp(index, 0, Math.max(0, playlist.length - 1));
    if (next === activeIndex) return;
    pulseNavFade();
    scrollToIndex(next, "auto");
    setVisForIndex(next, 1);
    setActiveIndex(next, { scroll: false });
  }

  function createReel(video, index, total) {
    const node = reelTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.index = String(index);

    const videoEl = node.querySelector(".reel__video");
    if (videoEl) {
      const SCRUB_THRESHOLD_PX = 12;
      const SCRUB_SECONDS_PER_SCREEN = 30;

      let lastScrubEndAt = 0;
      /** @type {{pointerId: number, startX: number, startY: number, startTime: number, active: boolean} | null} */
      let scrub = null;

      const apiSrc = buildDriveApiMediaUrl(video.id);
      const fallbackSrc = buildDriveDownloadUrl(video.id);
      videoEl.dataset.apiSrc = apiSrc;
      videoEl.dataset.fallbackSrc = fallbackSrc;
      videoEl.dataset.fallbackTried = "0";
      videoEl.dataset.src = apiSrc || fallbackSrc;
      videoEl.setAttribute("aria-label", `Wedding video: ${video.title}`);
      videoEl.addEventListener("loadeddata", () => {
        const src = videoEl.getAttribute("src");
        if (!src) return;
        if (src !== videoEl.dataset.src) return;
        node.classList.remove("reel--loading");
      });
      videoEl.addEventListener("error", () => {
        const src = videoEl.getAttribute("src") || "";
        if (!src) return;
        if (videoEl.dataset.fallbackTried === "1") return;

        const api = videoEl.dataset.apiSrc || "";
        const fallback = videoEl.dataset.fallbackSrc || "";
        if (api && fallback && src === api) {
          videoEl.dataset.fallbackTried = "1";
          videoEl.dataset.src = fallback;
          videoEl.setAttribute("src", fallback);
          videoEl.load?.();
          void videoEl.play?.().catch(() => {
            // ignore
          });
          toast("Trying fallback…");
          return;
        }
        toast("Couldn't play — tap Open");
      });
      videoEl.addEventListener("click", () => {
        if (Date.now() - lastScrubEndAt < 450) return;
        if (videoEl.paused) {
          void videoEl.play()
            .then(() => node.classList.remove("reel--needsTap"))
            .catch(() => {
              node.classList.add("reel--needsTap");
              toast("Tap to play");
            });
          return;
        }
        muted = !muted;
        writeMutedPreference(muted);
        applyMutedPreference(videoEl);
        toast(muted ? "Muted" : "Sound on");
      });
      videoEl.addEventListener("playing", () => node.classList.remove("reel--needsTap"));
      videoEl.addEventListener("pause", () => {
        if (!node.classList.contains("reel--active")) return;
        node.classList.add("reel--needsTap");
      });
      videoEl.addEventListener("pointerdown", (event) => {
        if (!node.classList.contains("reel--active")) return;
        if (event.pointerType === "mouse" && event.button !== 0) return;
        scrub = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startTime: Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : 0,
          active: false,
        };
      });
      videoEl.addEventListener(
        "pointermove",
        (event) => {
          if (!scrub) return;
          if (event.pointerId !== scrub.pointerId) return;

          const dx = event.clientX - scrub.startX;
          const dy = event.clientY - scrub.startY;

          if (!scrub.active) {
            if (Math.abs(dx) < SCRUB_THRESHOLD_PX && Math.abs(dy) < SCRUB_THRESHOLD_PX) return;
            if (Math.abs(dx) < Math.abs(dy)) {
              scrub = null;
              return;
            }
            scrub.active = true;
            scrub.startTime = Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
            node.classList.add("reel--scrubbing");
            videoEl.pause?.();
            try {
              videoEl.setPointerCapture?.(event.pointerId);
            } catch {
              // ignore
            }
          }

          if (!scrub.active) return;

          event.preventDefault();

          const duration = videoEl.duration;
          if (!Number.isFinite(duration) || duration <= 0) return;

          const width = Math.max(320, window.innerWidth || 0, videoEl.clientWidth || 0, 1);
          const deltaSeconds = (dx / width) * SCRUB_SECONDS_PER_SCREEN;
          const target = clamp(scrub.startTime + deltaSeconds, 0, Math.max(0, duration - 0.01));
          if (!Number.isFinite(target)) return;

          try {
            videoEl.currentTime = target;
          } catch {
            // ignore
          }
        },
        { passive: false },
      );
      videoEl.addEventListener("pointerup", (event) => {
        if (!scrub) return;
        if (event.pointerId !== scrub.pointerId) return;

        const shouldResume = scrub.active;
        scrub = null;
        node.classList.remove("reel--scrubbing");

        if (!shouldResume) return;
        lastScrubEndAt = Date.now();
        void videoEl.play()
          .then(() => node.classList.remove("reel--needsTap"))
          .catch(() => node.classList.add("reel--needsTap"));
      });
      videoEl.addEventListener("pointercancel", (event) => {
        if (!scrub) return;
        if (event.pointerId !== scrub.pointerId) return;
        scrub = null;
        node.classList.remove("reel--scrubbing");
      });
    }

    const titleEl = node.querySelector(".reel__title");
    titleEl.textContent = video.title;

    const descEl = node.querySelector(".reel__desc");
    descEl.textContent = video.description || "";

    const upNextBtn = node.querySelector(".upnext");
    if (upNextBtn) {
      if (index >= total - 1) {
        upNextBtn.hidden = true;
      } else {
        const nextVideo = playlist[index + 1];
        const upNextTitleEl = upNextBtn.querySelector(".upnext__title");
        if (upNextTitleEl) upNextTitleEl.textContent = nextVideo?.title ?? "";
        upNextBtn.addEventListener("click", () => goToIndex(index + 1));
      }
    }

    const countEl = node.querySelector(".reel__count");
    countEl.textContent = `${index + 1} / ${total}`;

    const heartBtn = node.querySelector('[data-action="heart"]');
    function updateHeartUi() {
      if (!heartBtn) return;
      const isOn = favorites.has(video.id);
      heartBtn.setAttribute("aria-pressed", String(isOn));
      heartBtn.setAttribute("aria-label", isOn ? "Remove from favorites" : "Add to favorites");
    }
    updateHeartUi();
    heartBtn?.addEventListener("click", () => {
      const isOn = favorites.has(video.id);
      if (isOn) favorites.delete(video.id);
      else favorites.add(video.id);
      writeFavorites();
      updateHeartUi();
      toast(isOn ? "Removed" : "Saved");
    });

    const openBtn = node.querySelector('[data-action="open"]');
    openBtn?.addEventListener("click", () => {
      window.open(buildDriveOpenUrl(video.id), "_blank", "noopener,noreferrer");
    });

    const shareBtn = node.querySelector('[data-action="share"]');
    shareBtn?.addEventListener("click", async () => {
      const url = new URL(window.location.href);
      url.hash = `v=${encodeURIComponent(video.id)}`;
      const shareUrl = url.toString();
      const shareData = { title: video.title, text: video.description || "", url: shareUrl };

      if (navigator.share) {
        try {
          await navigator.share(shareData);
          return;
        } catch (err) {
          const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
          if (name === "AbortError") return;
          // Fall back to copy link.
        }
      }

      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(shareUrl);
          toast("Link copied");
          return;
        }
      } catch {
        // ignore
      }

      try {
        window.prompt("Copy this link:", shareUrl);
      } catch {
        toast("Couldn’t share link");
      }
    });

    return node;
  }

  function renderPlaylist() {
    clearReels();

    const frag = document.createDocumentFragment();
    playlist.forEach((video, i) => frag.appendChild(createReel(video, i, playlist.length)));
    reelsEl.appendChild(frag);

    setupObservers();
    updateSideProgress();
  }

  function setupObservers() {
    if (reelObserver) reelObserver.disconnect();

    const thresholds = [];
    for (let i = 0; i <= 20; i += 1) thresholds.push(i / 20);

    reelObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          reelVisibility.set(entry.target, entry.intersectionRatio);
          entry.target?.style?.setProperty("--vis", entry.intersectionRatio.toFixed(4));
        }

        let bestEl = null;
        let bestRatio = 0;
        for (const [el, ratio] of reelVisibility.entries()) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestEl = el;
          }
        }
        if (!bestEl) return;
        if (bestRatio < 0.6) return;

        const idx = Number.parseInt(bestEl?.dataset?.index ?? "", 10);
        if (!Number.isFinite(idx)) return;
        if (idx === activeIndex) return;

        setActiveIndex(idx, { scroll: false });
      },
      { root: reelsEl, threshold: thresholds },
    );

    Array.from(reelsEl.children).forEach((child) => {
      child.style?.setProperty("--vis", "0");
      reelVisibility.set(child, 0);
      reelObserver.observe(child);
    });
  }

  function unloadReel(index) {
    const reel = reelsEl.children[index];
    if (!reel) return;
    reel.classList.remove("reel--active");
    reel.classList.remove("reel--loading");
    reel.classList.remove("reel--needsTap");
    reel.classList.remove("reel--scrubbing");
    const videoEl = reel.querySelector?.(".reel__video");

    if (videoEl) {
      videoEl.pause?.();
      if (videoEl.getAttribute?.("src")) videoEl.removeAttribute("src");
      videoEl.load?.();
      applyMutedPreference(videoEl);
    }
  }

  function loadReel(index) {
    const reel = reelsEl.children[index];
    if (!reel) return;
    reel.classList.add("reel--active");
    reel.classList.add("reel--loading");
    reel.classList.remove("reel--needsTap");
    reel.classList.remove("reel--scrubbing");

    const videoEl = reel.querySelector?.(".reel__video");

    const loadToken = String(Date.now());
    reel.dataset.loadToken = loadToken;
    window.setTimeout(() => {
      if (!reel.isConnected) return;
      if (reel.dataset.loadToken !== loadToken) return;
      if (!reel.classList.contains("reel--loading")) return;
      reel.classList.remove("reel--loading");
      if (!loadHelpToastShown) {
        toast("If it won't play, tap Open");
        loadHelpToastShown = true;
      }
    }, 12000);

    if (!videoEl) {
      reel.classList.remove("reel--loading");
      return;
    }
    const src = videoEl.dataset.src;
    if (!src) {
      reel.classList.remove("reel--loading");
      return;
    }
    applyMutedPreference(videoEl);
    if (videoEl.getAttribute("src") !== src) videoEl.setAttribute("src", src);
    videoEl.load?.();
    void videoEl.play?.().catch(() => {
      // iOS may require a gesture; keep the reel visible and let the user tap.
      reel.classList.add("reel--needsTap");
    });
  }

  function scrollToIndex(index, behavior = prefersReducedMotion ? "auto" : "smooth") {
    const reel = reelsEl.children[index];
    if (!reel) return;
    reel.scrollIntoView({ behavior, block: "start" });
  }

  function setVisForIndex(index, ratio) {
    const reel = reelsEl.children[index];
    if (!reel) return;
    const safeRatio = clamp(ratio, 0, 1);
    reel.style?.setProperty("--vis", safeRatio.toFixed(4));
    reelVisibility.set(reel, safeRatio);
  }

  function setActiveIndex(index, { scroll, hideHint: shouldHideHint } = { scroll: false, hideHint: true }) {
    const next = clamp(index, 0, Math.max(0, playlist.length - 1));
    if (next === activeIndex) return;

    const prev = activeIndex;
    activeIndex = next;

    if (prev >= 0) unloadReel(prev);
    loadReel(activeIndex);
    updateHashForActive();
    updateTitleForActive();
    updateSideProgress();
    if (shouldHideHint) hideHint();

    if (scroll) scrollToIndex(activeIndex, "auto");
  }

  function goRelative(delta) {
    hideHint();
    const next = clamp(activeIndex + delta, 0, Math.max(0, playlist.length - 1));
    if (next === activeIndex) {
      toast(delta > 0 ? "End of playlist" : "Start of playlist");
      return;
    }
    pulseNavFade();
    scrollToIndex(next, "auto");
    setVisForIndex(next, 1);
    setActiveIndex(next, { scroll: false });
  }

  function onWheel(event) {
    if (!playlist.length) return;
    if (scrimVisible()) return;
    if (event.ctrlKey) return;
    if (isEditableTarget(event.target)) return;
    if (Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;

    event.preventDefault();

    if (wheelLocked) return;
    wheelLocked = true;

    const delta = event.deltaY > 0 ? 1 : -1;
    goRelative(delta);

    if (wheelUnlockTimer) window.clearTimeout(wheelUnlockTimer);
    wheelUnlockTimer = window.setTimeout(() => {
      wheelLocked = false;
    }, 650);
  }

  function onKeyDown(event) {
    if (!playlist.length) return;
    if (scrimVisible()) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isEditableTarget(event.target)) return;
    if (isInteractiveTarget(event.target)) return;

    const key = event.key;
    if (key === "ArrowDown" || key === "PageDown" || key === " " || key === "j") {
      event.preventDefault();
      goRelative(1);
      return;
    }
    if (key === "ArrowUp" || key === "PageUp" || key === "k") {
      event.preventDefault();
      goRelative(-1);
      return;
    }
    if (key === "Home") {
      event.preventDefault();
      setActiveIndex(0, { scroll: false });
      scrollToIndex(0);
      return;
    }
    if (key === "End") {
      event.preventDefault();
      const last = Math.max(0, playlist.length - 1);
      setActiveIndex(last, { scroll: false });
      scrollToIndex(last);
    }
  }

  function navigateToHash({ behavior } = { behavior: "auto" }) {
    if (!playlist.length) return;
    const idx = parseInitialTarget(playlist);
    if (idx === activeIndex) return;
    setActiveIndex(idx, { scroll: false });
    scrollToIndex(idx, behavior);
  }

  async function init({ reshuffle } = { reshuffle: false }) {
    try {
      setScrimState({ loading: true, error: false, unlock: false });
      const videos = await ensureLibraryLoaded();

      const currentId = reshuffle ? playlist?.[activeIndex]?.id ?? null : null;
      playlist = shuffleInPlace([...videos]);
      renderPlaylist();

      setScrimState({ loading: false, error: false, unlock: false });

      const initial = currentId ? Math.max(0, playlist.findIndex((v) => v.id === currentId)) : parseInitialTarget(playlist);
      setActiveIndex(initial, { scroll: false, hideHint: false });
      scrollToIndex(initial, "auto");
      setVisForIndex(initial, 1);

      toast(reshuffle ? "Shuffled" : "Scroll or swipe");
    } catch (err) {
      console.error(err);
      setScrimState({ loading: false, error: true, unlock: false });
    }
  }

  window.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("hashchange", () => navigateToHash({ behavior: prefersReducedMotion ? "auto" : "smooth" }));

  retryBtn?.addEventListener("click", () => {
    resetLibrary();
    init();
  });
  shuffleBtn?.addEventListener("click", () => {
    if (shuffleBtn) {
      shuffleBtn.classList.remove("iconbtn--spin");
      void shuffleBtn.offsetWidth;
      shuffleBtn.classList.add("iconbtn--spin");
      window.setTimeout(() => shuffleBtn.classList.remove("iconbtn--spin"), 700);
    }
    init({ reshuffle: true });
  });
  updateBtn?.addEventListener("click", () => applyServiceWorkerUpdate());
  cinemaBtn?.addEventListener("click", () => {
    const enabled = appEl?.classList?.contains("app--cinema") ?? false;
    setCinemaMode(!enabled);
  });

  try {
    const stored = window.localStorage?.getItem(CINEMA_STORAGE_KEY);
    if (stored === "1") setCinemaMode(true, { silent: true });
  } catch {
    // ignore
  }

  if (hintEl) {
    hintTimer = window.setTimeout(() => hideHint(), 4200);
    reelsEl.addEventListener(
      "scroll",
      () => {
        hideHint();
      },
      { passive: true },
    );
  }

  setupServiceWorkerUpdates();

  init();
})();
