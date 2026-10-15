#!/usr/bin/env python3
"""Annict からアニメ作品の一覧を作り、catalog.json に書き出す。

使い方:
  python3 scripts/build_catalog.py             # Annict の全作品（タイトル検索用、配信サービスなし）
  python3 scripts/build_catalog.py --services  # 配信サービスの記録がある作品だけ、サービス付きで
  python3 scripts/build_catalog.py --discover  # Annict にある配信チャンネルを表示するだけ
  python3 scripts/build_catalog.py --update-readings  # 今の catalog.json の読み（タイトル順用）だけ作り直す

どの作品にも、タイトル順に使う読み（ひらがな）を付ける（scripts/readings.py）。
必要なもの: pip install pykakasi alkana

--services のしくみ:
  1. 人気の作品を順に見て、配信サービス（チャンネル）の一覧を集める
  2. 配信サービスごとに、そこで配信された作品（Annict の「番組」）を全部たどる
  3. 作品ごとに、配信されたサービスをまとめて catalog.json に書く
  Annict の配信の記録は新作に偏っていて、主要作品でも抜けが多いので、今は使っていない。

Annict のアクセストークンは、環境変数 ANNICT_TOKEN か、
Claude Code の環境の Network secrets（api.annict.com 宛ての Authorization ヘッダー）で渡す。
"""

import argparse
import base64
import datetime
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request

from readings import Readings

API = "https://api.annict.com/graphql"
WAIT_SECONDS = 0.3  # Annict に負担をかけないよう、1回ごとに少し待つ
SCAN_PAGES = 120  # 配信チャンネルを探すときに見る作品数（×50）

# 配信サービス（アプリでの ID, 表示名, Annict のチャンネル名に合う正規表現）。上から順に判定し、この順でアプリに並ぶ。
# 無料の動画サイト（YouTube、ニコニコ生放送）と海外向け（Crunchyroll）は入れない。
SERVICES = [
    ("unext", "U-NEXT", r"^u-?next"),
    ("netflix", "Netflix", r"^netflix"),
    ("prime", "Prime Video", r"^(amazon ?)?(prime ?video|プライム・?ビデオ)"),
    ("danime", "dアニメストア", r"^dアニメストア$"),
    ("abema", "ABEMA", r"^abema"),
    ("dmm", "DMM TV", r"^dmm ?tv"),
    ("hulu", "Hulu", r"^hulu"),
    ("disney", "Disney+", r"^(disney ?\+|disney ?plus|ディズニー ?プラス|ディズニー\+)"),
    ("fod", "FOD", r"^fod"),
    ("lemino", "Lemino", r"^(lemino|dtv)$"),
    ("telasa", "TELASA", r"^(telasa|ビデオパス)"),
    ("bandai", "バンダイチャンネル", r"^バンダイチャンネル"),
    ("animehodai", "アニメ放題", r"^アニメ放題"),
    ("danimenico", "dアニメ ニコニコ支店", r"^dアニメストア ?ニコニコ支店"),
    ("nicoch", "ニコニコチャンネル", r"^ニコニコチャンネル"),
]
STREAMING_GROUPS = {"動画サービス", "ABEMA"}

MEDIA = {"TV": "tv", "MOVIE": "movie", "OVA": "ova", "WEB": "web", "OTHER": "other"}
SEASON = {"WINTER": "winter", "SPRING": "spring", "SUMMER": "summer", "AUTUMN": "fall"}

WORK_FIELDS = "annictId title titleKana titleEn media seasonName seasonYear episodesCount watchersCount"

ALL_WORKS_QUERY = """
query ($after: String) {
  searchWorks(orderBy: { field: WATCHERS_COUNT, direction: DESC }, first: 200, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { %s }
  }
}
""" % WORK_FIELDS

SCAN_QUERY = """
query ($after: String) {
  searchWorks(orderBy: { field: WATCHERS_COUNT, direction: DESC }, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      annictId
      programs(first: 100) { nodes { channel { annictId name channelGroup { name } } } }
    }
  }
}
"""

