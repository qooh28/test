#!/usr/bin/env python3
"""Annict から「配信サービスで見られる作品」の一覧を作り、catalog.json に書き出す。

使い方:
  python3 scripts/build_catalog.py             # catalog.json を作る
  python3 scripts/build_catalog.py --discover  # 配信チャンネル名と作品数を表示するだけ

Annict のアクセストークンは、環境変数 ANNICT_TOKEN か、
Claude Code の環境の Network secrets（api.annict.com 宛ての Authorization ヘッダー）で渡す。
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
import urllib.request

API = "https://api.annict.com/graphql"
PAGE_SIZE = 50
WAIT_SECONDS = 1.0  # Annict に負担をかけないよう、1回ごとに少し待つ

# 配信サービス（アプリでの ID, 表示名, Annict のチャンネル名に合う正規表現）。上から順に判定する
SERVICES = [
    ("unext", "U-NEXT", r"^u-?next"),
    ("netflix", "Netflix", r"^netflix"),
    ("danime", "dアニメストア", r"^dアニメストア$"),
    ("prime", "Prime Video", r"^(amazon ?)?(prime ?video|プライム・?ビデオ)"),
    ("abema", "ABEMA", r"^abema"),
    ("dmm", "DMM TV", r"^dmm ?tv"),
    ("hulu", "Hulu", r"^hulu"),
    ("disney", "Disney+", r"^(disney ?\+|disney ?plus|ディズニー ?プラス|ディズニー\+)"),
    ("lemino", "Lemino", r"^(lemino|dtv)$"),
    ("fod", "FOD", r"^fod"),
    ("telasa", "TELASA", r"^(telasa|ビデオパス)"),
    ("bandai", "バンダイチャンネル", r"^バンダイチャンネル"),
    ("animehodai", "アニメ放題", r"^アニメ放題"),
    ("niconico", "ニコニコ", r"^(niconico|ニコニコ)"),
]

MEDIA = {"TV": "tv", "MOVIE": "movie", "OVA": "ova", "WEB": "web", "OTHER": "other"}
SEASON = {"WINTER": "winter", "SPRING": "spring", "SUMMER": "summer", "AUTUMN": "fall"}

QUERY = """
query ($after: String) {
  searchWorks(orderBy: { field: WATCHERS_COUNT, direction: DESC }, first: %d, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      annictId
      title
      titleKana
      titleEn
      media
      seasonName
      seasonYear
      episodesCount
      watchersCount
      programs(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes { channel { name } }
      }
    }
  }
}
""" % PAGE_SIZE

# 放送局が多い長寿作品は、配信チャンネルが2ページ目以降に入ることがあるので続きを取る
MORE_PROGRAMS_QUERY = """
query ($ids: [Int!], $after: String) {
  searchWorks(annictIds: $ids, first: 1) {
    nodes {
      programs(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { channel { name } }
      }
    }
  }
}
"""


def post(query, variables):
    body = json.dumps({"query": query, "variables": variables}).encode()
    # 既定の User-Agent（Python-urllib）だと Annict 側で拒否される
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "anime-log-catalog/1.0 (+https://github.com/qooh28/test)",
    }
    token = os.environ.get("ANNICT_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    for attempt in range(5):
        req = urllib.request.Request(API, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                data = json.load(res)
        except urllib.error.HTTPError as err:
            if err.code == 401:
                sys.exit("Annict に認証されませんでした。トークンの設定を確認してください。")
            if err.code in (429, 500, 502, 503, 504) and attempt < 4:
                time.sleep(5 * (attempt + 1))
                continue
            raise
        if data.get("errors"):
            sys.exit(f"Annict がエラーを返しました: {json.dumps(data['errors'], ensure_ascii=False)}")
        return data["data"]
    raise RuntimeError("Annict への問い合わせが続けて失敗しました")


def complete_programs(work):
    programs = work["programs"]
    while programs["pageInfo"]["hasNextPage"]:
        time.sleep(WAIT_SECONDS)
        data = post(MORE_PROGRAMS_QUERY, {"ids": [work["annictId"]], "after": programs["pageInfo"]["endCursor"]})
        more = data["searchWorks"]["nodes"][0]["programs"]
        programs["nodes"].extend(more["nodes"])
        programs["pageInfo"] = more["pageInfo"]


def fetch_all_works(cache_path=None, limit=0):
    """全作品を人気順に取る。cache_path を渡すと1ページごとに保存し、途中で止まっても続きから再開する。"""
    works = []
    after = None
    done = False
    if cache_path and os.path.exists(cache_path):
        with open(cache_path, encoding="utf-8") as fp:
            for line in fp:
                page = json.loads(line)
                works.extend(page["nodes"])
                after, done = page["next"], not page["hasNext"]
        print(f"保存済みの{len(works)}作品から再開します", file=sys.stderr)

    page_no = 0
    while not done and not (limit and len(works) >= limit):
        page_no += 1
        data = post(QUERY, {"after": after})["searchWorks"]
        for work in data["nodes"]:
            complete_programs(work)
        works.extend(data["nodes"])
        after, done = data["pageInfo"]["endCursor"], not data["pageInfo"]["hasNextPage"]
        if cache_path:
            with open(cache_path, "a", encoding="utf-8") as fp:
                fp.write(json.dumps({"next": after, "hasNext": not done, "nodes": data["nodes"]}, ensure_ascii=False) + "\n")
        print(f"\r{len(works)}作品まで取得", end="", file=sys.stderr, flush=True)
        time.sleep(WAIT_SECONDS)
    print(file=sys.stderr)
    return works[:limit] if limit else works


def norm(name):
    return unicodedata.normalize("NFKC", name).strip().lower()


def service_of(channel_name):
    name = norm(channel_name)
    for index, (_, _, pattern) in enumerate(SERVICES):
        if re.search(pattern, name):
            return index
    return None


def discover(works):
    counts = {}
    for work in works:
        for program in work["programs"]["nodes"]:
            name = program["channel"]["name"]
            counts[name] = counts.get(name, 0) + 1
    for name, count in sorted(counts.items(), key=lambda kv: -kv[1]):
        index = service_of(name)
        label = SERVICES[index][1] if index is not None else "-"
        print(f"{count:6d}  {label:14s}  {name}")


def build(works, out_path, all_works=False):
    entries = []
    for work in works:
        services = sorted({i for p in work["programs"]["nodes"] if (i := service_of(p["channel"]["name"])) is not None})
        if not work.get("title") or (not services and not all_works):
            continue
        entry = {"id": work["annictId"], "t": work["title"].strip()}
        if work.get("titleKana"):
            entry["k"] = work["titleKana"].strip()
        if work.get("titleEn"):
            entry["e"] = work["titleEn"].strip()
        if work.get("seasonYear"):
            entry["y"] = work["seasonYear"]
        if work.get("seasonName") in SEASON:
            entry["c"] = SEASON[work["seasonName"]]
        episodes = work.get("episodesCount") or 0
        if work.get("media") == "MOVIE" and not episodes:
            episodes = 1
        if episodes:
            entry["n"] = episodes
        if work.get("media") in MEDIA:
            entry["m"] = MEDIA[work["media"]]
        entry["s"] = services
        entry["p"] = work.get("watchersCount") or 0
        entries.append(entry)

    today = datetime.date.today()
    catalog = {
        "source": "Annict (https://annict.com)",
        "generatedAt": f"{today.year}年{today.month}月{today.day}日",
        "services": [{"id": sid, "name": name} for sid, name, _ in SERVICES],
        "works": entries,
    }
    with open(out_path, "w", encoding="utf-8") as fp:
        json.dump(catalog, fp, ensure_ascii=False, separators=(",", ":"))
    per_service = {name: 0 for _, name, _ in SERVICES}
    for entry in entries:
        for i in entry["s"]:
            per_service[SERVICES[i][1]] += 1
    with_service = sum(1 for entry in entries if entry["s"])
    print(f"{len(entries)}作品（うち配信サービスの記録あり {with_service}作品）を {out_path} に書き出しました", file=sys.stderr)
    for name, count in per_service.items():
        print(f"  {name}: {count}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--discover", action="store_true", help="配信チャンネル名と作品数を表示するだけ")
    parser.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "catalog.json"))
    parser.add_argument("--limit", type=int, default=0, help="試しに先頭の何作品だけ取るか（0 = 全部）")
    parser.add_argument("--cache", help="取得した生データを保存するファイル（JSON Lines）。あれば続きから再開する")
    parser.add_argument("--all-works", action="store_true", help="配信サービスの記録がない作品も入れる（タイトル検索用）")
    args = parser.parse_args()

    works = fetch_all_works(args.cache, args.limit)

    if args.discover:
        discover(works)
    else:
        build(works, os.path.normpath(args.out), args.all_works)


if __name__ == "__main__":
    main()
