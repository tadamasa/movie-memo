import * as db from './db.js';
import * as tmdb from './tmdb.js';
import * as gemini from './gemini.js';
import * as sync from './sync.js';
import { exportData, importData } from './backup.js';
import {
  EMOTIONS, EMOTION_LABEL, FACTORS, FACTOR_LABEL, PLACES, PLACE_LABEL, VIVID, VIVID_LABEL,
  ymd, dateLabel, dateSortKey, dueAfterglows, currentScore, filmScore, drift, driftRanking,
  onThisSeason, emotionProfile, emotionGaps, bestByYear, REGIONS, DECADES, gapGrid,
  pickThreadSeeds, weaveThreads, LENSES, LENS_LABEL, buildSuggestPrompt, parseSuggest, findFilm,
} from './core.js';

// ---------- 状態 ----------
const state = { films: [], views: [] };
let shelfFilter = 'seen';
let shelfSort = 'date';
let shelfQuery = '';
let addMode = 'seen';
let lookRange = 'all';
let threadResult = null; // 作り手の糸の最後の結果(画面を移っても残す)
let suggestResult = null;
let gapResult = null;
let unwatchSync = null;

const $view = document.getElementById('view');

// ---------- ユーティリティ ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, ms = 2600) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

function setTitle(text, { back = false } = {}) {
  document.getElementById('nav-title').textContent = text;
  document.getElementById('nav-title-large').textContent = text;
  document.getElementById('back').hidden = !back;
  document.title = `${text} - 映画メモ`;
}

