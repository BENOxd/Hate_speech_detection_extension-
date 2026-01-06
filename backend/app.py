from flask import Flask, request, jsonify
from flask_cors import CORS
import pickle
import re
import nltk

from nltk.corpus import stopwords
from nltk.stem import WordNetLemmatizer

# ==============================
# INITIAL SETUP
# ==============================
app = Flask(__name__)
CORS(app)  # VERY IMPORTANT for Chrome Extension

nltk.download('stopwords')
nltk.download('wordnet')

stop_words = set(stopwords.words('english'))
lemmatizer = WordNetLemmatizer()

# ==============================
# LOAD MODEL & VECTORIZER
# ==============================
with open("model.pkl", "rb") as f:
    model = pickle.load(f)

with open("tfidf.pkl", "rb") as f:
    vectorizer = pickle.load(f)

# ==============================
# TEXT PREPROCESSING FUNCTION
# ==============================
def preprocess_text(text):
    text = text.lower()
    text = re.sub(r"http\S+|www\S+", "", text)  # remove URLs
    text = re.sub(r"@\w+|#\w+", "", text)       # remove mentions & hashtags
    text = re.sub(r"[^a-z\s]", "", text)        # remove punctuation & numbers

    tokens = text.split()
    tokens = [
        lemmatizer.lemmatize(word)
        for word in tokens
        if word not in stop_words
    ]

    return " ".join(tokens)

# ==============================
# PREDICTION API
# ==============================
@app.route("/predict", methods=["POST"])
def predict():
    data = request.get_json()

    if not data or "text" not in data:
        return jsonify({"error": "No text provided"}), 400

    raw_text = data["text"]

    cleaned_text = preprocess_text(raw_text)
    vector = vectorizer.transform([cleaned_text])

    prediction = model.predict(vector)[0]
    confidence = max(model.predict_proba(vector)[0])

    # LABEL MAPPING (CHANGE IF NEEDED)
    label_map = {
        0: "Normal",
        1: "Offensive",
        2: "Hate Speech"
    }

    return jsonify({
        "label": label_map[prediction],
        "confidence": round(float(confidence), 2)
    })

# ==============================
# RUN SERVER
# ==============================
if __name__ == "__main__":
    app.run(debug=True)
