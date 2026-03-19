from flask import Flask, request, jsonify

import pickle
import re
import nltk
from nltk.corpus import stopwords
from nltk.stem import WordNetLemmatizer

app = Flask(__name__)


nltk.download('stopwords', quiet=True)
nltk.download('wordnet', quiet=True)

stop_words = set(stopwords.words('english'))
lemmatizer = WordNetLemmatizer()

with open("model.pkl", "rb") as f:
    model = pickle.load(f)

with open("tfidf.pkl", "rb") as f:
    vectorizer = pickle.load(f)


def preprocess_text(text):
    text = text.lower()
    text = re.sub(r"http\S+|www\S+", "", text)
    text = re.sub(r"@\w+|#\w+", "", text)
    text = re.sub(r"[^a-z\s]", "", text)
    tokens = text.split()
    tokens = [lemmatizer.lemmatize(w) for w in tokens if w not in stop_words]
    return " ".join(tokens)


def find_offensive_phrases(raw_text, vectorizer, model):
    """
    Slide a window of 1-5 words over the text,
    find which windows are offensive/hate speech,
    return their character positions.
    """
    words = raw_text.split()
    flagged_spans = []

    for window_size in range(1, 6):  # 1 to 5 word windows
        for i in range(len(words) - window_size + 1):
            phrase = " ".join(words[i:i + window_size])
            cleaned = preprocess_text(phrase)
            if not cleaned.strip():
                continue

            vec = vectorizer.transform([cleaned])
            pred = model.predict(vec)[0]
            conf = max(model.predict_proba(vec)[0])

            if pred in [1, 2] and conf > 0.75:  # Offensive or Hate Speech
                # Find character position in original text
                start = raw_text.lower().find(phrase.lower())
                if start != -1:
                    flagged_spans.append({
                        "phrase": phrase,
                        "start": start,
                        "end": start + len(phrase),
                        "label": "Hate Speech" if pred == 2 else "Offensive",
                        "confidence": round(float(conf), 2)
                    })

    # Merge overlapping spans
    if not flagged_spans:
        return []

    flagged_spans.sort(key=lambda x: x["start"])
    merged = [flagged_spans[0]]

    for current in flagged_spans[1:]:
        last = merged[-1]
        if current["start"] <= last["end"]:
            # Overlapping — extend the last span
            merged[-1]["end"] = max(last["end"], current["end"])
            merged[-1]["phrase"] = raw_text[merged[-1]["start"]:merged[-1]["end"]]
            # Keep the more severe label
            if current["label"] == "Hate Speech":
                merged[-1]["label"] = "Hate Speech"
                merged[-1]["confidence"] = current["confidence"]
        else:
            merged.append(current)

    return merged


@app.route("/predict", methods=["POST"])
def predict():
    data = request.get_json()

    if not data or "text" not in data:
        return jsonify({"error": "No text provided"}), 400

    raw_text = data["text"]
    cleaned_text = preprocess_text(raw_text)

    if not cleaned_text.strip():
        return jsonify({"label": "Normal", "confidence": 1.0, "spans": []})

    vector = vectorizer.transform([cleaned_text])
    prediction = model.predict(vector)[0]
    confidence = max(model.predict_proba(vector)[0])

    label_map = {0: "Normal", 1: "Offensive", 2: "Hate Speech"}
    label = label_map[prediction]

    # Only find spans if the overall text is flagged
    spans = []
    if prediction in [1, 2]:
        spans = find_offensive_phrases(raw_text, vectorizer, model)

    return jsonify({
        "label": label,
        "confidence": round(float(confidence), 2),
        "spans": spans  # <-- new field
    })


if __name__ == "__main__":
    app.run(debug=True)