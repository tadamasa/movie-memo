/**
 * 映画ハブ: 映画メモアプリ(https://tadamasa.github.io/movie-memo/)の映画と鑑賞記録を、このスプレッドシートに同期する受け口。
 * 仕組みは読書メモの読書ハブと同じ。読書ハブとは別のスプレッドシートに置く。
 *
 * 使い方は hub/README.md を参照。
 *  1. 新しいスプレッドシート → 拡張機能 → Apps Script に、このファイルを貼る
 *  2. setup を一度実行(合言葉が実行ログに出る)
 *  3. デプロイ → 新しいデプロイ → ウェブアプリ(実行ユーザー: 自分、アクセス: 全員)
 *  4. 出たURLと合言葉を、映画メモアプリの設定に入れる
 *
 * シート「films」「views」は、ほかのApps Script(日記アプリなど)からそのまま読める表になっている。
 * 最後の列 json がアプリの元データ。人が表を書き換えても、アプリには反映されない(json が正)。
 */

const FILM_COLS = ['id', 'rev', 'mtime', 'deleted', 'title', 'year', 'directors', 'status', 'tmdbId', 'json'];
const VIEW_COLS = ['id', 'rev', 'mtime', 'deleted', 'date', 'filmId', 'filmTitle', 'place', 'venue', 'score', 'text', 'json'];
const STATUS = { want: '観たい', seen: '観た' };
const NAMES = ['films', 'views'];
const COLS = { films: FILM_COLS, views: VIEW_COLS };
const PAGE = 400; // 1回の応答で返す最大件数

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, ''));
  sheet_('films', FILM_COLS);
  sheet_('views', VIEW_COLS);
  Logger.log('合言葉: ' + props.getProperty('TOKEN'));
}

function doGet() {
  return json_({ ok: true, app: 'movie-hub' });
}

// 受け取る: { token, since, films: [{id, mtime, deleted, data}], views: [...] }
// 返す:     { ok, rev, more, films: [{id, mtime, deleted, data}], views: [...] }  (rev が since より新しいもの)
function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token || req.token !== token) return json_({ ok: false, error: 'unauthorized' });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties();
    let rev = Number(props.getProperty('REV') || 0);
    const since = Number(req.since || 0);
    const titles = {};
    const fresh = []; // since より新しい行(両シート分)
    for (const name of NAMES) {
      const cols = COLS[name];
      const sh = sheet_(name, cols);
      const values = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, cols.length).getValues() : [];
      const index = {};
      values.forEach((r, i) => { index[r[0]] = i; });
      if (name === 'films') values.forEach(r => { if (r[0]) titles[r[0]] = r[4]; });
      let changed = false;
      for (const item of req[name] || []) {
        if (!item || !item.id) continue;
        const i = index[item.id];
        if (i !== undefined && Number(values[i][2]) > Number(item.mtime || 0)) continue; // 表のほうが新しい
        rev += 1;
        if (name === 'films' && item.data) titles[item.id] = item.data.title || '';
        const row = name === 'films' ? filmRow_(item, rev) : viewRow_(item, rev, titles);
        if (i === undefined) { index[item.id] = values.length; values.push(row); } else values[i] = row;
        changed = true;
      }
      if (changed) {
        const need = values.length + 1 - sh.getMaxRows();
        if (need > 0) { sh.insertRowsAfter(sh.getMaxRows(), need); sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@'); }
        sh.getRange(2, 1, values.length, cols.length).setValues(values);
      }
      for (const r of values) if (Number(r[1]) > since) fresh.push({ name, rev: Number(r[1]), r, last: cols.length - 1 });
    }
    props.setProperty('REV', String(rev));
    // 古い順に PAGE 件まで返す。残りがあれば more を立て、返した最後の rev を次の起点にする
    fresh.sort((x, y) => x.rev - y.rev);
    const page = fresh.slice(0, PAGE);
    const out = { ok: true, films: [], views: [], more: fresh.length > PAGE, rev: fresh.length > PAGE ? page[page.length - 1].rev : rev };
    for (const f of page) {
      const deleted = String(f.r[3]) === 'true';
      out[f.name].push({ id: String(f.r[0]), mtime: Number(f.r[2]), deleted, data: deleted ? null : parse_(f.r[f.last]) });
    }
    return json_(out);
  } finally {
    lock.releaseLock();
  }
}

function filmRow_(item, rev) {
  const f = item.data || {};
  return [item.id, String(rev), String(Number(item.mtime || 0)), String(!!item.deleted), f.title || '', f.year ? String(f.year) : '', (f.directors || []).join('、'),
    STATUS[f.status] || f.status || '', f.tmdbId ? String(f.tmdbId) : '', item.deleted ? '' : cell_(f)];
}

function viewRow_(item, rev, titles) {
  const v = item.data || {};
  const score = typeof v.score === 'number' ? String(v.score) : '';
  return [item.id, String(rev), String(Number(item.mtime || 0)), String(!!item.deleted), v.date || '', v.filmId || '', titles[v.filmId] || '',
    v.place || '', v.venue || '', score, v.text || '', item.deleted ? '' : cell_(v)];
}

// 1セルは5万字まで。超えるときは長い項目を削って入れる
function cell_(obj) {
  let s = JSON.stringify(obj);
  if (s.length < 49000) return s;
  const slim = Object.assign({}, obj, { cast: undefined, overview: (obj.overview || '').slice(0, 2000) });
  return JSON.stringify(slim);
}

function sheet_(name, cols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    // 日付などが勝手に変換されないよう、すべて書式なしテキストにする
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function parse_(s) { try { return JSON.parse(s); } catch (e) { return null; } }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * ほかのApps Script(日記アプリなど)から使う例: ある日に観た映画を返す。
 * 日記アプリ側では SpreadsheetApp.openById('映画ハブのID') で開いて、同じように views シートを読めばよい。
 */
function moviesOn(date) {
  const sh = sheet_('views', VIEW_COLS);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, VIEW_COLS.length).getValues()
    .filter(r => r[4] === date && String(r[3]) !== 'true')
    .map(r => ({ title: r[6], place: r[7], venue: r[8], score: r[9], text: r[10] }));
}
