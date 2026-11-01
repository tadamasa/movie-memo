// 日記から抜き出した鑑賞記録のCSV(日付,映画名,視聴媒体,備考)を読み、取り込む前の形に整える。
// 画面に触れないので node --test で確かめられる。
//
// 決まりごと(2026-11-01 ただまさと決めた):
// - 「途中まで」の行は取り込まない。鑑賞が終わった日(「続き」「残りを鑑賞」の日)だけを記録する。
// - 「続き」の前に同じ題名の行があれば(例: 4/17 ワークスマン → 4/18 ワークスマン(続き))、前の行は途中までとみなして除く。
// - 同じ題名が離れた日に何度も出てくるのは、観直し。1本の映画に鑑賞を複数つける。
// - 題名の括弧の中は、別名(TMDbで探す手がかり)と、印(続き・途中まで・再鑑賞・新作など)に分ける。

import { normTitle, seenSummary } from './core.js';

// ---------- CSV ----------
export function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

export function readDiaryCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim());
  const at = name => head.indexOf(name);
  const iDate = at('日付'), iTitle = at('映画名'), iMedia = at('視聴媒体'), iNote = at('備考');
  if (iDate < 0 || iTitle < 0) throw new Error('「日付」と「映画名」の列があるCSVを選んでください');
  return rows.slice(1).map((r, n) => ({
    line: n + 2,
    date: (r[iDate] || '').trim(),
    title: (r[iTitle] || '').trim(),
    media: iMedia >= 0 ? (r[iMedia] || '').trim() : '',
    note: iNote >= 0 ? (r[iNote] || '').trim() : '',
  })).filter(r => r.title && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
}

// ---------- 視聴媒体 ----------
// 表記ゆれ(Amazon Prime / Amazonプライム / Prime Video(Amazon) など)を、配信サービスの名前にそろえる
export function normalizeMedia(raw) {
  const m = String(raw || '').normalize('NFKC').trim();
  if (!m || m === '記載なし') return { place: '', venue: '', rental: false };
  const rental = /レンタル/.test(m);
  const low = m.toLowerCase();
  let venue = m.replace(/[(（].*?[)）]/g, '').trim();
  if (/netflix/.test(low)) venue = 'Netflix';
  else if (/prime|プライム|amazon/.test(low)) venue = 'Amazon Prime Video';
  else if (/u-?next/.test(low)) venue = 'U-NEXT';
  else if (/apple/.test(low)) venue = 'Apple TV';
  else if (/youtube/.test(low)) venue = 'YouTube';
  else if (/disney/.test(low)) venue = 'Disney Plus';
  else if (/hulu/.test(low)) venue = 'Hulu';
  else if (/映画館|劇場/.test(m)) return { place: 'theater', venue: '', rental };
  else if (/テレビ|tv放送|地上波/.test(low)) return { place: 'tv', venue: '', rental };
  return { place: 'stream', venue, rental };
}

// ---------- 題名 ----------
const MARK_RULES = [
  [/^続き$/, 'cont'], [/^残りを鑑賞$|^残り$/, 'cont'],
  [/^途中まで$/, 'partial'],
  [/^再鑑賞$|^見直し$/, 'rewatch'],
];
// 探す手がかりにはしないが、照合のときに見せる言葉
const HINT_RE = /^(新作|最新作|最新版|アニメ映画|\d+|.*作品)$/;

