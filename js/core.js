// 画面に触れない計算。node --test で確かめられるようにここに集める。

export const PLACES = [['stream', '配信'], ['theater', '映画館'], ['tv', 'テレビ'], ['disc', 'ディスク'], ['other', 'その他']];
export const PLACE_LABEL = Object.fromEntries(PLACES);

// ---------- 配信サービス ----------
// 契約しているサービスの既定。TMDb(JustWatch)の提供元名と、ゆるく突き合わせる
export const DEFAULT_SERVICES = ['Netflix', 'Amazon Prime Video', 'U-NEXT'];
const normSvc = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\-_.]/g, '');
// 「Netflix Standard with Ads」や「Amazon Prime Video with Ads」も同じサービスとみなす
export function sameService(a, b) {
  const x = normSvc(a), y = normSvc(b);
  if (!x || !y) return false;
  if (x === y || x.startsWith(y) || y.startsWith(x)) return true;
  // 「HBO Max on U-Next」のように、契約中のサービスの中のチャンネル
  return x.endsWith(`on${y}`) || y.endsWith(`on${x}`);
}
// その映画を、自分の契約で見放題で観られるサービス
export function availableOn(film, services = DEFAULT_SERVICES) {
  const flat = (film && film.providers && film.providers.flatrate) || [];
  return services.filter(s => flat.some(p => sameService(p, s)));
}
export function parseServices(text) {
  const list = String(text || '').split(/\n|,|、/).map(x => x.trim()).filter(Boolean);
  return list.length ? [...new Set(list)] : DEFAULT_SERVICES.slice();
}

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

export function currentScore(v) {
  return v && typeof v.score === 'number' ? v.score : null;
}

// 映画の評価: いちばん新しい鑑賞の今の評価
export function filmScore(film, views) {
  const vs = views.filter(v => v.filmId === film.id).sort((a, b) => dateSortKey(b).localeCompare(dateSortKey(a)));
  for (const v of vs) { const s = currentScore(v); if (s !== null) return s; }
  return null;
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
  ['near', '近い'],
  ['far', '遠いのに通じる'],
  ['counter', '反対側から'],
  ['unknown', 'まだ観ていない領域'],
];
export const LENS_LABEL = Object.fromEntries(LENSES);