function setTab(tab) {
  for (const a of document.querySelectorAll('.tabbar__item')) {
    const on = a.dataset.tab === tab;
    a.classList.toggle('is-active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

const filmById = id => state.films.find(f => f.id === id);
const viewsOf = filmId => state.views.filter(v => v.filmId === filmId).sort((a, b) => dateSortKey(b).localeCompare(dateSortKey(a)));
const recentViews = () => state.views.slice().sort((a, b) => dateSortKey(b).localeCompare(dateSortKey(a)) || (b.createdAt || '').localeCompare(a.createdAt || ''));

async function load() {
  [state.films, state.views] = await Promise.all([db.getAll('films'), db.getAll('views')]);
  tmdb.setKey(await db.getMeta('tmdbKey', ''));
  shelfSort = (await db.getMeta('shelfSort')) || shelfSort;
}

async function saveFilm(f) {
  f.updatedAt = new Date().toISOString();
  if (!f.createdAt) f.createdAt = f.updatedAt;
  await db.put('films', f);
  const i = state.films.findIndex(x => x.id === f.id);
  if (i >= 0) state.films[i] = f; else state.films.push(f);
  return f;
}

async function saveView(v) {
  v.updatedAt = new Date().toISOString();
  if (!v.createdAt) v.createdAt = v.updatedAt;
  await db.put('views', v);
  const i = state.views.findIndex(x => x.id === v.id);
  if (i >= 0) state.views[i] = v; else state.views.push(v);
  return v;
}

function posterHtml(f, size = 'sm') {
  const src = tmdb.posterUrl(f && f.posterPath, size === 'lg' ? 'w342' : 'w154');
  const ph = esc(((f && f.title) || '?').slice(0, 1));
  return `<span class="cover cover--${size}" aria-hidden="true"><span class="cover__ph">${ph}</span>${src ? `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
}

function scoreText(s) { return s === null || s === undefined ? '' : `${s}点`; }

function filmMeta(f) {
  return [f.year, (f.directors || []).join('、')].filter(Boolean).join(' ・ ');
}

// 評価スライダー(未評価を表せるように、触るまで薄く出す)
function scoreRow(id, value, label = '評価') {
  const set = typeof value === 'number';
  return `<div class="row score-row"><label for="${id}">${label}</label>
    <input id="${id}" type="range" min="0" max="10" step="1" value="${set ? value : 6}" class="${set ? '' : 'is-unset'}" aria-valuetext="${set ? `${value}点` : '未評価'}">
    <output for="${id}" id="${id}-out">${set ? `${value}<small>/10</small>` : '<small>未評価</small>'}</output></div>`;
}
function bindScore(id) {
  const el = document.getElementById(id);
  const out = document.getElementById(`${id}-out`);
  el.addEventListener('input', () => {
    el.classList.remove('is-unset');
    out.innerHTML = `${el.value}<small>/10</small>`;
    el.setAttribute('aria-valuetext', `${el.value}点`);
  });
  return () => (el.classList.contains('is-unset') ? null : Number(el.value));
}

function chipsHtml(list, selected, name) {
  return `<div class="kinds" role="group" data-chips="${name}">${list.map(([k, l]) => `<button type="button" class="kind ${selected.includes(k) ? 'is-active' : ''}" data-k="${k}" aria-pressed="${selected.includes(k)}">${esc(l)}</button>`).join('')}</div>`;
}
function bindChips(root, name, { single = false } = {}) {
  const box = root.querySelector(`[data-chips="${name}"]`);
  box.querySelectorAll('.kind').forEach(b => b.addEventListener('click', () => {
    const on = !b.classList.contains('is-active');
    if (single) box.querySelectorAll('.kind').forEach(x => { x.classList.remove('is-active'); x.setAttribute('aria-pressed', 'false'); });
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', on);
  }));
  return () => [...box.querySelectorAll('.kind.is-active')].map(b => b.dataset.k);
}

function filmRow(f, sub = '') {
  return `<li><a class="list__row" href="#film/${esc(f.id)}" style="color:inherit;text-decoration:none">
    ${posterHtml(f)}<div class="list__text"><span class="list__title">${esc(f.title)}</span>
    <span class="list__subtitle">${esc(sub || filmMeta(f))}</span></div><span class="list__chevron" aria-hidden="true">›</span></a></li>`;
}

// 外から来た候補(TMDbの検索結果・糸・AIの提案)を「観たい」に入れる。すでにあれば理由だけ足す
async function addWant(info, reason) {
  let f = findFilm(state.films, info);
  if (f) {
    if (f.status === 'seen') { toast('もう観た映画です'); return f; }
    f.want = f.want || { addedAt: new Date().toISOString(), reasons: [] };
    if (reason && !f.want.reasons.includes(reason)) f.want.reasons.push(reason);
    await saveFilm(f);
    toast('観たいに理由を足しました');
    return f;
  }
  f = {
    id: db.uid(), tmdbId: info.tmdbId || null, title: info.title, originalTitle: info.originalTitle || '', year: info.year || null,
    directors: info.directors || (info.director ? [info.director] : []), posterPath: info.posterPath || '', overview: info.overview || '',
    status: 'want', want: { addedAt: new Date().toISOString(), reasons: reason ? [reason] : [] },
  };
  await saveFilm(f);
  toast(`『${f.title}』を観たいに入れました`);
  return f;
}

// TMDbから詳しい情報を取り、映画に足す(キーがあり、まだ取っていないとき)
async function enrich(f, { force = false } = {}) {
  if (!f.tmdbId || !tmdb.hasKey() || (f.fetchedAt && !force)) return f;
  try {
    const d = await tmdb.detail(f.tmdbId);
    Object.assign(f, d, { id: f.id, status: f.status, want: f.want, title: f.titleEdited ? f.title : d.title });
    await saveFilm(f);
  } catch (e) { console.warn(e); }
  return f;
}

// ---------- 記録(ホーム) ----------
function renderHome() {
  setTab('home');
  setTitle('記録');
  const due = dueAfterglows(state.views);
  const recent = recentViews().slice(0, 6);
  $view.innerHTML = `
    <div class="actions" style="padding-top:var(--space-2)">
      <a class="btn btn--prominent btn--large" href="#add/seen">観た映画を記録</a>
    </div>
    <div class="actions" style="padding-top:0">
      <a class="btn btn--tinted" href="#add/recall">昔の映画を思い出す</a>
      <a class="btn btn--tinted" href="#add/want">観たいを足す</a>
    </div>
    ${due.length ? `<section class="list-section"><h2 class="list-section__header">余韻をたずねる</h2>
      ${due.map(afterglowCard).join('')}
      <p class="list-section__footer">観た直後の評価と、時間がたってからの評価は違うことがあります。思い出すたびに付け直すのではなく、1週間後と3か月後に一度ずつだけ聞きます。</p></section>` : ''}
    ${recent.length ? `<section class="list-section"><h2 class="list-section__header">最近の鑑賞</h2><ul class="list list--inset">
      ${recent.map(v => { const f = filmById(v.filmId); return f ? filmRow(f, [dateLabel(v), PLACE_LABEL[v.place], scoreText(currentScore(v))].filter(Boolean).join(' ・ ')) : ''; }).join('')}
    </ul></section>` : `<div class="empty">
      <p class="empty__title">最初の1本を記録しましょう</p>
      <p class="empty__message">点数より先に「いちばんの場面」と「観終わった直後の気持ち」を一言ずつ残します。昔観た映画は、覚えている場面だけで記録できます。</p>
    </div>`}`;
  bindAfterglow($view, renderHome);
}

function afterglowCard({ view, label }) {
  const f = filmById(view.filmId);
  if (!f) return '';
  const now = currentScore(view);
  return `<div class="card afterglow" data-view="${esc(view.id)}">
    <div class="afterglow__head">${posterHtml(f)}<div><b>${esc(f.title)}</b><p class="small muted" style="margin:2px 0 0">観てから${label}。${view.peak ? `あのとき「${esc(view.peak.slice(0, 40))}」と書きました。` : ''}いま思い出すと?</p></div></div>
    <div class="segmented" role="group" data-vivid>${VIVID.map(([k, l]) => `<button type="button" class="segmented__item" data-k="${k}">${l}</button>`).join('')}</div>
    ${scoreRow(`ag-${view.id}`, now, '今の評価')}
    <textarea class="field" rows="2" data-note placeholder="いま残っている場面・考えていること(任意)"></textarea>
    <div class="actions" style="padding:var(--space-2) 0 0"><button class="btn btn--plain btn--small" data-skip>今回はとばす</button><button class="btn btn--prominent btn--small" data-save>残す</button></div>
  </div>`;
}

function bindAfterglow(root, rerender) {
  root.querySelectorAll('.afterglow').forEach(card => {
    const v = state.views.find(x => x.id === card.dataset.view);
    const due = dueAfterglows([v])[0];
    let vivid = null;
    card.querySelectorAll('[data-vivid] .segmented__item').forEach(b => b.addEventListener('click', () => {
      vivid = b.dataset.k;
      card.querySelectorAll('[data-vivid] .segmented__item').forEach(x => x.classList.toggle('is-active', x === b));
    }));
    const getScore = bindScore(`ag-${v.id}`);
    const save = async skipped => {
      v.afterglow = v.afterglow || [];
      v.afterglow.push(skipped ? { checkpoint: due.checkpoint, at: ymd(), skipped: true }
        : { checkpoint: due.checkpoint, at: ymd(), vivid, score: getScore(), note: card.querySelector('[data-note]').value.trim() });
      await saveView(v);
      const d = drift(v);
      toast(skipped ? 'とばしました' : d >= 1 ? `あとから効いた映画です(+${d})` : d <= -1 ? `余韻で${d}になりました` : '残しました');
      rerender();
    };
    card.querySelector('[data-save]').addEventListener('click', () => {
      if (!vivid && getScore() === null) { toast('鮮明さか評価のどちらかを選んでください'); return; }
      save(false);
    });
    card.querySelector('[data-skip]').addEventListener('click', () => save(true));
  });
}

// ---------- 映画を追加 ----------
const ADD_MODES = [['seen', '観た'], ['recall', '昔観た'], ['want', '観たい']];

function renderAdd(mode) {
  if (ADD_MODES.some(([k]) => k === mode)) addMode = mode;
  setTab('home');
  setTitle('映画を探す', { back: true });
  $view.innerHTML = `
    <div class="segmented-wrap" style="padding-top:var(--space-2)"><div class="segmented" role="tablist">
      ${ADD_MODES.map(([k, l]) => `<button class="segmented__item ${k === addMode ? 'is-active' : ''}" role="tab" aria-selected="${k === addMode}" data-m="${k}">${l}</button>`).join('')}
    </div></div>
    <label class="search"><span aria-hidden="true">⌕</span><input id="q" type="search" enterkeyhint="search" placeholder="題名で探す" aria-label="題名で探す" autocomplete="off"></label>
    <div id="results">${tmdb.hasKey() ? '' : `<p class="list-section__footer">設定でTMDbのキーを入れると、題名から作品情報とポスターを探せます。キーがなくても下で手入力できます。</p>`}</div>
    <details class="fold" ${tmdb.hasKey() ? '' : 'open'}><summary>手で入力する</summary><div class="fold__body">
      <div class="card">
        <div class="row"><label for="m-title">題名</label><input id="m-title" placeholder="必須"></div>
        <div class="row"><label for="m-year">公開年</label><input id="m-year" inputmode="numeric" placeholder="例 1999"></div>
        <div class="row"><label for="m-dir">監督</label><input id="m-dir" placeholder="任意"></div>
      </div>
      <div class="actions"><button class="btn btn--tinted" id="m-add">この内容で進む</button></div>
    </div></details>`;
  $view.querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => { addMode = b.dataset.m; renderAdd(addMode); }));
  const q = document.getElementById('q');
  const results = document.getElementById('results');
  let timer = null;
  const run = async () => {
    const text = q.value.trim();
    if (!text) { results.innerHTML = ''; return; }
    if (!tmdb.hasKey()) { document.getElementById('m-title').value = text; return; }
    results.innerHTML = '<p class="list-section__footer">探しています…</p>';
    try {
      const list = await tmdb.search(text);
      if (q.value.trim() !== text) return;
      results.innerHTML = list.length ? `<section class="list-section" style="margin-top:var(--space-3)"><ul class="list list--inset">${list.map((r, i) => {
        const mine = findFilm(state.films, r);
        return `<li><button class="list__row" data-i="${i}" style="width:100%;text-align:left">${posterHtml(r)}<div class="list__text"><span class="list__title">${esc(r.title)}</span>
          <span class="list__subtitle">${esc([r.year, r.originalTitle, mine ? (mine.status === 'seen' ? '観た' : '観たい') : ''].filter(Boolean).join(' ・ '))}</span></div></button></li>`;
      }).join('')}</ul></section>` : '<p class="list-section__footer">見つかりませんでした。題名の一部や原題でも探せます。</p>';
      results.querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', () => choose(list[Number(b.dataset.i)])));
    } catch (e) { results.innerHTML = `<p class="list-section__footer">${esc(e.message)}</p>`; }
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 450); });
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
  document.getElementById('m-add').addEventListener('click', () => {
    const title = document.getElementById('m-title').value.trim();
    if (!title) { document.getElementById('m-title').focus(); return; }
    const y = Number(document.getElementById('m-year').value.trim()) || null;
    const dir = document.getElementById('m-dir').value.trim();
    choose({ title, year: y, directors: dir ? [dir] : [] });
  });
  setTimeout(() => q.focus(), 50);
}

async function choose(info) {
  if (addMode === 'want') {
    const f = await addWant(info, '');
    location.hash = `#film/${f.id}`;
    enrich(f);
    return;
  }
  let f = findFilm(state.films, info);
  if (!f) {
    f = { id: db.uid(), tmdbId: info.tmdbId || null, title: info.title, originalTitle: info.originalTitle || '', year: info.year || null, directors: info.directors || [], posterPath: info.posterPath || '', overview: info.overview || '', status: 'seen' };
    await saveFilm(f);
  }
  location.hash = `#log/${f.id}/${addMode === 'recall' ? 'recall' : 'new'}`;
  enrich(f);
}

