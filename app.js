/* アニメ視聴記録 — 記録はこの端末の localStorage に保存する */
(() => {
  'use strict';

  const STORE_KEY = 'anime-log:v1';
  const PREFS_KEY = 'anime-log:prefs';
  const CATALOG_URL = 'catalog.json'; // 配信サービスで見られる作品の一覧（scripts/build_catalog.py で作る）
  const SEGMENT_LIMIT = 30; // この話数までは1話ずつのコマで表示し、超えたら1本のバーにする
  const FIRST_TV_ANIME_YEAR = 1963; // 年の選択肢の下限（国産初の連続TVアニメの年）
  const FIND_PAGE = 60; // 「作品をさがす」で一度に並べる件数
  const SUGGEST_LIMIT = 6;

  const STATUS = { want: '見たい', watching: '視聴中', done: '見終わった', dropped: '中断' };
  const COUR = { winter: '冬', spring: '春', summer: '夏', fall: '秋' };
  const COUR_RANK = { winter: 1, spring: 2, summer: 3, fall: 4 };
  const MEDIA = { tv: 'TV', movie: '劇場版', ova: 'OVA', web: '配信', other: 'その他' };
  const TABS = ['all', 'watching', 'want', 'done', 'dropped'];

  const collator = new Intl.Collator('ja');
  const SORTS = {
    updated: (a, b) => b.updatedAt - a.updatedAt,
    season: (a, b) => seasonRank(b) - seasonRank(a) || b.updatedAt - a.updatedAt,
    rating: (a, b) => b.rating - a.rating || b.updatedAt - a.updatedAt,
    title: (a, b) => collator.compare(a.title, b.title),
  };
  // 作品一覧は人気順で読み込むので、人気順は並べ替え不要
  const FIND_SORTS = {
    popular: null,
    season: (a, b) => seasonRank(b) - seasonRank(a) || b.popularity - a.popularity,
    title: (a, b) => collator.compare(a.kana || a.title, b.kana || b.title),
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    summary: $('summary'),
    modes: $('modes'),
    search: $('search'),
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
    findCount: $('find-count'),
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
  };
  const f = {
    title: $('f-title'),
    watched: $('f-watched'),
    total: $('f-total'),
    year: $('f-year'),
    cour: $('f-cour'),
    note: $('f-note'),
  };

  const state = {
    mode: 'mine', // mine = マイリスト, find = 作品をさがす
    items: [],
    tab: 'all',
    query: '',
    sort: 'updated',
    order: [], // 表示中の並び。＋1話を押しても並びが動かないように保持する
    editingId: null,
    rating: 0,
    picked: null, // 入力候補や「作品をさがす」から選んだ作品 { id, title }
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

  /* ---------- helpers ---------- */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

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
      { title: '葬送のフリーレン', status: 'watching', watched: 18, total: 28, year: 2023, cour: 'fall', rating: 5, note: '静かな回ほど沁みる。一級魔法使い試験に入った。', ago: 2 },
      { title: 'ダンジョン飯', status: 'watching', watched: 9, total: 24, year: 2024, cour: 'winter', rating: 4, note: '料理の作画がとにかくおいしそう。', ago: 26 },
      { title: 'ぼっち・ざ・ろっく！', status: 'done', watched: 12, total: 12, year: 2022, cour: 'fall', rating: 5, note: '文化祭ライブの回は何度でも見返せる。', ago: 50 },
      { title: '薬屋のひとりごと', status: 'want', watched: 0, total: 24, year: 2023, cour: 'fall', rating: 0, note: '友だちのおすすめ。', ago: 74 },
      { title: 'ONE PIECE', status: 'dropped', watched: 380, total: null, year: 1999, cour: 'fall', rating: 0, note: '長いので一旦お休み。続きは381話から。', ago: 300 },
    ].map(({ ago, ...s }) => normalize({ ...s, id: newId(), sample: true, createdAt: now - ago * hour, updatedAt: now - ago * hour }));
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
    const prefs = readJSON(PREFS_KEY);
    if (prefs) {
      if (prefs.mode === 'mine' || prefs.mode === 'find') state.mode = prefs.mode;
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
        render({ keepOrder: true });
        if (els.editor.open) renderSuggest();
      });
    return catalogPromise;
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
      work.folded = [fold(work.title), fold(work.kana), fold(work.en)].join('|');
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
    catalog.byTitle = new Map();
    for (const w of works) {
      const key = fold(w.title);
      if (!catalog.byTitle.has(key)) catalog.byTitle.set(key, w); // 同じ題名なら人気の高いほう
    }
    catalog.generatedAt = typeof data.generatedAt === 'string' ? data.generatedAt : '';
    catalog.status = 'ready';
    if (state.find.service !== 'all' && !catalog.services.some((s) => s.id === state.find.service)) {
      state.find.service = 'all';
    }
  }

  // 記録した作品に対応する一覧の作品（選んで登録した作品は ID で、それ以外は題名で探す）
  function workFor(item) {
    if (catalog.status !== 'ready') return null;
    return (item.sourceId && catalog.byId.get(item.sourceId)) || catalog.byTitle.get(fold(item.title)) || null;
  }

  function serviceNames(work) {
    return work.services.map((id) => catalog.serviceNames.get(id) || id);
  }

  /* ---------- render ---------- */
  function render(options = {}) {
    const find = state.mode === 'find';
    els.mineView.hidden = find;
    els.findView.hidden = !find;
    els.tabs.hidden = find;
    els.serviceTabs.hidden = !find;
    els.fab.hidden = find;
    for (const btn of els.modes.querySelectorAll('[data-mode]')) {
      btn.setAttribute('aria-selected', String(btn.dataset.mode === state.mode));
    }
    renderSummary();
    if (find) renderFind();
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

    els.list.innerHTML = visible.map(cardHTML).join('');
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

  function progressHTML(item) {
    if (!item.total) return '';
    if (item.total <= SEGMENT_LIMIT) {
      return `<div class="frames" aria-hidden="true">${'<i class="on"></i>'.repeat(item.watched)}${'<i></i>'.repeat(item.total - item.watched)}</div>`;
    }
    return `<progress class="bar" max="${item.total}" value="${item.watched}" aria-hidden="true"></progress>`;
  }

  function countHTML(item) {
    if (item.total) return `<b>${item.watched}</b><span>/ ${item.total}話</span>`;
    if (item.watched > 0) return `<b>${item.watched}</b><span>話まで視聴</span>`;
    return item.status === 'done' ? '' : '<span>未視聴</span>';
  }

  function starsHTML(rating) {
    if (!rating) return '';
    return `<span class="stars" role="img" aria-label="評価 ${rating} / 5">${'★'.repeat(rating)}<span class="off">${'★'.repeat(5 - rating)}</span></span>`;
  }

  function whereHTML(item) {
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
      ? `<button type="button" class="minus" data-action="minus" aria-label="${title}を1話戻す">−1話</button>`
      : '';
    const plus = canPlus(item)
      ? `<button type="button" class="plus" data-action="plus" aria-label="${title}を1話進める">＋1話</button>`
      : '';
    return minus || plus ? `<div class="ep-btns">${minus}${plus}</div>` : '';
  }

  function cardHTML(item) {
    const season = seasonLabel(item);
    const title = esc(item.title);
    return `<article class="card s-${item.status}" data-id="${esc(item.id)}">
  <button type="button" class="card-hit" data-action="edit" aria-label="${title}を編集"></button>
  <div class="card-head">
    <span class="chip">${STATUS[item.status]}</span>
    ${item.sample ? '<span class="tag">サンプル</span>' : ''}
    ${season ? `<span class="season">${season}</span>` : ''}
  </div>
  <h2 class="card-title">${title}</h2>
  ${progressHTML(item)}
  ${whereHTML(item)}
  ${item.note ? `<p class="note">${esc(item.note)}</p>` : ''}
  <div class="card-foot">
    <span class="count">${countHTML(item)}</span>
    ${starsHTML(item.rating)}
    ${episodeButtonsHTML(item, title)}
  </div>
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
        missing: ['作品データはまだ入っていません', '準備ができたら、ここに配信サービスで見られる作品が並びます。それまでは「マイリスト」の「作品を追加」から登録できます。'],
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
    const list = catalog.works.filter((w) => (service === 'all' || w.services.includes(service)) && (!q || w.folded.includes(q)));
    const sorter = FIND_SORTS[state.find.sort];
    if (sorter) list.sort(sorter);

    const mineIds = new Set();
    const mineTitles = new Set();
    for (const it of state.items) {
      if (it.sourceId) mineIds.add(it.sourceId);
      mineTitles.add(fold(it.title));
    }

    const shown = list.slice(0, state.find.limit);
    els.findToolbar.hidden = false;
    els.findCount.textContent = `${list.length.toLocaleString('ja-JP')}作品`;
    els.works.hidden = shown.length === 0;
    els.works.innerHTML = shown.map((w) => workHTML(w, mineIds.has(w.id) || mineTitles.has(fold(w.title)))).join('');
    els.findMore.hidden = list.length <= shown.length;
    els.findMore.textContent = `もっと見る（残り${(list.length - shown.length).toLocaleString('ja-JP')}作品）`;
    els.findEmpty.hidden = list.length > 0;
    els.findRetry.hidden = true;
    if (!list.length) {
      els.findEmptyTitle.textContent = state.find.query ? `「${state.find.query}」に一致する作品はありません` : 'このサービスの作品はありません';
      els.findEmptyBody.textContent = state.find.query ? 'ひらがなでも探せます。短い言葉でも試してください。' : '';
      els.findEmptyBody.hidden = !state.find.query;
    }
    els.catalogDate.textContent = catalog.generatedAt ? `（${catalog.generatedAt}時点）` : '';
  }

  function workHTML(work, recorded) {
    const services = work.services.length
      ? `<p class="svc-list">${work.services
        .map((id) => `<span class="svc${id === state.find.service ? ' on' : ''}">${esc(catalog.serviceNames.get(id) || id)}</span>`)
        .join('')}</p>`
      : '';
    const action = recorded
      ? '<span class="added">記録済み</span>'
      : `<button type="button" class="add-btn" data-work="${work.id}" aria-label="${esc(work.title)}を記録に追加">＋ 追加</button>`;
    const meta = workMeta(work);
    return `<article class="work">
  <div class="work-main">
    <h3 class="work-title">${esc(work.title)}</h3>
    ${meta ? `<p class="work-meta">${esc(meta)}</p>` : ''}
    ${services}
  </div>
  ${action}
</article>`;
  }

  function prefillFromWork(work, status = 'want') {
    return { title: work.title, total: work.total, year: work.year, cour: work.cour, sourceId: work.id, status };
  }

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
  });

  /* ---------- mode switch & find actions ---------- */
  function setMode(mode) {
    if (mode !== 'mine' && mode !== 'find') return;
    state.mode = mode;
    savePrefs();
    els.search.value = mode === 'find' ? state.find.query : state.query;
    els.search.placeholder = mode === 'find' ? '作品名で検索（ひらがなでも探せます）' : 'タイトルや感想で検索';
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
  function buildYearOptions() {
    const thisYear = new Date().getFullYear();
    const options = ['<option value="">年 —</option>'];
    for (let y = thisYear + 1; y >= FIRST_TV_ANIME_YEAR; y -= 1) options.push(`<option value="${y}">${y}年</option>`);
    f.year.innerHTML = options.join('');
  }

  function ensureYearOption(year) {
    if (!year || f.year.querySelector(`option[value="${year}"]`)) return;
    const opt = document.createElement('option');
    opt.value = String(year);
    opt.textContent = `${year}年`;
    f.year.append(opt);
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
    ensureYearOption(work.year);
    f.year.value = work.year ? String(work.year) : '';
    f.cour.value = work.cour || '';
    state.picked = work.sourceId ? { id: work.sourceId, title: work.title } : null;
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
    if (item) ensureYearOption(item.year);
    f.year.value = item && item.year ? String(item.year) : '';
    f.cour.value = item && item.cour ? item.cour : '';
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
      if (w.folded.includes(q)) {
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
    if (state.picked && title === state.picked.title) sourceId = state.picked.id;
    const data = {
      title: title.slice(0, 200),
      status: currentStatus(),
      watched,
      total,
      year: toYear(f.year.value),
      cour: COUR[f.cour.value] ? f.cour.value : null,
      rating: state.rating,
      note: f.note.value.trim().slice(0, 5000),
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
  for (const dialog of [els.editor, els.menu]) {
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
    const payload = { app: 'anime-log', version: 1, exportedAt: new Date().toISOString(), items: state.items };
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
      els.menu.close();
      commit();
      toast(`${added}件を追加し、${updated}件を更新しました`);
    } catch {
      toast('読み込めませんでした。このアプリで書き出したバックアップ（.json）を選んでください');
    }
  });

  /* ---------- start ---------- */
  buildYearOptions();
  load();
  setMode(state.mode);
  // 記録した作品の配信サービスを出すため、画面を出した後で作品一覧を読み込む
  setTimeout(loadCatalog, 600);

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