function splitTop(s, sep) {
  // 括弧の外にある区切りだけで分ける
  const out = [];
  let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ('（('.includes(c)) depth++;
    if ('）)'.includes(c)) depth = Math.max(0, depth - 1);
    if (!depth && s.startsWith(sep, i)) { out.push(cur); cur = ''; i += sep.length - 1; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

export function parseTitle(raw) {
  const flags = { cont: false, partial: false, rewatch: false };
  const aliases = [], hints = [];
  const groups = [];
  const base = String(raw || '').replace(/[（(]([^（）()]*)[）)]/g, (_, g) => { groups.push(g); return ' '; }).replace(/\s+/g, ' ').trim();
  for (const g of groups) {
    for (const part of g.split(/\s*\/\s*/).map(x => x.trim()).filter(Boolean)) {
      const mark = MARK_RULES.find(([re]) => re.test(part));
      if (mark) { flags[mark[1]] = true; continue; }
      if (HINT_RE.test(part)) { hints.push(part); continue; }
      aliases.push(part);
    }
  }
  // 「ロスト・ブレッド3 / イコライザー3」のように、1行に2本書いてあるもの
  const titles = splitTop(base, ' / ');
  return { titles: titles.length ? titles : [base], aliases, hints, flags };
}

// ---------- 取り込みの計画 ----------
// 返すもの: 映画ごとに { key, title, aliases, hints, queries, views: [{ date, place, venue, text, line }] }
// と、除いた行 { line, date, title, reason }
export function planImport(rows, { joinDays = 21 } = {}) {
  const items = [];
  for (const r of rows) {
    const t = parseTitle(r.title);
    const media = normalizeMedia(r.media);
    for (const title of t.titles) {
      items.push({ ...r, film: title, key: normTitle(title), aliases: t.titles.length > 1 ? [] : t.aliases, hints: t.hints, flags: t.flags, media });
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.line - b.line);
  const skipped = [];
  const keep = [];
  for (const it of items) {
    if (it.flags.partial) { skipped.push({ line: it.line, date: it.date, title: it.title, reason: '途中まで' }); continue; }
    if (it.flags.cont) {
      // 続きの前にある同じ題名の行(途中まで観た日)を除く
      for (let i = keep.length - 1; i >= 0; i--) {
        const p = keep[i];
        if (p.key !== it.key) continue;
        const gap = (Date.parse(it.date) - Date.parse(p.date)) / 864e5;
        if (gap > joinDays) break;
        if (!p.flags.rewatch) { keep.splice(i, 1); skipped.push({ line: p.line, date: p.date, title: p.title, reason: '続きの前の日' }); }
        break;
      }
    }
    keep.push(it);
  }
  const films = new Map();
  for (const it of keep) {
    if (!films.has(it.key)) films.set(it.key, { key: it.key, title: it.film, aliases: [], hints: [], views: [] });
    const f = films.get(it.key);
    for (const a of it.aliases) if (!f.aliases.includes(a)) f.aliases.push(a);
    for (const h of it.hints) if (!f.hints.includes(h)) f.hints.push(h);
    if (f.views.some(v => v.date === it.date)) continue; // 同じ日の同じ映画は1回
    const notes = [it.note, it.media.rental ? 'レンタル' : ''].filter(Boolean);
    f.views.push({ date: it.date, place: it.media.place, venue: it.media.venue, text: notes.join(' ・ '), line: it.line });
  }
  const list = [...films.values()].map(f => ({ ...f, queries: searchQueries(f) }));
  list.sort((a, b) => b.views[b.views.length - 1].date.localeCompare(a.views[a.views.length - 1].date));
  return { films: list, skipped, viewCount: list.reduce((n, f) => n + f.views.length, 0) };
}

// TMDbで探す言葉。題名そのもの、末尾の番号を外したもの(DUNE1 → DUNE)、別名の順
export function searchQueries(f) {
  const q = [f.title];
  const noNum = f.title.replace(/(?<=[A-Za-zＡ-Ｚ])\d+$/, '').trim();
  if (noNum && noNum !== f.title) q.push(noNum);
  for (const a of f.aliases) q.push(a);
  return [...new Set(q.map(x => x.trim()).filter(Boolean))];
}

// 検索結果から、鑑賞日より前に公開されたものを優先して選ぶ
export function pickCandidate(results, firstDate) {
  return rankCandidates(results, { title: '', views: [{ date: firstDate }] }).list[0] || null;
}

// 候補を並べ直し、迷いがないか(sure)も返す。
// 題名がそのまま一致し、鑑賞日より前に公開されたものを上に。同じ題名が2本以上あるとき(リメイク・シリーズ)や、
// 題名に「新作」などの手がかりが付いているときは、目で確かめてもらう。
export function rankCandidates(results, f) {
  const y = Number(String((f.views && f.views[0] && f.views[0].date) || '').slice(0, 4)) || 9999;
  const names = [f.title, ...(f.aliases || [])].map(normTitle).filter(Boolean);
  const exact = r => names.includes(normTitle(r.title)) || (r.originalTitle && names.includes(normTitle(r.originalTitle)));
  const before = r => !r.year || r.year <= y;
  const scored = results.map((r, i) => ({ r, s: (exact(r) ? 2 : 0) + (before(r) ? 1 : 0), i }));
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  const list = scored.map(x => x.r);
  const top = list[0];
  const rivals = list.filter(r => exact(r) && before(r)).length;
  const sure = !!top && exact(top) && before(top) && rivals === 1 && !(f.hints || []).length;
  return { list, sure };
}

// ---------- 既存の記録と重ねる ----------
// items: [{ plan(映画1本の計画), choice: { tmdb: 候補 } | { plain: true } | { skip: true } }]
// 返すもの: 保存する films と views(新しく作ったものと直したもの)、数
// - 同じ映画(TMDbのID、なければ題名と年)がすでにあれば、そこに鑑賞を足す
// - 同じ日の鑑賞がすでにあれば足さない(2回取り込んでも増えない)
// - 日付が「2026」のように粗い鑑賞があり、取り込む日付がその中に入るなら、その鑑賞の日付を詳しくする
export function mergeImport(items, films, views, { uid, findFilm, now = new Date().toISOString() }) {
  const allFilms = films.slice();
  const outFilms = new Map(), outViews = new Map();
  const count = { films: 0, filmsNew: 0, views: 0, upgraded: 0, same: 0, skippedFilms: 0 };
  const allViews = views.slice();
  for (const { plan, choice } of items) {
    if (!choice || choice.skip) { count.skippedFilms++; continue; }
    const c = choice.tmdb || null;
    const info = c ? { tmdbId: c.tmdbId, title: c.title, year: c.year } : { title: plan.title };
    let f = findFilm(allFilms, info) || (c ? findFilm(allFilms, { title: plan.title, year: c.year }) : null);
    if (!f) {
      f = {
        id: uid(), tmdbId: c ? c.tmdbId : null, title: c ? c.title : plan.title, originalTitle: c ? c.originalTitle || '' : '',
        year: c ? c.year || null : null, directors: [], posterPath: c ? c.posterPath || '' : '', backdropPath: c ? c.backdropPath || '' : '',
        overview: c ? c.overview || '' : '', status: 'seen', importedFrom: 'diary', createdAt: now,
      };
      allFilms.push(f);
      count.filmsNew++;
    } else if (c && !f.tmdbId) {
      Object.assign(f, { tmdbId: c.tmdbId, posterPath: f.posterPath || c.posterPath || '', year: f.year || c.year || null });
    }
    count.films++;
    f.status = 'seen';
    outFilms.set(f.id, f);
    for (const pv of plan.views) {
      const mine = allViews.filter(v => v.filmId === f.id);
      if (mine.some(v => v.date === pv.date)) { count.same++; continue; }
      const rough = mine.find(v => !/^\d{4}-\d{2}-\d{2}$/.test(v.date || '') && v.date && pv.date.startsWith(v.date));
      if (rough) {
        rough.date = pv.date;
        rough.recall = false;
        if (!rough.place && pv.place) { rough.place = pv.place; rough.venue = pv.venue; }
        if (pv.text && !(rough.text || '').includes(pv.text)) rough.text = [rough.text, pv.text].filter(Boolean).join('\n');
        outViews.set(rough.id, rough);
        count.upgraded++;
        continue;
      }
      const v = { id: uid(), filmId: f.id, date: pv.date, dateNote: '', recall: false, place: pv.place, venue: pv.venue, with: '', score: null, text: pv.text, source: 'diary', createdAt: now };
      allViews.push(v);
      outViews.set(v.id, v);
      count.views++;
    }
    const s = seenSummary(f.id, allViews);
    f.lastSeen = s.lastSeen;
    f.seenCount = s.count;
  }
  return { films: [...outFilms.values()], views: [...outViews.values()], count };
}
