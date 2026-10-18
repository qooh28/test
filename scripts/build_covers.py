#!/usr/bin/env python3
"""Annict の作品に、TVmaze のポスター画像を結びつけて covers.json に書き出す。

使い方:
  python3 scripts/build_covers.py                  # covers.json を作る
  python3 scripts/build_covers.py --cache DIR      # 取ったデータを DIR に残し、次は続きから取る
  python3 scripts/build_covers.py --search 0       # TVmaze の検索を使わない（Wikidata とシリーズだけ）
  python3 scripts/build_covers.py --remove 10079   # 権利者から削除を頼まれた作品のポスターを外す（問い合わせはしない）

削除を頼まれた作品は scripts/covers_blocklist.txt に Annict の作品 ID を書いておく。作り直しても付かない。

結びつけ方（間違ったポスターを出さないよう、確かなものだけ。劇場版には付けない）:
  1. Annict の作品の MyAnimeList の番号を、Wikidata で TVmaze の番組 ID に変える（1つに決まるものだけ）。
     TVmaze の番組が日本語のアニメで、番組が始まる2年以上前の作品でなければ使う
  2. 1 で結びつかない人気のテレビ・Web 作品は、題名（日本語と英語）で TVmaze を検索し、
     日本語のアニメで、作品と同じ時期（季）に始まった番組を候補にする。
     候補が複数あれば、題名の後ろに副題を足した名前の番組（同じ時期のミニアニメなど）は外す。
     題名がぴったり合う番組を先に決め、残りは候補が1つに絞れて、ほかの作品の候補にもならないときだけ使う
  3. 2期・3期など、まだ結びつかないテレビ・Web 作品は、Annict で同じシリーズの作品が結びついた番組のうち、
     同じ時期に始まった季がちょうど1つだけあるときに使う。
     ただし、その季にすでに別の作品が結びついていれば（同じ時期のミニアニメなど）使わない。
     同じ季に複数の作品が並ぶときは、題名がいちばん近い1作品だけに付ける
  ポスターは、作品と同じ季のポスターがあればそれを、なければ番組のポスターを使う。
  3 で番組のポスターを使うのは、題名が「番組に結びついた作品の題名＋第2期・Season 2・Ⅱなど」のときだけ
  （TVmaze は「ジュエルペット」の各シリーズのように、題名の違うシリーズを1つの番組にまとめていることがあるため）

TVmaze のデータは CC BY-SA 4.0（https://www.tvmaze.com/api ）。covers.json も CC BY-SA 4.0 で、
Annict のデータ（catalog.json）とは分けて置く。Wikidata のデータは CC0。
Annict のアクセストークンは build_catalog.py と同じ方法で渡す。
"""

import argparse
import datetime
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_catalog import WAIT_SECONDS, post  # noqa: E402

USER_AGENT = "anime-log-covers/1.0 (+https://github.com/qooh28/test)"
TVMAZE_API = "https://api.tvmaze.com"
TVMAZE_WAIT_SECONDS = 0.5  # TVmaze は 10 秒に 20 回まで
SEARCH_TOP = 3000  # TVmaze を検索するのは、人気（Annict で見ている人の数）の上位この数の作品だけ
IMAGE_PREFIX = "https://static.tvmaze.com/uploads/images/medium_portrait/"
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
# P4086 = MyAnimeList の作品 ID、P8600 = TVmaze の番組 ID
WIKIDATA_QUERY = "SELECT ?mal ?tvmaze WHERE { ?item wdt:P4086 ?mal ; wdt:P8600 ?tvmaze . }"

WORKS_QUERY = """
query ($after: String) {
  searchWorks(orderBy: { field: WATCHERS_COUNT, direction: DESC }, first: 200, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { annictId title titleEn media seasonName seasonYear malAnimeId seriesList { nodes { annictId } } }
  }
}
"""

