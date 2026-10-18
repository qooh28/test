/* アニメ視聴記録 — 記録はこの端末の localStorage に保存する */
(() => {
  'use strict';

  const STORE_KEY = 'anime-log:v1';
  const PREFS_KEY = 'anime-log:prefs';
  const PROFILE_KEY = 'anime-log:profile'; // アカウント（名前と写真）。今はこの端末の中だけ
  const AVATAR_SIZE = 256; // 写真は正方形に切り抜いて、この大きさ（px）の JPEG にして保存する
  const AVATAR_DATA = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
  const AVATAR_MAX = 400000; // 保存する写真の上限（文字数）。256px の JPEG なら 20〜60KB ほど
  const NAME_MAX = 30;
  const CATALOG_URL = 'catalog.json'; // 配信サービスで見られる作品の一覧（scripts/build_catalog.py で作る）
  // ポスター画像（TVmaze）。covers.json は Annict の作品 ID → TVmaze の画像のパス（scripts/build_covers.py で作る）
  const COVERS_URL = 'covers.json';
  const COVER_BASE = 'https://static.tvmaze.com/uploads/images/medium_portrait/';
  const COVER_PATH = /^\d{1,6}\/\d{1,12}\.(?:jpe?g|png)$/;
  const TILE_COLORS = 12; // ジャケット風の四角の色の数（style.css の .c0〜.c11）
  const FIND_PAGE = 60; // 「作品をさがす」で一度に並べる件数
  const SUGGEST_LIMIT = 6;

  const STATUS = { want: '見たい', watching: '視聴中', done: '見終わった', dropped: '中断' };
  const COUR = { winter: '冬', spring: '春', summer: '夏', fall: '秋' };
  const COUR_RANK = { winter: 1, spring: 2, summer: 3, fall: 4 };
  const MEDIA = { tv: 'TV', movie: '劇場版', ova: 'OVA', web: '配信', other: 'その他' };
  const TABS = ['all', 'watching', 'want', 'done', 'dropped'];
  const MODES = { mine: 'ライブラリ', find: '検索', account: 'アカウント' };

  // ランク（下から順）。episodes = 見た話数（記録した作品の「見た話数」の合計）、
  // works = 作品数（「見終わった」作品だけ）。両方を満たすと、そのランクになる。サンプルは数えない。
  // secret のランクは、達成条件を画面に出さない。名前も、そのランクになるまでは「？？？」にする。色は style.css の --rank-<id>
  const RANKS = [
    { id: 'normal', name: 'ノーマル', episodes: 0 },
    { id: 'rookie', name: 'ルーキー', episodes: 100 },
    { id: 'amateur', name: 'アマチュア', episodes: 300 },
    { id: 'veteran', name: 'ベテラン', episodes: 500 },
    { id: 'bronze', name: 'ブロンズ', episodes: 1000 },
    { id: 'silver', name: 'シルバー', episodes: 2000 },
    { id: 'gold', name: 'ゴールド', episodes: 3000 },
    { id: 'platinum', name: 'プラチナ', episodes: 4000 },
    { id: 'diamond', name: 'ダイアモンド', episodes: 5000 },
    { id: 'mithril', name: 'ミスリル', episodes: 7000, works: 300, secret: true },
    { id: 'orichalcum', name: 'オリハルコン', episodes: 10000, works: 500, secret: true },
  ];
  const RANKED_STATUS = ['done']; // 作品数に数える状態（見終わった作品だけ）

  const collator = new Intl.Collator('ja');
  const SORTS = {
    updated: (a, b) => b.updatedAt - a.updatedAt,
    season: (a, b) => seasonRank(b) - seasonRank(a) || b.updatedAt - a.updatedAt,
    rating: (a, b) => b.rating - a.rating || b.updatedAt - a.updatedAt,
    title: (a, b) => compareReading(readingKey(a.kana || a.title), readingKey(b.kana || b.title)),
  };
  // 作品一覧は人気順で読み込むので、人気順は並べ替え不要。評価順は自分の記録の星を使うので renderFind で並べる
  const FIND_SORTS = {
    popular: null,
    rating: null,
    season: (a, b) => seasonRank(b) - seasonRank(a) || b.popularity - a.popularity,
    // 作品一覧の読みは、作るときにひらがなだけに整えてある（scripts/readings.py）
    title: (a, b) => compareReading(a.kana || readingKey(a.title), b.kana || readingKey(b.title)),
  };

  // タイトル順の比べ方：読み（ひらがな）のあいうえお順。
  // 読みが分からない作品（作品一覧にない題名を手で入力し、漢字や英字で始まるもの）は最後にまとめる
  const startsWithKana = (s) => /^[ぁ-ゖ]/.test(s);
  function compareReading(a, b) {
    return (startsWithKana(b) - startsWithKana(a)) || collator.compare(a, b);
  }

  // 読みの比べる部分：括弧・記号・空白は読まず、カタカナはひらがなにそろえる
  function readingKey(text) {
    return String(text)
      .normalize('NFKC')
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
      .replace(/[^\p{L}\p{N}]/gu, '');
  }

  // サンプルの読み（作品一覧の題名と一致しないものがあるので、ここで持つ）
  const SAMPLE_KANA = {
    '葬送のフリーレン': 'そうそうのふりーれん',
    'ダンジョン飯': 'だんじょんめし',
    'ぼっち・ざ・ろっく！': 'ぼっちざろっく',
    '薬屋のひとりごと': 'くすりやのひとりごと',
    'ONE PIECE': 'わんぴーす',
  };
  const $ = (id) => document.getElementById(id);
  const els = {
    pageTitle: $('page-title'),
    summary: $('summary'),
    modes: $('modes'),
    search: $('search'),
    tabbar: document.querySelector('.tabbar'),
    tabs: $('tabs'),
    serviceTabs: $('service-tabs'),
    mineView: $('mine-view'),
    findView: $('find-view'),
    storageWarn: $('storage-warn'),
    sampleNote: $('sample-note'),
    toolbar: $('toolbar'),
    resultCount: $('result-count'),
    sort: $('sort'),
    list: $('list'),
    empty: $('empty'),
    emptyTitle: $('empty-title'),
    emptyBody: $('empty-body'),
    emptyAdd: $('empty-add'),
    findToolbar: $('find-toolbar'),
    findSort: $('find-sort'),
    works: $('works'),
    findMore: $('find-more'),
    findEmpty: $('find-empty'),
    findEmptyTitle: $('find-empty-title'),
    findEmptyBody: $('find-empty-body'),
    findRetry: $('find-retry'),
    catalogDate: $('catalog-date'),
    fab: $('add'),
    toast: $('toast'),
    toastMsg: $('toast-msg'),
    toastAction: $('toast-action'),
    editor: $('editor'),
    editorTitle: $('editor-title'),
    editorBody: $('editor-body'),
    form: $('editor-form'),
    titleError: $('f-title-error'),
    suggest: $('suggest'),
    ratingText: $('rating-text'),
    delete: $('delete'),
    footMain: $('foot-main'),
    footConfirm: $('foot-confirm'),
    confirmText: $('confirm-text'),
    menu: $('menu'),
    menuSamples: $('menu-samples'),
    importFile: $('import-file'),
    searchBox: document.querySelector('.search'),
    avatarBtn: $('avatar-btn'),
    navAvatar: $('nav-avatar'),
    accountView: $('account-view'),
    heroAvatar: $('hero-avatar'),
    profileName: $('profile-name'),
    profileMeta: $('profile-meta'),
    editProfile: $('edit-profile'),
    rankCard: $('rank-card'),
    rankTitle: $('rank-title'),
    rankEpisodes: $('rank-episodes'),
    rankBar: $('rank-bar'),
    rankNext: $('rank-next'),
    rankInfo: $('rank-info'),
    rankInfoBtn: $('rank-info-btn'),
    rankList: $('rank-list'),
    rankSampleHint: $('rank-sample-hint'),
    stats: $('stats'),
    profileEditor: $('profile-editor'),
    profileForm: $('profile-form'),
    pAvatar: $('p-avatar'),
    pPhoto: $('p-photo'),
    pPhotoRemove: $('p-photo-remove'),
    pPhotoError: $('p-photo-error'),
    pName: $('p-name'),
  };
  const f = {
    title: $('f-title'),
    watched: $('f-watched'),
    total: $('f-total'),
    season: $('f-season'),
    note: $('f-note'),
  };

  const state = {
    mode: 'mine', // mine = ライブラリ, find = 検索, account = アカウント
    items: [],
    profile: null, // { name, avatar, createdAt, updatedAt }
    draftAvatar: '', // プロフィール編集中の写真（保存するまで反映しない）
    tab: 'all',
    query: '',
    sort: 'updated',
    order: [], // 表示中の並び。＋1話を押しても並びが動かないように保持する
    editingId: null,
    rating: 0,
    picked: null, // 入力候補や「作品をさがす」から選んだ作品 { id, title }
    season: null, // 登録画面の放送時期 { year, cour }。選んだ作品から入る（手では選ばない）
    baseSeason: null, // 選んだ作品をやめたときに戻す放送時期（編集中の作品のもの）
    find: { query: '', service: 'all', sort: 'popular', limit: FIND_PAGE },
  };

  const catalog = {
    status: 'idle', // idle | loading | ready | missing | error
    services: [], // [{ id, name, count }]
    serviceNames: new Map(),
    works: [], // 人気順
    byId: new Map(),
    byTitle: new Map(),
    generatedAt: '',
  };
  const covers = new Map(); // Annict の作品 ID → TVmaze の画像のパス

  /* ---------- helpers ---------- */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  // 中身が変わったときだけ入れ替える。画面を切り替えるたびに作り直すと、
  // ポスターや写真が読み込み直しになり、一瞬ちらつくため
  const shownHTML = new WeakMap();
  function setHTML(el, html) {
    if (shownHTML.get(el) === html) return;
    shownHTML.set(el, html);
    el.innerHTML = html;
  }

  // 一覧用：行ごとに比べて、変わった行だけ作り直す（同じ行は要素ごと残すので、画像を読み込み直さない）
  const shownRows = new WeakMap();
  const rowTemplate = document.createElement('template');
  function setRows(el, rows) {
    const prev = shownRows.get(el) || new Map();
    const prevById = new Map([...el.children].filter((n) => n.dataset.id).map((n) => [n.dataset.id, n]));
    const next = new Map();
    const nodes = rows.map((html) => {
      let node = prev.get(html);
      if (!node || next.has(html)) {
        rowTemplate.innerHTML = html;
        node = rowTemplate.content.firstElementChild;
        // 中身が変わった行（＋1話など）も、同じポスターは読み込み済みの要素を使い回す
        const old = node.dataset.id && prevById.get(node.dataset.id);
        const oldImg = old && old.querySelector('.tile img');
        const newImg = node.querySelector('.tile img');
        if (oldImg && newImg && oldImg.getAttribute('src') === newImg.getAttribute('src')) newImg.replaceWith(oldImg);
      }
      next.set(html, node);
      return node;
    });
    shownRows.set(el, next);
    if (nodes.length === el.children.length && nodes.every((node, i) => el.children[i] === node)) return;
    el.replaceChildren(...nodes);
  }

  function newId() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function toCount(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(n, 9999);
  }

  function toYear(value) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) && n >= 1900 && n <= 2100 ? n : null;
  }

  function toSourceId(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  // 検索用：全角半角・大文字小文字・カタカナひらがな・記号の違いを吸収する
  function fold(s) {
    return String(s)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
      .replace(/[\s・･·:：!！?？,，、。.．\-‐–—~〜'"「」『』()（）]/g, '');
  }

  function seasonRank(item) {
    return item.year ? item.year * 10 + (COUR_RANK[item.cour] || 0) : -1;
  }

  function seasonLabel(item) {
    if (!item.year) return '';
    return item.cour ? `${item.year}年${COUR[item.cour]}` : `${item.year}年`;
  }

  function findItem(id) {
    return state.items.find((it) => it.id === id) || null;
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = String(raw.title ?? '').trim().slice(0, 200);
    if (!title) return null;
    const total = toCount(raw.total) || null;
    let watched = toCount(raw.watched) ?? 0;
    if (total !== null && watched > total) watched = total;
    const rating = Math.max(0, Math.min(5, Math.round(Number(raw.rating) || 0)));
    const now = Date.now();
    return {
      id: raw.id ? String(raw.id) : newId(),
      title,
      status: STATUS[raw.status] ? raw.status : 'want',
      watched,
      total,
      year: toYear(raw.year),
      cour: COUR[raw.cour] ? raw.cour : null,
      rating,
      note: String(raw.note ?? '').slice(0, 5000),
      kana: String(raw.kana ?? '').slice(0, 200), // 読みがな（タイトル順に使う）
      sourceId: toSourceId(raw.sourceId),
      sample: raw.sample === true,
      createdAt: Number(raw.createdAt) || now,
      updatedAt: Number(raw.updatedAt) || now,
    };
  }

  function makeSamples() {
    const now = Date.now();
    const hour = 3600 * 1000;
    return [
      { title: '葬送のフリーレン', sourceId: 10079, status: 'watching', watched: 18, total: 28, year: 2023, cour: 'fall', rating: 5, note: '静かな回ほど沁みる。一級魔法使い試験に入った。', ago: 2 },
      { title: 'ダンジョン飯', sourceId: 9820, status: 'watching', watched: 9, total: 24, year: 2024, cour: 'winter', rating: 4, note: '料理の作画がとにかくおいしそう。', ago: 26 },
      { title: 'ぼっち・ざ・ろっく！', sourceId: 8128, status: 'done', watched: 12, total: 12, year: 2022, cour: 'fall', rating: 5, note: '文化祭ライブの回は何度でも見返せる。', ago: 50 },
      { title: '薬屋のひとりごと', sourceId: 10518, status: 'want', watched: 0, total: 24, year: 2023, cour: 'fall', rating: 0, note: '友だちのおすすめ。', ago: 74 },
      { title: 'ONE PIECE', sourceId: 2457, status: 'dropped', watched: 380, total: null, year: 1999, cour: 'fall', rating: 0, note: '長いので一旦お休み。続きは381話から。', ago: 300 },
    ].map(({ ago, ...s }) => normalize({ ...s, kana: SAMPLE_KANA[s.title], id: newId(), sample: true, createdAt: now - ago * hour, updatedAt: now - ago * hour }));
  }

  function normalizeProfile(raw) {
    const now = Date.now();
    const p = raw && typeof raw === 'object' ? raw : {};
    const avatar = typeof p.avatar === 'string' && p.avatar.length <= AVATAR_MAX && AVATAR_DATA.test(p.avatar) ? p.avatar : '';
    return {
      name: String(p.name ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX),
      avatar,
      createdAt: Number(p.createdAt) || now,
      updatedAt: Number(p.updatedAt) || 0, // 0 = まだ設定していない
    };
  }

  /* ---------- storage ---------- */
  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function load() {
    const saved = readJSON(STORE_KEY);
    if (saved && Array.isArray(saved.items)) {
      state.items = saved.items.map(normalize).filter(Boolean);
    } else {
      // 初回だけサンプルを入れる。消した後は空のまま保存されるので戻ってこない
      state.items = makeSamples();
      save();
    }
    state.profile = normalizeProfile(readJSON(PROFILE_KEY));
    const prefs = readJSON(PREFS_KEY);
    if (prefs) {
      if (MODES[prefs.mode]) state.mode = prefs.mode;
      if (TABS.includes(prefs.tab)) state.tab = prefs.tab;
      if (SORTS[prefs.sort]) state.sort = prefs.sort;
      if (typeof prefs.service === 'string') state.find.service = prefs.service;
      if (prefs.findSort in FIND_SORTS) state.find.sort = prefs.findSort;
    }
    els.sort.value = state.sort;
    els.findSort.value = state.find.sort;
  }

  function save() {
    const ok = writeJSON(STORE_KEY, { version: 1, items: state.items });
    els.storageWarn.hidden = ok;
    return ok;
  }

  function saveProfile() {
    return writeJSON(PROFILE_KEY, { version: 1, ...state.profile });
  }

  function savePrefs() {
    writeJSON(PREFS_KEY, {
      mode: state.mode,
      tab: state.tab,
      sort: state.sort,
      service: state.find.service,
      findSort: state.find.sort,
    });
  }

  function commit(renderOptions) {
    save();
    render(renderOptions);
  }

  /* ---------- covers ---------- */
  // ポスターの一覧は小さいので、起動したらすぐ読み込む。読めなくても頭文字の四角で動く
  function loadCovers() {
    fetch(COVERS_URL)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const list = data && data.covers && typeof data.covers === 'object' ? data.covers : {};
        for (const [id, path] of Object.entries(list)) {
          const sourceId = toSourceId(id);
          if (sourceId && COVER_PATH.test(path)) covers.set(sourceId, path);
        }
        if (covers.size) render({ keepOrder: true });
      })
      .catch(() => {});
  }

  // 記録のポスター。選んで登録した作品は ID で、それ以外は作品一覧を読み込んであれば題名で探す
  function coverFor(item) {
    const id = item.sourceId || (workFor(item) || {}).id;
    return (id && covers.get(id)) || '';
  }

  /* ---------- catalog ---------- */
  let catalogPromise = null;

  function loadCatalog() {
    if (catalogPromise) return catalogPromise;
    catalog.status = 'loading';
    catalogPromise = fetch(CATALOG_URL)
      .then((res) => {
        if (res.status === 404) {
          catalog.status = 'missing';
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (data) prepareCatalog(data);
      })
      .catch(() => {
        catalog.status = 'error';
        catalogPromise = null; // 次に開いたときにもう一度読み込む
      })
      .then(() => {
        // 読みがなが入ったらタイトル順の並びが変わるので並べ直す。それ以外は並びを動かさない
        const filled = fillKana();
        render({ keepOrder: !(filled && state.sort === 'title') });
        if (els.editor.open) renderSuggest();
      });
    return catalogPromise;
  }

  // 記録の読みを、作品一覧のものにそろえる（作品を選んで登録した記録か、題名が一致する記録）。
  // 読みが変わったら true を返す（タイトル順の並べ直しに使う）
  function fillKana() {
    if (catalog.status !== 'ready') return false;
    let kanaChanged = false;
    for (const item of state.items) {
      const work = workFor(item);
      const kana = (work && work.kana) || (item.sample && SAMPLE_KANA[item.title]) || '';
      if (kana && item.kana !== kana) {
        item.kana = kana;
        kanaChanged = true;
      }
    }
    if (kanaChanged) save();
    return kanaChanged;
  }

  // マイリストをタイトル順で並べるときは、記録の読みをそろえるために作品一覧を読み込む
  function needKana() {
    return state.mode === 'mine' && state.sort === 'title' && catalog.status !== 'ready';
  }

  function prepareCatalog(data) {
    const services = (Array.isArray(data.services) ? data.services : [])
      .filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string')
      .map((s) => ({ id: s.id, name: s.name, count: 0 }));
    const works = [];
    for (const w of Array.isArray(data.works) ? data.works : []) {
      const id = toSourceId(w && w.id);
      const title = String((w && w.t) || '').trim();
      if (!id || !title) continue;
      const work = {
        id,
        title,
        kana: String(w.k || ''),
        en: String(w.e || ''),
        year: toYear(w.y),
        cour: COUR[w.c] ? w.c : null,
        total: toCount(w.n) || null,
        media: MEDIA[w.m] ? w.m : '',
        services: (Array.isArray(w.s) ? w.s : []).filter((i) => services[i]).map((i) => services[i].id),
        popularity: Number(w.p) || 0,
      };
      works.push(work);
    }
    works.sort((a, b) => b.popularity - a.popularity || seasonRank(b) - seasonRank(a));

    const counts = new Map();
    for (const w of works) for (const s of w.services) counts.set(s, (counts.get(s) || 0) + 1);
    for (const s of services) s.count = counts.get(s.id) || 0;

    catalog.services = services.filter((s) => s.count > 0);
    catalog.serviceNames = new Map(services.map((s) => [s.id, s.name]));
    catalog.works = works;
    catalog.byId = new Map(works.map((w) => [w.id, w]));
    catalog.byTitle = null; // 必要になったときに作る（titleIndex）
    catalog.generatedAt = typeof data.generatedAt === 'string' ? data.generatedAt : '';
    catalog.status = 'ready';
    if (state.find.service !== 'all' && !catalog.services.some((s) => s.id === state.find.service)) {
      state.find.service = 'all';
    }
  }

  // 検索用の文字列。作品数が多いので、読み込み時ではなく初めて検索したときに作る
  function workFolded(work) {
    if (work.folded === undefined) work.folded = [fold(work.title), fold(work.kana), fold(work.en)].join('|');
    return work.folded;
  }

  function titleIndex() {
    if (!catalog.byTitle) {
      catalog.byTitle = new Map();
      for (const w of catalog.works) {
        const key = fold(w.title);
        if (!catalog.byTitle.has(key)) catalog.byTitle.set(key, w); // 同じ題名なら人気の高いほう
      }
    }
    return catalog.byTitle;
  }

  // 記録した作品に対応する一覧の作品（選んで登録した作品は ID で、それ以外は題名で探す）
  function workFor(item) {
    if (catalog.status !== 'ready') return null;
    return (item.sourceId && catalog.byId.get(item.sourceId)) || titleIndex().get(fold(item.title)) || null;
  }

  function serviceNames(work) {
    return work.services.map((id) => catalog.serviceNames.get(id) || id);
  }

  /* ---------- render ---------- */
  function render(options = {}) {
    const mine = state.mode === 'mine';
    const find = state.mode === 'find';
    const account = state.mode === 'account';
    els.mineView.hidden = !mine;
    els.findView.hidden = !find;
    els.accountView.hidden = !account;
    // 作品データに配信サービスの情報がないときは、サービスの絞り込みを出さない
    const hasServices = catalog.status === 'ready' && catalog.services.length > 0;
    els.tabbar.hidden = account || (find && !hasServices);
    els.tabs.hidden = !mine;
    els.serviceTabs.hidden = !find;
    els.fab.hidden = !mine;
    els.summary.hidden = !mine;
    els.searchBox.hidden = account;
    els.avatarBtn.hidden = account;
    els.pageTitle.textContent = MODES[state.mode];
    document.body.dataset.mode = state.mode;
    for (const btn of els.modes.querySelectorAll('[data-mode]')) {
      btn.setAttribute('aria-selected', String(btn.dataset.mode === state.mode));
    }
    const rank = currentRank();
    document.body.dataset.rank = rank.current.id;
    paintAvatar(els.avatarBtn, state.profile, rank.current);
    paintAvatar(els.navAvatar, state.profile, null);
    els.avatarBtn.setAttribute('aria-label', state.profile.name ? `アカウント（${state.profile.name}）` : 'アカウント');
    renderSummary();
    if (find) renderFind();
    else if (account) renderAccount(rank);
    else renderMine(options);
  }

  function renderMine({ keepOrder = false } = {}) {
    renderTabs();

    let visible;
    if (keepOrder) {
      visible = state.order.map(findItem).filter(Boolean);
    } else {
      const q = fold(state.query);
      visible = state.items.filter((it) => matches(it, q)).sort(SORTS[state.sort]);
      state.order = visible.map((it) => it.id);
    }

    setRows(els.list, visible.map(cardHTML));
    els.resultCount.textContent = `${visible.length}件`;
    renderEmpty(visible.length);

    const hasSamples = state.items.some((it) => it.sample);
    els.sampleNote.hidden = !hasSamples;
    els.menuSamples.hidden = !hasSamples;
  }

  function matches(item, q) {
    if (state.tab !== 'all' && item.status !== state.tab) return false;
    if (!q) return true;
    return fold(item.title).includes(q) || fold(item.note).includes(q);
  }

  function renderSummary() {
    const episodes = state.items.reduce((sum, it) => sum + it.watched, 0);
    els.summary.textContent = `${state.items.length}作品 · 累計 ${episodes.toLocaleString('ja-JP')}話`;
  }

  function renderTabs() {
    const counts = { all: state.items.length, want: 0, watching: 0, done: 0, dropped: 0 };
    for (const it of state.items) counts[it.status] += 1;
    for (const btn of els.tabs.querySelectorAll('[data-tab]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.tab === state.tab));
      btn.querySelector('.n').textContent = counts[btn.dataset.tab];
    }
  }

  function renderEmpty(count) {
    els.empty.hidden = count > 0;
    els.toolbar.hidden = state.items.length === 0;
    if (count > 0) return;

    let title;
    let body;
    if (state.items.length === 0) {
      title = 'まだ作品がありません';
      body = '「作品をさがす」から選ぶか、「作品を追加」から登録しましょう。';
    } else if (state.query) {
      const where = state.tab === 'all' ? '' : `「${STATUS[state.tab]}」の中に、`;
      title = `${where}「${state.query}」に一致する作品はありません`;
      body = 'ひらがなとカタカナの違いは気にせず探せます。別の言葉でも試してください。';
    } else {
      title = `「${STATUS[state.tab]}」の作品はありません`;
      body = '作品の編集画面で状態を変えると、ここに並びます。';
    }
    els.emptyTitle.textContent = title;
    els.emptyBody.textContent = body;
    els.emptyAdd.hidden = state.items.length > 0;
  }

  // ポスター。ない・読み込めないときは、題名から選んだ色の四角に最初の1文字を出す
  function tileHTML(title, image) {
    let hash = 0;
    for (const ch of String(title)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    const letter = String(title).normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
    const initial = letter ? [...letter][0].toUpperCase() : '？';
    const img = image ? `<img src="${COVER_BASE}${esc(image)}" alt="" loading="lazy" decoding="async">` : '';
    return `<div class="tile c${hash % TILE_COLORS}" aria-hidden="true">${esc(initial)}${img}</div>`;
  }

  // 画像が読み込めなかったら外して、下の色の四角を見せる
  document.addEventListener('error', (e) => {
    if (e.target instanceof HTMLImageElement && e.target.parentElement && e.target.parentElement.classList.contains('tile')) {
      e.target.remove();
    }
  }, true);

  function progressHTML(item) {
    if (!item.total) return '';
    return `<progress class="bar" max="${item.total}" value="${item.watched}" aria-hidden="true"></progress>`;
  }

  function countHTML(item) {
    if (item.total) return `<b>${item.watched}</b>/${item.total}話`;
    if (item.watched > 0) return `<b>${item.watched}</b>話まで`;
    return item.status === 'done' ? '' : '未視聴';
  }

  function starsHTML(rating) {
    if (!rating) return '';
    return `<span class="stars" role="img" aria-label="評価 ${rating} / 5">${'★'.repeat(rating)}<span class="off">${'★'.repeat(5 - rating)}</span></span>`;
  }

  function whereHTML(item) {
    if (!catalog.services.length) return '';
    const work = workFor(item);
    if (!work || !work.services.length) return '';
    return `<p class="where">配信：${esc(serviceNames(work).join('・'))}</p>`;
  }

  function canPlus(item) {
    if (item.status !== 'watching' && item.status !== 'want') return false;
    return !(item.total && item.watched >= item.total);
  }

  function canMinus(item) {
    return item.watched > 0;
  }

  function episodeButtonsHTML(item, title) {
    const minus = canMinus(item)
      ? `<button type="button" class="minus" data-action="minus" aria-label="${title}を1話戻す">−1</button>`
      : '';
    const plus = canPlus(item)
      ? `<button type="button" class="plus" data-action="plus" aria-label="${title}を1話進める">+1</button>`
      : '';
    return minus || plus ? `<div class="ep-btns">${minus}${plus}</div>` : '';
  }

  function cardHTML(item) {
    const season = seasonLabel(item);
    const title = esc(item.title);
    const count = countHTML(item);
    // 2行目：状態 · 話数 · 放送時期 · 星（ある物だけを「·」でつなぐ）
    const sub = [
      `<span class="chip">${STATUS[item.status]}</span>`,
      count ? `<span class="count">${count}</span>` : '',
      season ? `<span class="season">${season}</span>` : '',
      starsHTML(item.rating),
    ].filter(Boolean).join('<span class="sep" aria-hidden="true">·</span>');
    return `<article class="card s-${item.status}" data-id="${esc(item.id)}">
  <button type="button" class="card-hit" data-action="edit" aria-label="${title}を編集"></button>
  ${tileHTML(item.title, coverFor(item))}
  <div class="card-main">
    <h2 class="card-title">${title}</h2>
    <p class="card-sub">${item.sample ? '<span class="tag">サンプル</span>' : ''}${sub}</p>
    ${progressHTML(item)}
    ${whereHTML(item)}
    ${item.note ? `<p class="note">${esc(item.note)}</p>` : ''}
  </div>
  ${episodeButtonsHTML(item, title)}
</article>`;
  }

  /* ---------- find (作品をさがす) ---------- */
  function renderServiceTabs() {
    const chips = [{ id: 'all', name: 'すべて', count: catalog.works.length }].concat(catalog.services);
    els.serviceTabs.innerHTML = chips
      .map((s) => `<button type="button" data-service="${esc(s.id)}" aria-pressed="${s.id === state.find.service}">${esc(s.name)}<span class="n">${s.count.toLocaleString('ja-JP')}</span></button>`)
      .join('');
  }

  function workMeta(work) {
    return [seasonLabel(work), MEDIA[work.media], work.total ? `全${work.total}話` : ''].filter(Boolean).join(' · ');
  }

  function renderFind() {
    if (catalog.status !== 'ready') {
      els.serviceTabs.innerHTML = '';
      els.findToolbar.hidden = true;
      els.works.hidden = true;
      els.findMore.hidden = true;
      els.findEmpty.hidden = false;
      els.findRetry.hidden = catalog.status !== 'error';
      const messages = {
        idle: ['作品データを読み込んでいます', ''],
        loading: ['作品データを読み込んでいます', ''],
        missing: ['作品データはまだ入っていません', '準備ができたら、ここにアニメの作品が並びます。それまでは「マイリスト」の「作品を追加」から登録できます。'],
        error: ['作品データを読み込めませんでした', '電波の良い場所で、もう一度読み込んでください。'],
      };
      const [title, body] = messages[catalog.status];
      els.findEmptyTitle.textContent = title;
      els.findEmptyBody.textContent = body;
      els.findEmptyBody.hidden = !body;
      els.catalogDate.textContent = '';
      return;
    }

    renderServiceTabs();
    const q = fold(state.find.query);
    const service = state.find.service;
    const list = catalog.works.filter((w) => (service === 'all' || w.services.includes(service)) && (!q || workFolded(w).includes(q)));
    // 記録済みの作品（一覧の作品 ID → 自分の記録）
    const recorded = new Map();
    for (const it of state.items) {
      const work = workFor(it);
      if (work && !recorded.has(work.id)) recorded.set(work.id, it);
    }

    if (state.find.sort === 'rating') {
      // 自分でつけた星の多い順。同じ星の数なら人気順のまま（sort は安定）
      const stars = (w) => (recorded.get(w.id) || { rating: 0 }).rating;
      list.sort((a, b) => stars(b) - stars(a));
    } else {
      const sorter = FIND_SORTS[state.find.sort];
      if (sorter) list.sort(sorter);
    }

    const shown = list.slice(0, state.find.limit);
    els.findToolbar.hidden = false;
    els.works.hidden = shown.length === 0;
    setRows(els.works, shown.map((w) => workHTML(w, recorded.get(w.id))));
    els.findMore.hidden = list.length <= shown.length;
    els.findEmpty.hidden = list.length > 0;
    els.findRetry.hidden = true;
    if (!list.length) {
      els.findEmptyTitle.textContent = state.find.query ? `「${state.find.query}」に一致する作品はありません` : 'このサービスの作品はありません';
      els.findEmptyBody.textContent = state.find.query ? 'ひらがなでも探せます。短い言葉でも試してください。' : '';
      els.findEmptyBody.hidden = !state.find.query;
    }
    els.catalogDate.textContent = catalog.generatedAt ? `（${catalog.generatedAt}時点）` : '';
  }

  function workHTML(work, mine) {
    const services = work.services.length
      ? `<p class="svc-list">${work.services
        .map((id) => `<span class="svc${id === state.find.service ? ' on' : ''}">${esc(catalog.serviceNames.get(id) || id)}</span>`)
        .join('')}</p>`
      : '';
    const action = mine
      ? `<span class="added"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="currentColor"/><path d="m7 12.5 3.2 3L17 8.8" fill="none" stroke="#000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="sr-only">記録済み</span>${mine.rating ? starsHTML(mine.rating) : ''}</span>`
      : `<button type="button" class="add-btn" data-work="${work.id}" aria-label="${esc(work.title)}を記録に追加"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 7.5v9M7.5 12h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>`;
    const meta = workMeta(work);
    return `<article class="work">
  ${tileHTML(work.title, covers.get(work.id))}
  <div class="work-main">
    <h3 class="work-title">${esc(work.title)}</h3>
    ${meta ? `<p class="work-meta">${esc(meta)}</p>` : ''}
    ${services}
  </div>
  ${action}
</article>`;
  }

  function prefillFromWork(work, status = 'want') {
    return { title: work.title, kana: work.kana, total: work.total, year: work.year, cour: work.cour, sourceId: work.id, status };
  }

  /* ---------- account (アカウント) ---------- */
  const PERSON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="4" fill="currentColor"/><path d="M4.5 20.5c.8-4 3.8-6.5 7.5-6.5s6.7 2.5 7.5 6.5" fill="currentColor"/></svg>';

  function ownItems() {
    return state.items.filter((it) => !it.sample);
  }

  // 条件を満たすいちばん上のランク。next はその1つ上（いちばん上なら null）
  function rankFor(episodes, works) {
    let index = 0;
    RANKS.forEach((r, i) => {
      if (episodes >= r.episodes && works >= (r.works || 0)) index = i;
    });
    return { episodes, works, current: RANKS[index], next: RANKS[index + 1] || null };
  }

  function currentRank() {
    const own = ownItems();
    const episodes = own.reduce((sum, it) => sum + it.watched, 0);
    const works = own.filter((it) => RANKED_STATUS.includes(it.status)).length;
    return rankFor(episodes, works);
  }

  const SECRET = (label) => `<span class="sr-only">${label}</span><span aria-hidden="true">？？？</span>`;

  function rankCondition(r) {
    if (r.secret) return SECRET('達成条件はひみつ');
    return r.episodes ? `${r.episodes.toLocaleString('ja-JP')}話以上` : 'はじめのランク';
  }

  // ランクと達成条件（上のランクから並べる）。ひみつのランクは、なるまで名前も色も出さない
  function openRankInfo() {
    const rank = currentRank();
    const at = RANKS.indexOf(rank.current);
    els.rankList.innerHTML = RANKS.map((r, i) => {
      const now = i === at;
      const hidden = r.secret && i > at;
      return `<li data-rank="${hidden ? 'secret' : r.id}"${i <= at ? ' class="reached"' : ''}${now ? ' aria-current="true"' : ''}>
  <i aria-hidden="true"></i><span class="ln">${hidden ? SECRET('ひみつのランク') : esc(r.name)}</span><span class="lm">${rankCondition(r)}</span>${now ? '<span class="now">いまここ</span>' : ''}
</li>`;
    }).reverse().join('');
    els.rankSampleHint.hidden = !state.items.some((it) => it.sample);
    els.rankInfo.showModal();
  }

  // 丸いアイコン：写真 → 名前の最初の1文字 → 人の形、の順に出す。rank を渡すとランクの色の輪を付ける
  function paintAvatar(el, profile, rank, avatar = profile.avatar) {
    let face;
    if (avatar) {
      face = `<span class="face"><img src="${esc(avatar)}" alt=""></span>`;
    } else {
      const letter = profile.name.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
      if (letter) {
        let hash = 0;
        for (const ch of profile.name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
        face = `<span class="face c${hash % TILE_COLORS}">${esc([...letter][0].toUpperCase())}</span>`;
      } else {
        face = `<span class="face blank">${PERSON_SVG}</span>`;
      }
    }
    setHTML(el, face);
    el.classList.toggle('ringed', !!rank);
    el.dataset.rank = rank ? rank.id : '';
  }

  function renderAccount(rank) {
    const p = state.profile;
    const own = ownItems();
    const n = (v) => v.toLocaleString('ja-JP');

    paintAvatar(els.heroAvatar, p, rank.current);
    els.profileName.textContent = p.name || '名前が未設定です';
    els.profileName.classList.toggle('unset', !p.name);
    els.profileMeta.textContent = `見た話数 ${n(rank.episodes)}話 · ${rank.current.name}`;
    const isSet = Boolean(p.name || p.avatar);
    els.editProfile.textContent = isSet ? 'プロフィールを編集' : 'プロフィールを設定';
    els.editProfile.classList.toggle('primary', !isSet);

    els.rankCard.dataset.rank = rank.current.id;
    els.rankTitle.textContent = rank.current.name;
    els.rankEpisodes.textContent = n(rank.episodes);
    const { current, next } = rank;
    els.rankBar.hidden = Boolean(next && next.secret);
    if (!next) {
      els.rankBar.max = 1;
      els.rankBar.value = 1;
      els.rankNext.textContent = 'いちばん上のランクです';
    } else if (next.secret) {
      // ひみつのランクは、名前も残りの数も出さない
      els.rankNext.textContent = '次のランクは ？？？。達成条件はひみつです';
    } else {
      els.rankBar.max = next.episodes - current.episodes;
      els.rankBar.value = rank.episodes - current.episodes;
      els.rankNext.textContent = `${next.name}まで あと${n(next.episodes - rank.episodes)}話`;
    }

    const counts = { done: 0, watching: 0, want: 0, dropped: 0 };
    let episodes = 0;
    let rated = 0;
    let stars = 0;
    for (const it of own) {
      counts[it.status] += 1;
      episodes += it.watched;
      if (it.rating) {
        rated += 1;
        stars += it.rating;
      }
    }
    const stats = [
      ['見終わった作品', n(counts.done)],
      ['視聴中の作品', n(counts.watching)],
      ['見たい作品', n(counts.want)],
      ['中断した作品', n(counts.dropped)],
      ['見た話数', n(episodes)],
      ['平均の星', rated ? (stars / rated).toFixed(1) : '—'],
    ];
    els.stats.innerHTML = stats.map(([label, value]) => `<div class="stat"><dt>${label}</dt><dd>${value}</dd></div>`).join('');
  }

  /* ---------- profile editor ---------- */
  // 写真を中央で正方形に切り抜き、AVATAR_SIZE の JPEG（data URL）にする。写真は端末の外に出さない
  async function photoToAvatar(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('decode'));
        image.src = url;
      });
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      if (!side) throw new Error('size');
      const canvas = document.createElement('canvas');
      canvas.width = AVATAR_SIZE;
      canvas.height = AVATAR_SIZE;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#121212'; // 透明な部分がある画像は、黒地にのせる
      ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
      return canvas.toDataURL('image/jpeg', 0.85);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function paintDraft() {
    paintAvatar(els.pAvatar, { name: els.pName.value, avatar: state.draftAvatar }, null, state.draftAvatar);
    els.pPhotoRemove.hidden = !state.draftAvatar;
  }

  function openProfileEditor() {
    state.draftAvatar = state.profile.avatar;
    els.pName.value = state.profile.name;
    els.pPhotoError.hidden = true;
    paintDraft();
    els.profileEditor.showModal();
    if (!state.profile.name) els.pName.focus();
  }

  els.pPhoto.addEventListener('change', async () => {
    const file = els.pPhoto.files && els.pPhoto.files[0];
    els.pPhoto.value = '';
    if (!file) return;
    els.pPhotoError.hidden = true;
    try {
      if (file.type && !file.type.startsWith('image/')) throw new Error('type');
      const avatar = await photoToAvatar(file);
      if (avatar.length > AVATAR_MAX || !AVATAR_DATA.test(avatar)) throw new Error('size');
      state.draftAvatar = avatar;
      paintDraft();
    } catch {
      els.pPhotoError.textContent = 'この写真は読み込めませんでした。別の写真を選んでください。';
      els.pPhotoError.hidden = false;
    }
  });

  els.pPhotoRemove.addEventListener('click', () => {
    state.draftAvatar = '';
    paintDraft();
  });

  els.pName.addEventListener('input', () => {
    if (!state.draftAvatar) paintDraft();
  });

  els.profileForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const before = state.profile;
    state.profile = normalizeProfile({ ...before, name: els.pName.value, avatar: state.draftAvatar, updatedAt: Date.now() });
    if (!saveProfile()) {
      state.profile = before;
      els.pPhotoError.textContent = '保存できませんでした。端末の空き容量を確かめるか、写真を外して保存してください。';
      els.pPhotoError.hidden = false;
      return;
    }
    els.profileEditor.close();
    render();
    toast('プロフィールを保存しました');
  });

  els.avatarBtn.addEventListener('click', () => setMode('account'));
  els.heroAvatar.addEventListener('click', openProfileEditor);
  els.editProfile.addEventListener('click', openProfileEditor);
  els.rankInfoBtn.addEventListener('click', openRankInfo);

  /* ---------- toast ---------- */
  let toastTimer = 0;
  let toastRun = null;

  function toast(message, action) {
    els.toastMsg.textContent = message;
    toastRun = action ? action.run : null;
    els.toastAction.hidden = !action;
    els.toastAction.textContent = action ? action.label : '';
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 5000 : 2600);
  }

  function hideToast() {
    els.toast.hidden = true;
    toastRun = null;
  }

  els.toastAction.addEventListener('click', () => {
    const run = toastRun;
    hideToast();
    if (run) run();
  });

  /* ---------- list actions ---------- */
  // 一覧の ＋1話／−1話 ボタン
  function changeEpisode(id, delta) {
    const item = findItem(id);
    if (!item) return;
    if (delta < 0 && item.watched <= 0) return;
    const before = { ...item };

    item.watched = Math.max(0, item.watched + delta);
    if (item.total && item.watched > item.total) item.watched = item.total;
    let message = item.watched > 0 ? `${item.title}：${item.watched}話まで見ました` : `${item.title}：未視聴に戻しました`;
    if (delta > 0) {
      if (item.status === 'want') item.status = 'watching';
      if (item.total && item.watched >= item.total) {
        item.status = 'done';
        message = `${item.title}を見終わりました`;
      }
    } else if (item.status === 'done' && item.total && item.watched < item.total) {
      item.status = 'watching';
    }
    item.updatedAt = Date.now();
    commit({ keepOrder: true });

    toast(message, {
      label: '元に戻す',
      run: () => {
        const current = findItem(id);
        if (!current) return;
        Object.assign(current, before);
        commit({ keepOrder: true });
      },
    });
  }

  els.list.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const card = target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    const action = target.dataset.action;
    if (action === 'plus' || action === 'minus') {
      const hadFocus = document.activeElement === target;
      changeEpisode(id, action === 'plus' ? 1 : -1);
      if (hadFocus) {
        const buttons = els.list.querySelector(`.card[data-id="${CSS.escape(id)}"] .ep-btns`);
        const next = buttons && (buttons.querySelector(`[data-action="${action}"]`) || buttons.querySelector('button'));
        if (next) next.focus();
      }
    } else {
      openEditor(id);
    }
  });

  els.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    savePrefs();
    render();
  });

  els.search.addEventListener('input', () => {
    const value = els.search.value.trim();
    if (state.mode === 'find') {
      state.find.query = value;
      state.find.limit = FIND_PAGE;
    } else {
      state.query = value;
    }
    render();
  });

  els.sort.addEventListener('change', () => {
    state.sort = SORTS[els.sort.value] ? els.sort.value : 'updated';
    savePrefs();
    render();
    if (needKana()) loadCatalog();
  });

  /* ---------- mode switch & find actions ---------- */
  function setMode(mode) {
    if (!MODES[mode]) return;
    state.mode = mode;
    savePrefs();
    els.search.value = mode === 'find' ? state.find.query : state.query;
    els.search.placeholder = mode === 'find' ? '作品名で検索（ひらがなでも探せます）' : 'ライブラリ内を検索';
    if (mode === 'find') loadCatalog();
    render();
    window.scrollTo(0, 0);
  }

  els.modes.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (btn && btn.dataset.mode !== state.mode) setMode(btn.dataset.mode);
  });

  els.serviceTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-service]');
    if (!btn) return;
    state.find.service = btn.dataset.service;
    state.find.limit = FIND_PAGE;
    savePrefs();
    render();
    window.scrollTo(0, 0);
  });

  els.findSort.addEventListener('change', () => {
    state.find.sort = els.findSort.value in FIND_SORTS ? els.findSort.value : 'popular';
    state.find.limit = FIND_PAGE;
    savePrefs();
    render();
  });

  els.findMore.addEventListener('click', () => {
    state.find.limit += FIND_PAGE;
    render();
  });

  els.findRetry.addEventListener('click', () => {
    loadCatalog();
    render();
  });

  els.works.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-work]');
    if (!btn) return;
    const work = catalog.byId.get(Number(btn.dataset.work));
    if (work) openEditor(null, prefillFromWork(work));
  });

  /* ---------- editor ---------- */
  // 放送時期は表示だけ。作品一覧や候補から選んだ作品のものが入る
  function setEditorSeason(season) {
    state.season = season && season.year ? { year: season.year, cour: season.cour || null } : null;
    f.season.textContent = state.season ? `放送時期：${seasonLabel(state.season)}` : '';
    f.season.hidden = !state.season;
  }

  function currentStatus() {
    const checked = els.form.querySelector('input[name="status"]:checked');
    return checked ? checked.value : 'want';
  }

  function setStatus(status) {
    const input = els.form.querySelector(`input[name="status"][value="${status}"]`);
    if (input) input.checked = true;
  }

  function setRating(value) {
    state.rating = value;
    for (const btn of els.form.querySelectorAll('[data-star]')) {
      const n = Number(btn.dataset.star);
      btn.classList.toggle('on', n <= value);
      btn.setAttribute('aria-checked', String(n === value));
    }
    els.ratingText.textContent = value ? `${value} / 5` : '未評価';
  }

  function showConfirm(on) {
    els.footMain.hidden = on;
    els.footConfirm.hidden = !on;
    if (on) {
      const item = findItem(state.editingId);
      els.confirmText.textContent = `「${item ? item.title : 'この作品'}」を削除しますか？`;
    }
  }

  // 作品の情報（題名・話数・放送時期）をフォームに入れる
  function fillWorkFields(work) {
    f.title.value = work.title;
    if (work.total) f.total.value = String(work.total);
    setEditorSeason(work);
    state.picked = work.sourceId ? { id: work.sourceId, title: work.title, kana: work.kana || '' } : null;
  }

  function openEditor(id = null, prefill = null) {
    const item = id ? findItem(id) : null;
    state.editingId = item ? item.id : null;
    state.picked = null;
    els.editorTitle.textContent = item ? '作品を編集' : '作品を登録';
    f.title.value = item ? item.title : '';
    setStatus(item ? item.status : (prefill && prefill.status) || 'watching');
    f.watched.value = String(item ? item.watched : 0);
    f.total.value = item && item.total ? String(item.total) : '';
    state.baseSeason = item && item.year ? { year: item.year, cour: item.cour } : null;
    setEditorSeason(state.baseSeason);
    setRating(item ? item.rating : 0);
    f.note.value = item ? item.note : '';
    if (prefill) fillWorkFields(prefill);
    els.titleError.hidden = true;
    els.suggest.hidden = true;
    els.delete.hidden = !item;
    showConfirm(false);

    els.editor.showModal();
    els.editorBody.scrollTop = 0;
    if (!item && !prefill) {
      f.title.focus();
      loadCatalog();
    }
  }

  // タイトル入力中に、作品一覧から候補を出す（新規登録のときだけ）
  function renderSuggest() {
    const value = f.title.value.trim();
    const q = fold(value);
    if (state.editingId || catalog.status !== 'ready' || !q || (state.picked && value === state.picked.title)) {
      els.suggest.hidden = true;
      return;
    }
    const hits = [];
    for (const w of catalog.works) {
      if (workFolded(w).includes(q)) {
        hits.push(w);
        if (hits.length >= SUGGEST_LIMIT) break;
      }
    }
    els.suggest.hidden = hits.length === 0;
    els.suggest.innerHTML = hits
      .map((w) => {
        const meta = workMeta(w);
        return `<button type="button" data-suggest="${w.id}"><span class="s-title">${esc(w.title)}</span>${meta ? `<span class="s-meta">${esc(meta)}</span>` : ''}</button>`;
      })
      .join('');
  }

  els.suggest.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-suggest]');
    if (!btn) return;
    const work = catalog.byId.get(Number(btn.dataset.suggest));
    if (!work) return;
    fillWorkFields(prefillFromWork(work));
    els.suggest.hidden = true;
    els.titleError.hidden = true;
  });

  function stepWatched(delta) {
    let watched = (toCount(f.watched.value) ?? 0) + delta;
    const total = toCount(f.total.value) || null;
    if (watched < 0) watched = 0;
    if (total && watched > total) watched = total;
    f.watched.value = String(watched);
    if (delta > 0 && currentStatus() === 'want') setStatus('watching');
  }

  els.form.addEventListener('click', (e) => {
    const step = e.target.closest('[data-step]');
    if (step) {
      stepWatched(Number(step.dataset.step));
      return;
    }
    const star = e.target.closest('[data-star]');
    if (star) {
      const n = Number(star.dataset.star);
      setRating(n === state.rating ? 0 : n);
    }
  });

  els.form.addEventListener('change', (e) => {
    // 「見終わった」にしたら、見た話数を全話数にそろえる
    if (e.target.name === 'status' && e.target.value === 'done') {
      const total = toCount(f.total.value) || null;
      if (total && (toCount(f.watched.value) ?? 0) < total) f.watched.value = String(total);
    }
  });

  f.title.addEventListener('input', () => {
    if (f.title.value.trim()) els.titleError.hidden = true;
    // 選んだ作品から題名を変えたら、その作品の放送時期は使わない
    if (state.picked && f.title.value.trim() !== state.picked.title) {
      state.picked = null;
      setEditorSeason(state.baseSeason);
    }
    renderSuggest();
  });

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = f.title.value.trim();
    if (!title) {
      els.titleError.hidden = false;
      f.title.focus();
      return;
    }
    const total = toCount(f.total.value) || null;
    let watched = toCount(f.watched.value) ?? 0;
    if (total && watched > total) watched = total;
    const existing = state.editingId ? findItem(state.editingId) : null;
    let sourceId = existing ? existing.sourceId : null;
    // 読みがなは、選んだ作品のもの。編集で題名を変えたら、古い読みがなは捨てる（作品一覧に同じ題名があれば後で入る）
    let kana = existing && existing.title === title ? existing.kana : '';
    if (state.picked && title === state.picked.title) {
      sourceId = state.picked.id;
      kana = state.picked.kana;
    }
    const data = {
      title: title.slice(0, 200),
      status: currentStatus(),
      watched,
      total,
      year: state.season ? state.season.year : null,
      cour: state.season ? state.season.cour : null,
      rating: state.rating,
      note: f.note.value.trim().slice(0, 5000),
      kana,
      sourceId,
      sample: false,
    };
    const now = Date.now();
    let message;

    if (existing) {
      Object.assign(existing, data, { updatedAt: now });
      message = '保存しました';
    } else {
      const item = normalize({ ...data, id: newId(), createdAt: now, updatedAt: now });
      state.items.push(item);
      message = `「${item.title}」を登録しました`;
      // マイリストの今の絞り込みでは見えない作品を登録したら、絞り込みを外して見えるようにする
      if (state.mode === 'mine' && !matches(item, fold(state.query))) {
        state.tab = 'all';
        state.query = '';
        els.search.value = '';
        savePrefs();
      }
    }

    els.editor.close();
    fillKana();
    commit();
    toast(message);
  });

  els.delete.addEventListener('click', () => showConfirm(true));
  $('delete-cancel').addEventListener('click', () => showConfirm(false));
  $('delete-confirm').addEventListener('click', () => {
    const index = state.items.findIndex((it) => it.id === state.editingId);
    if (index === -1) return;
    const [removed] = state.items.splice(index, 1);
    els.editor.close();
    commit();
    toast(`「${removed.title}」を削除しました`, {
      label: '元に戻す',
      run: () => {
        state.items.splice(Math.min(index, state.items.length), 0, removed);
        commit();
      },
    });
  });

  /* ---------- dialogs ---------- */
  for (const dialog of [els.editor, els.menu, els.profileEditor, els.rankInfo]) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close(); // 背景をタップしたら閉じる
      if (e.target.closest('[data-close]')) dialog.close();
    });
  }

  els.fab.addEventListener('click', () => openEditor());
  els.emptyAdd.addEventListener('click', () => openEditor());
  $('open-menu').addEventListener('click', () => els.menu.showModal());

  /* ---------- samples ---------- */
  function clearSamples() {
    const removed = state.items.filter((it) => it.sample);
    if (!removed.length) return;
    state.items = state.items.filter((it) => !it.sample);
    commit();
    toast(`サンプル${removed.length}件を消しました`, {
      label: '元に戻す',
      run: () => {
        state.items = state.items.concat(removed.filter((it) => !findItem(it.id)));
        commit();
      },
    });
  }

  $('clear-samples-inline').addEventListener('click', clearSamples);
  $('clear-samples').addEventListener('click', () => {
    els.menu.close();
    clearSamples();
  });

  /* ---------- backup ---------- */
  function dateStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }

  $('export').addEventListener('click', async () => {
    const payload = { app: 'anime-log', version: 1, exportedAt: new Date().toISOString(), profile: state.profile, items: state.items };
    const name = `anime-log-${dateStamp()}.json`;
    const file = new File([JSON.stringify(payload, null, 2)], name, { type: 'application/json' });

    // iPhone では共有シートの「"ファイル"に保存」で保存できる
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'アニメ視聴記録のバックアップ' });
        toast('バックアップを書き出しました');
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }

    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });

  els.importFile.addEventListener('change', async () => {
    const file = els.importFile.files && els.importFile.files[0];
    els.importFile.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data && data.items;
      if (!Array.isArray(list)) throw new Error('format');
      let added = 0;
      let updated = 0;
      for (const item of list.map(normalize).filter(Boolean)) {
        const index = state.items.findIndex((it) => it.id === item.id);
        if (index === -1) {
          state.items.push(item);
          added += 1;
        } else if (item.updatedAt > state.items[index].updatedAt) {
          state.items[index] = item;
          updated += 1;
        }
      }
      // プロフィールは、バックアップのほうが新しく設定したものなら置き換える
      let profileNote = '';
      if (data && data.profile) {
        const incoming = normalizeProfile(data.profile);
        if (incoming.updatedAt > state.profile.updatedAt && (incoming.name || incoming.avatar)) {
          state.profile = incoming;
          saveProfile();
          profileNote = '、プロフィールも読み込みました';
        }
      }
      els.menu.close();
      commit();
      toast(`${added}件を追加し、${updated}件を更新しました${profileNote}`);
    } catch {
      toast('読み込めませんでした。このアプリで書き出したバックアップ（.json）を選んでください');
    }
  });

  /* ---------- start ---------- */
  load();
  setMode(state.mode);
  loadCovers();
  if (needKana()) loadCatalog();

  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch {
    /* 使えない環境では何もしない */
  }

  try {
    if ('serviceWorker' in navigator && window.isSecureContext) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      });
    }
  } catch {
    /* プレビュー環境などで使えないときは、オフライン対応なしで動く */
  }
})();
