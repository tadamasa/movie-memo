// node --test tests/ で実行。画面に触れない計算と、TMDbの応答の読み取り、ハブ(Apps Script)を確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filmScore, onThisSeason, bestByYear, gapGrid, regionOf, decadeOf, pickThreadSeeds, weaveThreads, buildSuggestPrompt, parseSuggest,
  findFilm, dateLabel, fullDate, availableOn, parseServices, sameService, reviewLinks,
} from '../js/core.js';
import { parseDetail, parseCredits, ROLES } from '../js/tmdb.js';
import { loadHub } from './gas-mock.mjs';

test('いつかの今ごろ: 過去の年の前後10日だけを出す(年をまたぐ日付も)', () => {
  const views = [{ id: 'a', date: '2020-11-05' }, { id: 'b', date: '2026-10-30' }, { id: 'c', date: '2019-06-01' }, { id: 'd', date: '2018-01-03' }];
  assert.deepEqual(onThisSeason(views, '2026-10-31').map(v => v.id), ['a']);
  assert.deepEqual(onThisSeason(views, '2026-12-28').map(v => v.id), ['d']);
});

test('年ごとのいちばん: 評価で並べる', () => {
  const films = [{ id: 'f', title: 'A' }, { id: 'g', title: 'B' }];
  const views = [{ filmId: 'f', date: '2026-01-01', score: 7 }, { filmId: 'g', date: '2026-02-01', score: 9 }];
  const best = bestByYear(views, films);
  assert.equal(best[0].year, '2026');
  assert.equal(best[0].top[0].film.id, 'g');
});

test('空白地図: 製作国と年代で数える', () => {
  assert.equal(regionOf({ countries: ['FR', 'BE'] }), 'eu');
  assert.equal(regionOf({ countries: ['XX', 'IR'] }), 'me');
  assert.equal(decadeOf(1987), '1980');
  assert.equal(decadeOf(1931), 'old');
  const { grid, unknown } = gapGrid([
    { status: 'seen', countries: ['JP'], year: 2001 }, { status: 'seen', countries: ['JP'], year: 2003 },
    { status: 'want', countries: ['JP'], year: 2001 }, { status: 'seen', countries: [], year: 2001 },
  ]);
  assert.equal(grid.jp['2000'], 2);
  assert.equal(unknown, 1);
});

test('TMDbの詳細から、作り手・国・日本の配信を読む', () => {
  const f = parseDetail({
    id: 129, title: '千と千尋の神隠し', original_title: '千と千尋の神隠し', release_date: '2001-07-20', runtime: 125, poster_path: '/p.jpg',
    genres: [{ name: 'アニメーション' }], production_countries: [{ iso_3166_1: 'JP' }], origin_country: ['JP'],
    credits: {
      cast: [{ id: 1, name: 'B', order: 1 }, { id: 2, name: 'A', order: 0 }],
      crew: [
        { id: 10, name: '宮崎駿', job: 'Director' }, { id: 10, name: '宮崎駿', job: 'Screenplay' }, { id: 10, name: '宮崎駿', job: 'Writer' },
        { id: 11, name: '久石譲', job: 'Original Music Composer' }, { id: 12, name: 'X', job: 'Producer' },
      ],
    },
    'watch/providers': { results: { JP: { link: 'https://x', flatrate: [{ provider_name: 'Netflix' }] } } },
  });
  assert.equal(f.year, 2001);
  assert.equal(f.originalTitle, '');
  assert.deepEqual(f.directors, ['宮崎駿']);
  assert.equal(f.crew.Screenplay.length, 1);
  assert.equal(f.crew.Producer, undefined);
  assert.equal(f.cast[0].name, 'A');
  assert.deepEqual(f.countries, ['JP']);
  assert.deepEqual(f.providers.flatrate, ['Netflix']);
});

test('作り手の糸: 二人以上でつながる映画を上に出し、観た映画と未公開作は除く', () => {
  const films = [
    { id: 'a', tmdbId: 1, title: 'A', status: 'seen', crew: { Director: [{ id: 100, name: '監督甲' }], 'Director of Photography': [{ id: 200, name: '撮影乙' }] } },
    { id: 'b', tmdbId: 2, title: 'B', status: 'seen', crew: { 'Original Music Composer': [{ id: 300, name: '音楽丙' }] } },
    { id: 'c', tmdbId: 3, title: 'C', status: 'seen', crew: { Director: [{ id: 999, name: '低評価' }] } },
  ];
  const views = [{ filmId: 'a', date: '2026-01-01', score: 9 }, { filmId: 'b', date: '2026-01-02', score: 8 }, { filmId: 'c', date: '2026-01-03', score: 4 }];
  const seeds = pickThreadSeeds(films, views);
  assert.deepEqual(seeds.map(s => s.id).sort(), [100, 200, 300]);
  const credits = {
    100: parseCredits({ crew: [{ id: 50, title: '一本糸', release_date: '1999-01-01', job: 'Director', vote_count: 900 }, { id: 1, title: 'A', release_date: '2000-01-01', job: 'Director', vote_count: 100 }] }),
    200: parseCredits({ crew: [{ id: 60, title: '二本糸', release_date: '2005-01-01', job: 'Director of Photography', vote_count: 40 }, { id: 70, title: '未来', release_date: '2099-01-01', job: 'Director of Photography', vote_count: 40 }] }),
    300: parseCredits({ crew: [{ id: 60, title: '二本糸', release_date: '2005-01-01', job: 'Original Music Composer', vote_count: 40 }] }),
  };
  const r = weaveThreads(seeds, credits, { exclude: new Set([1, 2, 3]), roles: ROLES, thisYear: 2026 });
  assert.equal(r[0].title, '二本糸');
  assert.equal(r[0].people, 2);
  assert.ok(r.every(x => x.title !== 'A' && x.title !== '未来'));
});