// ---------- 鑑賞を記録・直す ----------
function renderLog(filmId, arg) {
  const f = filmById(filmId);
  if (!f) { location.hash = '#home'; return; }
  const editing = arg && arg !== 'new' && arg !== 'recall' ? state.views.find(v => v.id === arg) : null;
  const recall = editing ? !!editing.recall : arg === 'recall';
  const v = editing || { id: db.uid(), filmId, recall, date: recall ? '' : ymd(), place: recall ? '' : 'theater', emotions: [], factors: [] };
  setTab('home');
  setTitle(editing ? '鑑賞を直す' : recall ? '思い出して記録' : '鑑賞を記録', { back: true });
  $view.innerHTML = `
    <div class="book-head book-head--cover">${posterHtml(f)}<div><h2>${esc(f.title)}</h2><p class="muted small">${esc(filmMeta(f))}</p></div></div>
    ${recall ? `<p class="list-section__footer" style="margin-top:0">記憶は思い出すたびに組み立て直されます(Bartlett『Remembering』1932)。いま残っている場面こそ、この映画があなたに残したものです。思い出せないところは空けておいて構いません。</p>` : ''}
    <div class="card">
      ${recall
        ? `<div class="row"><label for="v-date">時期</label><input id="v-date" placeholder="例 2015 / 2015-08" value="${esc(v.date)}" inputmode="numeric"></div>
           <div class="row"><label for="v-datenote">ことば</label><input id="v-datenote" placeholder="例 学生時代、引っ越した年" value="${esc(v.dateNote || '')}"></div>`
        : `<div class="row"><label for="v-date">観た日</label><input id="v-date" type="date" value="${esc(v.date)}"></div>`}
      <div class="row"><label for="v-place">場所</label><select id="v-place"><option value="">-</option>${PLACES.map(([k, l]) => `<option value="${k}" ${v.place === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="row"><label for="v-venue">劇場・サービス</label><input id="v-venue" value="${esc(v.venue || '')}" placeholder="任意"></div>
      <div class="row"><label for="v-with">誰と</label><input id="v-with" value="${esc(v.with || '')}" placeholder="任意"></div>
      ${scoreRow('v-score', v.score)}
    </div>
    <h3 class="form-label">${recall ? '覚えている場面' : 'いちばんの場面'}</h3>
    <div class="card"><textarea class="field field--note" id="v-peak" placeholder="${recall ? '何年たっても浮かぶ場面・台詞・音' : '心がいちばん動いた瞬間。台詞・音・構図でも'}">${esc(v.peak || '')}</textarea></div>
    <h3 class="form-label">${recall ? 'いま思い返して' : '観終わった直後の気持ち'}</h3>
    <div class="card"><textarea class="field" rows="3" id="v-ending" placeholder="${recall ? '思い出したら、どんな気分になるか' : '劇場を出たとき・画面を消したときの一言'}">${esc(v.ending || '')}</textarea></div>
    <h3 class="form-label">心が動いた種類</h3>
    ${chipsHtml(EMOTIONS, v.emotions || [], 'emo')}
    <h3 class="form-label">何が効いたか</h3>
    ${chipsHtml(FACTORS, v.factors || [], 'fac')}
    <h3 class="form-label">メモ</h3>
    <div class="card"><textarea class="field" rows="3" id="v-memo" placeholder="考えたこと・調べたいこと(任意)">${esc(v.memo || '')}</textarea></div>
    <div class="actions">${editing ? '<button class="btn btn--destructive" id="v-del">この記録を消す</button>' : ''}<button class="btn btn--prominent" id="v-save">保存</button></div>`;
  const getScore = bindScore('v-score');
  const getEmo = bindChips($view, 'emo');
  const getFac = bindChips($view, 'fac');
  document.getElementById('v-save').addEventListener('click', async () => {
    const date = document.getElementById('v-date').value.trim();
    if (recall && date && !/^\d{4}(-\d{2})?(-\d{2})?$/.test(date)) { toast('時期は 2015 や 2015-08 の形で入れてください'); return; }
    Object.assign(v, {
      date, dateNote: recall ? document.getElementById('v-datenote').value.trim() : '',
      place: document.getElementById('v-place').value, venue: document.getElementById('v-venue').value.trim(), with: document.getElementById('v-with').value.trim(),
      score: getScore(), peak: document.getElementById('v-peak').value.trim(), ending: document.getElementById('v-ending').value.trim(),
      emotions: getEmo(), factors: getFac(), memo: document.getElementById('v-memo').value.trim(),
    });
    await saveView(v);
    if (f.status !== 'seen') { f.status = 'seen'; f.seenAt = ymd(); }
    await saveFilm(f);
    toast(editing ? '直しました' : recall ? '思い出を残しました' : '残しました。1週間後に余韻をたずねます');
    location.hash = `#film/${f.id}`;
  });
  const del = document.getElementById('v-del');
  if (del) del.addEventListener('click', async () => {
    if (!confirm('この鑑賞の記録を消しますか。')) return;
    await db.del('views', v.id);
    state.views = state.views.filter(x => x.id !== v.id);
    location.hash = `#film/${f.id}`;
  });
}

// ---------- 映画の詳細 ----------
function viewHtml(v) {
  const s = currentScore(v), d = drift(v);
  const ag = (v.afterglow || []).filter(a => !a.skipped);
  return `<li class="note">
    <div class="note__meta" style="margin:0 0 var(--space-1)"><b>${esc(dateLabel(v))}</b>${v.recall ? '<span class="tag">思い出し</span>' : ''}${v.place ? `<span>${esc(PLACE_LABEL[v.place])}${v.venue ? `(${esc(v.venue)})` : ''}</span>` : ''}${v.with ? `<span>${esc(v.with)}と</span>` : ''}${s !== null ? `<span>${s}点${d ? `(余韻で${d > 0 ? '+' : ''}${d})` : ''}</span>` : ''}<a href="#log/${esc(v.filmId)}/${esc(v.id)}" style="margin-left:auto">直す</a></div>
    ${v.peak ? `<p class="note__quote">${esc(v.peak)}</p>` : ''}
    ${v.ending ? `<p class="note__text">${esc(v.ending)}</p>` : ''}
    ${(v.emotions || []).length || (v.factors || []).length ? `<div class="tags">${(v.emotions || []).map(e => `<span class="tag">${esc(EMOTION_LABEL[e])}</span>`).join('')}${(v.factors || []).map(e => `<span class="tag tag--factor">${esc(FACTOR_LABEL[e])}が効いた</span>`).join('')}</div>` : ''}
    ${v.memo ? `<p class="note__text small" style="margin-top:var(--space-2)">${esc(v.memo)}</p>` : ''}
    ${ag.map(a => `<p class="afterglow-log small"><span>${a.checkpoint === 7 ? '1週間後' : '3か月後'}</span>${a.vivid ? esc(VIVID_LABEL[a.vivid]) : ''}${typeof a.score === 'number' ? ` ・ ${a.score}点` : ''}${a.note ? ` ・ ${esc(a.note)}` : ''}</p>`).join('')}
  </li>`;
}

