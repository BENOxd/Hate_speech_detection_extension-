import os
import pickle
import re

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_HF_HOME = os.path.join(_BACKEND_DIR, ".hf_home")
os.makedirs(_HF_HOME, exist_ok=True)
os.environ.setdefault("HF_HOME", _HF_HOME)

_HF_MODEL_CACHE = os.path.join(
    _HF_HOME,
    "hub",
    "models--sentence-transformers--all-MiniLM-L6-v2",
    "snapshots",
)
if os.path.isdir(_HF_MODEL_CACHE) and os.listdir(_HF_MODEL_CACHE):
    os.environ.setdefault("HF_HUB_OFFLINE", "1")

from flask import Flask, request, jsonify
import numpy as np
from sentence_transformers import SentenceTransformer

from text_pipeline import normalize_text

app = Flask(__name__)

ST_MODEL_NAME = "all-MiniLM-L6-v2"

# Trigger offensive-keyword scan when whole text is even mildly offensive/hate.
# Lowered from 0.55 → 0.25 so posts the model labels Normal with low confidence
# (e.g. "this is fucking disgusting...") still get their offensive keywords blurred.
FULL_TEXT_TRIGGER_PROB = 0.25
# Whole-element blur fallback only when the classifier is VERY confident and no
# keyword matched (keeps ordinary news/opinion posts from being blurred wholesale).
FULL_TEXT_STRONG_PROB = 0.97


@app.after_request
def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    response.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
    return response


@app.before_request
def handle_options():
    if request.method == "OPTIONS":
        response = app.make_response("")
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
        response.status_code = 200
        return response


with open("model.pkl", "rb") as f:
    classifier = pickle.load(f)

embedder = SentenceTransformer(ST_MODEL_NAME)


def _load_wordlist(filename):
    path = os.path.join(_BACKEND_DIR, filename)
    if not os.path.exists(path):
        return []
    words = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            w = line.strip().lower()
            if not w or w.startswith("#"):
                continue
            words.append(w)
    return sorted(set(words), key=len, reverse=True)


def _compile_wordlist_regex(words):
    if not words:
        return None
    escaped = [re.escape(w) for w in words]
    pattern = r"(?<![A-Za-z0-9_])(?:" + "|".join(escaped) + r")(?![A-Za-z0-9_])"
    return re.compile(pattern, re.IGNORECASE)


_OFFENSIVE_WORDS = _load_wordlist("words_offensive.txt")
_HATE_WORDS = _load_wordlist("words_hate.txt")
_OFFENSIVE_RE = _compile_wordlist_regex(_OFFENSIVE_WORDS)
_HATE_RE = _compile_wordlist_regex(_HATE_WORDS)


def embed_texts(texts, batch_size=64):
    if not texts:
        return np.zeros((0, embedder.get_sentence_embedding_dimension()), dtype=np.float32)
    return embedder.encode(
        texts,
        batch_size=batch_size,
        show_progress_bar=False,
        convert_to_numpy=True,
    )


def predict_proba_batch(texts):
    emb = embed_texts(texts)
    return classifier.predict_proba(emb)


def _scan_pattern(pattern, raw_text, label, confidence):
    if pattern is None:
        return []
    spans = []
    for m in pattern.finditer(raw_text):
        spans.append(
            {
                "phrase": raw_text[m.start() : m.end()],
                "start": m.start(),
                "end": m.end(),
                "label": label,
                "confidence": round(confidence, 2),
            }
        )
    return spans


def _merge_spans(spans):
    if not spans:
        return []
    spans.sort(key=lambda s: (s["start"], 0 if s["label"] == "Hate Speech" else 1))
    merged = []
    for span in spans:
        if merged and span["start"] < merged[-1]["end"]:
            if span["label"] == "Hate Speech" and merged[-1]["label"] != "Hate Speech":
                merged[-1] = span
            continue
        merged.append(span)
    return merged


_SENTENCE_BOUNDARY_RE = re.compile(r"[.!?]+\s+|\n+")


def _sentence_ranges(text):
    ranges = []
    pos = 0
    for m in _SENTENCE_BOUNDARY_RE.finditer(text):
        ranges.append((pos, m.end()))
        pos = m.end()
    if pos < len(text):
        ranges.append((pos, len(text)))
    return ranges or [(0, len(text))]


def _escalate_offensive_in_hate_sentences(spans, raw_text):
    """
    If a sentence already contains a Hate Speech span, any Offensive spans
    inside the same sentence are treated as Hate Speech (intent is the same).
    """
    if not spans:
        return spans
    for s_start, s_end in _sentence_ranges(raw_text):
        in_sentence = [sp for sp in spans if sp["start"] >= s_start and sp["end"] <= s_end]
        if not in_sentence:
            continue
        if any(sp["label"] == "Hate Speech" for sp in in_sentence):
            for sp in in_sentence:
                if sp["label"] == "Offensive":
                    sp["label"] = "Hate Speech"
                    sp["confidence"] = max(sp["confidence"], 0.9)
    return spans


def find_keyword_spans(raw_text, confidence, include_offensive):
    """
    Hate-word matches always run (context-independent slurs).
    Offensive-word matches are gated on include_offensive (ML said text is offensive).
    If a sentence contains a Hate match, co-located Offensive matches are
    escalated to Hate Speech (same intent).
    """
    spans = _scan_pattern(_HATE_RE, raw_text, "Hate Speech", max(confidence, 0.9))
    if include_offensive:
        spans.extend(_scan_pattern(_OFFENSIVE_RE, raw_text, "Offensive", confidence))
    spans = _merge_spans(spans)
    spans = _escalate_offensive_in_hate_sentences(spans, raw_text)
    return spans


def process_single(raw_text):
    cleaned = normalize_text(raw_text)
    if not cleaned.strip():
        return {"label": "Normal", "confidence": 1.0, "spans": []}

    probs = predict_proba_batch([cleaned])[0]
    prediction = int(np.argmax(probs))
    confidence = float(np.max(probs))

    label_map = {0: "Normal", 1: "Offensive", 2: "Hate Speech"}
    label = label_map[prediction]

    non_normal_prob = float(probs[1] + probs[2])
    include_offensive = non_normal_prob >= FULL_TEXT_TRIGGER_PROB

    spans = find_keyword_spans(raw_text, confidence, include_offensive)

    if (
        not spans
        and include_offensive
        and non_normal_prob >= FULL_TEXT_STRONG_PROB
    ):
        spans = [
            {
                "phrase": raw_text,
                "start": 0,
                "end": len(raw_text),
                "label": label,
                "confidence": round(confidence, 2),
            }
        ]

    if spans and label == "Normal":
        label = "Hate Speech" if any(s["label"] == "Hate Speech" for s in spans) else "Offensive"

    return {
        "label": label,
        "confidence": round(confidence, 2),
        "spans": spans,
    }


@app.route("/predict", methods=["POST", "OPTIONS"])
def predict():
    data = request.get_json()
    if not data or "text" not in data:
        return jsonify({"error": "No text provided"}), 400
    return jsonify(process_single(data["text"]))


@app.route("/predict_batch", methods=["POST", "OPTIONS"])
def predict_batch():
    data = request.get_json()
    if not data or "texts" not in data:
        return jsonify({"error": "No texts provided"}), 400

    texts = data["texts"]
    if not isinstance(texts, list) or len(texts) == 0:
        return jsonify({"error": "texts must be a non-empty array"}), 400
    if len(texts) > 50:
        return jsonify({"error": "Max 50 texts per batch"}), 400

    results = [process_single(t) for t in texts]
    return jsonify({"results": results})


if __name__ == "__main__":
    app.run(debug=True)