# 季の始まりの月。その前の月から次の月までに始まった番組を、その季の番組とみなす（例：秋＝9〜11月、冬＝12〜2月）
SEASON_MONTH = {"WINTER": 1, "SPRING": 4, "SUMMER": 7, "AUTUMN": 10}
NOT_MOVIE = {"TV", "WEB", "OVA", "OTHER"}
SEQUEL_MEDIA = {"TV", "WEB"}
BLOCKLIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "covers_blocklist.txt")
# 2期・3期の題名の後ろにつく言葉（例：第2期、Season 2、Ⅱ、2nd Season、第3シリーズ）。fold した形で比べる
SEQUEL_SUFFIX = re.compile(r"^(?:|[ivx]+|.*\d.*|.*(?:期|season|シーズン|シリーズ|続).*)$")


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


def fetch_tvmaze_shows(ids, cache_path, shows=None):
    """TVmaze の番組を、季の情報つきで1件ずつ取る。cache_path か shows（取ったもの）があれば続きから取る"""
    shows = dict(shows or {})
    if not shows and cache_path and os.path.exists(cache_path):
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


def fold(text):
    """題名を比べるときの形（全角・半角、大文字・小文字、記号の違いをなくす）"""
    return "".join(ch for ch in unicodedata.normalize("NFKC", text or "").lower() if ch.isalnum())


def poster_for(show, season, season_only=False):
    """その季のポスターがあればそれを、なければ（season_only でなければ）番組のポスターを返す"""
    if season:
        for s in show.get("seasons") or []:
            if season_of(s.get("premiereDate")) == season and image_path(s.get("image")):
                return image_path(s["image"])
    return None if season_only else image_path(show.get("image"))


def link_by_wikidata(works, mal_to_tvmaze, shows):
    """1：MyAnimeList の番号から、1つに決まる番組（Annict の作品 ID → TVmaze の番組 ID）"""
    linked = {}
    for work in works:
        if work.get("media") not in NOT_MOVIE:
            continue
        ids = mal_to_tvmaze.get(str(work.get("malAnimeId") or "").strip(), [])
        if len(ids) != 1 or not usable(shows.get(ids[0])):
            continue
        premiered = season_of(shows[ids[0]].get("premiered"))
        season = work_season(work)
        # 番組が始まる2年以上前の作品は、別の作品に結びついているとみなして使わない
        if premiered and season and season[0] < premiered[0] - 1:
            continue
        linked[work["annictId"]] = ids[0]
    return linked


def search_tvmaze(queries, cache_path):
    """題名ごとの TVmaze の検索結果（番組の要約）。cache_path があれば途中から続ける"""
    results = {}
    if cache_path and os.path.exists(cache_path):
        with open(cache_path, encoding="utf-8") as fp:
            results = json.load(fp)
    todo = [q for q in queries if q not in results]
    for n, query in enumerate(todo, 1):
        found = get_json(f"{TVMAZE_API}/search/shows?q={urllib.parse.quote(query)}") or []
        results[query] = [
            {"id": x["show"]["id"], "name": x["show"]["name"], "type": x["show"].get("type"),
             "language": x["show"].get("language"), "premiered": x["show"].get("premiered")}
            for x in found
        ]
        print(f"\rTVmaze の検索: {n}/{len(todo)}", end="", file=sys.stderr, flush=True)
        if cache_path and n % 50 == 0:
            with open(cache_path, "w", encoding="utf-8") as fp:
                json.dump(results, fp, ensure_ascii=False)
        time.sleep(TVMAZE_WAIT_SECONDS)
    if todo:
        print(file=sys.stderr)
    if cache_path:
        with open(cache_path, "w", encoding="utf-8") as fp:
            json.dump(results, fp, ensure_ascii=False)
    return results


def search_targets(works, linked, top):
    """2 で検索する作品（結びついていない、人気の上位のテレビ・Web 作品）"""
    return [w for w in works[:top] if w["annictId"] not in linked and w.get("media") in SEQUEL_MEDIA and work_season(w)]


def titles_of(work):
    return [t for t in dict.fromkeys([work.get("title"), work.get("titleEn")]) if t]


