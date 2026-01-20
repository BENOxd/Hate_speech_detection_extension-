import pandas as pd
import re
import pickle
import nltk

from sklearn.model_selection import train_test_split
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import classification_report, accuracy_score

from nltk.corpus import stopwords
from nltk.stem import WordNetLemmatizer

nltk.download("stopwords")
nltk.download("wordnet")

stop_words = set(stopwords.words("english"))
lemmatizer = WordNetLemmatizer()

# ============================
# LOAD DATASET
# ============================
# IMPORTANT: no header in your CSV
data = pd.read_csv(
    "../dataset/hate_speech_dataset.csv",
    header=None
)

# Select ONLY required columns
# Column 5 → label
# Column 6 → tweet text
data = data[[5, 6]]
data.columns = ["label", "tweet"]

label_map = {
    0: 2,  # Hate -> 2
    1: 1,  # Offensive -> 1
    2: 0   # Normal -> 0
}

data["label"] = data["label"].map(label_map)

# ============================
# TEXT PREPROCESSING
# ============================
def preprocess_text(text):
    text = str(text).lower()
    text = re.sub(r"http\S+|www\S+", "", text)
    text = re.sub(r"@\w+|#\w+", "", text)
    text = re.sub(r"[^a-z\s]", "", text)

    tokens = text.split()
    tokens = [
        lemmatizer.lemmatize(word)
        for word in tokens
        if word not in stop_words
    ]

    return " ".join(tokens)

data["clean_text"] = data["tweet"].apply(preprocess_text)

# ============================
# FEATURE EXTRACTION
# ============================
X = data["clean_text"]
y = data["label"]

tfidf = TfidfVectorizer(max_features=5000)
X_tfidf = tfidf.fit_transform(X)

# ============================
# TRAIN / TEST SPLIT
# ============================
X_train, X_test, y_train, y_test = train_test_split(
    X_tfidf, y, test_size=0.2, random_state=42
)

# ============================
# MODEL TRAINING
# ============================
model = LogisticRegression(max_iter=1000)
model.fit(X_train, y_train)

# ============================
# EVALUATION
# ============================
y_pred = model.predict(X_test)

print("Accuracy:", accuracy_score(y_test, y_pred))
print("\nClassification Report:\n")
print(classification_report(y_test, y_pred))

# ============================
# SAVE MODEL
# ============================
with open("model.pkl", "wb") as f:
    pickle.dump(model, f)

with open("tfidf.pkl", "wb") as f:
    pickle.dump(tfidf, f)

print("\n✅ Model and vectorizer saved!")
