// 日記の鑑賞記録CSVの取り込み
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDiaryCsv, normalizeMedia, parseTitle, planImport, rankCandidates, mergeImport } from '../js/diaryimport.js';
import { findFilm } from '../js/core.js';

const csv = rows => '﻿日付,映画名,視聴媒体,備考\n' + rows.map(r => r.join(',')).join('\n');

test('CSV: BOM付き、引用符の中のカンマ、日付のない行は捨てる', () => {
  const rows = readDiaryCsv(csv([['2025-01-02', '"ダイ・ハード, 再び"', 'Netflix', ''], ['不明', 'X', '', ''], ['2025-01-03', 'Y', '', 'メモ']]));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'ダイ・ハード, 再び');
  assert.equal(rows[1].note, 'メモ');
  assert.throws(() => readDiaryCsv('a,b\n1,2'));
});

test('視聴媒体: 表記ゆれをサービス名にそろえる', () => {
  assert.deepEqual(normalizeMedia('Amazonプライム'), { place: 'stream', venue: 'Amazon Prime Video', rental: false });
  assert.equal(normalizeMedia('Prime Video(レンタル)').rental, true);
  assert.equal(normalizeMedia('u-next').venue, 'U-NEXT');
  assert.equal(normalizeMedia('映画館').place, 'theater');
  assert.equal(normalizeMedia('記載なし').place, '');
});

test('題名: 括弧の中を印・手がかり・別名に分け、1行2本も分ける', () => {
  const t = parseTitle('ワークスマン(続き)');
  assert.deepEqual(t.titles, ['ワークスマン']);
  assert.equal(t.flags.cont, true);
  assert.equal(parseTitle('オッペンハイマー(途中まで)').flags.partial, true);
  assert.deepEqual(parseTitle('攻殻機動隊(新作)').hints, ['新作']);
  assert.deepEqual(parseTitle('ロスト・ブレッド3 / イコライザー3').titles, ['ロスト・ブレッド3', 'イコライザー3']);
  assert.deepEqual(parseTitle('ザ・ウォッチャーズ(The Watchers)').aliases, ['The Watchers']);
});

test('計画: 途中までは除き、続きの前の日も除く。離れた日の同じ題名は観直し', () => {
  const rows = readDiaryCsv(csv([
    ['2025-04-17', 'ワークスマン', 'Netflix', ''],
    ['2025-04-18', 'ワークスマン(続き)', 'Netflix', ''],
    ['2025-05-01', 'オッペンハイマー(途中まで)', 'U-NEXT', ''],
    ['2022-01-16', 'Mr.ノーバディ', 'U-NEXT', ''],
    ['2023-07-29', 'Mr.ノーバディ', '', ''],
  ]));
  const plan = planImport(rows);
  assert.equal(plan.viewCount, 3);
  assert.deepEqual(plan.skipped.map(s => s.reason).sort(), ['続きの前の日', '途中まで']);
  const w = plan.films.find(f => f.title === 'ワークスマン');
  assert.deepEqual(w.views.map(v => v.date), ['2025-04-18']);
  assert.equal(plan.films.find(f => f.title === 'Mr.ノーバディ').views.length, 2);
  assert.ok(!plan.films.some(f => f.title === 'オッペンハイマー'));
});

test('候補: 題名が一致し鑑賞日より前の公開を上に。同名が複数なら確かめる', () => {
  const f = { title: 'ゴーストバスターズ', aliases: [], hints: [], views: [{ date: '2023-05-01' }] };
  const res = [{ tmdbId: 1, title: 'ゴーストバスターズ/アフターライフ', year: 2021 }, { tmdbId: 2, title: 'ゴーストバスターズ', year: 2024 }, { tmdbId: 3, title: 'ゴーストバスターズ', year: 1984 }, { tmdbId: 4, title: 'ゴーストバスターズ', year: 2016 }];
  const r = rankCandidates(res, f);
  assert.equal(r.list[0].tmdbId, 3);
  assert.equal(r.sure, false);
  const one = rankCandidates([{ tmdbId: 9, title: 'ビーキーパー', year: 2024 }], { title: 'ビーキーパー', views: [{ date: '2025-03-22' }] });
  assert.equal(one.sure, true);
  assert.equal(rankCandidates([{ tmdbId: 9, title: '攻殻機動隊', year: 1995 }], { title: '攻殻機動隊', hints: ['新作'], views: [{ date: '2025-03-22' }] }).sure, false);
});

test('重ねる: 既存の映画に足し、同じ日は足さず、粗い日付は詳しくする。2回目は増えない', () => {
  let n = 0;
  const uid = () => `id${++n}`;
  const films = [{ id: 'dune', tmdbId: 438631, title: 'DUNE/デューン 砂の惑星', status: 'seen' }, { id: 'bee', tmdbId: 866398, title: 'ビーキーパー', status: 'seen' }];
  const views = [{ id: 'v1', filmId: 'dune', date: '2026', recall: true }, { id: 'v2', filmId: 'bee', date: '2026-10-31' }];
  const plan = planImport(readDiaryCsv(csv([['2026-09-26', 'DUNE1', 'Netflix', ''], ['2025-03-22', 'ビーキーパー', 'Amazon Prime', ''], ['2025-02-01', '新しい映画', '', 'よかった']])));
  const choice = t => ({ DUNE1: { tmdb: { tmdbId: 438631, title: 'DUNE/デューン 砂の惑星', year: 2021 } }, ビーキーパー: { tmdb: { tmdbId: 866398, title: 'ビーキーパー', year: 2024 } } }[t] || { plain: true });
  const items = plan.films.map(p => ({ plan: p, choice: choice(p.title) }));
  const out = mergeImport(items, films, views, { uid, findFilm });
  assert.equal(out.count.filmsNew, 1);
  assert.equal(out.count.upgraded, 1);
  assert.equal(views[0].date, '2026-09-26');
  assert.equal(views[0].venue, 'Netflix');
  assert.equal(out.count.views, 2); // ビーキーパーの2025年分と、新しい映画
  assert.equal(films[1].seenCount, 2);
  assert.equal(films[1].lastSeen, '2026-10-31');
  const nv = out.views.find(v => v.text === 'よかった');
  assert.ok(nv && nv.source === 'diary');
  // 2回目
  const allFilms = [...films, ...out.films.filter(f => !films.includes(f))];
  const allViews = [...views, ...out.views.filter(v => !views.includes(v))];
  const again = mergeImport(items, allFilms, allViews, { uid, findFilm });
  assert.equal(again.count.views + again.count.upgraded + again.count.filmsNew, 0);
  assert.equal(again.count.same, 3);
});

test('重ねる: 取り込まないを選んだ映画は入れない', () => {
  const plan = planImport(readDiaryCsv(csv([['2025-02-01', 'A', '', '']])));
  const out = mergeImport(plan.films.map(p => ({ plan: p, choice: { skip: true } })), [], [], { uid: () => 'x', findFilm });
  assert.equal(out.films.length + out.views.length, 0);
});
