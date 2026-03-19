const CHECK_INTERVAL = 4000;
const BATCH_SIZE = 20;
const retryQueue = new Set();

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
// API CALLS — via background service worker
// ===============================
async function detectBatch(texts) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "PREDICT_BATCH", texts },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error("❌ Background error:", chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        if (response?.success) resolve(response.results);
        else resolve(null);
      }
    );
  });
}

async function detect(text) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "PREDICT_SINGLE", text },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error("❌ Background error:", chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        if (response?.success) resolve(response.result);
        else resolve(null);
      }
    );
  });
}

// ===============================
// BLUR SPECIFIC PHRASES
// ===============================
function blurPhrasesInElement(el, spans) {
  if (!spans || spans.length === 0) return;

  const textNodes = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  let offset = 0;
  const nodeMap = textNodes.map(node => {
    const start = offset;
    const end = offset + node.textContent.length;
    offset = end;
    return { node, start, end };
  });

  const reversedSpans = [...spans].reverse();

  for (const span of reversedSpans) {
    const blurLevel = span.label === "Hate Speech" ? 6 : 3;

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
      blurSpan.style.filter = `blur(${blurLevel}px)`;
      blurSpan.style.transition = "filter 0.2s ease";
      blurSpan.style.cursor = "pointer";
      blurSpan.style.position = "relative";
      blurSpan.style.display = "inline-block";

      // Custom tooltip — no native title attribute
      const tooltip = document.createElement("span");
      tooltip.textContent = `⚠ ${span.label} (${Math.round(span.confidence * 100)}%). Hover to reveal.`;
      tooltip.style.cssText = `
        display: none;
        position: absolute;
        bottom: 125%;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0,0,0,0.8);
        color: #fff;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 11px;
        white-space: nowrap;
        pointer-events: none;
        z-index: 999999;
      `;
      blurSpan.appendChild(tooltip);

      blurSpan.addEventListener("mouseenter", () => {
        blurSpan.style.filter = "blur(0px)";
        tooltip.style.display = "block";
      });
      blurSpan.addEventListener("mouseleave", () => {
        blurSpan.style.filter = `blur(${blurLevel}px)`;
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
    if (text.split(/\s+/).length < 4) {
      el.dataset.checked = "true";
      continue;
    }
    const result = await detect(text.slice(0, 300));
    if (!result) {
      retryQueue.add(el);
      continue;
    }
    el.dataset.checked = "true";
    if (result.spans && result.spans.length > 0) {
      blurPhrasesInElement(el, result.spans);
    }
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

// ===============================
// REAL-TIME LOOP
// ===============================
setInterval(scanPage, CHECK_INTERVAL);
scanPage();