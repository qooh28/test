#!/usr/bin/env python3
"""TVmaze のポスターがない作品に使う、公式サイトの画像の一覧を official_images.json に書き出す。

使い方:
  python3 scripts/build_official_images.py                 # official_images.json を作る（covers.json を先に作っておく）
  python3 scripts/build_official_images.py --cache DIR     # 取ったデータを DIR に残し、次は続きから取る

画像は、Annict の作品データに記録された公式サイトの画像の URL。おすすめの画像（recommendedImageUrl）を先に、
それが空・読めない作品は公式サイトの og:image（facebookOgImageUrl）を使う。
アプリは画像を保存せず、公式サイトから直接読み込み、「出典：公式サイト」と権利者の表記を添えて出す。
画像の著作権は各作品の権利者にあり、利用の許諾を受けたものではない。権利者から削除を頼まれたら
build_covers.py --remove で covers_blocklist.txt に書く（この一覧からも外れる）。

http の URL は https に直して試し、実際に画像として読めたものだけを使う（古い公式サイトは消えていることが多い）。
同じ画像を多くの作品が持っているもの（サイト共通の画像）と、公式サイトと別のドメインにある画像は使わない。
"""

import argparse
import concurrent.futures
import datetime
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_catalog import fetch_works  # noqa: E402
from build_covers import load_or, read_blocklist  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
USER_AGENT = "Mozilla/5.0 (compatible; anime-log-images/1.0; +https://github.com/qooh28/test)"
CHECK_WAIT_SECONDS = 0.5  # 同じサイトの画像を続けて確かめるときの間
CHECK_SITES_AT_ONCE = 8  # 別々のサイトは、この数まで並べて確かめる
MAX_URL = 500
# 同じ画像の URL を持つ作品がこれより多いときは、サイト共通の画像（会社のロゴなど）とみなして使わない。
# ただし、その作品がみな Annict で同じシリーズなら、シリーズの公式サイトの画像として使う（例：1期・2期・劇場版）
MAX_SHARED = 3
# ファイル名がこれを含む画像も、会社のロゴや仮の画像とみなして使わない
GENERIC_NAME = re.compile(r"logo|default|noimage|no_image|favicon|dummy|screenshot|common", re.I)
# 画像は公式サイトと同じドメインにあるものだけを使う（Wikipedia の画像や、ドメインが切れて別のサイトになった画像を除くため）。
# 配信サービスの作品ページは、画像を別ドメインの画像用サーバーに置いているので、その組み合わせだけ認める
IMAGE_DOMAINS = {"netflix.com": {"nflxso.net"}, "disneyplus.com": {"disney-plus.net"}}
JP_SECOND_LEVEL = {"co", "ne", "or", "ac", "go", "ed", "gr", "lg", "ad"}
# 画像の URL を探す欄（使う順）。recommendedImageUrl が空で og:image だけが入っている作品も多い
IMAGE_FIELDS = ("recommendedImageUrl", "facebookOgImageUrl")

WORK_FIELDS = "annictId media seasonYear officialSiteUrl image { recommendedImageUrl facebookOgImageUrl copyright } seriesList { nodes { annictId } }"


def fetch_annict_images():
    return fetch_works(WORK_FIELDS)


def same_series(works):
    """作品がみな Annict の同じシリーズに入っているか"""
    common = None
    for work in works:
        series = {s["annictId"] for s in (work.get("seriesList") or {}).get("nodes") or []}
        common = series if common is None else common & series
        if not common:
            return False
    return True


def movies_of_other_years(works):
    """公開年の違う劇場版が同じ画像を持っているか。毎年の映画で同じ公式サイトを使い、画像が最新作のものに
    なっていることがある（例：名探偵コナン、おしりたんてい）ので、そういう画像は劇場版には使わない"""
    return len({work.get("seasonYear") for work in works if work.get("media") == "MOVIE"}) > 1


def is_image(url):
    """画像として読めるか（リファラーなしで。まず HEAD、だめなら先頭だけ GET）"""
    for method, headers in (("HEAD", {}), ("GET", {"Range": "bytes=0-1023"})):
        req = urllib.request.Request(url, method=method, headers={"User-Agent": USER_AGENT, "Accept": "image/*", **headers})
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                if res.status in (200, 206) and res.headers.get_content_type().startswith("image/"):
                    return True
        except (urllib.error.URLError, TimeoutError, ValueError, OSError):
            pass
    return False


def check_images(candidates, cache_path):
    """URL ごとに、画像として読めたかを調べる。サイトごとに順番に、別々のサイトは並べて調べる。
    cache_path があれば途中から続ける"""
    checked = {}
    if cache_path and os.path.exists(cache_path):
        with open(cache_path, encoding="utf-8") as fp:
            checked = json.load(fp)
    todo = [url for url in candidates if url not in checked]
    by_host = {}
    for url in todo:
        by_host.setdefault(urllib.parse.urlsplit(url).netloc, []).append(url)
    lock = threading.Lock()
    done = [0]

    def check_host(urls):
        for url in urls:
            ok = is_image(url)
            with lock:
                checked[url] = ok
                done[0] += 1
                print(f"\r画像を確かめています: {done[0]}/{len(todo)}", end="", file=sys.stderr, flush=True)
                if cache_path and done[0] % 50 == 0:
                    with open(cache_path, "w", encoding="utf-8") as fp:
                        json.dump(checked, fp)
            time.sleep(CHECK_WAIT_SECONDS)

    with concurrent.futures.ThreadPoolExecutor(max_workers=CHECK_SITES_AT_ONCE) as pool:
        list(pool.map(check_host, by_host.values()))
    if todo:
        print(file=sys.stderr)
    if cache_path:
        with open(cache_path, "w", encoding="utf-8") as fp:
            json.dump(checked, fp)
    return checked


