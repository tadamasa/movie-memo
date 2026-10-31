// TMDb(The Movie Database)API。作品情報・クレジット・日本の配信状況を取る。
// キーは本人が無料で取得したもの(v3のAPIキー、またはv4の読み取り用トークン)を端末内にだけ置く。
// 出典表示の決まり: "This product uses the TMDB API but is not endorsed or certified by TMDB."
// 配信状況(watch/providers)は JustWatch のデータで、表示するときは JustWatch の名前を出す。

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';

let key = '';
export function setKey(k) { key = (k || '').trim(); }
export function hasKey() { return !!key; }

// 作り手の糸でたどる役割。重みは「その人が作品の手触りをどれだけ決めるか」の目安。
export const ROLES = {
  Director: { label: '監督', weight: 1.0 },
  Screenplay: { label: '脚本', weight: 0.8 },
  Writer: { label: '脚本', weight: 0.8 },
  'Director of Photography': { label: '撮影', weight: 0.7 },
  'Original Music Composer': { label: '音楽', weight: 0.6 },
  Editor: { label: '編集', weight: 0.5 },
};

export function posterUrl(path, size = 'w185') {
  return path ? `${IMG}${size}${path}` : '';
}

async function call(path, params = {}) {
  if (!key) throw new Error('設定でTMDbのキーを入れてください');
  const url = new URL(BASE + path);
  const headers = { accept: 'application/json' };
  // v4トークンは長いJWT、v3キーは32桁の英数字
  if (key.length > 40) headers.Authorization = `Bearer ${key}`; else url.searchParams.set('api_key', key);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, v);
  const res = await fetch(url, { headers });
  if (res.status === 401) throw new Error('TMDbのキーが違います');
  if (res.status === 429) throw new Error('TMDbの呼び出しが多すぎます。少し待ってください');
  if (!res.ok) throw new Error(`TMDb HTTP ${res.status}`);
  return res.json();
}

const year = d => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : null);

// 検索結果の1件
export function parseResult(r) {
  return {
    tmdbId: r.id,
    title: r.title || r.original_title || '',
    originalTitle: r.original_title && r.original_title !== r.title ? r.original_title : '',
    year: year(r.release_date),
    posterPath: r.poster_path || '',
    overview: r.overview || '',
    voteCount: r.vote_count || 0,
  };
}

export async function search(query) {
  const data = await call('/search/movie', { query, language: 'ja-JP', include_adult: 'false' });
  return (data.results || []).slice(0, 12).map(parseResult);
}

// 詳細(クレジットと日本の配信状況つき)を、アプリの映画の形にする
export function parseDetail(d) {
  const crew = (d.credits && d.credits.crew) || [];
  const people = {};
  for (const c of crew) {
    if (!ROLES[c.job]) continue;
    const role = c.job === 'Writer' ? 'Screenplay' : c.job;
    (people[role] = people[role] || []);
    if (!people[role].some(p => p.id === c.id)) people[role].push({ id: c.id, name: c.name });
  }
  const cast = ((d.credits && d.credits.cast) || []).slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).slice(0, 8).map(c => ({ id: c.id, name: c.name, character: c.character || '' }));
  const countries = (d.production_countries || []).map(c => c.iso_3166_1).concat(d.origin_country || []);
  return {
    ...parseResult(d),
    runtime: d.runtime || null,
    genres: (d.genres || []).map(g => g.name),
    countries: [...new Set(countries)],
    directors: (people.Director || []).map(p => p.name),
    crew: people,
    cast,
    providers: parseProviders(d['watch/providers']),
    fetchedAt: new Date().toISOString(),
  };
}

// 日本で見られる配信(定額・レンタル・購入)
export function parseProviders(wp) {
  const jp = wp && wp.results && wp.results.JP;
  if (!jp) return null;
  const names = list => (list || []).map(p => p.provider_name);
  return { link: jp.link || '', flatrate: names(jp.flatrate), rent: names(jp.rent), buy: names(jp.buy), checkedAt: new Date().toISOString() };
}

export async function detail(tmdbId) {
  const d = await call(`/movie/${tmdbId}`, { language: 'ja-JP', append_to_response: 'credits,watch/providers' });
  return parseDetail(d);
}

// ある人が関わった映画(役割つき)
export function parseCredits(data) {
  const out = [];
  for (const c of [...(data.crew || [])]) {
    if (!c.id) continue;
    out.push({ ...parseResult(c), job: c.job === 'Writer' ? 'Screenplay' : c.job });
  }
  return out;
}

export async function personCredits(personId) {
  return parseCredits(await call(`/person/${personId}/movie_credits`, { language: 'ja-JP' }));
}

// 地域と年代で、評価の数が多い順に探す(空白地図から)
export async function discoverBy({ countries, from, to, page = 1 }) {
  const data = await call('/discover/movie', {
    language: 'ja-JP', with_origin_country: countries.join('|'), 'primary_release_date.gte': `${from}-01-01`, 'primary_release_date.lte': `${to}-12-31`,
    sort_by: 'vote_count.desc', include_adult: 'false', page,
  });
  return (data.results || []).map(parseResult);
}

export async function ping() {
  await call('/configuration');
  return true;
}
