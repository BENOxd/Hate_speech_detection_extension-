"""
Shared normalization and word-span tokenization for training and inference.
"""
from __future__ import annotations

import re
import unicodedata
from typing import List, Tuple

# Only these inside mixed alphanumeric tokens (e.g. "sh1t", "b@d") get folded.
# We intentionally do NOT fold digits like "2025" or standalone "!" / "$".
_IN_TOKEN_LEET = str.maketrans(
    {
        "0": "o",
        "1": "i",
        "3": "e",
        "4": "a",
        "5": "s",
        "7": "t",
        "@": "a",
        "$": "s",
    }
)

_URL_RE = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
_MENTION_RE = re.compile(r"@\w+")
_HASHTAG_RE = re.compile(r"#(\w+)")
_TOKEN_RE = re.compile(r"\S+")

_ALPHA_RE = re.compile(r"[a-z]")
_LEET_TRIGGER_RE = re.compile(r"[a-z].*[0134579@$]|[0134579@$].*[a-z]")


def _fold_leet_in_token(token: str) -> str:
    """
    Apply leetspeak folding only if the token mixes ASCII letters with
    leet-candidate characters (e.g. "sh1t", "b@d", "a$$"). Pure numbers,
    URLs, punctuation, or plain words are left untouched.
    """
    if _LEET_TRIGGER_RE.search(token):
        return token.translate(_IN_TOKEN_LEET)
    return token


def normalize_text(text: str) -> str:
    """
    Normalize text for embedding: NFKC, lowercase, strip URLs,
    replace @mentions with a placeholder, keep hashtags as words,
    apply per-token leetspeak folding only for mixed-alnum tokens.
    """
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", text)
    text = text.lower()
    text = _URL_RE.sub(" ", text)
    text = _MENTION_RE.sub(" @user ", text)
    text = _HASHTAG_RE.sub(r"\1", text)

    folded_tokens = [_fold_leet_in_token(m.group(0)) for m in _TOKEN_RE.finditer(text)]
    text = " ".join(folded_tokens)
    return text.strip()


def tokenize_words_with_spans(raw_text: str) -> List[Tuple[str, int, int]]:
    """
    Non-whitespace tokens with start/end indices in the original string.
    """
    return [(m.group(0), m.start(), m.end()) for m in _TOKEN_RE.finditer(raw_text)]
