// 画面に触れない計算。node --test で確かめられるようにここに集める。

// ---------- 心が動いた種類 ----------
// 美的感情の尺度 AESTHEMOS(Schindler ほか 2017, PLOS ONE 12(6): e0178899)の下位尺度から、
// 映画で起きやすく、言葉にしやすいものを選んで日本語の言い回しにした。ジャンルではなく「自分に何が起きたか」で残す。
export const EMOTIONS = [
  ['moved', '心を揺さぶられた'], ['awe', '圧倒された'], ['beauty', '美しかった'], ['fascination', '目が離せなかった'],
  ['humor', '笑った'], ['energy', '元気が出た'], ['relax', 'くつろいだ'], ['nostalgia', '懐かしかった'],
  ['surprise', '驚いた'], ['insight', '気づきがあった'], ['challenge', '頭を使った'],
  ['unease', '落ち着かなかった'], ['sadness', '悲しかった'], ['confusion', '分からなかった'], ['boredom', '退屈だった'],
];
export const EMOTION_LABEL = Object.fromEntries(EMOTIONS);
// 退屈・分からないは「また味わいたい」ものではないので、空白の候補から外す
const SEEKABLE = new Set(['moved', 'awe', 'beauty', 'fascination', 'humor', 'energy', 'relax', 'nostalgia', 'surprise', 'insight', 'challenge', 'unease', 'sadness']);

// 何が効いたか
export const FACTORS = [
  ['story', '物語'], ['visual', '映像'], ['acting', '演技'], ['music', '音楽'], ['dialogue', '台詞'],
  ['world', '世界観'], ['company', '一緒に観た人'], ['place', '観た場所'],
];
export const FACTOR_LABEL = Object.fromEntries(FACTORS);

export const PLACES = [['theater', '映画館'], ['stream', '配信'], ['tv', 'テレビ'], ['disc', 'ディスク'], ['other', 'その他']];
export const PLACE_LABEL = Object.fromEntries(PLACES);

export const VIVID = [['vivid', 'まだ鮮明'], ['faint', 'ぼんやり'], ['gone', 'ほぼ消えた']];
export const VIVID_LABEL = Object.fromEntries(VIVID);

