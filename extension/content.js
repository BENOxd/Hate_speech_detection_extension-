const API_URL = "http://127.0.0.1:5000/predict";
const CHECK_INTERVAL = 4000;
function getTextElements() {
  return Array.from(document.querySelectorAll("p, span, div")).filter(el =>
    el.innerText &&
    el.innerText.length > 30 &&
    !el.dataset.checked
  );
}

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

function blurText(el, level) {
  el.style.filter = `blur(${level}px)`;
  el.style.transition = "filter 0.2s ease";
  el.style.cursor = "pointer";

  
  el.addEventListener("mouseenter", () => {
    el.style.filter = "blur(0px)";
  });

  el.addEventListener("mouseleave", () => {
    el.style.filter = `blur(${level}px)`;
  });
}


async function scanPage() {
  const elements = getTextElements();

  for (let el of elements) {
    el.dataset.checked = "true";

    const text = el.innerText.slice(0, 300);
    if (text.split(" ").length < 4) continue;

    const result = await detect(text);
    if (!result) continue;

   
    if (result.label === "Hate Speech" && result.confidence > 0.60) {
      blurText(el, 6);
    }
   
    else if (result.label === "Offensive" && result.confidence > 0.70) {
      blurText(el, 3);
    }
    el.title = "⚠ Content blurred due to harmful language";

  }
}

// ===============================
// REAL-TIME LOOP
// ===============================
setInterval(scanPage, CHECK_INTERVAL);
scanPage();