function renderFilm(id) {
  const f = filmById(id);
  if (!f) { location.hash = '#shelf'; return; }
  setTab(f.status === 'want' ? 'explore' : 'shelf');
  setTitle(f.status === 'want' ? '観たい映画' : '観た映画', { back: true });
  const vs = viewsOf(f.id);
  const crewRows = Object.entries(f.crew || {}).filter(([, ps]) => ps.length).map(([role, ps]) =>
    `<div class="row links-row"><span class="links-row__group">${esc(tmdb.ROLES[role] ? tmdb.ROLES[role].label : role)}</span><span class="links-row__items">${ps.slice(0, 3).map(p => `<a class="btn btn--small btn--tinted" href="#person/${p.id}/${encodeURIComponent(p.name)}">${esc(p.name)}</a>`).join('')}</span></div>`).join('');
  const castRow = (f.cast || []).length ? `<div class="row links-row"><span class="links-row__group">出演</span><span class="links-row__items">${f.cast.slice(0, 6).map(p => `<a class="btn btn--small btn--plain" href="#person/${p.id}/${encodeURIComponent(p.name)}?cast">${esc(p.name)}</a>`).join('')}</span></div>` : '';
  const pv = f.providers;
  $view.innerHTML = `
    <div class="book-head book-head--cover">${posterHtml(f, 'lg')}<div>
      <h2>${esc(f.title)}</h2>
      ${f.originalTitle ? `<p class="muted small">${esc(f.originalTitle)}</p>` : ''}
      <p class="muted small">${esc([f.year, (f.directors || []).length ? `監督 ${f.directors.join('、')}` : '', f.runtime ? `${f.runtime}分` : ''].filter(Boolean).join(' ・ '))}</p>
      ${(f.genres || []).length ? `<div class="tags">${f.genres.map(g => `<span class="tag">${esc(g)}</span>`).join('')}</div>` : ''}
      ${filmScore(f, state.views) !== null ? `<p class="film-score">${filmScore(f, state.views)}<small>/10</small></p>` : ''}
    </div></div>
    <div class="actions" style="padding-top:0">
      <a class="btn btn--prominent" href="#log/${esc(f.id)}/new">${vs.length ? 'もう一度観た' : '観た'}</a>
      ${vs.length ? '' : `<a class="btn btn--tinted" href="#log/${esc(f.id)}/recall">昔観た</a>`}
    </div>
    ${f.status === 'want' && f.want ? `<section class="list-section"><h2 class="list-section__header">観たいと思ったきっかけ</h2>
      <div class="card">${(f.want.reasons || []).length ? f.want.reasons.map(r => `<p class="small" style="margin:0 0 var(--space-1)">${esc(r)}</p>`).join('') : ''}
        <textarea class="field" rows="2" id="w-reason" placeholder="誰に勧められた・何で知った(任意)"></textarea></div>
      <div class="actions" style="padding-bottom:0"><button class="btn btn--tinted btn--small" id="w-add">きっかけを足す</button><button class="btn btn--plain btn--small" id="w-drop">観たいから外す</button></div></section>` : ''}
    ${vs.length ? `<section class="list-section"><h2 class="list-section__header">鑑賞の記録 ${vs.length}回</h2><ul class="list list--inset">${vs.map(viewHtml).join('')}</ul></section>` : ''}
    ${f.tmdbId ? `<section class="list-section"><h2 class="list-section__header">日本で観られるところ</h2><div class="card">
      ${pv ? `${pv.flatrate.length ? `<p class="small" style="margin:0">見放題: <b>${pv.flatrate.map(esc).join('、')}</b></p>` : '<p class="small muted" style="margin:0">見放題の配信は見つかりません</p>'}
        ${pv.rent.length ? `<p class="small" style="margin:var(--space-1) 0 0">レンタル: ${pv.rent.map(esc).join('、')}</p>` : ''}
        <p class="small muted" style="margin:var(--space-1) 0 0">${esc((pv.checkedAt || '').slice(0, 10))}時点 ・ データ: JustWatch ${pv.link ? `・ <a href="${esc(pv.link)}" target="_blank" rel="noopener">詳しく</a>` : ''}</p>`
      : '<p class="small muted" style="margin:0">まだ確かめていません</p>'}
      </div><div class="actions" style="padding-bottom:0"><button class="btn btn--plain btn--small" id="f-refresh">${tmdb.hasKey() ? '作品情報と配信を取り直す' : '設定でTMDbのキーを入れると取れます'}</button></div></section>` : ''}
    ${crewRows || castRow ? `<section class="list-section"><h2 class="list-section__header">作り手</h2><div class="card">${crewRows}${castRow}</div>
      <p class="list-section__footer">名前を押すと、その人が関わったほかの映画を出します。</p></section>` : ''}
    ${f.overview ? `<section class="list-section"><h2 class="list-section__header">あらすじ</h2><div class="card"><p class="summary">${esc(f.overview)}</p></div></section>` : ''}
    <section class="list-section"><h2 class="list-section__header">外で調べる</h2><div class="card"><div class="links-row__items">${extLinks(f).map(l => `<a class="btn btn--small btn--plain" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('')}</div></div></section>
    <div class="actions"><button class="btn btn--destructive btn--small" id="f-del">この映画を消す</button></div>`;
  const refresh = document.getElementById('f-refresh');
  if (refresh && tmdb.hasKey()) refresh.addEventListener('click', async () => { refresh.disabled = true; refresh.textContent = '取っています…'; await enrich(f, { force: true }); renderFilm(f.id); });
  const wAdd = document.getElementById('w-add');
  if (wAdd) wAdd.addEventListener('click', async () => {
    const t = document.getElementById('w-reason').value.trim();
    if (!t) return;
    f.want.reasons.push(t);
    await saveFilm(f);
    renderFilm(f.id);
  });
  const wDrop = document.getElementById('w-drop');
  if (wDrop) wDrop.addEventListener('click', async () => {
    if (!confirm('観たいから外しますか(映画ごと消えます)。')) return;
    await removeFilm(f);
    location.hash = '#explore';
  });
  document.getElementById('f-del').addEventListener('click', async () => {
    if (!confirm(`『${f.title}』と、その鑑賞の記録${vs.length ? `${vs.length}件` : ''}を消しますか。`)) return;
    await removeFilm(f);
    location.hash = '#shelf';
  });
  // まだ詳しい情報がなければ取りにいく
  if (f.tmdbId && !f.fetchedAt && tmdb.hasKey()) enrich(f).then(() => { if (location.hash === `#film/${f.id}`) renderFilm(f.id); });
}

async function removeFilm(f) {
  for (const v of viewsOf(f.id)) await db.del('views', v.id);
  await db.del('films', f.id);
  state.views = state.views.filter(v => v.filmId !== f.id);
  state.films = state.films.filter(x => x.id !== f.id);
}

function extLinks(f) {
  const q = encodeURIComponent([f.title, f.year].filter(Boolean).join(' '));
  const qt = encodeURIComponent(f.title);
  return [
    { label: 'Filmarks', url: `https://filmarks.com/search/movies?q=${qt}` },
    { label: '映画.com', url: `https://eiga.com/search/${qt}/` },
    { label: 'Wikipedia', url: `https://ja.wikipedia.org/w/index.php?search=${encodeURIComponent(`${f.title} 映画`)}` },
    { label: '予告編', url: `https://www.youtube.com/results?search_query=${encodeURIComponent(`${f.title} 予告`)}` },
    { label: '感想(X)', url: `https://x.com/search?q=${q}&f=live` },
    ...(f.tmdbId ? [{ label: 'TMDb', url: `https://www.themoviedb.org/movie/${f.tmdbId}?language=ja-JP` }] : []),
  ];
}

// ---------- 人(監督・撮影監督など) ----------
async function renderPerson(personId, name) {
  setTab('explore');
  setTitle(name || '作り手', { back: true });
  if (!tmdb.hasKey()) { $view.innerHTML = '<div class="empty"><p class="empty__message">設定でTMDbのキーを入れると、この人が関わった映画を出せます。</p></div>'; return; }
  $view.innerHTML = '<p class="list-section__footer">探しています…</p>';
  let credits;
  try { credits = await personCreditsCached(personId); } catch (e) { $view.innerHTML = `<p class="list-section__footer">${esc(e.message)}</p>`; return; }
  const byJob = {};
  for (const c of credits) {
    const job = tmdb.ROLES[c.job] ? tmdb.ROLES[c.job].label : null;
    if (!job || !c.year) continue;
    (byJob[job] = byJob[job] || new Map()).set(c.tmdbId, c);
  }
  const sections = Object.entries(byJob).map(([job, m]) => {
    const list = [...m.values()].sort((a, b) => (b.year || 0) - (a.year || 0));
    return `<section class="list-section"><h2 class="list-section__header">${esc(job)}として ${list.length}本</h2><ul class="list list--inset">${list.map(c => candRow(c, `${name}が${job}`)).join('')}</ul></section>`;
  }).join('');
  $view.innerHTML = sections || '<div class="empty"><p class="empty__message">監督・脚本・撮影・音楽・編集として関わった映画は見つかりませんでした。</p></div>';
  bindCands($view);
}

