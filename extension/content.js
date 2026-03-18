const API_URL = "http://127.0.0.1:5000/predict";
const CHECK_INTERVAL = 4000;
const retryQueue = new Set();

// ===============================
// DOM SELECTION
// ===============================
function getTextElements() {
  return Array.from(document.querySelectorAll("[data-testid='tweetText']")).filter(el => {
    if (el.dataset.checked === "true") return false;
    const text = el.innerText?.trim();
    if (!text || text.length < 30) return false;
    return true;
  });
}

// ===============================
// API CALL
// ===============================
async function detect(text) {
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    return await res.json();
  } catch {
    return null;
  }
}

// ===============================
// CORE FIX — walk text nodes and wrap only bad words
// Never touches the element's structure or innerHTML
// ===============================
function blurPhrasesInElement(el, spans) {
  if (!spans || spans.length === 0) return;

  // Collect all text nodes inside this element (deep)
  const textNodes = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  // Rebuild full text with offsets mapped to each text node
  // so we know which text node a span.start/end falls in
  let offset = 0;
  const nodeMap = textNodes.map(node => {
    const start = offset;
    const end = offset + node.textContent.length;
    offset = end;
    return { node, start, end };
  });

  // Process spans in reverse so DOM mutations don't shift offsets
  const reversedSpans = [...spans].reverse();

  for (const span of reversedSpans) {
    const blurLevel = span.label === "Hate Speech" ? 6 : 3;

    // Find which text node(s) this span falls in
    for (const { node, start, end } of [...nodeMap].reverse()) {
      // Check if this span overlaps with this text node
      const overlapStart = Math.max(span.start, start);
      const overlapEnd = Math.min(span.end, end);
      if (overlapStart >= overlapEnd) continue;

      // Local offsets within this text node
      const localStart = overlapStart - start;
      const localEnd = overlapEnd - start;

      const text = node.textContent;
      const before = text.slice(0, localStart);
      const match = text.slice(localStart, localEnd);
      const after = text.slice(localEnd);

      // Create the blurred span for just the bad word/phrase
      const blurSpan = document.createElement("span");
      blurSpan.textContent = match;
      blurSpan.style.filter = `blur(${blurLevel}px)`;
      blurSpan.style.transition = "filter 0.2s ease";
      blurSpan.style.cursor = "pointer";
      blurSpan.title = `⚠ ${span.label} (${Math.round(span.confidence * 100)}% confidence). Hover to reveal.`;

      blurSpan.addEventListener("mouseenter", () => {
        blurSpan.style.filter = "blur(0px)";
      });
      blurSpan.addEventListener("mouseleave", () => {
        blurSpan.style.filter = `blur(${blurLevel}px)`;
      });

      // Split the text node and insert blurred span in between
      const parent = node.parentNode;
      if (!parent) continue;

      if (after) parent.insertBefore(document.createTextNode(after), node.nextSibling);
      parent.insertBefore(blurSpan, node.nextSibling);
      if (before) parent.insertBefore(document.createTextNode(before), blurSpan);

      node.remove();
      break; // each span targets one text node
    }
  }
}

// ===============================
// PROCESS SINGLE ELEMENT
// ===============================
async function processElement(el) {
  const text = el.innerText.trim();

  if (text.split(/\s+/).length < 4) {
    el.dataset.checked = "true";
    return;
  }

  const result = await detect(text.slice(0, 300));

  if (!result) {
    retryQueue.add(el);
    return;
  }

  el.dataset.checked = "true";
  retryQueue.delete(el);

  // ---- DEBUG: log what API returned ----
  console.group("🔍 Scan Result");
  console.log("📝 Text sent:", text.slice(0, 300));
  console.log("🏷️ Label:", result.label, "| Confidence:", result.confidence);
  console.log("📍 Spans returned:", JSON.stringify(result.spans, null, 2));
  if (result.spans) {
    result.spans.forEach(s => {
      console.log(`  → "${text.slice(s.start, s.end)}" [${s.start}-${s.end}] = ${s.label} (${s.confidence})`);
    });
  }
  console.groupEnd();
  // ---- END DEBUG ----

  if (result.spans && result.spans.length > 0) {
    blurPhrasesInElement(el, result.spans);
  }
}


// ===============================
// RETRY FAILED ELEMENTS
// ===============================
async function retryFailed() {
  if (retryQueue.size === 0) return;
  const toRetry = Array.from(retryQueue);
  retryQueue.clear();
  for (const el of toRetry) {
    if (document.contains(el)) await processElement(el);
  }
}

// ===============================
// MAIN SCAN
// ===============================
async function scanPage() {
  await retryFailed();
  const elements = getTextElements();
  for (const el of elements) {
    await processElement(el);
  }
}

// ===============================
// REAL-TIME LOOP
// ===============================
setInterval(scanPage, CHECK_INTERVAL);
scanPage();

