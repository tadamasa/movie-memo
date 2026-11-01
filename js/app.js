import * as db from './db.js';
import * as tmdb from './tmdb.js';
import * as gemini from './gemini.js';
import * as sync from './sync.js';
import { exportData, importData } from './backup.js';
import { readDiaryCsv, planImport, rankCandidates, mergeImport } from './diaryimport.js';
import {
  PLACES, PLACE_LABEL, DEFAULT_SERVICES, availableOn, parseServices, sameService,
  ymd, dateLabel, dateSortKey, currentScore, filmScore, onThisSeason, bestByYear, REGIONS, DECADES, gapGrid,
  pickThreadSeeds, weaveThreads, LENSES, buildSuggestPrompt, parseSuggest, findFilm, reviewLinks,
  DEFAULT_CATEGORIES, parseCategories, genreToCategory, seenSummary, paceStats,
} from './core.js';

// ---------- 状態 ----------
const state = { films: [], views: [], services: DEFAULT_SERVICES.slice(), categories: DEFAULT_CATEGORIES.slice() };
let shelfFilter = 'seen';
let shelfSort = 'date';
let shelfQuery = '';
let shelfGrid = true;
let shelfCat = ''; // ''=すべて、'-'=未分類
let wantMine = false; // 観たいを「契約中の配信で観られる」だけにする
let addMode = 'seen';
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
  if (!SORTS[shelfSort]) shelfSort = 'date';
  shelfGrid = (await db.getMeta('shelfGrid', true)) !== false;
  state.services = parseServices(await db.getMeta('services', ''));
  state.categories = parseCategories(await db.getMeta('categories', ''));
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

// ポスター。sm=一覧の小、md=横の帯、lg=詳細、fill=格子(幅いっぱい)
function posterHtml(f, size = 'sm') {
  const w = { sm: 'w154', md: 'w185', lg: 'w342', fill: 'w342' }[size] || 'w185';
  const src = tmdb.posterUrl(f && f.posterPath, w);
  const ph = esc(((f && f.title) || '?').slice(0, 12));
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
    // カテゴリがまだなければ、ジャンルから付ける(あとで詳細画面で直せる)
    if (!f.category) { const c = genreToCategory(f.genres, state.categories); if (c) { f.category = c; f.categoryAuto = true; } }
    await saveFilm(f);
  } catch (e) { console.warn(e); }
  return f;
}

// ---------- 記録(ホーム) ----------
// ポスターを横に並べる帯
function stripHtml(films, sub) {
  return `<div class="strip">${films.map(f => `<a class="strip__item" href="#film/${esc(f.id)}">${posterHtml(f, 'md')}<span class="strip__title">${esc(f.title)}</span>${sub(f) ? `<span class="strip__sub">${sub(f)}</span>` : ''}</a>`).join('')}</div>`;
}

function serviceBadges(f) {
  const mine = availableOn(f, state.services);
  return mine.map(s => `<span class="svc">${esc(shortService(s))}</span>`).join('');
}
function shortService(s) {
  if (sameService(s, 'Amazon Prime Video')) return 'Prime';
  return s;
}