// 候補の行: 観た・観たいの印か、観たいボタン
function candRow(c, reason, extra = '') {
  const mine = findFilm(state.films, c);
  const right = mine ? `<a class="tag" href="#film/${esc(mine.id)}">${mine.status === 'seen' ? '観た' : '観たい'}</a>`
    : `<button class="btn btn--small btn--tinted" data-want='${esc(JSON.stringify({ tmdbId: c.tmdbId || null, title: c.title, originalTitle: c.originalTitle || '', year: c.year || null, posterPath: c.posterPath || '', director: c.director || '', reason }))}'>観たい</button>`;
  return `<li class="list__row cand">${posterHtml(c)}<div class="list__text"><span class="list__title">${esc(c.title)}</span>
    <span class="list__subtitle">${esc([c.year, c.originalTitle, c.director].filter(Boolean).join(' ・ '))}</span>${extra}</div>${right}</li>`;
}
function bindCands(root) {
  root.querySelectorAll('[data-want]').forEach(b => b.addEventListener('click', async () => {
    const info = JSON.parse(b.dataset.want);
    const f = await addWant(info, info.reason);
    b.outerHTML = `<a class="tag" href="#film/${esc(f.id)}">観たい</a>`;
    enrich(f);
  }));
}

async function personCreditsCached(personId) {
  const cache = (await db.getMeta('personCache')) || {};
  const hit = cache[personId];
  if (hit && Date.now() - hit.at < 30 * 864e5) return hit.credits;
  const credits = await tmdb.personCredits(personId);
  // 役割のある作品だけ、軽くして残す
  const slim = credits.filter(c => tmdb.ROLES[c.job]).map(({ tmdbId, title, originalTitle, year, posterPath, voteCount, job }) => ({ tmdbId, title, originalTitle, year, posterPath, voteCount, job }));
  cache[personId] = { at: Date.now(), credits: slim };
  const keys = Object.keys(cache);
  if (keys.length > 200) keys.sort((a, b) => cache[a].at - cache[b].at).slice(0, keys.length - 200).forEach(k => delete cache[k]);
  await db.setMeta('personCache', cache);
  return slim;
}

// ---------- 映画棚 ----------
const SORTS = {
  date: { label: '観た日', key: f => (viewsOf(f.id)[0] ? dateSortKey(viewsOf(f.id)[0]) : (f.want && f.want.addedAt) || f.createdAt || '') },
  score: { label: '評価', key: f => { const s = filmScore(f, state.views); return s === null ? '' : String(s).padStart(2, '0'); } },
  year: { label: '公開年', key: f => (f.year ? String(f.year) : '') },
  drift: { label: 'あとから効いた順', key: f => { const ds = viewsOf(f.id).map(drift).filter(d => d !== null); return ds.length ? String(100 + Math.max(...ds)).padStart(3, '0') : ''; } },
};

function renderShelf() {
  setTab('shelf');
  setTitle('映画棚');
  const filters = [['seen', '観た'], ['want', '観たい'], ['all', 'すべて']];
  const q = shelfQuery.normalize('NFKC').toLowerCase();
  const list = state.films
    .filter(f => shelfFilter === 'all' || f.status === shelfFilter)
    .filter(f => !q || `${f.title} ${f.originalTitle || ''} ${(f.directors || []).join(' ')}`.normalize('NFKC').toLowerCase().includes(q))
    .map(f => ({ f, k: SORTS[shelfSort].key(f) }))
    .sort((a, b) => (!a.k !== !b.k ? (a.k ? -1 : 1) : b.k.localeCompare(a.k)))
    .map(x => x.f);
  const counts = Object.fromEntries(filters.map(([k]) => [k, k === 'all' ? state.films.length : state.films.filter(f => f.status === k).length]));
  $view.innerHTML = `
    <label class="search"><span aria-hidden="true">⌕</span><input id="shelf-q" type="search" placeholder="題名・監督で絞り込み" value="${esc(shelfQuery)}" aria-label="映画棚を検索"></label>
    <div class="segmented-wrap" style="margin-top:var(--space-3)"><div class="segmented" role="tablist">
      ${filters.map(([k, l]) => `<button class="segmented__item ${k === shelfFilter ? 'is-active' : ''}" role="tab" aria-selected="${k === shelfFilter}" data-f="${k}">${l} ${counts[k]}</button>`).join('')}
    </div></div>
    <div class="sort-bar"><label for="shelf-sort">並び順</label>
      <select id="shelf-sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${k === shelfSort ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
    <section class="list-section" style="margin-top:var(--space-3)">
      ${list.length ? `<ul class="list list--inset">${list.slice(0, 400).map(f => filmRow(f, shelfSub(f))).join('')}</ul>`
        : '<div class="empty"><p class="empty__message">まだありません。記録タブから追加できます。</p></div>'}
    </section>`;
  const input = document.getElementById('shelf-q');
  input.addEventListener('input', () => {
    shelfQuery = input.value;
    const pos = input.selectionStart;
    renderShelf();
    const again = document.getElementById('shelf-q');
    again.focus();
    again.setSelectionRange(pos, pos);
  });
  $view.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => { shelfFilter = b.dataset.f; renderShelf(); }));
  document.getElementById('shelf-sort').addEventListener('change', e => { shelfSort = e.target.value; db.setMeta('shelfSort', shelfSort); renderShelf(); });
}

function shelfSub(f) {
  const vs = viewsOf(f.id);
  if (f.status === 'want') return [f.year, (f.providers && f.providers.flatrate.length) ? `見放題: ${f.providers.flatrate.slice(0, 2).join('、')}` : (f.want && f.want.reasons[0]) || ''].filter(Boolean).join(' ・ ');
  const s = filmScore(f, state.views);
  const ds = vs.map(drift).filter(d => d !== null);
  const d = ds.length ? Math.max(...ds) : null;
  return [vs[0] ? dateLabel(vs[0]) : '', vs.length > 1 ? `${vs.length}回` : '', s !== null ? `${s}点` : '', d ? `余韻${d > 0 ? '+' : ''}${d}` : ''].filter(Boolean).join(' ・ ');
}