def domain_of(url):
    """URL の登録ドメイン（例：www.tv-tokyo.co.jp → tv-tokyo.co.jp、shingeki.tv → shingeki.tv）"""
    labels = (urllib.parse.urlsplit(url).hostname or "").lower().split(".")
    keep = 3 if len(labels) >= 3 and labels[-1] == "jp" and labels[-2] in JP_SECOND_LEVEL else 2
    return ".".join(labels[-keep:])


def same_site(image_url, site_url):
    """画像が作品の公式サイトのものか。ドメインが同じで、同じホストなら作品のページのフォルダの中にあること
    （例：ページが vap.co.jp/hxh-movie/ なのに画像が vap.co.jp/assets/… なら会社共通の画像とみなす）"""
    image, site = domain_of(image_url), domain_of(site_url or "")
    if not site or not (image == site or image in IMAGE_DOMAINS.get(site, set())):
        return False
    host = lambda url: (urllib.parse.urlsplit(url).hostname or "").lower().removeprefix("www.")
    if host(image_url) != host(site_url):
        return True
    folders = [part for part in urllib.parse.urlsplit(site_url).path.split("/")[:-1] if part][:2]
    return urllib.parse.urlsplit(image_url).path.startswith("/" + "/".join(folders) + "/" if folders else "/")


def https_url(url):
    """https の URL にして返す（http は https に直す。読めるかは後で確かめる）。使えない URL なら None"""
    if not url or len(url) > MAX_URL:
        return None
    url = url.strip()
    if url.startswith("http://"):
        url = "https://" + url[len("http://"):]
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:  # 例：http://[directory]/… のような壊れた URL
        return None
    return parts.geturl() if parts.scheme == "https" and parts.netloc else None


def image_candidates(work):
    """作品の公式サイトの画像の URL の候補（使う順）"""
    image = work.get("image") or {}
    urls = []
    for field in IMAGE_FIELDS:
        url = https_url(image.get(field))
        if url and url not in urls and same_site(url, work.get("officialSiteUrl")):
            urls.append(url)
    return urls


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default=os.path.join(ROOT, "official_images.json"))
    parser.add_argument("--covers", default=os.path.join(ROOT, "covers.json"), help="TVmaze のポスターの一覧（ここにある作品には付けない）")
    parser.add_argument("--cache", help="取ったデータを置くフォルダ（あれば続きから取る）")
    args = parser.parse_args()
    cache = (lambda name: os.path.join(args.cache, name)) if args.cache else (lambda name: None)
    if args.cache:
        os.makedirs(args.cache, exist_ok=True)

    works = load_or(cache("annict_work_images.json"), fetch_annict_images)
    with open(args.covers, encoding="utf-8") as fp:
        covered = {int(k) for k in json.load(fp)["covers"]}
    blocked = read_blocklist()
    wanted = {}
    for work in works:
        urls = image_candidates(work)
        if urls and work["annictId"] not in covered and work["annictId"] not in blocked:
            wanted[work["annictId"]] = (urls, work)
    shared = {}
    for urls, work in wanted.values():
        for url in urls:
            shared.setdefault(url, []).append(work)
    generic = {
        url for url, sharing in shared.items()
        if (len(sharing) > MAX_SHARED and not same_series(sharing)) or GENERIC_NAME.search(urllib.parse.urlsplit(url).path.rsplit("/", 1)[-1])
    }
    other_movies = {url for url, sharing in shared.items() if movies_of_other_years(sharing)}
    wanted = {
        k: ([url for url in urls if url not in generic and not (work.get("media") == "MOVIE" and url in other_movies)], work)
        for k, (urls, work) in wanted.items()
    }
    wanted = {k: v for k, v in wanted.items() if v[0]}
    checked = check_images(list(dict.fromkeys(url for urls, _ in wanted.values() for url in urls)), cache("official_image_checks.json"))

    images = {}
    for work_id, (urls, work) in wanted.items():
        url = next((url for url in urls if checked.get(url)), None)
        if not url:
            continue
        entry = {"u": url}
        copyright_text = " ".join(((work.get("image") or {}).get("copyright") or "").split())[:200]
        if copyright_text:
            entry["c"] = copyright_text
        site = (work.get("officialSiteUrl") or "").strip()  # 出典のリンク先（http のままのサイトもある）
        if site.startswith(("https://", "http://")) and len(site) <= MAX_URL:
            entry["s"] = site
        images[str(work_id)] = entry

    today = datetime.date.today()
    data = {
        "source": "各作品の公式サイト（Annict の作品データに記録された画像の URL）",
        "note": "画像の著作権は各作品の権利者に帰属します。アプリは画像を保存せず、公式サイトから直接読み込みます。",
        "generatedAt": f"{today.year}年{today.month}月{today.day}日",
        "images": {k: images[k] for k in sorted(images, key=int)},
    }
    with open(args.out, "w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, separators=(",", ":"))
    print(f"公式サイトの画像：{len(images)}作品（候補 {len(wanted)}、読めなかった {len(wanted) - len(images)}、サイト共通の画像 {len(generic)}種類は除外）", file=sys.stderr)
    print(f"{args.out} に書き出しました", file=sys.stderr)


if __name__ == "__main__":
    main()
