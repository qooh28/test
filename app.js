/* アニメ視聴記録 — 記録はこの端末の localStorage に保存する */
(() => {
  'use strict';

  const STORE_KEY = 'anime-log:v1';
  const PREFS_KEY = 'anime-log:prefs';
  const SEGMENT_LIMIT = 30; // この話数までは1話ずつのコマで表示し、超えたら1本のバーにする
  const FIRST_TV_ANIME_YEAR = 1963; // 年の選択肢の下限（国産初の連続TVアニメの年）

  const STATUS = { want: '見たい', watching: '視聴中', done: '見終わった', dropped: '中断' };
  const COUR = { winter: '冬', spring: '春', summer: '夏', fall: '秋' };
  const COUR_RANK = { winter: 1, spring: 2, summer: 3, fall: 4 };
  const TABS = ['all', 'watching', 'want', 'done', 'dropped'];

  const collator = new Intl.Collator('ja');
  const SORTS = {
    updated: (a, b) => b.updatedAt - a.updatedAt,
    season: (a, b) => seasonRank(b) - seasonRank(a) || b.updatedAt - a.updatedAt,
    rating: (a, b) => b.rating - a.rating || b.updatedAt - a.updatedAt,
    title: (a, b) => collator.compare(a.title, b.title),
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    summary: $('summary'),
    search: $('search'),
    tabs: $('tabs'),
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
    toast: $('toast'),
    toastMsg: $('toast-msg'),
    toastAction: $('toast-action'),
    editor: $('editor'),
    editorTitle: $('editor-title'),
    editorBody: $('editor-body'),
    form: $('editor-form'),
    titleError: $('f-title-error'),
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
    items: [],
    tab: 'all',
    query: '',
    sort: 'updated',
    order: [], // 表示中の並び。＋1話を押しても並びが動かないように保持する
    editingId: null,
    rating: 0,
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
      if (TABS.includes(prefs.tab)) state.tab = prefs.tab;
      if (SORTS[prefs.sort]) state.sort = prefs.sort;
    }
    els.sort.value = state.sort;
  }

  function save() {
    const ok = writeJSON(STORE_KEY, { version: 1, items: state.items });
    els.storageWarn.hidden = ok;
    return ok;
  }

  function savePrefs() {
    writeJSON(PREFS_KEY, { tab: state.tab, sort: state.sort });
  }

  function commit(renderOptions) {
    save();
    render(renderOptions);
  }

  /* ---------- render ---------- */
  function render({ keepOrder = false } = {}) {
    renderSummary();
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
      body = '「作品を追加」から、見たいアニメや視聴中のアニメを登録しましょう。';
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
  ${item.note ? `<p class="note">${esc(item.note)}</p>` : ''}
  <div class="card-foot">
    <span class="count">${countHTML(item)}</span>
    ${starsHTML(item.rating)}
    ${episodeButtonsHTML(item, title)}
  </div>
</article>`;
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
    state.query = els.search.value.trim();
    render();
  });

  els.sort.addEventListener('change', () => {
    state.sort = SORTS[els.sort.value] ? els.sort.value : 'updated';
    savePrefs();
    render();
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

  function openEditor(id = null) {
    const item = id ? findItem(id) : null;
    state.editingId = item ? item.id : null;
    els.editorTitle.textContent = item ? '作品を編集' : '作品を登録';
    f.title.value = item ? item.title : '';
    setStatus(item ? item.status : 'watching');
    f.watched.value = String(item ? item.watched : 0);
    f.total.value = item && item.total ? String(item.total) : '';
    if (item) ensureYearOption(item.year);
    f.year.value = item && item.year ? String(item.year) : '';
    f.cour.value = item && item.cour ? item.cour : '';
    setRating(item ? item.rating : 0);
    f.note.value = item ? item.note : '';
    els.titleError.hidden = true;
    els.delete.hidden = !item;
    showConfirm(false);

    els.editor.showModal();
    els.editorBody.scrollTop = 0;
    if (!item) f.title.focus();
  }

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
    const data = {
      title: title.slice(0, 200),
      status: currentStatus(),
      watched,
      total,
      year: toYear(f.year.value),
      cour: COUR[f.cour.value] ? f.cour.value : null,
      rating: state.rating,
      note: f.note.value.trim().slice(0, 5000),
      sample: false,
    };
    const now = Date.now();
    let message;

    const existing = state.editingId ? findItem(state.editingId) : null;
    if (existing) {
      Object.assign(existing, data, { updatedAt: now });
      message = '保存しました';
    } else {
      const item = normalize({ ...data, id: newId(), createdAt: now, updatedAt: now });
      state.items.push(item);
      message = `「${item.title}」を登録しました`;
      // 今の絞り込みでは見えない作品を登録したら、絞り込みを外して見えるようにする
      if (!matches(item, fold(state.query))) {
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

  $('add').addEventListener('click', () => openEditor());
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
  render();

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