// ---------- 振り返り ----------
function renderLook() {
  setTab('look');
  setTitle('振り返り');
  const thisYear = String(new Date().getFullYear());
  const vs = state.views;
  if (!vs.length) {
    $view.innerHTML = `<div class="empty"><p class="empty__title">まだ振り返る記録がありません</p>
      <p class="empty__message">観た映画や、昔観た映画を思い出して記録すると、名場面の壁、あとから効いた映画、心が動いた種類がここに並びます。</p>
      <a class="btn btn--prominent" href="#add/recall">昔観た映画を思い出す</a></div>`;
    return;
  }
  const yearViews = vs.filter(v => (v.date || '').startsWith(thisYear) && !v.recall);
  const theater = yearViews.filter(v => v.place === 'theater').length;
  const season = onThisSeason(vs);
  const peaks = vs.filter(v => v.peak && filmById(v.filmId));
  const wall = shuffle(peaks).slice(0, 6);
  const { grew, faded } = driftRanking(vs, state.films);
  const range = lookRange === 'year' ? { from: thisYear, to: `${thisYear}-12-31` } : {};
  const prof = emotionProfile(vs, range).filter(p => p.count).sort((a, b) => b.count - a.count);
  const max = prof.length ? prof[0].count : 1;
  const gaps = emotionGaps(vs);
  const best = bestByYear(vs, state.films);
  $view.innerHTML = `
    <div class="tiles" style="margin-top:var(--space-2)">
      <div class="tile"><span class="tile__label">今年観た</span><span class="tile__value">${yearViews.length}<small>本</small></span><span class="tile__sub">うち映画館 ${theater}</span></div>
      <div class="tile"><span class="tile__label">記録した映画</span><span class="tile__value">${state.films.filter(f => f.status === 'seen').length}</span><span class="tile__sub">思い出し ${vs.filter(v => v.recall).length}</span></div>
      <div class="tile"><span class="tile__label">あとから効いた</span><span class="tile__value">${grew.length}</span><span class="tile__sub">その場かぎり ${faded.length}</span></div>
    </div>
    ${season.length ? `<section class="list-section"><h2 class="list-section__header">いつかの今ごろ観ていた</h2><ul class="list list--inset">
      ${season.slice(0, 5).map(v => filmRow(filmById(v.filmId), `${v.date.slice(0, 4)}年 ・ ${v.peak ? v.peak.slice(0, 30) : PLACE_LABEL[v.place] || ''}`)).join('')}</ul></section>` : ''}
    ${wall.length ? `<section class="list-section"><h2 class="list-section__header">名場面の壁</h2>
      <div class="wall">${wall.map(v => { const f = filmById(v.filmId); return `<a class="wall__item" href="#film/${esc(f.id)}"><p>${esc(v.peak)}</p><span>${esc(f.title)}${v.date ? ` ・ ${esc(dateLabel(v))}` : ''}</span></a>`; }).join('')}</div>
      ${peaks.length > 6 ? '<div class="actions" style="padding-bottom:0"><button class="btn btn--plain btn--small" id="wall-more">ほかの場面</button></div>' : ''}</section>` : ''}
    ${grew.length ? `<section class="list-section"><h2 class="list-section__header">あとから効いた映画</h2><ul class="list list--inset">
      ${grew.slice(0, 8).map(r => filmRow(r.film, `観た直後 ${r.view.score}点 → 今 ${currentScore(r.view)}点`)).join('')}</ul>
      <p class="list-section__footer">観た直後より、時間がたってからの評価が上がった映画です。何がそうさせたのかが、あなたの好みの芯に近いかもしれません。</p></section>` : ''}
    ${faded.length ? `<section class="list-section"><h2 class="list-section__header">その場かぎりだった映画</h2><ul class="list list--inset">
      ${faded.slice(0, 5).map(r => filmRow(r.film, `観た直後 ${r.view.score}点 → 今 ${currentScore(r.view)}点`)).join('')}</ul></section>` : ''}
    <section class="list-section"><h2 class="list-section__header">心が動いた種類</h2>
      <div class="segmented-wrap"><div class="segmented" role="tablist">${[['all', '全期間'], ['year', '今年']].map(([k, l]) => `<button class="segmented__item ${k === lookRange ? 'is-active' : ''}" data-r="${k}">${l}</button>`).join('')}</div></div>
      <div class="card">${prof.length ? prof.map(p => `<div class="bar"><span class="bar__label">${esc(p.label)}</span><span class="bar__track"><span class="bar__fill" style="width:${Math.max(4, p.count / max * 100)}%"></span></span><span class="bar__value">${p.count}</span></div>`).join('') : '<p class="small muted" style="margin:0">記録のときに「心が動いた種類」を選ぶと、ここに出ます。</p>'}</div>
      ${gaps.length && prof.length ? `<p class="list-section__footer">しばらく味わっていない: ${gaps.slice(0, 6).map(g => esc(g.label)).join('、')}。<a href="#explore">探す</a>で、これを起こしやすい映画を提案できます。</p>` : ''}
    </section>
    ${best.length ? `<section class="list-section"><h2 class="list-section__header">年ごとのいちばん</h2>${best.slice(0, 6).map(y => `
      <h3 class="form-label">${y.year}年 <span class="muted">${y.count}本</span></h3>
      <ul class="list list--inset">${y.top.map(r => filmRow(r.film, `${r.score}点${r.view.peak ? ` ・ ${r.view.peak.slice(0, 24)}` : ''}`)).join('')}</ul>`).join('')}</section>` : ''}`;
  const more = document.getElementById('wall-more');
  if (more) more.addEventListener('click', () => { const y = scrollY; renderLook(); scrollTo(0, y); });
  $view.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', () => { const y = scrollY; lookRange = b.dataset.r; renderLook(); scrollTo(0, y); }));
}

function shuffle(a) {
  const x = a.slice();
  for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
  return x;
}

// ---------- 探す ----------
function renderExplore() {
  setTab('explore');
  setTitle('探す');
  const want = state.films.filter(f => f.status === 'want').sort((a, b) => ((b.want && b.want.addedAt) || '').localeCompare((a.want && a.want.addedAt) || ''));
  const { grid, unknown } = gapGrid(state.films);
  const seenCount = state.films.filter(f => f.status === 'seen').length;
  const maxCell = Math.max(1, ...REGIONS.flatMap(r => DECADES.map(d => grid[r.key][d.key])));
  $view.innerHTML = `
    <section class="list-section" style="margin-top:var(--space-2)"><h2 class="list-section__header">観たい ${want.length}本</h2>
      ${want.length ? `<ul class="list list--inset">${want.slice(0, 50).map(f => filmRow(f, shelfSub(f))).join('')}</ul>
        ${tmdb.hasKey() ? '<div class="actions" style="padding-bottom:0"><button class="btn btn--plain btn--small" id="pv-all">配信状況をまとめて確かめる</button></div>' : ''}`
        : '<div class="card"><p class="small muted" style="margin:0">下の3つの探し方で見つけた映画を「観たい」に入れると、ここに並びます。</p></div>'}
    </section>

    <section class="list-section"><h2 class="list-section__header">作り手の糸をたどる</h2>
      <div class="card"><p class="small" style="margin:0">7点以上を付けた映画の、監督・脚本・撮影・音楽・編集が関わったほかの映画を集めます。別々の好きな映画から<b>二人以上でつながる</b>ものを上に出します。</p></div>
      <div class="actions" style="padding-bottom:0"><button class="btn btn--tinted" id="threads">${threadResult ? 'たどり直す' : '糸をたどる'}</button></div>
      <div id="threads-out">${threadResult ? threadsHtml(threadResult) : ''}</div>
    </section>

    <section class="list-section"><h2 class="list-section__header">空白地図</h2>
      <div class="card gap-card">${seenCount ? `<table class="gap"><thead><tr><th></th>${DECADES.map(d => `<th>${d.label.replace('年代', '')}</th>`).join('')}</tr></thead><tbody>
        ${REGIONS.map(r => `<tr><th>${r.label}</th>${DECADES.map(d => { const n = grid[r.key][d.key]; return `<td><button class="gap__cell" data-r="${r.key}" data-d="${d.key}" style="--a:${n ? 0.18 + 0.82 * n / maxCell : 0}" aria-label="${r.label} ${d.label} ${n}本">${n || ''}</button></td>`; }).join('')}</tr>`).join('')}
        </tbody></table><p class="small muted" style="margin:var(--space-2) 0 0">観た映画を、製作国と公開年代で数えています。${unknown ? `国か年の分からない${unknown}本は除いています。` : ''}空いているマスを押すと、そこでよく観られている映画を出します。</p>`
        : '<p class="small muted" style="margin:0">観た映画が増えると、どの国・年代を観ていないかが見えてきます。</p>'}</div>
      <div id="gap-out">${gapResult ? gapHtml(gapResult) : ''}</div>
    </section>

    <section class="list-section"><h2 class="list-section__header">AIに選んでもらう</h2>
      <div class="card"><p class="small" style="margin:0">${LENSES.map(([, l]) => esc(l)).join(' / ')} の4つの観点で2本ずつ。Geminiに送るのは、観た映画の題名・年・監督・評価・心が動いた種類だけで、場面やメモの文章は送りません。</p></div>
      <div class="actions" style="padding-bottom:0"><button class="btn btn--tinted" id="suggest">${suggestResult ? '選び直す' : '選んでもらう'}</button></div>
      <div id="suggest-out">${suggestResult ? suggestHtml(suggestResult) : ''}</div>
    </section>
    <p class="list-section__footer">作品情報・ポスター・作り手: TMDb。This product uses the TMDB API but is not endorsed or certified by TMDB. 配信状況: JustWatch。</p>`;
  bindCands($view);
  document.getElementById('threads').addEventListener('click', runThreads);
  document.getElementById('suggest').addEventListener('click', runSuggest);
  $view.querySelectorAll('.gap__cell').forEach(b => b.addEventListener('click', () => runGap(b.dataset.r, b.dataset.d)));
  const pvAll = document.getElementById('pv-all');
  if (pvAll) pvAll.addEventListener('click', async () => {
    pvAll.disabled = true;
    let n = 0;
    for (const f of want.filter(x => x.tmdbId)) { pvAll.textContent = `確かめています… ${++n}/${want.filter(x => x.tmdbId).length}`; await enrich(f, { force: true }); }
    toast('配信状況を取り直しました');
    renderExplore();
  });
}

