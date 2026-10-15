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
        nodes { channel { name } }
      }
    }
  }
}
""" % PAGE_SIZE


def post(query, variables):
    body = json.dumps({"query": query, "variables": variables}).encode()
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
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


def fetch_all_works():
    after = None
    page = 0
    while True:
        page += 1
        data = post(QUERY, {"after": after})["searchWorks"]
        nodes = data["nodes"]
        yield from nodes
        print(f"\r{page}ページ目まで取得", end="", file=sys.stderr, flush=True)
        if not data["pageInfo"]["hasNextPage"]:
            break
        after = data["pageInfo"]["endCursor"]
        time.sleep(WAIT_SECONDS)
    print(file=sys.stderr)


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


def build(works, out_path):
    entries = []
    for work in works:
        services = sorted({i for p in work["programs"]["nodes"] if (i := service_of(p["channel"]["name"])) is not None})
        if not services or not work.get("title"):
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
    print(f"{len(entries)}作品を {out_path} に書き出しました", file=sys.stderr)
    for name, count in per_service.items():
        print(f"  {name}: {count}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--discover", action="store_true", help="配信チャンネル名と作品数を表示するだけ")
    parser.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "catalog.json"))
    parser.add_argument("--limit", type=int, default=0, help="試しに先頭の何作品だけ取るか（0 = 全部）")
    args = parser.parse_args()

    works = []
    for work in fetch_all_works():
        works.append(work)
        if args.limit and len(works) >= args.limit:
            break

    if args.discover:
        discover(works)
    else:
        build(works, os.path.normpath(args.out))


if __name__ == "__main__":
    main()
