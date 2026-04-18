const API_BASE = "http://127.0.0.1:5001";

async function callApi(path, body) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[HSD] Flask responded ${res.status} ${res.statusText} on ${path}`);
      return { success: false, error: `HTTP ${res.status}` };
    }
    return { success: true, data: await res.json() };
  } catch (err) {
    console.warn(`[HSD] fetch to ${path} failed:`, err?.message || err);
    return { success: false, error: err?.message || String(err) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PREDICT_BATCH") {
    callApi("/predict_batch", { texts: message.texts }).then((r) => {
      if (r.success) sendResponse({ success: true, results: r.data.results });
      else sendResponse({ success: false, error: r.error });
    });
    return true;
  }

  if (message.type === "PREDICT_SINGLE") {
    callApi("/predict", { text: message.text }).then((r) => {
      if (r.success) sendResponse({ success: true, result: r.data });
      else sendResponse({ success: false, error: r.error });
    });
    return true;
  }

  if (message.type === "PING") {
    callApi("/predict_batch", { texts: ["ping"] }).then((r) => {
      sendResponse(r);
    });
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[HSD] service worker installed, API base:", API_BASE);
});
