chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PREDICT_BATCH") {
    fetch("http://127.0.0.1:5000/predict_batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: message.texts })
    })
      .then(res => res.json())
      .then(data => sendResponse({ success: true, results: data.results }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === "PREDICT_SINGLE") {
    fetch("http://127.0.0.1:5000/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message.text })
    })
      .then(res => res.json())
      .then(data => sendResponse({ success: true, result: data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});