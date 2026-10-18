#!/usr/bin/env python3
"""Annict の作品に、TVmaze のポスター画像を結びつけて covers.json に書き出す。

使い方:
  python3 scripts/build_covers.py                  # covers.json を作る
  python3 scripts/build_covers.py --cache DIR      # 取ったデータを DIR に残し、次は続きから取る

結びつけ方（間違ったポスターを出さないよう、確かなものだけ）:
  1. Annict の作品の MyAnimeList の番号を、Wikidata で TVmaze の番組 ID に変える（1つに決まるものだけ）
  2. TVmaze の番組が日本語のアニメで、作品が劇場版でなければ使う。
     作品の放送時期と同じ季（シーズン）にポスターがあればそれを、なければ番組のポスターを使う
  3. 2期・3期など 1 で結びつかなかったテレビ作品は、Annict で同じシリーズの作品が結びついた番組のうち、
     同じ時期に始まった季がちょうど1つだけあるとき、その季（なければ番組）のポスターを使う

TVmaze のデータは CC BY-SA 4.0（https://www.tvmaze.com/api ）。covers.json も CC BY-SA 4.0 で、
Annict のデータ（catalog.json）とは分けて置く。Wikidata のデータは CC0。
Annict のアクセストークンは build_catalog.py と同じ方法で渡す。
"""

import argparse
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_catalog import WAIT_SECONDS, post  # noqa: E402

USER_AGENT = "anime-log-covers/1.0 (+https://github.com/qooh28/test)"
TVMAZE_API = "https://api.tvmaze.com"
TVMAZE_WAIT_SECONDS = 0.5  # TVmaze は 10 秒に 20 回まで
IMAGE_PREFIX = "https://static.tvmaze.com/uploads/images/medium_portrait/"
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
# P4086 = MyAnimeList の作品 ID、P8600 = TVmaze の番組 ID
WIKIDATA_QUERY = "SELECT ?mal ?tvmaze WHERE { ?item wdt:P4086 ?mal ; wdt:P8600 ?tvmaze . }"

WORKS_QUERY = """
query ($after: String) {
  searchWorks(orderBy: { field: WATCHERS_COUNT, direction: DESC }, first: 200, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { annictId title media seasonName seasonYear malAnimeId seriesList { nodes { annictId } } }
  }
}
"""

# 季の始まりの月。その前の月から次の月までに始まった番組を、その季の番組とみなす（例：秋＝9〜11月、冬＝12〜2月）
SEASON_MONTH = {"WINTER": 1, "SPRING": 4, "SUMMER": 7, "AUTUMN": 10}
NOT_MOVIE = {"TV", "WEB", "OVA", "OTHER"}
SEQUEL_MEDIA = {"TV", "WEB"}


def load_or(path, make):
    """path があれば読み、なければ make() の結果を書いて返す（path が None なら毎回 make）"""
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as fp:
            return json.load(fp)
    data = make()
    if path:
        with open(path, "w", encoding="utf-8") as fp:
            json.dump(data, fp, ensure_ascii=False)
    return data


def fetch_annict_works():
    works, after = [], None
    while True:
        data = post(WORKS_QUERY, {"after": after})["searchWorks"]
        works.extend(data["nodes"])
        print(f"\rAnnict: {len(works)}作品まで取得", end="", file=sys.stderr, flush=True)
        if not data["pageInfo"]["hasNextPage"]:
            break
        after = data["pageInfo"]["endCursor"]
        time.sleep(WAIT_SECONDS)
    print(file=sys.stderr)
    return works


