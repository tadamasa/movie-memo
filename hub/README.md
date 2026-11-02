# 映画ハブ(スプレッドシートとの同期)

映画メモアプリの映画と鑑賞記録を、自分のGoogleスプレッドシートに置いて、iPadなど他の端末や、日記アプリなど他のApps Scriptと共有するための受け口です。費用はかかりません。読書ハブとは別の、新しいスプレッドシートに作ってください(壊れても互いに巻き込まないため)。

- アプリのデータは今まで通り各端末の中にあり、開いたときと、書いてから数秒後に、変わった分だけをやり取りします。
- 同じ記録を二つの端末で直したときは、後から直したほうが残ります。削除も伝わります。

## 準備(最初の1回、パソコンで行うのが楽です)

> ただまさの映画ハブのスプレッドシートは作成済み(2026-10-31、Googleドライブの「映画ハブ」、`films` と `views` のシートと見出しも作ってある)。手順2から始めればよい。

1. Googleドライブで新しいスプレッドシートを作ります(名前の例: 映画ハブ)。
2. メニューの「拡張機能」→「Apps Script」を開きます。
3. 最初からある `コード.gs` の中身を全部消して、[Code.gs](https://raw.githubusercontent.com/tadamasa/movie-memo/main/hub/Code.gs) の中身を貼り、保存します。
4. 上の関数の選択欄で `setup` を選び、「実行」を押します。
   - 権限の確認が出たら、自分のアカウントを選び、「詳細」→「(安全ではないページ)に移動」→「許可」と進みます。自分で作ったスクリプトなので問題ありません。
   - 下の実行ログに「合言葉: …」が出ます。これを控えます。
5. 右上の「デプロイ」→「新しいデプロイ」を開き、種類の歯車から「ウェブアプリ」を選びます。
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
   - 「デプロイ」を押し、出てきた「ウェブアプリのURL」(`…/exec` で終わるもの)をコピーします。
6. 映画メモアプリの「設定」→「映画ハブ(同期)」に、URLと合言葉を入れて「接続して同期する」を押します。最初の1回は全部の記録を送るので少し時間がかかります。
7. iPadでは、同じアプリ(https://tadamasa.github.io/movie-memo/)をホーム画面に追加し、同じURLと合言葉で接続します。映画棚がそのまま届きます。

URLと合言葉を知っている人は読み書きできるので、他の人には教えないでください。

## スクリプトを新しくするとき

Code.gs を貼り替えて保存したら、「デプロイ」→「デプロイを管理」→ 鉛筆の印 → バージョン「新バージョン」→「デプロイ」。URLは変わりません。

## 他のApps Script(日記アプリなど)から読む

スプレッドシートには `films` と `views` の二つのシートがあり、普通の表として読めます。

| シート | 主な列 |
|---|---|
| films | id, title(題名), year(公開年), directors(監督), status(観た/観たい), lastSeen(最後に観た日 yyyy-mm-dd。覚えていない映画は 2015 などの時期), seenCount(観た回数), category(カテゴリ), tmdbId |
| views | id, date(観た日。昔観た映画では 2015 や 2015-08 のこともある), filmId, filmTitle, place(stream/theater/tv/disc/other), venue(配信サービスや劇場), score(10点満点), text(感想) |

- `deleted` が `true` の行は削除済みです。読むときは飛ばしてください。
- 最後の `json` 列がアプリの元データです。表を手で書き換えても、アプリには反映されません。

例: ある日に観た映画を日記アプリで取り出す

```js
function moviesOn(date) { // date: '2026-10-31'
  const sh = SpreadsheetApp.openById('映画ハブのスプレッドシートID').getSheetByName('views');
  const rows = sh.getDataRange().getValues();
  const head = rows.shift();
  const col = name => head.indexOf(name);
  return rows
    .filter(r => r[col('date')] === date && String(r[col('deleted')]) !== 'true')
    .map(r => ({ title: r[col('filmTitle')], venue: r[col('venue')], text: r[col('text')] }));
}
```

スプレッドシートIDは、スプレッドシートのURLの `/d/` と `/edit` の間の文字列です。

## ほかのアプリが読む約束(列を変える前に必ず読む)

2026-11-02 から、映画ハブはほかのアプリにも読まれています。下の列と値は「読む約束」です。**列の並び・列名・`place` の値・json の下の項目を変えるときは、読んでいる相手側も直す必要があります。** 映画メモ側だけで変えると、相手は黙って壊れます(エラーにならず、値が空になるだけ)。

### 読んでいる相手

| 相手 | 読むシート | 読む列 | 使いみち |
|---|---|---|---|
| 縁泉GAS(毎晩) | views | `date`、`deleted`、`filmId`、`place`、`venue`、json の `recall` | 観た映画を縁泉の「作品」として追記する。`date` が `YYYY-MM-DD` の完全な日付の行だけを使い、年だけ・月だけの「思い出し」記録(`recall`)は入れない |
| 縁泉GAS(毎晩) | films | `title`、`tmdbId` | 作品名と同一性の判定 |
| 「その日」の共通ライブラリ(日記ホーム側) | views | `date, filmId, filmTitle, place, venue, score, text` | 日記ハブ・縁泉ハブと同じく、ある日に観た映画を出す |
| 「その日」の共通ライブラリ(日記ホーム側) | films | `title, year, directors`、json の `posterPath`・`genres` | 題名・監督・ポスター・ジャンルの表示 |

### 約束の中身(2026-11-02 に実シートの見出し行で確認)

| シート | 列(左から) | json の位置 |
|---|---|---|
| views | `id, rev, mtime, deleted, date, filmId, filmTitle, place, venue, score, text, json` | 12列目 |
| films | `id, rev, mtime, deleted, title, year, directors, status, lastSeen, seenCount, category, tmdbId, json` | 13列目 |

- `place` の値は `stream` / `theater` / `tv` / `disc` / `other` の5つ。名前を変える・増やすのも約束の変更にあたります。
- json の中で約束に入っているのは、views の `recall`(真偽値)と、films の `posterPath`・`genres`。`cell_()` が5万字を超える行を削るときも、この3つは残すこと(いまは `cast` と `overview` だけを削っている)。
- `deleted` が `true` の行は json が空です。相手は `deleted` を先に見て飛ばしてください。
- 相手は**列の位置ではなく見出し名で読む**のが原則です(上の `moviesOn` の例のように `head.indexOf(name)`)。それでも、列名を変えると壊れます。

### 列を足して相手が壊れた実例(2026-11-02 時点で未解決)

films に `lastSeen, seenCount, category` を足した(2026-10-31)ことで、json は 10列目 → 13列目に移りました。日記ハブ・縁泉ハブは古い10列の並びを前提に「10列目を json」として読んでいるため、いま「その日」の映画に**ポスターとジャンルが出ません**。共通ライブラリを見出し名で読む形にして直す予定です(日記ホーム側の作業)。

この件から: 列を足すときも約束の変更です。末尾の `json` の手前に足すと位置で読む相手を壊すので、足す前に上の相手に知らせ、相手が見出し名で読んでいることを確かめてから入れてください。

### 当面そのままのこと

- 映画館で観た日を、縁泉にも手で書いている場合の二重入力は、当面そのまま(保留)。縁泉GASの取り込みと重なることがあります。