def link_by_search(targets, results, claimed):
    """2：検索で見つかった番組から、作品と同じ時期に始まった日本語のアニメを結びつける"""
    candidates, exact = {}, {}
    for work in targets:
        season = work_season(work)
        names = {fold(t) for t in titles_of(work)}
        shows = {}
        for title in titles_of(work):
            for show in results.get(title, []):
                if usable(show) and show["id"] not in claimed and season_of(show.get("premiered")) == season:
                    shows[show["id"]] = show
        # 候補が複数あるときは、作品の題名の後ろに副題を足した名前の番組（同じ時期のミニアニメなど）を外す
        if len(shows) > 1:
            main = {sid for sid, show in shows.items() if not any(fold(show["name"]) != n and fold(show["name"]).startswith(n) for n in names)}
            if main:
                shows = {sid: shows[sid] for sid in main}
        candidates[work["annictId"]] = set(shows)
        exact[work["annictId"]] = {sid for sid, show in shows.items() if fold(show["name"]) in names}
    linked = {}
    # 題名がぴったり合う番組を先に決める（ほかの作品もぴったり合う番組は決めない）
    exact_count = {}
    for ids in exact.values():
        for sid in ids:
            exact_count[sid] = exact_count.get(sid, 0) + 1
    for aid, ids in exact.items():
        if len(ids) == 1 and exact_count[next(iter(ids))] == 1:
            linked[aid] = next(iter(ids))
    # 残りは、候補が1つに絞れて、ほかのまだ決まっていない作品の候補にもならないときだけ
    changed = True
    while changed:
        changed = False
        taken = set(linked.values())
        left = {aid: ids - taken for aid, ids in candidates.items() if aid not in linked}
        count = {}
        for ids in left.values():
            for sid in ids:
                count[sid] = count.get(sid, 0) + 1
        for aid, ids in left.items():
            if len(ids) == 1 and count[next(iter(ids))] == 1:
                linked[aid] = next(iter(ids))
                changed = True
    return {aid: str(sid) for aid, sid in linked.items()}


def make_covers(works, linked, shows):
    """結びついた番組からポスターを選び、3（2期・3期）を足す"""
    covers = {}
    owned = set()  # すでに作品が結びついた（番組, 季）
    base_titles = {}  # 番組 → 結びついた作品の題名
    for work in works:
        sid = linked.get(work["annictId"])
        if not sid:
            continue
        show, season = shows[sid], work_season(work)
        owned.add((sid, season))
        base_titles.setdefault(sid, []).append(fold(work["title"]))
        path = poster_for(show, season)
        if path:
            covers[work["annictId"]] = path
    found = len(covers)

    series_shows = {}
    for work in works:
        sid = linked.get(work["annictId"])
        if sid:
            for node in (work.get("seriesList") or {}).get("nodes", []):
                series_shows.setdefault(node["annictId"], set()).add(sid)
    proposals = {}  # (番組, 季) → [(題名の頭が同じ文字数, 題名の長さ, 作品)]
    for work in works:
        season = work_season(work)
        if work["annictId"] in linked or work.get("media") not in SEQUEL_MEDIA or not season:
            continue
        candidates = set()
        for node in (work.get("seriesList") or {}).get("nodes", []):
            candidates |= series_shows.get(node["annictId"], set())
        hits = [sid for sid in candidates if any(season_of(s.get("premiereDate")) == season for s in shows[sid].get("seasons") or [])]
        if len(hits) != 1 or (hits[0], season) in owned:
            continue
        title = fold(work["title"])
        prefix = max((len(os.path.commonprefix([title, base])) for base in base_titles.get(hits[0], [])), default=0)
        proposals.setdefault((hits[0], season), []).append((prefix, len(title), work))
    for (sid, season), group in proposals.items():
        # 同じ季に複数の作品が並ぶとき（続編と同じ時期のミニアニメなど）は、題名がいちばん近い1作品だけにする
        group.sort(key=lambda g: (-g[0], g[1]))
        if len(group) > 1 and group[0][:2] == group[1][:2]:
            continue
        prefix, _, work = group[0]
        title = fold(work["title"])
        same_name = any(title.startswith(base) and SEQUEL_SUFFIX.match(title[len(base):]) for base in base_titles.get(sid, []))
        path = poster_for(shows[sid], season, season_only=not same_name)
        if path:
            covers[work["annictId"]] = path
    print(f"ポスター：{len(covers)}作品（番組に結びついた作品 {found}、2期・3期など {len(covers) - found}）", file=sys.stderr)
    return covers