def get_json(url, headers=None, attempts=8):
    for attempt in range(attempts):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return json.load(res)
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            if err.code in (429, 500, 502, 503, 504) and attempt < attempts - 1:
                # Wikidata は混んでいると1分に1回まで。TVmaze も 429 なら少し待てばよい
                time.sleep(int(err.headers.get("Retry-After") or 0) or 5 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt < attempts - 1:
                time.sleep(5 * (attempt + 1))
                continue
            raise
    return None


def fetch_wikidata():
    """MyAnimeList の作品 ID → TVmaze の番組 ID の一覧"""
    url = f"{WIKIDATA_SPARQL}?format=json&query={urllib.parse.quote(WIKIDATA_QUERY)}"
    rows = get_json(url, {"Accept": "application/sparql-results+json"})["results"]["bindings"]
    mal_to_tvmaze = {}
    for row in rows:
        mal_to_tvmaze.setdefault(row["mal"]["value"], set()).add(row["tvmaze"]["value"])
    print(f"Wikidata: {len(mal_to_tvmaze)}作品", file=sys.stderr)
    return {mal: sorted(ids) for mal, ids in mal_to_tvmaze.items()}


def fetch_tvmaze_shows(ids, cache_path):
    """TVmaze の番組を、季の情報つきで1件ずつ取る。cache_path があれば途中から続ける"""
    shows = {}
    if cache_path and os.path.exists(cache_path):
        with open(cache_path, encoding="utf-8") as fp:
            shows = json.load(fp)
    todo = [i for i in ids if str(i) not in shows]
    for n, show_id in enumerate(todo, 1):
        s = get_json(f"{TVMAZE_API}/shows/{show_id}?embed=seasons")
        shows[str(show_id)] = None if s is None else {
            "id": s["id"],
            "name": s["name"],
            "type": s.get("type"),
            "language": s.get("language"),
            "premiered": s.get("premiered"),
            "image": (s.get("image") or {}).get("medium"),
            "url": s.get("url"),
            "seasons": [
                {"number": x.get("number"), "premiereDate": x.get("premiereDate"), "image": (x.get("image") or {}).get("medium")}
                for x in (s.get("_embedded") or {}).get("seasons", [])
            ],
        }
        print(f"\rTVmaze: {n}/{len(todo)}番組", end="", file=sys.stderr, flush=True)
        if cache_path and n % 50 == 0:
            with open(cache_path, "w", encoding="utf-8") as fp:
                json.dump(shows, fp, ensure_ascii=False)
        time.sleep(TVMAZE_WAIT_SECONDS)
    if todo:
        print(file=sys.stderr)
    if cache_path:
        with open(cache_path, "w", encoding="utf-8") as fp:
            json.dump(shows, fp, ensure_ascii=False)
    return shows


def season_of(date):
    """'2023-09-29' → (2023, 'AUTUMN')。12月は次の年の冬にする"""
    try:
        d = datetime.date.fromisoformat(date or "")
    except ValueError:
        return None
    year, month = d.year, d.month
    if month == 12:
        return (year + 1, "WINTER")
    for name, start in (("WINTER", 1), ("SPRING", 4), ("SUMMER", 7), ("AUTUMN", 10)):
        if start - 1 <= month <= start + 1:
            return (year, name)
    return None


def work_season(work):
    if work.get("seasonYear") and work.get("seasonName") in SEASON_MONTH:
        return (work["seasonYear"], work["seasonName"])
    return None


def image_path(url):
    """TVmaze の画像の URL から、アプリが付け足す部分（例：'477/1194327.jpg'）だけを取り出す"""
    if url and url.startswith(IMAGE_PREFIX):
        return url[len(IMAGE_PREFIX):]
    return None


def usable(show):
    return bool(show) and show.get("type") == "Animation" and show.get("language") == "Japanese"


def poster_for(show, season):
    """その季のポスターがあればそれを、なければ番組のポスターを返す"""
    if season:
        for s in show["seasons"]:
            if season_of(s.get("premiereDate")) == season and image_path(s.get("image")):
                return image_path(s["image"])
    return image_path(show.get("image"))


def match(works, mal_to_tvmaze, shows):
    covers, direct_show = {}, {}
    # 1・2：MyAnimeList の番号から、1つに決まる番組
    for work in works:
        if work.get("media") not in NOT_MOVIE:
            continue
        ids = mal_to_tvmaze.get(str(work.get("malAnimeId") or "").strip(), [])
        if len(ids) != 1:
            continue
        show = shows.get(ids[0])
        if not usable(show):
            continue
        premiered = season_of(show.get("premiered"))
        season = work_season(work)
        # 番組が始まる2年以上前の作品は、別の作品に結びついているとみなして使わない
        if premiered and season and season[0] < premiered[0] - 1:
            continue
        direct_show[work["annictId"]] = show
        path = poster_for(show, season)
        if path:
            covers[work["annictId"]] = path
    direct = len(covers)

    # 3：2期・3期など。同じシリーズの作品が結びついた番組の中から、同じ時期に始まった季を探す
    series_shows = {}
    for work in works:
        show = direct_show.get(work["annictId"])
        if show:
            for node in (work.get("seriesList") or {}).get("nodes", []):
                series_shows.setdefault(node["annictId"], {})[show["id"]] = show
    for work in works:
        if work["annictId"] in direct_show or work.get("media") not in SEQUEL_MEDIA:
            continue
        season = work_season(work)
        if not season:
            continue
        candidates = {}
        for node in (work.get("seriesList") or {}).get("nodes", []):
            candidates.update(series_shows.get(node["annictId"], {}))
        hits = [show for show in candidates.values() if any(season_of(s.get("premiereDate")) == season for s in show["seasons"])]
        if len(hits) == 1:
            path = poster_for(hits[0], season)
            if path:
                covers[work["annictId"]] = path
    print(f"ポスター：{len(covers)}作品（MyAnimeList の番号から {direct}、シリーズから {len(covers) - direct}）", file=sys.stderr)
    return covers


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "covers.json"))
    parser.add_argument("--cache", help="取ったデータを置くフォルダ（あれば続きから取る）")
    args = parser.parse_args()
    cache = (lambda name: os.path.join(args.cache, name)) if args.cache else (lambda name: None)
    if args.cache:
        os.makedirs(args.cache, exist_ok=True)

    works = load_or(cache("annict_works.json"), fetch_annict_works)
    mal_to_tvmaze = load_or(cache("wikidata.json"), fetch_wikidata)
    wanted = sorted({ids[0] for w in works for ids in [mal_to_tvmaze.get(str(w.get("malAnimeId") or "").strip(), [])] if len(ids) == 1}, key=int)
    shows = fetch_tvmaze_shows(wanted, cache("tvmaze_shows.json"))
    covers = match(works, mal_to_tvmaze, shows)

    today = datetime.date.today()
    data = {
        "source": "TVmaze (https://www.tvmaze.com)",
        "license": "CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)",
        "generatedAt": f"{today.year}年{today.month}月{today.day}日",
        "covers": {str(k): covers[k] for k in sorted(covers)},
    }
    with open(args.out, "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, separators=(",", ":"))
    print(f"{args.out} に書き出しました", file=sys.stderr)


if __name__ == "__main__":
    main()
