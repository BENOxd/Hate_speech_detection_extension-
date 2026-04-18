import os
import pickle

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

import pandas as pd
from sentence_transformers import SentenceTransformer
from sklearn.calibration import CalibratedClassifierCV
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, classification_report
from sklearn.model_selection import train_test_split

from text_pipeline import normalize_text

ST_MODEL_NAME = "all-MiniLM-L6-v2"

# ============================
# LOAD DATASET
# ============================
data = pd.read_csv("../dataset/hate_speech_dataset.csv")

data = data[["class", "tweet"]]
data.columns = ["label", "tweet"]

label_map = {
    0: 2,  # Hate Speech -> 2
    1: 1,  # Offensive -> 1
    2: 0,  # Normal -> 0
}

data["label"] = data["label"].map(label_map)
data = data.dropna(subset=["label", "tweet"])
data["label"] = data["label"].astype(int)

print("✅ Dataset loaded:", len(data), "rows")
print("Label distribution:\n", data["label"].value_counts())

# ============================
# TEXT PREPROCESSING (shared with inference)
# ============================
data["clean_text"] = data["tweet"].map(lambda t: normalize_text(str(t)))
data = data[data["clean_text"].str.len() > 0]

print("✅ After removing empty normalized texts:", len(data), "rows")

# ============================
# EMBEDDINGS
# ============================
embedder = SentenceTransformer(ST_MODEL_NAME)
texts = data["clean_text"].tolist()
X_emb = embedder.encode(texts, batch_size=64, show_progress_bar=True, convert_to_numpy=True)
y = data["label"].to_numpy()

# ============================
# TRAIN / TEST SPLIT
# ============================
X_train, X_test, y_train, y_test = train_test_split(
    X_emb, y, test_size=0.2, random_state=42, stratify=y
)

# ============================
# MODEL TRAINING (calibrated LR on embeddings)
# ============================
base_clf = LogisticRegression(
    max_iter=1000,
    solver="lbfgs",
)

model = CalibratedClassifierCV(base_clf, method="sigmoid", cv=3)
model.fit(X_train, y_train)

# ============================
# EVALUATION
# ============================
y_pred = model.predict(X_test)

print("\nAccuracy:", accuracy_score(y_test, y_pred))
print("\nClassification Report:\n")
print(classification_report(y_test, y_pred))

# ============================
# SAVE MODEL
# ============================
with open("model.pkl", "wb") as f:
    pickle.dump(model, f)

print("\n✅ Calibrated classifier saved to model.pkl")