test('AIの提案: 送る文に感想を入れず、返答のJSONを読む', () => {
  const films = [{ id: 'f', title: '秘密の映画', year: 2000, status: 'seen', directors: ['某'] }, { id: 'w', title: '観たい映画', status: 'want' }];
  const views = [{ filmId: 'f', date: '2026-01-01', score: 8, text: '誰にも言えない感想' }];
  const p = buildSuggestPrompt({ films, views, today: '2026-10-31' });
  assert.ok(p.includes('秘密の映画'));
  assert.ok(p.includes('評価:8'));
  assert.ok(p.includes('除く: 観たい映画'));
  assert.ok(!p.includes('誰にも言えない感想'));
  const items = parseSuggest('```json\n{"items":[{"lens":"far","title":"X","year":"1970","why":"w"},{"lens":"zzz","title":"Y"},{"title":""}]}\n```');
  assert.equal(items.length, 2);
  assert.equal(items[0].year, 1970);
  assert.equal(items[1].lens, 'near');
});

test('配信: 広告つきプランなども同じサービスとみなし、契約中のものだけを返す', () => {
  const film = { providers: { flatrate: ['Netflix Standard with Ads', 'Amazon Prime Video', 'Hulu'] } };
  assert.deepEqual(availableOn(film, ['Netflix', 'Amazon Prime Video', 'U-NEXT']), ['Netflix', 'Amazon Prime Video']);
  assert.deepEqual(availableOn({}, ['Netflix']), []);
  assert.ok(sameService('U-NEXT', 'unext'));
  assert.ok(!sameService('Netflix', ''));
  assert.deepEqual(parseServices('Netflix\nU-NEXT、Netflix'), ['Netflix', 'U-NEXT']);
  assert.deepEqual(parseServices(''), ['Netflix', 'Amazon Prime Video', 'U-NEXT']);
});

test('ほかの人の感想: Xは「映画 感想」を添えて探し、原題があればLetterboxdも出す', () => {
  const links = reviewLinks({ title: 'パスト ライブス/再会', originalTitle: 'Past Lives', year: 2023 });
  const x = links.find(l => l.label === '感想(話題順)');
  assert.ok(decodeURIComponent(x.url).includes('パスト ライブス/再会 映画 感想 min_faves:20'));
  assert.ok(links.some(l => l.label === 'Letterboxd' && l.url.includes('Past%20Lives')));
  assert.ok(links.some(l => l.group === 'ブログ'));
  assert.ok(!reviewLinks({ title: '羅生門' }).some(l => l.label === 'Letterboxd'));
});

test('題名の照合は全角半角と記号を無視し、年が近いものだけを同じとみなす', () => {
  const films = [{ id: 'a', title: 'ＡＫＩＲＡ', year: 1988 }, { id: 'b', title: 'Her/世界でひとつの彼女', originalTitle: 'Her', year: 2013 }];
  assert.equal(findFilm(films, { title: 'akira', year: 1988 }).id, 'a');
  assert.equal(findFilm(films, { title: 'AKIRA', year: 2030 }), null);
  assert.equal(findFilm(films, { title: 'her', year: 2014 }).id, 'b');
});

test('時期の表示', () => {
  assert.equal(dateLabel({ date: '2026-10-31' }), '2026/10/31');
  assert.equal(dateLabel({ date: '2015-08' }), '2015年8月ごろ');
  assert.equal(dateLabel({ date: '', dateNote: '学生時代' }), '学生時代');
});

test('ハブ: 映画と鑑賞を受け取り、表に読みやすい列で書き、since より新しいものを返す', () => {
  const hub = loadHub();
  const film = { id: 'f1', title: '映画A', year: 1999, directors: ['甲', '乙'], status: 'seen', tmdbId: 5 };
  const view = { id: 'v1', filmId: 'f1', date: '2026-10-31', place: 'stream', venue: 'Netflix', score: 8, text: '雨の場面がよかった' };
  const r1 = hub.post({ token: hub.token, since: 0, films: [{ id: 'f1', mtime: 10, data: film }], views: [{ id: 'v1', mtime: 10, data: view }] });
  assert.equal(r1.ok, true);
  assert.equal(r1.films.length, 1);
  assert.equal(r1.views[0].data.text, '雨の場面がよかった');
  const rows = hub.sheets.get('views').rows;
  assert.deepEqual(rows[1].slice(4, 11), ['2026-10-31', 'f1', '映画A', 'stream', 'Netflix', '8', '雨の場面がよかった']);
  assert.equal(hub.sheets.get('films').rows[1][6], '甲、乙');
  // 古い書き込みは無視する
  hub.post({ token: hub.token, since: r1.rev, films: [{ id: 'f1', mtime: 5, data: { ...film, title: '古い' } }] });
  assert.equal(hub.sheets.get('films').rows[1][4], '映画A');
  assert.deepEqual(hub.moviesOn('2026-10-31').map(m => m.title), ['映画A']);
  assert.equal(hub.post({ token: 'x', since: 0 }).error, 'unauthorized');
});