def read_blocklist():
    """削除を頼まれた作品（Annict の作品 ID）。# から後ろはメモ"""
    if not os.path.exists(BLOCKLIST):
        return set()
    with open(BLOCKLIST, encoding="utf-8") as fp:
        return {int(line.split("#")[0]) for line in fp if line.split("#")[0].strip()}


def write_covers(path, covers, generated_at=None):
    today = datetime.date.today()
    data = {
        "source": "TVmaze (https://www.tvmaze.com)",
        "license": "CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/)",
        "generatedAt": generated_at or f"{today.year}年{today.month}月{today.day}日",
        "covers": {str(k): covers[k] for k in sorted(covers, key=int)},
    }
    with open(path, "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, separators=(",", ":"))
    print(f"{path} に書き出しました（{len(covers)}作品）", file=sys.stderr)


def remove(path, ids, note):
    """作品のポスターを covers.json から外し、作り直しても付かないよう covers_blocklist.txt に書く"""
    blocked = read_blocklist()
    today = datetime.date.today().isoformat()
    with open(BLOCKLIST, "a", encoding="utf-8") as fp:
        for work_id in ids:
            if work_id not in blocked:
                fp.write(f"{work_id}  # {today} {note}".rstrip() + "\n")
    with open(path, encoding="utf-8") as fp:
        data = json.load(fp)
    covers = {int(k): v for k, v in data["covers"].items() if int(k) not in set(ids)}
    write_covers(path, covers, data.get("generatedAt"))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "covers.json"))
    parser.add_argument("--cache", help="取ったデータを置くフォルダ（あれば続きから取る）")
    parser.add_argument("--search", type=int, default=SEARCH_TOP, help=f"TVmaze を検索する人気の上位の作品数（既定 {SEARCH_TOP}、0 で検索しない）")
    parser.add_argument("--remove", type=int, nargs="+", metavar="ID", help="この Annict の作品 ID のポスターを外す（作り直しても付かない）")
    parser.add_argument("--note", default="", help="--remove のときに残すメモ（例：権利者からの依頼 issue #3）")
    args = parser.parse_args()
    if args.remove:
        remove(args.out, args.remove, args.note)
        return
    cache = (lambda name: os.path.join(args.cache, name)) if args.cache else (lambda name: None)
    if args.cache:
        os.makedirs(args.cache, exist_ok=True)

    works = load_or(cache("annict_works.json"), fetch_annict_works)
    mal_to_tvmaze = load_or(cache("wikidata.json"), fetch_wikidata)
    wanted = sorted({ids[0] for w in works for ids in [mal_to_tvmaze.get(str(w.get("malAnimeId") or "").strip(), [])] if len(ids) == 1}, key=int)
    shows = fetch_tvmaze_shows(wanted, cache("tvmaze_shows.json"))
    linked = link_by_wikidata(works, mal_to_tvmaze, shows)
    print(f"Wikidata から：{len(linked)}作品", file=sys.stderr)
    if args.search:
        targets = search_targets(works, linked, args.search)
        results = search_tvmaze(list(dict.fromkeys(t for w in targets for t in titles_of(w))), cache("tvmaze_search.json"))
        found = link_by_search(targets, results, {int(sid) for sid in linked.values()})
        print(f"TVmaze の検索から：{len(found)}作品（{len(targets)}作品を検索）", file=sys.stderr)
        shows = fetch_tvmaze_shows(sorted(set(found.values()), key=int), cache("tvmaze_shows.json"), shows)
        linked.update(found)
    covers = make_covers(works, linked, shows)
    blocked = read_blocklist()
    covers = {k: v for k, v in covers.items() if k not in blocked}
    write_covers(args.out, covers)


if __name__ == "__main__":
    main()