// 送るのは題名・年・監督・評価だけ。感想の文章は送らない
export function buildSuggestPrompt({ films, views, today = ymd() }) {
  const lines = [];
  lines.push('あなたは映画に詳しい選び手です。下の鑑賞記録の持ち主に、まだ観ていない映画を提案します。');
  lines.push('ありがちな定番や、記録にある監督の代表作ばかりにならないようにし、実在が確かな長編映画だけを挙げてください。確信がないものは挙げません。');
  lines.push('観点ごとに2本ずつ、計8本。観点は次の4つです。');
  lines.push('- near: 高く評価した映画に近い映画');
  lines.push('- far: 国・時代・ジャンルは遠いのに、高く評価した映画と通じるところがある映画');
  lines.push('- counter: 高く評価した映画と反対の立場・語り口から同じ主題を扱った映画');
  lines.push('- unknown: 記録にほとんどない国・年代・ジャンルへの入口になる映画');
  lines.push('JSONで {"items":[{"lens":"near","title":"日本での題名","originalTitle":"原題","year":1999,"director":"監督","country":"国","why":"この人に勧める理由を1文"}]} の形だけを返します。why は記録のどの映画とつながるかを具体的に書きます。');
  lines.push('');
  lines.push(`今日: ${today}`);
  const rows = films.filter(f => f.status === 'seen').map(f => ({ f, score: filmScore(f, views) }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 50);
  lines.push('鑑賞記録(評価は10点満点):');
  for (const r of rows) {
    lines.push(`- ${r.f.title}${r.f.year ? `(${r.f.year})` : ''}${r.f.directors && r.f.directors.length ? ` 監督:${r.f.directors.join('、')}` : ''} 評価:${r.score ?? '未'}`);
  }
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
    lens: LENS_LABEL[x.lens] ? x.lens : 'near', title: String(x.title), originalTitle: x.originalTitle ? String(x.originalTitle) : '',
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

// ---------- 他の人の感想 ----------
// 題名だけでは同名の別作品や小説が混ざるので、「映画」や公開年を添えて探す
export function reviewLinks(f) {
  const t = f.title;
  const enc = encodeURIComponent;
  const year = f.year ? ` ${f.year}` : '';
  const links = [
    { group: 'X', label: '感想(話題順)', url: `https://x.com/search?q=${enc(`${t} 映画 感想 min_faves:20`)}&f=top` },
    { group: 'X', label: '感想(新しい順)', url: `https://x.com/search?q=${enc(`${t} 映画 感想`)}&f=live` },
    { group: 'レビュー', label: 'Filmarks', url: `https://filmarks.com/search/movies?q=${enc(t)}` },
    { group: 'レビュー', label: '映画.com', url: `https://eiga.com/search/${enc(t)}/` },
    { group: 'ブログ', label: 'はてなブログ', url: `https://hatenablog.com/search?q=${enc(`${t} 映画 感想`)}` },
    { group: 'ブログ', label: 'note', url: `https://note.com/search?q=${enc(`${t} 映画`)}&context=note` },
    { group: 'ブログ', label: 'ブログを検索', url: `https://www.google.com/search?q=${enc(`"${t}" 映画 感想 ブログ${year}`)}` },
    { group: '動画', label: '予告編', url: `https://www.youtube.com/results?search_query=${enc(`${t} 予告`)}` },
    { group: '動画', label: '解説・考察', url: `https://www.youtube.com/results?search_query=${enc(`${t} 映画 解説 考察`)}` },
  ];
  const orig = f.originalTitle || (/^[\x00-\x7F]+$/.test(t) ? t : '');
  if (orig) links.push({ group: '海外', label: 'Letterboxd', url: `https://letterboxd.com/search/films/${enc(orig)}/` });
  links.push({ group: '海外', label: 'Wikipedia', url: `https://ja.wikipedia.org/w/index.php?search=${enc(`${t} 映画`)}` });
  return links;
}

// ---------- カテゴリ ----------
// 1本に1つ。一覧は設定で編集できる。TMDbのジャンル(日本語・英語どちらの名前でも)から最初の候補を決める
export const DEFAULT_CATEGORIES = [
  'ドラマ', 'コメディ', 'アクション・冒険', 'SF・ファンタジー', 'サスペンス・ミステリー', 'ホラー',
  '恋愛', 'アニメ', 'ドキュメンタリー', '歴史・戦争', '音楽・ミュージカル', '家族・青春',
];
export function parseCategories(text) {
  const list = String(text || '').split('\n').map(x => x.trim()).filter(Boolean);
  return list.length ? [...new Set(list)] : DEFAULT_CATEGORIES.slice();
}
// 上にあるものほど優先する(アニメのSFは「アニメ」、戦争ドラマは「歴史・戦争」)
const GENRE_RULES = [
  [/アニメ|animation/i, 'アニメ'],
  [/ドキュメンタリー|documentary/i, 'ドキュメンタリー'],
  [/ホラー|horror/i, 'ホラー'],
  [/サイエンス|SF|ファンタジー|science|fantasy/i, 'SF・ファンタジー'],
  [/戦争|歴史|西部|履歴|war|history|western/i, '歴史・戦争'],
  [/音楽|ミュージカル|music/i, '音楽・ミュージカル'],
  [/犯罪|スリラー|ミステリー|謎|サスペンス|crime|thriller|mystery/i, 'サスペンス・ミステリー'],
  [/ロマンス|恋愛|romance/i, '恋愛'],
  [/アクション|アドベンチャー|冒険|action|adventure/i, 'アクション・冒険'],
  [/コメディ|comedy/i, 'コメディ'],
  [/ファミリー|family/i, '家族・青春'],
  [/ドラマ|drama/i, 'ドラマ'],
];
export function genreToCategory(genres, categories = DEFAULT_CATEGORIES) {
  const text = (genres || []).join(' ');
  if (!text) return '';
  for (const [re, cat] of GENRE_RULES) if (re.test(text) && categories.includes(cat)) return cat;
  return '';
}

// ---------- 観た日 ----------
// 映画ごとの最後に観た日(いちばん新しい鑑賞の日付。「2015」のような粗い時期もそのまま)と、観た回数
export function seenSummary(filmId, views) {
  const vs = views.filter(v => v.filmId === filmId);
  let last = '';
  for (const v of vs) if (v.date && fullDate(v.date) > fullDate(last)) last = v.date;
  return { lastSeen: last, count: vs.length };
}