function renderHome() {
  setTab('home');
  setTitle('映画メモ');
  const recent = [];
  const seenIds = new Set();
  for (const v of recentViews()) { const f = filmById(v.filmId); if (f && !seenIds.has(f.id)) { seenIds.add(f.id); recent.push({ f, v }); } if (recent.length >= 12) break; }
  const want = wantFilms();
  const ready = want.filter(f => availableOn(f, state.services).length);
  $view.innerHTML = `
    <div class="actions" style="padding-top:var(--space-2)">
      <a class="btn btn--prominent btn--large" href="#add/seen">観た映画を記録</a>
    </div>
    <div class="actions" style="padding-top:0">
      <a class="btn btn--tinted" href="#add/want">観たいを足す</a>
      <a class="btn btn--tinted" href="#add/recall">昔観た映画</a>
    </div>
    ${ready.length ? `<section class="list-section"><h2 class="list-section__header">今夜、契約中の配信で観られる</h2>
      ${stripHtml(ready.slice(0, 15), f => serviceBadges(f))}</section>` : ''}
    ${recent.length ? `<section class="list-section"><h2 class="list-section__header">最近観た</h2>
      ${stripHtml(recent.map(r => r.f), f => { const v = recent.find(r => r.f === f).v; return esc([dateLabel(v).replace(/^\d{4}\//, ''), scoreText(currentScore(v))].filter(Boolean).join(' ・ ')); })}</section>` : ''}
    ${want.length ? `<section class="list-section"><h2 class="list-section__header">観たい ${want.length}本 <a href="#explore" class="small">すべて</a></h2>
      ${stripHtml(want.slice(0, 15), f => serviceBadges(f))}</section>` : ''}
    ${!recent.length && !want.length ? `<div class="empty">
      <p class="empty__title">最初の1本を記録しましょう</p>
      <p class="empty__message">観た映画も、観たい映画も、題名で探してポスター付きで残せます。設定でTMDbのキーを入れると題名から探せます。</p>
    </div>` : ''}`;
}

function wantFilms() {
  return state.films.filter(f => f.status === 'want').sort((a, b) => {
    const ma = availableOn(a, state.services).length ? 1 : 0, mb = availableOn(b, state.services).length ? 1 : 0;
    return mb - ma || ((b.want && b.want.addedAt) || '').localeCompare((a.want && a.want.addedAt) || '');
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
  const v = editing || { id: db.uid(), filmId, recall: false, date: recall ? '' : ymd(), place: recall ? '' : 'stream' };
  // 日付は原則として日まで。覚えていないときだけ「2015」「2015-08」や「学生時代」で残す
  const fullDay = /^\d{4}-\d{2}-\d{2}$/.test(v.date || '');
  const rough = !!editing && !fullDay;
  setTab('home');
  setTitle(editing ? '鑑賞を直す' : recall ? '昔観た映画' : '観た映画を記録', { back: true });
  const services = [...new Set([...state.services, ...(v.venue && v.place === 'stream' ? [v.venue] : [])])];
  $view.innerHTML = `
    <div class="book-head book-head--cover">${posterHtml(f, 'md')}<div><h2>${esc(f.title)}</h2><p class="muted small">${esc(filmMeta(f))}</p></div></div>
    <div class="card">
      <div class="row" id="day-row" ${rough ? 'hidden' : ''}><label for="v-date">観た日</label><input id="v-date" type="date" value="${esc(fullDay ? v.date : '')}" max="${ymd()}"></div>
      <div id="rough-rows" ${rough ? '' : 'hidden'}>
        <div class="row"><label for="v-period">時期</label><input id="v-period" placeholder="例 2015 / 2015-08" value="${esc(fullDay ? '' : v.date)}" inputmode="numeric"></div>
        <div class="row"><label for="v-datenote">ことば</label><input id="v-datenote" placeholder="例 学生時代(任意)" value="${esc(v.dateNote || '')}"></div>
      </div>
      <div class="row"><label for="v-place">どこで</label><select id="v-place"><option value="">-</option>${PLACES.map(([k, l]) => `<option value="${k}" ${v.place === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="row" id="svc-row"><label for="v-venue" id="venue-label">${v.place === 'stream' ? 'サービス' : '劇場など'}</label><input id="v-venue" value="${esc(v.venue || '')}" placeholder="任意"></div>
      <div class="row"><label for="v-with">誰と</label><input id="v-with" value="${esc(v.with || '')}" placeholder="任意"></div>
      ${scoreRow('v-score', v.score)}
    </div>
    <div class="actions" style="padding:var(--space-1) var(--space-4) 0"><button type="button" class="btn btn--plain btn--small" id="rough-toggle">${rough ? '日付で入れる' : '日付を覚えていない'}</button></div>
    <div class="kinds" id="svc-chips" ${v.place === 'stream' ? '' : 'hidden'}>${services.map(s => `<button type="button" class="kind ${v.venue === s ? 'is-active' : ''}" data-s="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    <h3 class="form-label">感想</h3>
    <div class="card"><textarea class="field field--note" id="v-text" placeholder="思ったこと、好きな場面、誰かに話したいこと。音声はキーボードのマイクで">${esc(v.text || legacyText(v))}</textarea></div>
    <div class="actions">${editing ? '<button class="btn btn--destructive" id="v-del">この記録を消す</button>' : ''}<button class="btn btn--prominent" id="v-save">保存</button></div>`;
  const getScore = bindScore('v-score');
  const place = document.getElementById('v-place');
  const venue = document.getElementById('v-venue');
  const chips = document.getElementById('svc-chips');
  place.addEventListener('change', () => {
    const stream = place.value === 'stream';
    chips.hidden = !stream;
    document.getElementById('venue-label').textContent = stream ? 'サービス' : '劇場など';
  });
  chips.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => {
    const on = !b.classList.contains('is-active');
    chips.querySelectorAll('.kind').forEach(x => x.classList.remove('is-active'));
    b.classList.toggle('is-active', on);
    venue.value = on ? b.dataset.s : '';
  }));
  let roughMode = rough;
  const dayInput = document.getElementById('v-date');
  document.getElementById('rough-toggle').addEventListener('click', e => {
    roughMode = !roughMode;
    document.getElementById('day-row').hidden = roughMode;
    document.getElementById('rough-rows').hidden = !roughMode;
    e.target.textContent = roughMode ? '日付で入れる' : '日付を覚えていない';
  });
  document.getElementById('v-save').addEventListener('click', async () => {
    let date, dateNote = '';
    if (roughMode) {
      date = document.getElementById('v-period').value.trim();
      dateNote = document.getElementById('v-datenote').value.trim();
      if (date && !/^\d{4}(-\d{2})?$/.test(date)) { toast('時期は 2015 や 2015-08 の形で入れてください'); return; }
      if (!date && !dateNote) { toast('時期かことばのどちらかを入れてください'); return; }
    } else {
      date = dayInput.value.trim();
      if (!date) { toast('観た日を選んでください'); dayInput.focus(); return; }
    }
    Object.assign(v, {
      date, dateNote, recall: roughMode,
      place: place.value, venue: venue.value.trim(), with: document.getElementById('v-with').value.trim(),
      score: getScore(), text: document.getElementById('v-text').value.trim(),
    });
    await saveView(v);
    f.status = 'seen';
    stampSeen(f);
    await saveFilm(f);
    toast(editing ? '直しました' : '記録しました');
    location.hash = `#film/${f.id}`;
  });
  const del = document.getElementById('v-del');
  if (del) del.addEventListener('click', async () => {
    if (!confirm('この鑑賞の記録を消しますか。')) return;
    await db.del('views', v.id);
    state.views = state.views.filter(x => x.id !== v.id);
    stampSeen(f);
    await saveFilm(f);
    location.hash = `#film/${f.id}`;
  });
}

// 映画に「最後に観た日」「観た回数」を持たせる(ハブの films シートに列として出す)
function stampSeen(f) {
  const s = seenSummary(f.id, state.views);
  f.lastSeen = s.lastSeen;
  f.seenCount = s.count;
  return f;
}

// 最初の版で分けて書いた欄(場面・直後の気持ち・メモ)を、感想の1欄にまとめて見せる
function legacyText(v) {
  return [v.peak, v.ending, v.memo].filter(Boolean).join('\n\n');
}

// ---------- 映画の詳細 ----------
function viewHtml(v) {
  const s = currentScore(v);
  const text = v.text || legacyText(v);
  return `<li class="note">
    <div class="note__meta" style="margin:0 0 var(--space-1)"><b>${esc(dateLabel(v))}</b>${v.recall ? '<span class="tag">昔観た</span>' : ''}${v.place ? `<span>${esc(v.venue || PLACE_LABEL[v.place])}${v.venue && v.place !== 'stream' ? `(${esc(PLACE_LABEL[v.place])})` : ''}</span>` : v.venue ? `<span>${esc(v.venue)}</span>` : ''}${v.with ? `<span>${esc(v.with)}と</span>` : ''}${s !== null ? `<span>${s}点</span>` : ''}<a href="#log/${esc(v.filmId)}/${esc(v.id)}" style="margin-left:auto">直す</a></div>
    ${text ? `<p class="note__text">${esc(text)}</p>` : ''}
  </li>`;
}

function renderFilm(id) {
  const f = filmById(id);
  if (!f) { location.hash = '#shelf'; return; }
  setTab(f.status === 'want' ? 'explore' : 'shelf');
  setTitle(f.status === 'want' ? '観たい映画' : '観た映画', { back: true });
  const vs = viewsOf(f.id);
  const score = filmScore(f, state.views);
  const crewRows = Object.entries(f.crew || {}).filter(([, ps]) => ps.length).map(([role, ps]) =>
    `<div class="row links-row"><span class="links-row__group">${esc(tmdb.ROLES[role] ? tmdb.ROLES[role].label : role)}</span><span class="links-row__items">${ps.slice(0, 3).map(p => `<a class="btn btn--small btn--tinted" href="#person/${p.id}/${encodeURIComponent(p.name)}">${esc(p.name)}</a>`).join('')}</span></div>`).join('');
  const castRow = (f.cast || []).length ? `<div class="row links-row"><span class="links-row__group">出演</span><span class="links-row__items">${f.cast.slice(0, 6).map(p => `<span class="tag">${esc(p.name)}</span>`).join('')}</span></div>` : '';
  const pv = f.providers;
  const mine = availableOn(f, state.services);
  const groups = {};
  for (const l of reviewLinks(f)) (groups[l.group] = groups[l.group] || []).push(l);
  const backdrop = tmdb.posterUrl(f.backdropPath, 'w780');
  $view.innerHTML = `
    <div class="hero-film${backdrop ? ' has-backdrop' : ''}">
      ${backdrop ? `<img class="hero-film__bg" src="${esc(backdrop)}" alt="" onerror="this.remove()">` : ''}
      <div class="hero-film__body">${posterHtml(f, 'lg')}<div>
        <h2>${esc(f.title)}</h2>
        ${f.originalTitle ? `<p class="small">${esc(f.originalTitle)}</p>` : ''}
        <p class="small">${esc([f.year, (f.directors || []).length ? `監督 ${f.directors.join('、')}` : '', f.runtime ? `${f.runtime}分` : ''].filter(Boolean).join(' ・ '))}</p>
        ${(f.genres || []).length ? `<div class="tags">${f.genres.map(g => `<span class="tag">${esc(g)}</span>`).join('')}</div>` : ''}
        ${score !== null ? `<p class="film-score">${score}<small>/10</small></p>` : ''}
      </div></div>
    </div>
    <div class="actions">
      <a class="btn btn--prominent" href="#log/${esc(f.id)}/new">${vs.length ? 'もう一度観た' : '観た'}</a>
      ${f.status === 'want' ? '<button class="btn btn--tinted" id="w-drop">観たいから外す</button>' : vs.length ? '' : `<a class="btn btn--tinted" href="#log/${esc(f.id)}/recall">昔観た</a>`}
    </div>
    <div class="card"><div class="row"><label for="f-cat">カテゴリ</label><select id="f-cat"><option value="">未分類</option>${[...new Set([...state.categories, ...(f.category ? [f.category] : [])])].map(c => `<option ${c === f.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div></div>
    ${f.categoryAuto && f.category ? '<p class="list-section__footer" style="margin-top:var(--space-1)">ジャンルから自動で付けました。違っていたら選び直してください。</p>' : ''}
    ${vs.length ? `<section class="list-section"><h2 class="list-section__header">自分の感想${vs.length > 1 ? `(${vs.length}回)` : ''}</h2><ul class="list list--inset">${vs.map(viewHtml).join('')}</ul></section>` : ''}
    ${f.tmdbId ? `<section class="list-section"><h2 class="list-section__header">配信</h2><div class="card">
      ${pv ? `${mine.length ? `<p style="margin:0"><b>契約中で観られる: ${mine.map(esc).join('、')}</b></p>` : ''}
        ${pv.flatrate.length ? `<p class="small" style="margin:${mine.length ? 'var(--space-1)' : '0'} 0 0">見放題: ${pv.flatrate.map(esc).join('、')}</p>` : '<p class="small muted" style="margin:0">見放題の配信は見つかりません</p>'}
        ${pv.rent.length ? `<p class="small" style="margin:var(--space-1) 0 0">レンタル: ${pv.rent.map(esc).join('、')}</p>` : ''}
        <p class="small muted" style="margin:var(--space-1) 0 0">${esc((pv.checkedAt || '').slice(0, 10))}時点 ・ データ: JustWatch${pv.link ? ` ・ <a href="${esc(pv.link)}" target="_blank" rel="noopener">詳しく</a>` : ''}</p>`
      : '<p class="small muted" style="margin:0">まだ確かめていません</p>'}
      </div><div class="actions" style="padding-bottom:0"><button class="btn btn--plain btn--small" id="f-refresh">${tmdb.hasKey() ? '作品情報と配信を取り直す' : '設定でTMDbのキーを入れると取れます'}</button></div></section>` : ''}
    <section class="list-section"><h2 class="list-section__header">ほかの人の感想</h2><div class="card">
      ${Object.entries(groups).map(([g, ls]) => `<div class="row links-row"><span class="links-row__group">${esc(g)}</span><span class="links-row__items">${ls.map(l => `<a class="btn btn--small btn--tinted" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('')}</span></div>`).join('')}
    </div><p class="list-section__footer">Xの「話題順」は、いいねが20以上ついた投稿に絞っています。</p></section>
    ${f.status === 'want' && f.want ? `<section class="list-section"><h2 class="list-section__header">観たいと思ったきっかけ</h2>
      <div class="card">${(f.want.reasons || []).map(r => `<p class="small" style="margin:0 0 var(--space-1)">${esc(r)}</p>`).join('')}
        <textarea class="field" rows="2" id="w-reason" placeholder="誰に勧められた・何で知った(任意)"></textarea></div>
      <div class="actions" style="padding-bottom:0"><button class="btn btn--tinted btn--small" id="w-add">きっかけを足す</button></div></section>` : ''}
    ${f.overview ? `<section class="list-section"><h2 class="list-section__header">あらすじ</h2><div class="card"><p class="summary">${esc(f.overview)}</p></div></section>` : ''}
    ${crewRows || castRow ? `<section class="list-section"><h2 class="list-section__header">作り手</h2><div class="card">${crewRows}${castRow}</div>
      <p class="list-section__footer">名前を押すと、その人が関わったほかの映画を出します。</p></section>` : ''}
    <div class="actions"><button class="btn btn--destructive btn--small" id="f-del">この映画を消す</button></div>`;
  document.getElementById('f-cat').addEventListener('change', async e => {
    f.category = e.target.value;
    f.categoryAuto = false;
    await saveFilm(f);
    toast(f.category ? `「${f.category}」にしました` : '未分類にしました');
  });
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
    if (!confirm(`『${f.title}』${vs.length ? `と、感想${vs.length}件` : ''}を消しますか。`)) return;
    await removeFilm(f);
    location.hash = '#shelf';
  });
  if (f.tmdbId && !f.fetchedAt && tmdb.hasKey()) enrich(f).then(() => { if (location.hash === `#film/${f.id}`) renderFilm(f.id); });
}

async function removeFilm(f) {
  for (const v of viewsOf(f.id)) await db.del('views', v.id);
  await db.del('films', f.id);
  state.views = state.views.filter(v => v.filmId !== f.id);
  state.films = state.films.filter(x => x.id !== f.id);
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
  date: { label: '観た日・足した日', key: f => (viewsOf(f.id)[0] ? dateSortKey(viewsOf(f.id)[0]) : (f.want && f.want.addedAt) || f.createdAt || '') },
  score: { label: '評価', key: f => { const s = filmScore(f, state.views); return s === null ? '' : String(s).padStart(2, '0'); } },
  year: { label: '公開年', key: f => (f.year ? String(f.year) : '') },
};

function gridHtml(films, sub) {
  return `<div class="pgrid">${films.map(f => `<a class="pgrid__item" href="#film/${esc(f.id)}">${posterHtml(f, 'fill')}<span class="pgrid__title">${esc(f.title)}</span>${sub(f) ? `<span class="pgrid__sub">${sub(f)}</span>` : ''}</a>`).join('')}</div>`;
}

function renderShelf() {
  setTab('shelf');
  setTitle('映画棚');
  const filters = [['seen', '観た'], ['want', '観たい'], ['all', 'すべて']];
  const q = shelfQuery.normalize('NFKC').toLowerCase();
  const list = state.films
    .filter(f => shelfFilter === 'all' || f.status === shelfFilter)
    .filter(f => !wantMine || shelfFilter === 'seen' || availableOn(f, state.services).length)
    .filter(f => !shelfCat || (shelfCat === '-' ? !f.category : f.category === shelfCat))
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
      <select id="shelf-sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${k === shelfSort ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
      <button class="btn btn--small btn--plain" id="shelf-view" aria-label="表示を切り替える">${shelfGrid ? '一覧' : 'ポスター'}</button></div>
    <div class="sort-bar" style="padding-top:0"><label for="shelf-cat">カテゴリ</label>
      <select id="shelf-cat"><option value="">すべて</option>${state.categories.map(c => `<option ${c === shelfCat ? 'selected' : ''}>${esc(c)}</option>`).join('')}<option value="-" ${shelfCat === '-' ? 'selected' : ''}>未分類</option></select>
      ${shelfFilter !== 'seen' ? `<button class="btn btn--small ${wantMine ? 'btn--tinted' : 'btn--plain'}" id="shelf-mine" aria-pressed="${wantMine}">契約中のみ</button>` : ''}</div>
    <section class="list-section" style="margin-top:var(--space-3)">
      ${!list.length ? '<div class="empty"><p class="empty__message">まだありません。記録タブから追加できます。</p></div>'
        : shelfGrid ? gridHtml(list.slice(0, 600), gridSub)
        : `<ul class="list list--inset">${list.slice(0, 600).map(f => filmRow(f, shelfSub(f))).join('')}</ul>`}
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
  document.getElementById('shelf-cat').addEventListener('change', e => { shelfCat = e.target.value; renderShelf(); });
  document.getElementById('shelf-view').addEventListener('click', () => { shelfGrid = !shelfGrid; db.setMeta('shelfGrid', shelfGrid); renderShelf(); });
  const mineBtn = document.getElementById('shelf-mine');
  if (mineBtn) mineBtn.addEventListener('click', () => { wantMine = !wantMine; renderShelf(); });
}

function gridSub(f) {
  if (f.status === 'want') return serviceBadges(f);
  const s = filmScore(f, state.views);
  return s !== null ? `<span class="score-badge">${s}</span>` : '';
}

function shelfSub(f) {
  const vs = viewsOf(f.id);
  if (f.status === 'want') {
    const mine = availableOn(f, state.services);
    return [f.year, mine.length ? `観られる: ${mine.join('、')}` : (f.want && f.want.reasons[0]) || ''].filter(Boolean).join(' ・ ');
  }
  const s = filmScore(f, state.views);
  return [f.category, vs[0] ? dateLabel(vs[0]) : '', vs[0] && vs[0].venue ? vs[0].venue : '', vs.length > 1 ? `${vs.length}回` : '', s !== null ? `${s}点` : ''].filter(Boolean).join(' ・ ');
}

// ---------- 振り返り ----------
function renderLook() {
  setTab('look');
  setTitle('振り返り');
  const thisYear = String(new Date().getFullYear());
  const vs = state.views;
  if (!vs.length) {
    $view.innerHTML = `<div class="empty"><p class="empty__title">まだ振り返る記録がありません</p>
      <p class="empty__message">観た映画を記録すると、今年のポスターの壁、どこで観たか、年ごとのいちばんがここに並びます。</p>
      <a class="btn btn--prominent" href="#add/seen">観た映画を記録</a></div>`;
    return;
  }
  const yearViews = vs.filter(v => (v.date || '').startsWith(thisYear) && !v.recall).sort((a, b) => dateSortKey(b).localeCompare(dateSortKey(a)));
  const yearFilms = [...new Map(yearViews.map(v => [v.filmId, filmById(v.filmId)])).values()].filter(Boolean);
  const season = onThisSeason(vs);
  // どこで観たか(配信はサービスごと)
  const where = new Map();
  for (const v of vs.filter(x => !x.recall)) {
    const k = v.place === 'stream' ? (v.venue || '配信(サービス不明)') : PLACE_LABEL[v.place] || '未記入';
    where.set(k, (where.get(k) || 0) + 1);
  }
  const whereRows = [...where.entries()].sort((a, b) => b[1] - a[1]);
  const max = whereRows.length ? whereRows[0][1] : 1;
  const best = bestByYear(vs, state.films);
  const catCount = new Map();
  for (const f of state.films.filter(x => x.status === 'seen')) { const k = f.category || '未分類'; catCount.set(k, (catCount.get(k) || 0) + 1); }
  const catRows = [...catCount.entries()].sort((a, b) => b[1] - a[1]);
  const catMax = catRows.length ? catRows[0][1] : 1;
  const pace = paceStats(vs);
  $view.innerHTML = `
    <div class="tiles" style="margin-top:var(--space-2)">
      <div class="tile"><span class="tile__label">今年観た</span><span class="tile__value">${yearViews.length}<small>本</small></span><span class="tile__sub">うち映画館 ${yearViews.filter(v => v.place === 'theater').length}</span></div>
      <div class="tile"><span class="tile__label">観た映画</span><span class="tile__value">${state.films.filter(f => f.status === 'seen').length}</span><span class="tile__sub">感想 ${vs.filter(v => v.text || legacyText(v)).length}件</span></div>
      <div class="tile"><span class="tile__label">観たい</span><span class="tile__value">${state.films.filter(f => f.status === 'want').length}</span><span class="tile__sub">契約中で ${state.films.filter(f => f.status === 'want' && availableOn(f, state.services).length).length}</span></div>
    </div>
    ${yearFilms.length ? `<section class="list-section"><h2 class="list-section__header">${thisYear}年に観た映画</h2>${gridHtml(yearFilms, gridSub)}</section>` : ''}
    ${season.length ? `<section class="list-section"><h2 class="list-section__header">いつかの今ごろ観ていた</h2>
      ${stripHtml(season.slice(0, 10).map(v => filmById(v.filmId)).filter(Boolean), f => { const v = season.find(x => x.filmId === f.id); return `${v.date.slice(0, 4)}年`; })}</section>` : ''}
    ${paceHtml(pace)}
    ${whereRows.length ? `<section class="list-section"><h2 class="list-section__header">どこで観たか</h2><div class="card">
      ${whereRows.map(([k, n]) => `<div class="bar"><span class="bar__label">${esc(k)}</span><span class="bar__track"><span class="bar__fill" style="width:${Math.max(4, n / max * 100)}%"></span></span><span class="bar__value">${n}</span></div>`).join('')}</div></section>` : ''}
    ${catRows.length ? `<section class="list-section"><h2 class="list-section__header">カテゴリ別</h2><div class="card">
      ${catRows.map(([k, n]) => `<div class="bar"><span class="bar__label">${esc(k)}</span><span class="bar__track"><span class="bar__fill bar__fill--alt" style="width:${Math.max(4, n / catMax * 100)}%"></span></span><span class="bar__value">${n}</span></div>`).join('')}</div></section>` : ''}
    ${best.length ? `<section class="list-section"><h2 class="list-section__header">年ごとのいちばん</h2>${best.slice(0, 8).map(y => `
      <h3 class="form-label">${y.year}年 <span class="muted">${y.count}本</span></h3>
      ${stripHtml(y.top.map(r => r.film), f => { const r = y.top.find(x => x.film === f); return `<span class="score-badge">${r.score}</span>`; })}`).join('')}</section>` : ''}`;
  bindPace();
}

// 観るペース: 年×月の濃淡表。マスを押すと、その月に観た映画を下に出す
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
function paceHtml(p) {
  if (!p) return '';
  const thisMonth = ymd().slice(0, 7);
  const cell = (y, m, n) => {
    const key = `${y}-${String(m + 1).padStart(2, '0')}`;
    if (key > thisMonth || key < p.first.slice(0, 7)) return '<td></td>';
    return `<td><button class="gap__cell pace__cell" style="--a:${n ? 0.15 + 0.85 * n / p.max : 0}" data-ym="${key}" aria-label="${y}年${m + 1}月 ${n}本">${n || ''}</button></td>`;
  };
  const trend = p.prev12 ? Math.round((p.last12 - p.prev12) / p.prev12 * 100) : null;
  const lg = p.longest;
  const barRows = (labels, counts, cls = '') => { const mx = Math.max(1, ...counts); return labels.map((l, i) => `<div class="bar"><span class="bar__label">${l}</span><span class="bar__track"><span class="bar__fill ${cls}" style="width:${counts[i] ? Math.max(4, counts[i] / mx * 100) : 0}%"></span></span><span class="bar__value">${counts[i]}</span></div>`).join(''); };
  return `<section class="list-section"><h2 class="list-section__header">観るペース</h2>
    <div class="tiles">
      <div class="tile"><span class="tile__label">ひと月に</span><span class="tile__value">${p.perMonth.toFixed(1)}<small>本</small></span><span class="tile__sub">${esc(p.first.slice(0, 7).replace('-', '/'))}から平均</span></div>
      <div class="tile"><span class="tile__label">この1年</span><span class="tile__value">${p.last12}<small>本</small></span><span class="tile__sub">${trend === null ? '前の1年は記録なし' : trend === 0 ? '前の1年と同じ' : `前の1年比 ${trend > 0 ? '+' : '−'}${Math.abs(trend)}%`}</span></div>
      <div class="tile"><span class="tile__label">間隔</span><span class="tile__value">${p.median ?? '—'}<small>日</small></span><span class="tile__sub">真ん中の値</span></div>
    </div>
    <div class="card gap-card"><table class="gap pace"><thead><tr><th></th>${Array.from({ length: 12 }, (_, i) => `<th>${i + 1}</th>`).join('')}<th>計</th></tr></thead>
      <tbody>${p.years.map(r => `<tr><th>${r.year}</th>${r.months.map((n, m) => cell(r.year, m, n)).join('')}<td class="pace__total">${r.total}</td></tr>`).join('')}</tbody></table>
      <p class="small muted" id="pace-detail" style="margin:var(--space-2) 0 0">マスを押すと、その月に観た映画を出します。濃いほど多く観た月です。</p>
      <div id="pace-films"></div></div>
    <p class="list-section__footer">いちばん長く空いたのは${lg.open ? `いまで、${esc(lg.from.replace(/-/g, '/'))}から${lg.days}日` : `${esc(lg.from.replace(/-/g, '/'))}から${esc(lg.to.replace(/-/g, '/'))}までの${lg.days}日`}。日付が「2015」のように粗い記録は数えていません(日まで分かる${p.count}回)。</p>
    <details class="fold"><summary>何月に多いか・何曜日に多いか</summary><div class="fold__body">
      <div class="card">${barRows(Array.from({ length: 12 }, (_, i) => `${i + 1}月`), p.monthTotals)}</div>
      <div class="card" style="margin-top:var(--space-2)">${barRows(WEEK.map(w => `${w}曜`), p.weekday, 'bar__fill--alt')}</div>
    </div></details></section>`;
}
function bindPace() {
  const detail = document.getElementById('pace-detail');
  if (!detail) return;
  $view.querySelectorAll('.pace__cell').forEach(b => b.addEventListener('click', () => {
    $view.querySelectorAll('.pace__cell.is-on').forEach(x => x.classList.remove('is-on'));
    b.classList.add('is-on');
    const ym = b.dataset.ym;
    const vs = state.views.filter(v => (v.date || '').startsWith(ym) && /^\d{4}-\d{2}-\d{2}$/.test(v.date)).sort((a, c) => a.date.localeCompare(c.date));
    detail.textContent = `${ym.replace('-', '年')}月 ${vs.length}本`.replace('年0', '年');
    const films = vs.map(v => filmById(v.filmId)).filter(Boolean);
    document.getElementById('pace-films').innerHTML = films.length ? stripHtml(films, f => { const v = vs.find(x => x.filmId === f.id); return `${Number(v.date.slice(8))}日`; }) : '';
  }));
}

// ---------- 探す ----------
function renderExplore() {
  setTab('explore');
  setTitle('探す');
  const want = wantFilms();
  const ready = want.filter(f => availableOn(f, state.services).length);
  const { grid, unknown } = gapGrid(state.films);
  const seenCount = state.films.filter(f => f.status === 'seen').length;
  const maxCell = Math.max(1, ...REGIONS.flatMap(r => DECADES.map(d => grid[r.key][d.key])));
  $view.innerHTML = `
    <section class="list-section" style="margin-top:var(--space-2)"><h2 class="list-section__header">観たい ${want.length}本${ready.length ? ` ・ 契約中で観られる ${ready.length}本` : ''}</h2>
      ${want.length ? gridHtml(want.slice(0, 60), gridSub) + (want.length > 60 ? '<p class="list-section__footer">続きは映画棚の「観たい」で。</p>' : '')
        + (tmdb.hasKey() ? '<div class="actions" style="padding-bottom:0"><button class="btn btn--plain btn--small" id="pv-all">配信状況をまとめて確かめる</button></div>' : '')
        : '<div class="card"><p class="small muted" style="margin:0">「観たいを足す」や、下の3つの探し方で見つけた映画を入れると、ここにポスターで並びます。</p></div>'}
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
      <div class="card"><p class="small" style="margin:0">${LENSES.map(([, l]) => esc(l)).join(' / ')} の4つの観点で2本ずつ。Geminiに送るのは、観た映画の題名・年・監督・評価だけで、感想の文章は送りません。</p></div>
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
    const prompt = buildSuggestPrompt({ films: state.films, views: state.views });
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
    <details class="fold"><summary>カテゴリ</summary><div class="fold__body">
      <div class="card"><textarea id="cat-list" class="field" rows="8" aria-label="カテゴリの一覧(1行に1つ)">${esc(state.categories.join('\n'))}</textarea></div>
      <div class="actions"><button class="btn btn--tinted" id="cat-save">保存</button></div>
      <p class="list-section__footer">1行に1つ。並び順がそのまま選択肢の順になります。名前を変えても、すでに付けた映画のカテゴリは変わりません。</p>
      <div class="card"><p class="small" style="margin:0">未分類 <b>${state.films.filter(f => !f.category).length}</b>本</p></div>
      <div class="actions"><button class="btn btn--tinted" id="cat-auto">未分類の映画にジャンルから付ける</button></div>
      <p class="list-section__footer">TMDbのジャンル(SF、アニメーションなど)から、一覧にあるカテゴリを選んで付けます。ジャンルがまだ取れていない映画は、先にTMDbから取ります。</p>
    </div></details>
    <details class="fold"><summary>契約中の配信サービス</summary><div class="fold__body">
      <div class="card"><textarea id="svc-list" class="field" rows="4" aria-label="契約中の配信サービス(1行に1つ)">${esc(state.services.join('\n'))}</textarea></div>
      <div class="actions"><button class="btn btn--tinted" id="svc-save">保存</button></div>
      <p class="list-section__footer">1行に1つ。観たい映画のうち、ここにあるサービスで見放題のものに印を付け、ホームの「今夜観られる」に出します。名前はTMDb(JustWatch)の表記に合わせます(例: Netflix、Amazon Prime Video、U-NEXT、Disney Plus、Hulu、ABEMA)。</p>
    </div></details>
    <details class="fold"><summary>AI(Gemini)<small>${gKey ? '設定済み' : '未設定'}</small></summary><div class="fold__body">
      <div class="card">
        <div class="row"><label for="g-key">APIキー</label><input id="g-key" type="password" autocomplete="off" value="${esc(gKey)}" placeholder="Google AI Studioで取得"></div>
        <div class="row"><label for="g-model">モデル</label><input id="g-model" value="${esc(gModel)}" placeholder="${gemini.DEFAULT_MODEL}"></div>
      </div>
      <div class="actions"><button class="btn btn--tinted" id="g-save">保存</button></div>
      <p class="list-section__footer">読書メモと同じキーを使えます。無料枠では送った内容がGoogleの製品改善に使われることがあります。送るのは「探す」で「選んでもらう」を押したときだけで、題名・年・監督・評価に限ります。</p>
    </div></details>
    <details class="fold"><summary>バックアップ</summary><div class="fold__body">
      <div class="card"><p class="small muted" style="margin:0">データはこの端末の中だけにあります。ときどき書き出して「ファイル」アプリ(iCloud Drive)に保存してください。</p>
        <p class="small" style="margin:var(--space-2) 0 0">最後の書き出し: ${lastBackup ? esc(lastBackup.slice(0, 10)) : 'まだありません'}</p></div>
      <div class="actions"><button class="btn btn--prominent" id="export">書き出す</button><label class="btn btn--tinted">読み込む<input type="file" id="import" accept="application/json,.json" hidden></label></div>
      ${!standalone ? '<p class="list-section__footer">Safariの共有ボタンから「ホーム画面に追加」してから使ってください。追加しないと、しばらく開かないうちにデータが消えることがあります。</p>' : ''}
      <p class="list-section__footer">保存領域の保護: ${persisted ? '有効' : '未許可'}</p>
    </div></details>
    <details class="fold"><summary>日記の記録を取り込む</summary><div class="fold__body">
      <div class="actions"><label class="btn btn--tinted">CSVを選ぶ<input type="file" id="diary-csv" accept="text/csv,.csv,text/plain" hidden></label>${(await db.getMeta('diaryImport')) ? '<a class="btn btn--plain" href="#import">続きから</a>' : ''}</div>
      <p class="list-section__footer">「日付,映画名,視聴媒体,備考」の列があるCSVを読み、TMDbで作品を照合してから観た映画として取り込みます。「途中まで」の行は取り込まず、鑑賞が終わった日(「続き」の日)だけを記録します。同じ日の鑑賞がすでにあれば足さないので、2回取り込んでも増えません。</p>
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
  document.getElementById('cat-save').addEventListener('click', async () => {
    const text = document.getElementById('cat-list').value;
    await db.setMeta('categories', text);
    state.categories = parseCategories(text);
    toast('保存しました');
  });
  document.getElementById('cat-auto').addEventListener('click', async e => {
    const btn = e.target;
    btn.disabled = true;
    let n = 0;
    const left = state.films.filter(f => !f.category);
    for (const [i, f] of left.entries()) {
      btn.textContent = `分類しています… ${i + 1}/${left.length}`;
      if (!(f.genres || []).length && f.tmdbId && tmdb.hasKey()) await enrich(f, { force: true });
      if (!f.category) { const c = genreToCategory(f.genres, state.categories); if (c) { f.category = c; f.categoryAuto = true; await saveFilm(f); } }
      if (f.category) n++;
    }
    toast(`${n}本に付けました${left.length - n ? `(${left.length - n}本は付けられませんでした)` : ''}`, 4000);
    renderSettings().then(() => { const d = [...document.querySelectorAll('details')].find(x => x.querySelector('#cat-list')); if (d) d.open = true; });
  });
  document.getElementById('svc-save').addEventListener('click', async () => {
    const text = document.getElementById('svc-list').value;
    await db.setMeta('services', text);
    state.services = parseServices(text);
    toast('保存しました');
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
  document.getElementById('diary-csv').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const plan = planImport(readDiaryCsv(await file.text()));
      if (!plan.films.length) { toast('取り込める行がありませんでした'); return; }
      await db.setMeta('diaryImport', { plan, matches: {}, at: new Date().toISOString() });
      location.hash = '#import';
    } catch (err) { toast(err.message, 4000); }
  });
  bindSyncSettings();
}

// ---------- 日記の記録を取り込む ----------
let importFilter = 'check';
async function renderImport() {
  setTab('settings');
  setTitle('日記の記録を取り込む', { back: true });
  const draft = await db.getMeta('diaryImport');
  if (!draft) { $view.innerHTML = '<p class="list-section__footer">設定の「日記の記録を取り込む」からCSVを選んでください。</p>'; return; }
  const { plan, matches } = draft;
  const save = () => db.setMeta('diaryImport', draft);
  const chosen = p => { const m = matches[p.key]; return m && m.choice; };
  const pending = plan.films.filter(p => !matches[p.key]);
  const unsure = plan.films.filter(p => matches[p.key] && !matches[p.key].sure);
  const shown = importFilter === 'check' ? plan.films.filter(p => !matches[p.key] || !matches[p.key].sure) : plan.films;
  const dates = p => p.views.map(v => v.date.replace(/-/g, '/')).join('、');
  const row = p => {
    const m = matches[p.key];
    const c = m && m.choice && m.choice.tmdb;
    const opts = m ? m.list.map((r, i) => `<option value="${i}" ${c && c.tmdbId === r.tmdbId ? 'selected' : ''}>${esc(r.title)}${r.year ? `(${r.year})` : ''}${r.originalTitle ? ` ${esc(r.originalTitle)}` : ''}</option>`).join('') : '';
    const sel = m && m.choice ? (m.choice.skip ? 'skip' : m.choice.plain ? 'plain' : '') : '';
    return `<li class="list__row" style="align-items:flex-start">${posterHtml(c || { title: p.title })}
      <div class="list__text" style="min-width:0"><span class="list__title">${esc(p.title)}${m && !m.sure ? ' <span class="tag">確かめる</span>' : ''}</span>
        <span class="list__subtitle">${esc(dates(p))}${p.aliases.length ? ` ・ 別名 ${esc(p.aliases.join('、'))}` : ''}${p.hints.length ? ` ・ ${esc(p.hints.join('、'))}` : ''}</span>
        <select class="field" data-k="${esc(p.key)}" style="margin-top:var(--space-1);width:100%" aria-label="『${esc(p.title)}』の作品">
          ${m ? '' : '<option value="">まだ照合していません</option>'}${opts}
          <option value="plain" ${sel === 'plain' ? 'selected' : ''}>照合しない(題名だけで記録)</option>
          <option value="skip" ${sel === 'skip' ? 'selected' : ''}>取り込まない</option>
        </select></div></li>`;
  };
  $view.innerHTML = `
    <div class="card"><p style="margin:0">映画 <b>${plan.films.length}</b>本 ・ 鑑賞 <b>${plan.viewCount}</b>回</p>
      <p class="small muted" style="margin:var(--space-1) 0 0">照合済み ${plan.films.length - pending.length}本 ・ 確かめたいもの ${unsure.length}本${pending.length ? ` ・ 未照合 ${pending.length}本` : ''}</p></div>
    ${plan.skipped.length ? `<details class="fold"><summary>取り込まない行<small>${plan.skipped.length}行</small></summary><div class="fold__body"><ul class="list list--inset">${plan.skipped.map(x => `<li class="list__row"><div class="list__text"><span class="list__title">${esc(x.title)}</span><span class="list__subtitle">${esc(x.date)} ・ ${esc(x.reason)}</span></div></li>`).join('')}</ul></div></details>` : ''}
    <div class="actions">${pending.length ? (tmdb.hasKey() ? `<button class="btn btn--prominent" id="imp-match">TMDbで照合する(${pending.length}本)</button>` : '<p class="list-section__footer">設定でTMDbのキーを入れると、ポスターや監督付きで取り込めます。キーなしでも「照合しない」で題名だけ取り込めます。</p>') : ''}</div>
    <div class="segmented-wrap"><div class="segmented" role="tablist">
      <button class="segmented__item ${importFilter === 'check' ? 'is-active' : ''}" data-f="check">確かめる ${pending.length + unsure.length}</button>
      <button class="segmented__item ${importFilter === 'all' ? 'is-active' : ''}" data-f="all">すべて ${plan.films.length}</button>
    </div></div>
    <section class="list-section"><ul class="list list--inset" id="imp-list">${shown.map(row).join('') || '<li class="list__row"><div class="list__text"><span class="list__subtitle">確かめるものはありません</span></div></li>'}</ul>
      <p class="list-section__footer">同じ題名の作品が複数あるもの、題名に「新作」などが付いているものは、候補から選び直してください。選んだものは確かめた扱いになります。</p></section>
    <div class="actions"><button class="btn btn--prominent" id="imp-go">取り込む</button><button class="btn btn--plain" id="imp-cancel">やめる</button></div>`;
  $view.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => { importFilter = b.dataset.f; renderImport(); }));
  $view.querySelectorAll('select[data-k]').forEach(el => el.addEventListener('change', async () => {
    const k = el.dataset.k;
    const m = matches[k] || (matches[k] = { list: [], sure: false });
    m.choice = el.value === 'skip' ? { skip: true } : el.value === 'plain' || el.value === '' ? { plain: true } : { tmdb: m.list[Number(el.value)] };
    m.sure = true;
    await save();
    const p = plan.films.find(x => x.key === k);
    const li = el.closest('li');
    const c = m.choice.tmdb;
    li.querySelector('.cover').outerHTML = posterHtml(c || { title: p.title });
    const tag = li.querySelector('.tag');
    if (tag) tag.remove();
  }));
  const matchBtn = document.getElementById('imp-match');
  if (matchBtn) matchBtn.addEventListener('click', async () => {
    matchBtn.disabled = true;
    for (const [i, p] of pending.entries()) {
      matchBtn.textContent = `照合しています… ${i + 1}/${pending.length}`;
      let results = [];
      try {
        for (const q of p.queries) { results = await tmdb.search(q); if (results.length) break; }
      } catch (e) { toast(e.message, 4000); break; }
      const r = rankCandidates(results, p);
      const list = r.list.slice(0, 6);
      // すでに映画メモにある映画なら、それを選ぶ
      const mine = list.find(x => findFilm(state.films, x));
      const pick = mine && findFilm(state.films, mine).status === 'seen' ? mine : list[0];
      matches[p.key] = { list, sure: r.sure || (!!mine && pick === mine), choice: pick ? { tmdb: pick } : { plain: true } };
      if (i % 5 === 4) await save();
    }
    await save();
    renderImport();
  });
  document.getElementById('imp-cancel').addEventListener('click', async () => {
    if (!confirm('取り込みをやめますか。照合した内容は消えます。')) return;
    await db.setMeta('diaryImport', null);
    location.hash = '#settings';
  });
  document.getElementById('imp-go').addEventListener('click', async e => {
    const left = plan.films.filter(p => !matches[p.key]).length;
    if (left && !confirm(`${left}本はまだ照合していません。題名だけで取り込みますか。`)) return;
    if (!left && unsure.length && !confirm(`確かめていないものが${unsure.length}本あります。いまの候補のまま取り込みますか。`)) return;
    const btn = e.target;
    btn.disabled = true;
    const items = plan.films.map(p => ({ plan: p, choice: chosen(p) || { plain: true } }));
    const out = mergeImport(items, state.films, state.views, { uid: db.uid, findFilm });
    for (const v of out.views) await saveView(v);
    for (const f of out.films) await saveFilm(f);
    await db.setMeta('diaryImport', null);
    sync.schedule(300);
    const n = out.count;
    toast(`${n.films}本(新しく${n.filmsNew}本)、鑑賞${n.views}回を取り込みました${n.upgraded ? `。${n.upgraded}回は日付を詳しくしました` : ''}${n.same ? `。${n.same}回はすでにありました` : ''}`, 6000);
    location.hash = '#shelf';
    // ジャンル・監督・カテゴリを後ろで取る
    for (const f of out.films) { if (f.tmdbId && !f.fetchedAt) await enrich(f); }
    sync.schedule(300);
  });
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
    case 'import': return renderImport();
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
  if (!typing && !drafting && !/^#(settings|log|import)/.test(location.hash)) { const y = scrollY; await route(); scrollTo(0, y); }
}

(async function start() {
  await load();
  db.requestPersist();
  if (!(matchMedia('(display-mode: standalone)').matches || navigator.standalone)) document.getElementById('tab-warning').hidden = false;
  route();
  await sync.initSync({ onRemoteChange });
  // 観た日の列を足す前に記録した映画にも、最後に観た日と回数を入れる(変わったものだけ保存して同期する)
  for (const f of state.films.filter(x => x.status === 'seen')) {
    const s = seenSummary(f.id, state.views);
    if (f.lastSeen !== s.lastSeen || f.seenCount !== s.count) await saveFilm(stampSeen(f));
  }
  sync.schedule(300);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync.schedule(300); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

window.__app = { state };
