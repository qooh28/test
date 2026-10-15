"""作品のタイトル順に使う「読み」（ひらがな）を作る。

- Annict の読みがながあれば、それを整える（記号を取り、カタカナ・数字・英字もひらがなの読みにする）
- なければタイトルから作る
  1. 同じシリーズの作品（このタイトルの先頭と同じ題名で、読みがながあるもの）の読みを使う
  2. 漢字・カタカナは pykakasi でひらがなにする
  3. 英単語は alkana（英語→カタカナの辞書）で読む。辞書にない短い語は1文字ずつ（SAO → えすえーおー）、
     長い語はローマ字として読む（SHIROBAKO → しろばこ）
  4. 数字は日本語の読みにする（86 → はちじゅうろく）
- 括弧・記号・空白は読まない

必要なもの: pip install pykakasi alkana
"""

import re
import unicodedata

import alkana
import pykakasi

_kks = pykakasi.kakasi()

LETTERS = {
    "a": "えー", "b": "びー", "c": "しー", "d": "でぃー", "e": "いー", "f": "えふ", "g": "じー",
    "h": "えいち", "i": "あい", "j": "じぇー", "k": "けー", "l": "える", "m": "えむ", "n": "えぬ",
    "o": "おー", "p": "ぴー", "q": "きゅー", "r": "あーる", "s": "えす", "t": "てぃー", "u": "ゆー",
    "v": "ぶい", "w": "だぶりゅー", "x": "えっくす", "y": "わい", "z": "ぜっと",
}

# ローマ字（ヘボン式・訓令式のよくある綴り）→ ひらがな。長い綴りから順に当てる
ROMAJI = {
    "kya": "きゃ", "kyu": "きゅ", "kyo": "きょ", "sha": "しゃ", "shu": "しゅ", "sho": "しょ", "she": "しぇ",
    "cha": "ちゃ", "chu": "ちゅ", "cho": "ちょ", "che": "ちぇ", "nya": "にゃ", "nyu": "にゅ", "nyo": "にょ",
    "hya": "ひゃ", "hyu": "ひゅ", "hyo": "ひょ", "mya": "みゃ", "myu": "みゅ", "myo": "みょ",
    "rya": "りゃ", "ryu": "りゅ", "ryo": "りょ", "gya": "ぎゃ", "gyu": "ぎゅ", "gyo": "ぎょ",
    "bya": "びゃ", "byu": "びゅ", "byo": "びょ", "pya": "ぴゃ", "pyu": "ぴゅ", "pyo": "ぴょ",
    "sya": "しゃ", "syu": "しゅ", "syo": "しょ", "tya": "ちゃ", "tyu": "ちゅ", "tyo": "ちょ",
    "shi": "し", "chi": "ち", "tsu": "つ", "dzu": "づ",
    "ja": "じゃ", "ju": "じゅ", "jo": "じょ", "je": "じぇ", "ji": "じ", "fu": "ふ", "fa": "ふぁ", "fi": "ふぃ",
    "fe": "ふぇ", "fo": "ふぉ", "ti": "てぃ", "di": "でぃ", "tu": "つ", "si": "し", "zi": "じ", "hu": "ふ",
    "ka": "か", "ki": "き", "ku": "く", "ke": "け", "ko": "こ", "sa": "さ", "su": "す", "se": "せ", "so": "そ",
    "ta": "た", "te": "て", "to": "と", "na": "な", "ni": "に", "nu": "ぬ", "ne": "ね", "no": "の",
    "ha": "は", "hi": "ひ", "he": "へ", "ho": "ほ", "ma": "ま", "mi": "み", "mu": "む", "me": "め", "mo": "も",
    "ya": "や", "yu": "ゆ", "yo": "よ", "ra": "ら", "ri": "り", "ru": "る", "re": "れ", "ro": "ろ",
    "la": "ら", "li": "り", "lu": "る", "le": "れ", "lo": "ろ", "wa": "わ", "wo": "を", "wi": "うぃ", "we": "うぇ",
    "ga": "が", "gi": "ぎ", "gu": "ぐ", "ge": "げ", "go": "ご", "za": "ざ", "zu": "ず", "ze": "ぜ", "zo": "ぞ",
    "da": "だ", "du": "づ", "de": "で", "do": "ど", "ba": "ば", "bi": "び", "bu": "ぶ", "be": "べ", "bo": "ぼ",
    "pa": "ぱ", "pi": "ぴ", "pu": "ぷ", "pe": "ぺ", "po": "ぽ", "va": "ば", "vi": "び", "vu": "ゔ", "ve": "べ", "vo": "ぼ",
    "a": "あ", "i": "い", "u": "う", "e": "え", "o": "お",
}