// ---------- 日付 ----------
export function ymd(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dayNumber(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5 : null;
}
export function daysBetween(a, b) {
  const x = dayNumber(a), y = dayNumber(b);
  return x === null || y === null ? null : y - x;
}
// 鑑賞日は「2026-10-31」のほか、思い出し記録では「2015」「2015-08」のように粗くてもよい
// 粗い日付を、比べるための日にする(年だけなら年の半ば)
export function fullDate(s) {
  s = String(s || '');
  if (/^\d{4}$/.test(s)) return `${s}-07-01`;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-15`;
  return s.slice(0, 10);
}
export function dateSortKey(v) { return v.date || (v.createdAt || '').slice(0, 10); }
export function dateLabel(v) {
  const d = v.date || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { const [y, m, dd] = d.split('-'); return `${y}/${+m}/${+dd}`; }
  if (/^\d{4}-\d{2}$/.test(d)) { const [y, m] = d.split('-'); return `${y}年${+m}月ごろ`; }
  if (/^\d{4}$/.test(d)) return `${d}年ごろ`;
  return v.dateNote || '時期不明';
}

// ---------- 余韻(あとからもう一度聞く) ----------
// 思い出すときの評価は、いちばん強かった瞬間と終わりの印象でほぼ決まり、長さはあまり効かない
// (Fredrickson & Kahneman 1993, JPSP 65(1) 45-55。実験の素材は映画の短い場面だった)。
// その「思い出したときの評価」が時間でどう変わるかを、1週間後と3か月後に一度ずつ聞いて残す。
export const CHECKPOINTS = [
  { days: 7, window: 30, label: '1週間' },
  { days: 90, window: 90, label: '3か月' },
];

export function dueAfterglows(views, today = ymd()) {
  const out = [];
  for (const v of views) {
    if (v.recall || !/^\d{4}-\d{2}-\d{2}$/.test(v.date || '')) continue;
    const age = daysBetween(v.date, today);
    if (age === null) continue;
    const done = new Set((v.afterglow || []).map(a => a.checkpoint));
    for (const c of CHECKPOINTS) {
      if (done.has(c.days) || age < c.days || age >= c.days + c.window) continue;
      // 7日目を逃して90日目が来たら、新しい方だけを聞く
      out.push({ view: v, checkpoint: c.days, label: c.label, age });
    }
  }
  const latest = new Map();
  for (const d of out) if (!latest.has(d.view.id) || latest.get(d.view.id).checkpoint < d.checkpoint) latest.set(d.view.id, d);
  return [...latest.values()].sort((a, b) => a.age - b.age);
}

// 一度の鑑賞の、今の評価(余韻で付け直していればそれ)
export function currentScore(v) {
  const ag = (v.afterglow || []).filter(a => typeof a.score === 'number');
  if (ag.length) return ag[ag.length - 1].score;
  return typeof v.score === 'number' ? v.score : null;
}

// 映画の評価: いちばん新しい鑑賞の今の評価
export function filmScore(film, views) {
  const vs = views.filter(v => v.filmId === film.id).sort((a, b) => dateSortKey(b).localeCompare(dateSortKey(a)));
  for (const v of vs) { const s = currentScore(v); if (s !== null) return s; }
  return null;
}

// 観た直後から余韻までの評価の動き。正なら「あとから効いた」、負なら「その場かぎり」
export function drift(v) {
  if (typeof v.score !== 'number') return null;
  const ag = (v.afterglow || []).filter(a => typeof a.score === 'number');
  if (!ag.length) return null;
  return ag[ag.length - 1].score - v.score;
}

export function driftRanking(views, films) {
  const byId = new Map(films.map(f => [f.id, f]));
  const rows = views.map(v => ({ view: v, film: byId.get(v.filmId), drift: drift(v) })).filter(r => r.film && r.drift !== null);
  return {
    grew: rows.filter(r => r.drift >= 1).sort((a, b) => b.drift - a.drift),
    faded: rows.filter(r => r.drift <= -1).sort((a, b) => a.drift - b.drift),
  };
}

// ---------- 振り返り ----------
// 過去の年の、今日の前後 range 日に観たもの
export function onThisSeason(views, today = ymd(), range = 10) {
  const [ty, tm, td] = today.split('-').map(Number);
  return views.filter(v => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.date || '');
    if (!m || +m[1] >= ty) return false;
    const a = Date.UTC(2001, +m[2] - 1, +m[3]), b = Date.UTC(2001, tm - 1, td);
    let diff = Math.abs(a - b) / 864e5;
    diff = Math.min(diff, 365 - diff);
    return diff <= range;
  }).sort((a, b) => b.date.localeCompare(a.date));
}

// 期間内で、どの感情が何回起きたか。最後に起きた日も返す
export function emotionProfile(views, { from = '', to = '9999' } = {}) {
  const map = new Map(EMOTIONS.map(([k]) => [k, { key: k, label: EMOTION_LABEL[k], count: 0, last: '' }]));
  for (const v of views) {
    const d = dateSortKey(v);
    if (d < from || d > to) continue;
    for (const e of v.emotions || []) {
      const r = map.get(e);
      if (!r) continue;
      r.count++;
      if (d > r.last) r.last = d;
    }
  }
  return [...map.values()];
}

// しばらく味わっていない感情: 一度も起きていないか、最後が days 日より前
export function emotionGaps(views, today = ymd(), days = 120) {
  const prof = emotionProfile(views);
  return prof.filter(p => SEEKABLE.has(p.key) && (!p.count || (daysBetween(fullDate(p.last), today) ?? 0) > days))
    .map(p => ({ ...p, never: !p.count }));
}

// 年ごとのいちばん(今の評価が高い順、同点は新しい順)
export function bestByYear(views, films, n = 3) {
  const byId = new Map(films.map(f => [f.id, f]));
  const years = new Map();
  for (const v of views) {
    const y = (v.date || '').slice(0, 4);
    const s = currentScore(v);
    if (!/^\d{4}$/.test(y) || s === null || !byId.get(v.filmId)) continue;
    if (!years.has(y)) years.set(y, []);
    years.get(y).push({ view: v, film: byId.get(v.filmId), score: s });
  }
  return [...years.entries()].sort((a, b) => b[0].localeCompare(a[0]))
    .map(([year, rows]) => ({ year, count: rows.length, top: rows.sort((a, b) => b.score - a.score || dateSortKey(b.view).localeCompare(dateSortKey(a.view))).slice(0, n) }));
}

// ---------- 空白地図(地域 × 年代) ----------
export const REGIONS = [
  { key: 'jp', label: '日本', codes: ['JP'] },
  { key: 'ea', label: '東アジア', codes: ['KR', 'CN', 'HK', 'TW', 'MO', 'MN', 'KP'] },
  { key: 'sa', label: '南・東南アジア', codes: ['IN', 'TH', 'PH', 'ID', 'VN', 'MY', 'SG', 'KH', 'MM', 'LA', 'BD', 'PK', 'LK', 'NP', 'BT'] },
  { key: 'me', label: '中東・アフリカ', codes: ['IR', 'TR', 'IL', 'PS', 'LB', 'EG', 'SY', 'IQ', 'JO', 'SA', 'AE', 'QA', 'MA', 'DZ', 'TN', 'SN', 'ML', 'BF', 'NG', 'GH', 'CM', 'ET', 'KE', 'ZA', 'CD', 'TD', 'MR', 'RW', 'UG', 'SD', 'AF', 'KZ', 'KG', 'UZ', 'TJ', 'GE', 'AM', 'AZ'] },
  { key: 'eu', label: 'ヨーロッパ', codes: ['FR', 'GB', 'DE', 'IT', 'ES', 'SE', 'DK', 'NO', 'FI', 'IS', 'NL', 'BE', 'LU', 'CH', 'AT', 'IE', 'PT', 'GR', 'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'RS', 'HR', 'SI', 'BA', 'MK', 'AL', 'ME', 'XK', 'EE', 'LV', 'LT', 'UA', 'BY', 'RU', 'MD', 'CY', 'MT', 'SU', 'XC', 'YU', 'CS', 'XG', 'DD'] },
  { key: 'na', label: '北米', codes: ['US', 'CA'] },
  { key: 'la', label: '中南米', codes: ['MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'CU', 'UY', 'VE', 'BO', 'EC', 'PY', 'GT', 'CR', 'PA', 'DO', 'PR', 'HT', 'NI', 'HN', 'SV', 'JM'] },
  { key: 'oc', label: 'オセアニア', codes: ['AU', 'NZ', 'PG', 'FJ'] },
];
const REGION_OF = new Map(REGIONS.flatMap(r => r.codes.map(c => [c, r.key])));
export function regionOf(film) {
  for (const c of film.countries || []) if (REGION_OF.has(c)) return REGION_OF.get(c);
  return null;
}
export const DECADES = [
  { key: 'old', label: '〜50年代', from: 1890, to: 1959 }, { key: '1960', label: '60年代', from: 1960, to: 1969 },
  { key: '1970', label: '70年代', from: 1970, to: 1979 }, { key: '1980', label: '80年代', from: 1980, to: 1989 },
  { key: '1990', label: '90年代', from: 1990, to: 1999 }, { key: '2000', label: '00年代', from: 2000, to: 2009 },
  { key: '2010', label: '10年代', from: 2010, to: 2019 }, { key: '2020', label: '20年代', from: 2020, to: 2029 },
];
export function decadeOf(year) {
  if (!year) return null;
  const d = DECADES.find(x => year >= x.from && year <= x.to);
  return d ? d.key : null;
}
export function gapGrid(films) {
  const grid = {};
  for (const r of REGIONS) { grid[r.key] = {}; for (const d of DECADES) grid[r.key][d.key] = 0; }
  let unknown = 0;
  for (const f of films) {
    if (f.status !== 'seen') continue;
    const r = regionOf(f), d = decadeOf(f.year);
    if (r && d) grid[r][d]++; else unknown++;
  }
  return { grid, unknown };
}

// ---------- 作り手の糸 ----------
// 高く評価した映画の監督・脚本・撮影・音楽・編集をたどり、その人たちが関わったまだ観ていない映画を集める。
// 一人だけでつながる映画より、別々の好きな映画から二人以上でつながる映画を上に出す(偶然の一致ではなく、好みの芯に近い)。
export function pickThreadSeeds(films, views, { min = 7, maxPeople = 14 } = {}) {
  const scored = films.filter(f => f.status === 'seen' && f.tmdbId && f.crew)
    .map(f => ({ film: f, score: filmScore(f, views) }))
    .filter(x => x.score !== null && x.score >= min)
    .sort((a, b) => b.score - a.score);
  const people = new Map();
  const roleOrder = ['Director', 'Screenplay', 'Director of Photography', 'Original Music Composer', 'Editor'];
  for (const role of roleOrder) {
    for (const { film, score } of scored) {
      for (const p of (film.crew[role] || []).slice(0, 2)) {
        if (people.size >= maxPeople && !people.has(p.id)) continue;
        if (!people.has(p.id)) people.set(p.id, { id: p.id, name: p.name, links: [] });
        people.get(p.id).links.push({ role, filmId: film.id, title: film.title, score });
      }
    }
  }
  return [...people.values()];
}

export function weaveThreads(seeds, creditsByPerson, { exclude = new Set(), roles, thisYear = new Date().getFullYear(), limit = 30 } = {}) {
  const cands = new Map();
  for (const person of seeds) {
    const credits = creditsByPerson[person.id] || [];
    const best = person.links.reduce((m, l) => Math.max(m, l.score), 0);
    const fan = Math.max(0.2, (best - 5) / 5); // 10点で1、7点で0.4
    for (const c of credits) {
      if (!roles[c.job] || exclude.has(c.tmdbId) || (c.year && c.year > thisYear) || !c.year) continue;
      if ((c.voteCount || 0) < 5) continue; // 情報のほとんどない短編や未公開作は外す
      if (!cands.has(c.tmdbId)) cands.set(c.tmdbId, { ...c, score: 0, links: [], people: new Set() });
      const x = cands.get(c.tmdbId);
      if (x.links.some(l => l.personId === person.id && l.job === c.job)) continue;
      x.score += roles[c.job].weight * fan;
      x.people.add(person.id);
      x.links.push({ personId: person.id, name: person.name, job: c.job, via: person.links[0].title, viaRole: person.links[0].role });
    }
  }
  return [...cands.values()].map(x => {
    const n = x.people.size;
    return { ...x, people: n, score: x.score * (n >= 2 ? 1.6 : 1) + Math.log10(1 + (x.voteCount || 0)) * 0.05 };
  }).sort((a, b) => b.people - a.people || b.score - a.score).slice(0, limit);
}

// ---------- Geminiでの提案 ----------
export const LENSES = [
  ['echo', 'あとから効いた映画と同じ効き方'],
  ['gap', 'しばらく味わっていない感情'],
  ['elsewhere', '好きな映画の問いを、別の国・時代で'],
  ['edge', '苦手の手前にある一本'],
];
export const LENS_LABEL = Object.fromEntries(LENSES);

export function buildSuggestPrompt({ films, views, gaps = [], today = ymd() }) {
  const lines = [];
  lines.push('あなたは映画に詳しい選び手です。下の鑑賞記録の持ち主に、まだ観ていない映画を提案します。');
  lines.push('ありがちな定番や、記録にある監督の代表作ばかりにならないようにし、実在が確かな長編映画だけを挙げてください。確信がないものは挙げません。');
  lines.push('観点ごとに2本ずつ、計8本。観点は次の4つです。');
  lines.push('- echo: 「あとから効いた」映画と、効き方(どの感情が残ったか)が近い映画');
  lines.push('- gap: 持ち主がしばらく味わっていない感情を起こしやすい映画');
  lines.push('- elsewhere: 高く評価した映画が扱った問いを、別の国・別の時代に扱った映画');
  lines.push('- edge: 低く評価した傾向の、ほんの少し手前にあり、苦手を越える入口になりそうな映画');
  lines.push('JSONで {"items":[{"lens":"echo","title":"日本での題名","originalTitle":"原題","year":1999,"director":"監督","country":"国","why":"この人に勧める理由を1文"}]} の形だけを返します。why は記録のどの映画・感情とつながるかを具体的に書きます。');
  lines.push('');
  lines.push(`今日: ${today}`);
  const seen = films.filter(f => f.status === 'seen');
  const rows = seen.map(f => {
    const vs = views.filter(v => v.filmId === f.id);
    const v = vs.sort((a, b) => dateSortKey(b).localeCompare(dateSortKey(a)))[0] || {};
    const d = drift(v);
    return { f, score: filmScore(f, views), emotions: [...new Set(vs.flatMap(x => x.emotions || []))], drift: d };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 40);
  lines.push('鑑賞記録(評価は10点満点、「→」は余韻で付け直した変化):');
  for (const r of rows) {
    const em = r.emotions.map(e => EMOTION_LABEL[e]).filter(Boolean).join('・');
    lines.push(`- ${r.f.title}${r.f.year ? `(${r.f.year})` : ''}${r.f.directors && r.f.directors.length ? ` 監督:${r.f.directors.join('、')}` : ''} 評価:${r.score ?? '未'}${r.drift ? ` (余韻で${r.drift > 0 ? '+' : ''}${r.drift})` : ''}${em ? ` 感情:${em}` : ''}`);
  }
  if (gaps.length) lines.push(`しばらく味わっていない感情: ${gaps.map(g => g.label).join('、')}`);
  const want = films.filter(f => f.status === 'want').map(f => f.title);
  if (want.length) lines.push(`すでに観たいリストにあるので除く: ${want.slice(0, 60).join('、')}`);
  return lines.join('\n');
}

export function parseSuggest(text) {
  let data;
  try { data = JSON.parse(text); } catch {
    const m = /\{[\s\S]*\}/.exec(text || '');
    if (!m) return [];
    try { data = JSON.parse(m[0]); } catch { return []; }
  }
  const items = Array.isArray(data) ? data : data.items || [];
  return items.filter(x => x && x.title).map(x => ({
    lens: LENS_LABEL[x.lens] ? x.lens : 'echo', title: String(x.title), originalTitle: x.originalTitle ? String(x.originalTitle) : '',
    year: Number(x.year) || null, director: x.director ? String(x.director) : '', country: x.country ? String(x.country) : '', why: x.why ? String(x.why) : '',
  }));
}

// 題名の照合(全角半角・空白・記号を無視)
export function normTitle(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[\s・:：\-–—'"「」『』!！?？.,、。]/g, '');
}
export function findFilm(films, { tmdbId, title, year }) {
  if (tmdbId) { const f = films.find(x => x.tmdbId === tmdbId); if (f) return f; }
  const t = normTitle(title);
  return films.find(f => (normTitle(f.title) === t || (f.originalTitle && normTitle(f.originalTitle) === t)) && (!year || !f.year || Math.abs(f.year - year) <= 1)) || null;
}
