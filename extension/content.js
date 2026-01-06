// ================================
// CONFIGURATION
// ================================
const API_URL = "http://127.0.0.1:5000/predict"; // Flask API endpoint
const CHECK_INTERVAL = 3000; // Check every 3 seconds

// ================================
// HELPER: Extract visible text nodes
// ================================
function getTextElements() {
  const elements = document.querySelectorAll("p, span, div");
  return Array.from(elements).filter(el => {
    return (
      el.innerText &&
      el.innerText.length > 20 &&
      !el.dataset.checked // avoid re-checking
    );
  });
}

// ================================
// HELPER: Send text to ML API
// ================================
async function detectHateSpeech(text) {
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text: text })
    });

    return await response.json();
  } catch (error) {
    console.error("API Error:", error);
    return null;
  }
}

// ================================
// MAIN LOGIC
// ================================
async function scanPage() {
  const elements = getTextElements();

  for (let el of elements) {
    el.dataset.checked = "true"; // mark as processed

    const text = el.innerText;

    const result = await detectHateSpeech(text);
    if (!result) continue;

    // Example API response:
    // { label: "Hate Speech", confidence: 0.91 }

    if (result.label === "Hate Speech") {
      highlightText(el, "red", result.confidence);
    } else if (result.label === "Offensive") {
      highlightText(el, "orange", result.confidence);
    }
  }
}

// ================================
// UI: Highlight detected text
// ================================
function highlightText(element, color, confidence) {
  element.style.border = `2px solid ${color}`;
  element.style.padding = "4px";
  element.style.borderRadius = "6px";
  element.style.backgroundColor =
    color === "red" ? "#ffe6e6" : "#fff3e0";

  element.title = `⚠ ${color.toUpperCase()} CONTENT\nConfidence: ${(confidence * 100).toFixed(1)}%`;
}

// ================================
// REAL-TIME MONITORING
// ================================
setInterval(scanPage, CHECK_INTERVAL);

// Initial scan
scanPage();