function threadsHtml(r) {
  if (r.error) return `<p class="list-section__footer">${esc(r.error)}</p>`;
  if (!r.items.length) return '<p class="list-section__footer">まだ糸が見つかりません。7点以上の映画が増えると出てきます。</p>';
  return `<ul class="list list--inset" style="margin-top:var(--space-3)">${r.items.map(c => {
    const how = c.links.map(l => `『${l.via}』の${tmdb.ROLES[l.viaRole].label} ${l.name}${l.viaRole !== l.job ? `(ここでは${tmdb.ROLES[l.job].label})` : ''}`);
    const extra = `<span class="thread-why${c.people >= 2 ? ' is-double' : ''}">${c.people >= 2 ? '<b>二本の糸</b> ' : ''}${esc(how.join(' / '))}</span>`;
    return candRow(c, `作り手の糸: ${how.join(' / ')}`, extra);
  }).join('')}</ul><p class="list-section__footer">${esc(r.at)} ・ ${r.people}人をたどりました</p>`;
}

async function runThreads() {
  const btn = document.getElementById('threads');
  const out = document.getElementById('threads-out');
  if (!tmdb.hasKey()) { out.innerHTML = '<p class="list-section__footer">設定でTMDbのキーを入れてください。</p>'; return; }
  btn.disabled = true;
  // 作り手の情報がまだない高評価の映画は、先に取る
  const need = state.films.filter(f => f.status === 'seen' && f.tmdbId && !f.crew && (filmScore(f, state.views) ?? 0) >= 7);
  for (const f of need) { btn.textContent = `作品情報を取っています…`; await enrich(f, { force: true }); }
  const seeds = pickThreadSeeds(state.films, state.views);
  if (!seeds.length) { threadResult = { items: [], people: 0 }; out.innerHTML = threadsHtml(threadResult); btn.disabled = false; btn.textContent = '糸をたどる'; return; }
  const credits = {};
  let i = 0;
  try {
    for (const s of seeds) { btn.textContent = `たどっています… ${++i}/${seeds.length}`; credits[s.id] = await personCreditsCached(s.id); }
  } catch (e) { threadResult = { error: e.message }; out.innerHTML = threadsHtml(threadResult); btn.disabled = false; btn.textContent = '糸をたどる'; return; }
  const exclude = new Set(state.films.filter(f => f.tmdbId).map(f => f.tmdbId));
  const items = weaveThreads(seeds, credits, { exclude, roles: tmdb.ROLES });
  threadResult = { items, people: seeds.length, at: new Date().toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) };
  out.innerHTML = threadsHtml(threadResult);
  bindCands(out);
  btn.disabled = false;
  btn.textContent = 'たどり直す';
}

function gapHtml(r) {
  if (r.error) return `<p class="list-section__footer">${esc(r.error)}</p>`;
  return `<h3 class="form-label">${esc(r.label)}でよく観られている映画</h3><ul class="list list--inset">${r.items.map(c => candRow(c, `空白地図: ${r.label}`)).join('')}</ul>`;
}

async function runGap(regionKey, decadeKey) {
  const out = document.getElementById('gap-out');
  const r = REGIONS.find(x => x.key === regionKey), d = DECADES.find(x => x.key === decadeKey);
  const label = `${r.label}・${d.label}`;
  if (!tmdb.hasKey()) { out.innerHTML = '<p class="list-section__footer">設定でTMDbのキーを入れると、このマスの映画を出せます。</p>'; return; }
  out.innerHTML = '<p class="list-section__footer">探しています…</p>';
  try {
    const items = (await tmdb.discoverBy({ countries: r.codes.slice(0, 12), from: Math.max(d.from, 1900), to: d.to })).slice(0, 12);
    gapResult = { label, items };
  } catch (e) { gapResult = { label, error: e.message }; }
  out.innerHTML = gapHtml(gapResult);
  bindCands(out);
  out.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function suggestHtml(r) {
  if (r.error) return `<p class="list-section__footer">${esc(r.error)}</p>`;
  return LENSES.map(([k, l]) => {
    const items = r.items.filter(x => x.lens === k);
    if (!items.length) return '';
    return `<h3 class="form-label">${esc(l)}</h3><ul class="list list--inset">${items.map(x => candRow(x, `AI(${l}): ${x.why}`, `<span class="thread-why">${esc(x.why)}</span>`)).join('')}</ul>`;
  }).join('') + '<p class="list-section__footer">AIの提案は実在しない作品や誤った年を含むことがあります。「観たい」に入れるとTMDbで照合します。</p>';
}

async function runSuggest() {
  const btn = document.getElementById('suggest');
  const out = document.getElementById('suggest-out');
  const [apiKey, model] = await Promise.all([db.getMeta('geminiKey', ''), db.getMeta('geminiModel', '')]);
  if (!apiKey) { out.innerHTML = '<p class="list-section__footer">設定でGeminiのAPIキーを入れてください。</p>'; return; }
  if (state.films.filter(f => f.status === 'seen').length < 3) { out.innerHTML = '<p class="list-section__footer">観た映画を3本以上記録すると選べます。</p>'; return; }
  btn.disabled = true; btn.textContent = '選んでいます…';
  try {
    const prompt = buildSuggestPrompt({ films: state.films, views: state.views, gaps: emotionGaps(state.views) });
    const text = await gemini.generateJson({ apiKey, model: model || undefined, prompt });
    let items = parseSuggest(text);
    // TMDbで照合して、ポスターとidを付ける
    if (tmdb.hasKey()) {
      items = await Promise.all(items.map(async x => {
        try {
          const hits = await tmdb.search(x.originalTitle || x.title);
          const hit = hits.find(h => !x.year || !h.year || Math.abs(h.year - x.year) <= 1);
          return hit ? { ...x, tmdbId: hit.tmdbId, posterPath: hit.posterPath, title: hit.title || x.title } : { ...x, unverified: true };
        } catch { return x; }
      }));
    }
    suggestResult = { items };
  } catch (e) { suggestResult = { error: e.message }; }
  out.innerHTML = suggestHtml(suggestResult);
  bindCands(out);
  btn.disabled = false; btn.textContent = '選び直す';
}

// ---------- 設定 ----------
function bindSyncSettings() {
  const stateEl = document.getElementById('sync-state');
  const sum = document.getElementById('sync-sum');
  const show = st => {
    if (!document.body.contains(stateEl)) return;
    stateEl.textContent = st.state === 'off' ? '未接続'
      : st.state === 'syncing' ? '同期しています…'
      : st.state === 'error' ? `同期できませんでした: ${st.error}`
      : `最後の同期: ${st.lastAt ? new Date(st.lastAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'まだ'}${st.pending ? ` ・ 未送信 ${st.pending}件` : ''}`;
    sum.textContent = st.state === 'off' ? '' : st.state === 'error' ? 'エラー' : st.state === 'syncing' ? '同期中' : '接続中';
  };
  if (unwatchSync) unwatchSync();
  unwatchSync = sync.onStatus(show);
  show(sync.status);
  const on = document.getElementById('s-on');
  if (on) on.addEventListener('click', async () => {
    const url = document.getElementById('s-url').value.trim();
    const token = document.getElementById('s-token').value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url) || !token) { toast('URL(script.google.com)と合言葉を入れてください'); return; }
    on.disabled = true;
    await sync.connect(url, token);
    if (sync.status.state === 'error') { toast(sync.status.error); on.disabled = false; return; }
    toast('映画ハブにつなぎました');
    await load();
    renderSettings().then(() => { document.getElementById('sync-fold').open = true; });
  });
  const now = document.getElementById('s-now');
  if (now) now.addEventListener('click', () => sync.syncNow());
  const off = document.getElementById('s-off');
  if (off) off.addEventListener('click', async () => {
    if (!confirm('同期をやめますか。この端末のデータとスプレッドシートはどちらも残ります。')) return;
    await sync.disconnect();
    renderSettings().then(() => { document.getElementById('sync-fold').open = true; });
  });
}