DIGITS = ["", "いち", "に", "さん", "よん", "ご", "ろく", "なな", "はち", "きゅう"]
HIRAGANA = re.compile(r"[ぁ-ゖー]")  # ひらがなと長音（ー）
LATIN_OR_DIGITS = re.compile(r"[A-Za-z]+|[0-9]+")


def _under_10000(n):
    out = ""
    thousands, rest = divmod(n, 1000)
    hundreds, rest = divmod(rest, 100)
    tens, ones = divmod(rest, 10)
    if thousands:
        out += {1: "せん", 3: "さんぜん", 8: "はっせん"}.get(thousands, DIGITS[thousands] + "せん")
    if hundreds:
        out += {1: "ひゃく", 3: "さんびゃく", 6: "ろっぴゃく", 8: "はっぴゃく"}.get(hundreds, DIGITS[hundreds] + "ひゃく")
    if tens:
        out += ("" if tens == 1 else DIGITS[tens]) + "じゅう"
    return out + DIGITS[ones]


def number_reading(digits):
    if len(digits) > 1 and digits.startswith("0"):
        return "".join("ぜろ" if d == "0" else DIGITS[int(d)] for d in digits)  # 007 → ぜろぜろなな
    n = int(digits)
    if n == 0:
        return "ぜろ"
    if n >= 10**12:
        return "".join("ぜろ" if d == "0" else DIGITS[int(d)] for d in digits)
    out = ""
    for unit, name in ((10**8, "おく"), (10**4, "まん")):
        if n >= unit:
            out += _under_10000(n // unit) + name
            n %= unit
    return out + _under_10000(n)


def romaji_reading(word):
    """ローマ字として読めればひらがなを、読めなければ None を返す。"""
    w = word.lower()
    out = ""
    i = 0
    while i < len(w):
        if i + 1 < len(w) and w[i] == w[i + 1] and w[i] not in "aeioun":
            out += "っ"  # 促音（kk, tt, ss など）
            i += 1
            continue
        if w[i] == "n" and (i + 1 == len(w) or w[i + 1] not in "aeiouy"):
            out += "ん"
            i += 1
            continue
        for size in (3, 2, 1):
            kana = ROMAJI.get(w[i:i + size])
            if kana:
                out += kana
                i += size
                break
        else:
            return None
    return out


def english_reading(word):
    katakana = alkana.get_kana(word.lower())
    if katakana:
        return to_hiragana(katakana)
    if len(word) <= 3:
        return "".join(LETTERS[c] for c in word.lower())
    return romaji_reading(word) or "".join(LETTERS[c] for c in word.lower())


def to_hiragana(text):
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in text)


def _clean(text):
    # 英字・数字を読みに置き換えてから、ひらがなと「ー」以外（括弧・記号・空白・読めない字）を取り除く
    text = LATIN_OR_DIGITS.sub(lambda m: number_reading(m.group()) if m.group().isdigit() else english_reading(m.group()), text)
    return "".join(HIRAGANA.findall(to_hiragana(text)))


def normalize_kana(kana):
    """Annict の読みがなを整える。「をたく… / おたく…」のように読みが2つあるときは、後ろの（発音どおりの）ものを使う。"""
    kana = unicodedata.normalize("NFKC", kana).split(" / ")[-1]
    return _clean(kana)


def generated_reading(title):
    text = unicodedata.normalize("NFKC", title)
    parts = []
    for piece in re.split(r"([A-Za-z]+|[0-9]+)", text):
        if not piece:
            continue
        if LATIN_OR_DIGITS.fullmatch(piece):
            parts.append(piece)
        else:
            parts.append("".join(item["hira"] for item in _kks.convert(piece)))
    return _clean("".join(parts))


class Readings:
    """作品一覧全体の読みを作る。同じシリーズの読みを借りるため、先に読みがなのある題名を集める。"""

    def __init__(self, titled_kana):
        self.known = {}
        for title, kana in titled_kana:
            key = unicodedata.normalize("NFKC", title).strip()
            if kana and key not in self.known:
                self.known[key] = normalize_kana(kana)
        self.by_head = {}
        for key in self.known:
            self.by_head.setdefault(key[:2], []).append(key)

    def reading(self, title, kana=None):
        if kana:
            reading = normalize_kana(kana)
            if reading:
                return reading
        text = unicodedata.normalize("NFKC", title).strip()
        # 同じシリーズの作品（題名がこの題名の先頭と一致し、その直後が区切りになっているもの）の読みを借りる
        best = ""
        for key in self.by_head.get(text[:2], ()):
            if len(key) > len(best) and len(key) < len(text) and text.startswith(key) and not text[len(key)].isalnum():
                best = key
        if best and self.known[best]:
            return self.known[best] + generated_reading(text[len(best):])
        return generated_reading(text)
