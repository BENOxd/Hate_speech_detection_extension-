const SCAN_DEBOUNCE_MS = 400;
const BATCH_SIZE = 20;
const retryQueue = new Set();

let mutationObserver = null;
let debounceTimer = null;
let scanRunning = false;
let scanQueued = false;

// ===============================
// EXTENSION CONTEXT GUARD
// ===============================
function isExtensionValid() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function handleContextInvalidated() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
  console.warn("⚠️ Extension reloaded — refreshing page to reconnect...");
  window.location.reload();
}

// ===============================
// DOM SELECTION
// ===============================
function getTextElements() {
  return Array.from(document.querySelectorAll(
    "p, h1, h2, h3, li, blockquote, td, " +
    "[data-testid='tweetText'], " +
    "#content-text, #description, " +
    "[data-cy='comment-body'], " +
    ".comment-body, .usertext-body, " +
    "article, .article-body, " +
    "[role='article'], [role='comment'], " +
    "[contenteditable='true']"
  )).filter(el => {
    if (el.dataset.checked === "true") return false;
    const text = el.innerText?.trim();
    if (!text || text.length < 30) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (el.closest("nav, header, footer, aside, script, style, noscript")) return false;
    const hasBlockChildren = Array.from(el.children).some(child => {
      const display = window.getComputedStyle(child).display;
      return display === "block" || display === "flex" || display === "grid";
    });
    if (hasBlockChildren) return false;
    return true;
  });
}

// ===============================
// API CALLS
// ===============================
async function detectBatch(texts) {
  if (!isExtensionValid()) { handleContextInvalidated(); return null; }
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "PREDICT_BATCH", texts },
        (response) => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message;
            console.error("❌ Background error:", msg);
            if (msg.includes("Extension context invalidated")) handleContextInvalidated();
            resolve(null);
            return;
          }
          if (response?.success) resolve(response.results);
          else resolve(null);
        }
      );
    } catch (e) {
      handleContextInvalidated();
      resolve(null);
    }
  });
}

async function detect(text) {
  if (!isExtensionValid()) { handleContextInvalidated(); return null; }
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "PREDICT_SINGLE", text },
        (response) => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message;
            console.error("❌ Background error:", msg);
            if (msg.includes("Extension context invalidated")) handleContextInvalidated();
            resolve(null);
            return;
          }
          if (response?.success) resolve(response.result);
          else resolve(null);
        }
      );
    } catch (e) {
      handleContextInvalidated();
      resolve(null);
    }
  });
}

// ===============================
// BLUR SPECIFIC PHRASES
// ===============================
function buildNodeMap(el) {
  const textNodes = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement && node.parentElement.dataset.hsdBlurred === "true") continue;
    textNodes.push(node);
  }
  let offset = 0;
  return textNodes.map(node => {
    const start = offset;
    const end = offset + node.textContent.length;
    offset = end;
    return { node, start, end };
  });
}

function blurPhrasesInElement(el, spans) {
  if (!spans || spans.length === 0) return;

  const reversedSpans = [...spans].sort((a, b) => b.start - a.start);

  for (const span of reversedSpans) {
    const isHateSpeech = span.label === "Hate Speech";
    const blurLevel = isHateSpeech ? 7 : 4;
    const bgColor = isHateSpeech ? "rgba(255, 50, 50, 0.35)" : "rgba(255, 165, 0, 0.25)";
    const borderColor = isHateSpeech ? "rgba(255, 50, 50, 0.8)" : "rgba(255, 165, 0, 0.8)";
    const tooltipBg = isHateSpeech ? "rgba(180, 0, 0, 0.9)" : "rgba(180, 100, 0, 0.9)";
    const label = isHateSpeech ? "🔴 Hate Speech" : "🟠 Offensive";

    const nodeMap = buildNodeMap(el);

    for (const { node, start, end } of [...nodeMap].reverse()) {
      const overlapStart = Math.max(span.start, start);
      const overlapEnd = Math.min(span.end, end);
      if (overlapStart >= overlapEnd) continue;

      const localStart = overlapStart - start;
      const localEnd = overlapEnd - start;
      const text = node.textContent;
      const before = text.slice(0, localStart);
      const match = text.slice(localStart, localEnd);
      const after = text.slice(localEnd);

      const blurSpan = document.createElement("span");
      blurSpan.textContent = match;
      blurSpan.dataset.hsdBlurred = "true";
      blurSpan.style.cssText = `
        filter: blur(${blurLevel}px);
        transition: filter 0.2s ease, background 0.2s ease;
        cursor: pointer;
        position: relative;
        display: inline-block;
        background: ${bgColor};
        border-radius: 3px;
        border-bottom: 2px solid ${borderColor};
        padding: 0 1px;
      `;

      const tooltip = document.createElement("span");
      tooltip.textContent = `${label} (${Math.round(span.confidence * 100)}%). Hover to reveal.`;
      tooltip.style.cssText = `
        display: none;
        position: absolute;
        bottom: 125%;
        left: 50%;
        transform: translateX(-50%);
        background: ${tooltipBg};
        color: #fff;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 11px;
        white-space: nowrap;
        pointer-events: none;
        z-index: 999999;
        font-family: sans-serif;
      `;
      blurSpan.appendChild(tooltip);

      blurSpan.addEventListener("mouseenter", () => {
        blurSpan.style.filter = "blur(0px)";
        blurSpan.style.background = isHateSpeech ? "rgba(255, 50, 50, 0.15)" : "rgba(255, 165, 0, 0.15)";
        tooltip.style.display = "block";
      });
      blurSpan.addEventListener("mouseleave", () => {
        blurSpan.style.filter = `blur(${blurLevel}px)`;
        blurSpan.style.background = bgColor;
        tooltip.style.display = "none";
      });

      const parent = node.parentNode;
      if (!parent) continue;
      if (after) parent.insertBefore(document.createTextNode(after), node.nextSibling);
      parent.insertBefore(blurSpan, node.nextSibling);
      if (before) parent.insertBefore(document.createTextNode(before), blurSpan);
      node.remove();
      break;
    }
  }
}