async function renderSettings() {
  setTab('settings');
  setTitle('設定');
  const [gKey, gModel, tKey, lastBackup, syncUrl, syncToken, persisted] = await Promise.all([
    db.getMeta('geminiKey', ''), db.getMeta('geminiModel', ''), db.getMeta('tmdbKey', ''), db.getMeta('lastBackupAt'),
    db.getMeta('syncUrl', ''), db.getMeta('syncToken', ''),
    navigator.storage && navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false),
  ]);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $view.innerHTML = `
    <details class="fold" open><summary>作品情報(TMDb)<small>${tKey ? '設定済み' : '未設定'}</small></summary><div class="fold__body">
      <div class="card"><div class="row"><label for="t-key">APIキー</label><input id="t-key" type="password" autocomplete="off" value="${esc(tKey)}" placeholder="v3キー または 読み取りトークン"></div></div>
      <div class="actions"><button class="btn btn--tinted" id="t-check">保存して接続を確かめる</button></div>
      <p class="list-section__footer">題名検索・ポスター・監督や撮影監督などの作り手・日本の配信状況に使います。themoviedb.org で無料のアカウントを作り、設定 → API からキーを取ります(個人の非商用利用)。キーはこの端末にだけ保存し、書き出しファイルにも含めません。</p>
    </div></details>
    <details class="fold"><summary>AI(Gemini)<small>${gKey ? '設定済み' : '未設定'}</small></summary><div class="fold__body">
      <div class="card">
        <div class="row"><label for="g-key">APIキー</label><input id="g-key" type="password" autocomplete="off" value="${esc(gKey)}" placeholder="Google AI Studioで取得"></div>
        <div class="row"><label for="g-model">モデル</label><input id="g-model" value="${esc(gModel)}" placeholder="${gemini.DEFAULT_MODEL}"></div>
      </div>
      <div class="actions"><button class="btn btn--tinted" id="g-save">保存</button></div>
      <p class="list-section__footer">読書メモと同じキーを使えます。無料枠では送った内容がGoogleの製品改善に使われることがあります。送るのは「探す」で「選んでもらう」を押したときだけで、題名・年・監督・評価・感情の種類に限ります。</p>
    </div></details>
    <details class="fold"><summary>バックアップ</summary><div class="fold__body">
      <div class="card"><p class="small muted" style="margin:0">データはこの端末の中だけにあります。ときどき書き出して「ファイル」アプリ(iCloud Drive)に保存してください。</p>
        <p class="small" style="margin:var(--space-2) 0 0">最後の書き出し: ${lastBackup ? esc(lastBackup.slice(0, 10)) : 'まだありません'}</p></div>
      <div class="actions"><button class="btn btn--prominent" id="export">書き出す</button><label class="btn btn--tinted">読み込む<input type="file" id="import" accept="application/json,.json" hidden></label></div>
      ${!standalone ? '<p class="list-section__footer">Safariの共有ボタンから「ホーム画面に追加」してから使ってください。追加しないと、しばらく開かないうちにデータが消えることがあります。</p>' : ''}
      <p class="list-section__footer">保存領域の保護: ${persisted ? '有効' : '未許可'}</p>
    </div></details>
    <details class="fold" id="sync-fold"><summary>映画ハブ(同期)<small id="sync-sum"></small></summary><div class="fold__body">
      <div class="card">
        <div class="row"><label for="s-url">URL</label><input id="s-url" type="url" autocomplete="off" value="${esc(syncUrl)}" placeholder="https://script.google.com/macros/s/…/exec"></div>
        <div class="row"><label for="s-token">合言葉</label><input id="s-token" type="password" autocomplete="off" value="${esc(syncToken)}" placeholder="setup の実行ログに出たもの"></div>
      </div>
      <p class="list-section__footer" id="sync-state"></p>
      <div class="actions">${syncUrl ? '<button class="btn btn--tinted" id="s-now">今すぐ同期</button><button class="btn btn--plain" id="s-off">同期をやめる</button>' : '<button class="btn btn--prominent" id="s-on">接続して同期する</button>'}</div>
      <p class="list-section__footer">自分のGoogleスプレッドシートに映画と鑑賞記録を置き、iPadなど他の端末や、日記アプリなど他のApps Scriptと共有します。準備の手順は<a href="https://github.com/tadamasa/movie-memo/blob/main/hub/README.md" target="_blank" rel="noopener">こちら</a>。読書ハブとは別のスプレッドシートにしてください。</p>
    </div></details>
    <p class="list-section__footer">作品情報・ポスター: TMDb(This product uses the TMDB API but is not endorsed or certified by TMDB.)・配信状況: JustWatch</p>`;
  document.getElementById('t-check').addEventListener('click', async e => {
    const k = document.getElementById('t-key').value.trim();
    await db.setMeta('tmdbKey', k);
    tmdb.setKey(k);
    if (!k) { toast('キーを消しました'); return; }
    e.target.disabled = true;
    try { await tmdb.ping(); toast('TMDbにつながりました'); } catch (err) { toast(err.message, 4000); }
    e.target.disabled = false;
  });
  document.getElementById('g-save').addEventListener('click', async () => {
    await db.setMeta('geminiKey', document.getElementById('g-key').value.trim());
    await db.setMeta('geminiModel', document.getElementById('g-model').value.trim());
    toast('保存しました');
  });
  document.getElementById('export').addEventListener('click', async () => {
    try { if (await exportData()) { toast('書き出しました'); renderSettings(); } } catch (e) { toast(`書き出せませんでした: ${e.message}`, 4000); }
  });
  document.getElementById('import').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try { const n = await importData(await file.text()); await load(); toast(`${n}件を読み込みました`); } catch (err) { toast(err.message, 4000); }
  });
  bindSyncSettings();
}

// ---------- ルーティング ----------
async function route() {
  const [path, query] = location.hash.replace(/^#/, '').split('?');
  const [name, a, b] = path.split('/');
  window.scrollTo(0, 0);
  switch (name) {
    case 'add': return renderAdd(a);
    case 'log': return renderLog(decodeURIComponent(a || ''), b);
    case 'film': return renderFilm(decodeURIComponent(a || ''));
    case 'person': return renderPerson(Number(a), decodeURIComponent(b || ''), query);
    case 'shelf': return renderShelf();
    case 'look': return renderLook();
    case 'explore': return renderExplore();
    case 'settings': return renderSettings();
    default: return renderHome();
  }
}

document.getElementById('back').addEventListener('click', () => (history.length > 1 ? history.back() : (location.hash = '#home')));
addEventListener('hashchange', route);

// Large Title の折り畳み
const nav = document.getElementById('nav');
const sentinel = document.createElement('div');
sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px;';
document.body.prepend(sentinel);
new IntersectionObserver(([e]) => nav.classList.toggle('is-collapsed', !e.isIntersecting), { threshold: 0 }).observe(sentinel);

// 他の端末の変更を受け取ったら読み直す。入力中は画面を作り直さない
async function onRemoteChange() {
  await load();
  const el = document.activeElement;
  const typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  const drafting = [...document.querySelectorAll('textarea')].some(t => t.value.trim());
  if (!typing && !drafting && !/^#(settings|log)/.test(location.hash)) { const y = scrollY; await route(); scrollTo(0, y); }
}

(async function start() {
  await load();
  db.requestPersist();
  if (!(matchMedia('(display-mode: standalone)').matches || navigator.standalone)) document.getElementById('tab-warning').hidden = false;
  route();
  await sync.initSync({ onRemoteChange });
  sync.schedule(300);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync.schedule(300); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

window.__app = { state };