# Annict にはチャンネルを直接引く入口がないので、そのチャンネルの番組を持つ作品からたどる
CHANNEL_QUERY = """
query ($work: Int!, $at: String, $after: String) {
  searchWorks(annictIds: [$work]) {
    nodes {
      programs(first: 1, after: $at) {
        nodes {
          channel {
            annictId
            name
            programs(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                work {
                  annictId title titleKana titleEn media seasonName seasonYear episodesCount watchersCount
                }
              }
            }
          }
        }
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


def offset_cursor(n):
    # Annict の番組一覧のカーソルは「何件目か」を base64 にしたもの
    return base64.b64encode(str(n).encode()).decode() if n else None


def service_of(channel_name):
    name = unicodedata.normalize("NFKC", channel_name).strip().lower()
    for index, (_, _, pattern) in enumerate(SERVICES):
        if re.search(pattern, name):
            return index
    return None


def discover_channels():
    """人気作品の番組から配信チャンネルを集める。チャンネルごとに、たどる入口（作品 ID, 番組の位置）も覚える。"""
    channels = {}
    after = None
    for page in range(SCAN_PAGES):
        data = post(SCAN_QUERY, {"after": after})["searchWorks"]
        for work in data["nodes"]:
            for index, program in enumerate(work["programs"]["nodes"]):
                channel = program["channel"]
                if channel["channelGroup"]["name"] not in STREAMING_GROUPS:
                    continue
                entry = channels.setdefault(channel["annictId"], {"name": channel["name"], "ref": (work["annictId"], index), "seen": 0})
                entry["seen"] += 1
        print(f"\r配信チャンネルを探しています（{(page + 1) * 50}作品）", end="", file=sys.stderr, flush=True)
        if not data["pageInfo"]["hasNextPage"]:
            break
        after = data["pageInfo"]["endCursor"]
        time.sleep(WAIT_SECONDS)
    print(file=sys.stderr)
    return channels


def fetch_channel_works(ref):
    work_id, index = ref
    works = {}
    offset = 0
    while True:
        data = post(CHANNEL_QUERY, {"work": work_id, "at": offset_cursor(index), "after": offset_cursor(offset)})
        programs = data["searchWorks"]["nodes"][0]["programs"]["nodes"][0]["channel"]["programs"]
        for program in programs["nodes"]:
            if program and program.get("work"):
                works[program["work"]["annictId"]] = program["work"]
        offset += len(programs["nodes"])
        if not programs["pageInfo"]["hasNextPage"] or not programs["nodes"]:
            return list(works.values())
        time.sleep(WAIT_SECONDS)


def fetch_all_works():
    works = []
    after = None
    while True:
        data = post(ALL_WORKS_QUERY, {"after": after})["searchWorks"]
        works.extend(data["nodes"])
        print(f"\r{len(works)}作品まで取得", end="", file=sys.stderr, flush=True)
        if not data["pageInfo"]["hasNextPage"]:
            break
        after = data["pageInfo"]["endCursor"]
        time.sleep(WAIT_SECONDS)
    print(file=sys.stderr)
    return works


def to_entry(work, services):
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
    if services:
        entry["s"] = sorted(services)
    entry["p"] = work.get("watchersCount") or 0
    return entry


def add_readings(entries):
    """タイトル順に使う読み（ひらがな）を全作品に付ける。Annict の読みがなは整え、ないものは作る。"""
    readings = Readings((e["t"], e.get("k")) for e in entries)
    for entry in entries:
        reading = readings.reading(entry["t"], entry.get("k"))
        if reading:
            entry["k"] = reading
        else:
            entry.pop("k", None)


def write_catalog(entries, services, out_path, generated_at=None):
    add_readings(entries)
    entries.sort(key=lambda e: -e["p"])
    today = datetime.date.today()
    catalog = {
        "source": "Annict (https://annict.com)",
        "generatedAt": generated_at or f"{today.year}年{today.month}月{today.day}日",
        "services": services,
        "works": entries,
    }
    with open(out_path, "w", encoding="utf-8") as fp:
        json.dump(catalog, fp, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(entries)}作品を {out_path} に書き出しました", file=sys.stderr)


def build_titles(out_path):
    entries = [to_entry(w, ()) for w in fetch_all_works() if (w.get("title") or "").strip()]
    write_catalog(entries, [], out_path)


def build(channels, out_path):
    works = {}
    services = {}
    targets = [(cid, c) for cid, c in channels.items() if service_of(c["name"]) is not None]
    for number, (cid, channel) in enumerate(targets, 1):
        index = service_of(channel["name"])
        found = fetch_channel_works(channel["ref"])
        print(f"[{number}/{len(targets)}] {channel['name']}: {len(found)}作品", file=sys.stderr)
        for work in found:
            if not (work.get("title") or "").strip():
                continue
            works[work["annictId"]] = work
            services.setdefault(work["annictId"], set()).add(index)

    entries = [to_entry(works[wid], services[wid]) for wid in works]
    write_catalog(entries, [{"id": sid, "name": name} for sid, name, _ in SERVICES], out_path)
    for index, (_, name, _) in enumerate(SERVICES):
        count = sum(1 for e in entries if index in e["s"])
        if count:
            print(f"  {name}: {count}", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--services", action="store_true", help="配信サービスの記録がある作品だけを、サービス付きで書き出す")
    parser.add_argument("--discover", action="store_true", help="Annict にある配信チャンネルを表示するだけ")
    parser.add_argument("--update-readings", action="store_true", help="Annict に問い合わせず、今の catalog.json の読みだけ作り直す")
    parser.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "catalog.json"))
    args = parser.parse_args()
    out_path = os.path.normpath(args.out)

    if args.update_readings:
        with open(out_path, encoding="utf-8") as fp:
            current = json.load(fp)
        write_catalog(current["works"], current["services"], out_path, current.get("generatedAt"))
        return

    if not args.services and not args.discover:
        build_titles(out_path)
        return

    channels = discover_channels()
    if args.discover:
        for cid, c in sorted(channels.items(), key=lambda kv: -kv[1]["seen"]):
            index = service_of(c["name"])
            label = SERVICES[index][1] if index is not None else "（入れない）"
            print(f"{cid:5d}  {label:18s}  {c['name']}")
        return
    build(channels, out_path)


if __name__ == "__main__":
    main()