// ===============================
// PROCESS BATCH
// ===============================
async function processBatch(elements) {
  const texts = elements.map(el => el.innerText.trim().slice(0, 300));
  console.group(`📦 Batch Request — ${texts.length} elements`);
  const results = await detectBatch(texts);

  if (!results) {
    console.warn("❌ Batch failed — added to retry queue");
    console.groupEnd();
    elements.forEach(el => retryQueue.add(el));
    return;
  }

  console.log(`✅ Batch succeeded — got ${results.length} results`);
  results.forEach((result, i) => {
    console.log(`  [${i}] "${texts[i].slice(0, 60)}..." → ${result.label} (${result.confidence})`);
  });
  console.groupEnd();

  results.forEach((result, i) => {
    const el = elements[i];
    el.dataset.checked = "true";
    if (result.spans && result.spans.length > 0) {
      blurPhrasesInElement(el, result.spans);
    }
  });
}

// ===============================
// RETRY FAILED ELEMENTS
// ===============================
async function retryFailed() {
  if (retryQueue.size === 0) return;
  const toRetry = Array.from(retryQueue);
  retryQueue.clear();

  for (const el of toRetry) {
    if (!document.contains(el)) continue;
    const text = el.innerText.trim();
    if (text.split(/\s+/).length < 4) { el.dataset.checked = "true"; continue; }
    const result = await detect(text.slice(0, 300));
    if (!result) { retryQueue.add(el); continue; }
    el.dataset.checked = "true";
    if (result.spans && result.spans.length > 0) blurPhrasesInElement(el, result.spans);
  }
}

// ===============================
// MAIN SCAN
// ===============================
async function scanPage() {
  await retryFailed();
  const elements = getTextElements().filter(el =>
    el.innerText.trim().split(/\s+/).length >= 4
  );
  if (elements.length === 0) return;
  const batches = [];
  for (let i = 0; i < elements.length; i += BATCH_SIZE) {
    batches.push(elements.slice(i, i + BATCH_SIZE));
  }
  await Promise.all(batches.map(batch => processBatch(batch)));
}

async function scanPageSafe() {
  if (scanRunning) {
    scanQueued = true;
    return;
  }
  scanRunning = true;
  try {
    await scanPage();
  } finally {
    scanRunning = false;
    if (scanQueued) {
      scanQueued = false;
      scheduleScan();
    }
  }
}

function scheduleScan() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    requestAnimationFrame(() => {
      void scanPageSafe();
    });
  }, SCAN_DEBOUNCE_MS);
}

function startMutationObserver(root) {
  if (mutationObserver) mutationObserver.disconnect();
  mutationObserver = new MutationObserver(() => {
    scheduleScan();
  });
  mutationObserver.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
  });
}

function initScanning() {
  void scanPageSafe();
  const root = document.body || document.documentElement;
  if (root) {
    startMutationObserver(root);
  } else {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        void scanPageSafe();
        if (document.body) startMutationObserver(document.body);
      },
      { once: true }
    );
  }
}

initScanning();
