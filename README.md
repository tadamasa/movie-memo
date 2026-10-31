# 映画メモ

観たか・観ていないかを、ポスター付きで管理する個人用のWebアプリ(PWA)。観た映画には日付・どこで(配信サービス)・評価・感想を残し、観たい映画には契約中の配信で今観られるかの印を付ける。ほかの人の感想(X・ブログ・Filmarksなど)へもすぐ飛べる。

構成は読書メモ(github.com/tadamasa/reading-memo)と同じ。サーバーなし・運用費0円で、データはiPhoneの中(IndexedDB)にある。

## 画面

| タブ | できること |
|---|---|
| 記録 | 観た映画を記録、観たいを足す、昔観た映画(時期は 2015 や「学生時代」でよい)。契約中の配信で今観られる観たい映画、最近観た映画、観たい映画をポスターで横に並べる |
| 映画棚 | 観た/観たいをポスターの格子か一覧で。観た日・評価・公開年で並べ替え、カテゴリと「契約中のみ」で絞れる |
| 振り返り | 今年観た映画のポスター、いつかの今ごろ観ていた映画、どこで(どのサービスで)観たか、カテゴリ別の本数、年ごとのいちばん |
| 探す | 観たい(配信状況をまとめて確認)、作り手の糸、空白地図、AIに選んでもらう |
| 設定 | TMDbのキー、カテゴリの一覧(1行に1つ、未分類にジャンルからまとめて付ける)、契約中の配信サービス(既定: Netflix・Amazon Prime Video・U-NEXT)、Geminiのキー、バックアップ、映画ハブ(同期) |

映画の詳細には、背景画像とポスター、カテゴリ(1本に1つ。TMDbのジャンルから自動で付け、選び直せる)、自分の感想、日本の配信状況(JustWatch)、ほかの人の感想へのリンク(Xの話題順・新しい順、Filmarks、映画.com、はてなブログ、note、ブログ検索、YouTubeの予告編と解説、Letterboxd)、あらすじ、作り手を出す。

### 探し方

- **作り手の糸**: 7点以上の映画の監督・脚本・撮影・音楽・編集が関わったほかの映画を集める。別々の好きな映画から二人以上でつながる映画(「二本の糸」)を上に出す。
- **空白地図**: 観た映画を製作国の地域×公開年代で数えた表。空いているマスを押すと、そこでよく観られている映画を出す。
- **AIに選んでもらう**: 「あとから効いた映画と同じ効き方」「しばらく味わっていない感情」「好きな映画の問いを別の国・時代で」「苦手の手前にある一本」の4観点で2本ずつ。Geminiに送るのは題名・年・監督・評価・感情の種類だけで、場面やメモの文章は送らない。

## 使い方(iPhone)

1. GitHub の Settings → Pages で「main / (root)」を選んで公開する(最初の1回だけ)。
2. https://tadamasa.github.io/movie-memo/ をSafariで開き、共有ボタンから「ホーム画面に追加」する。
3. 設定 → 作品情報(TMDb)に、themoviedb.org で無料で取ったAPIキーを入れる。なくても手入力で記録できる。
4. 設定 → バックアップ で、ときどき書き出す。

## 開発

ビルド不要。ES Modulesのまま配信する。構成の考え方と落とし穴は [docs/home-app-architecture.md](docs/home-app-architecture.md)(読書メモから写したもの)。

```sh
npm run serve   # http://localhost:8765
npm test        # Node 20以降
```

| ファイル | 役割 |
|---|---|
| `js/app.js` | 画面とルーティング |
| `js/core.js` | 画面に触れない計算(配信サービスの突き合わせ、ほかの人の感想へのリンク、振り返り、空白地図、作り手の糸、AIへの指示と返答の読み取り) |
| `js/tmdb.js` | TMDb API(検索、詳細とクレジット、日本の配信、人の作品、地域と年代での探索) |
| `js/db.js` | IndexedDBの薄いラッパー(ストア `films` `views` `meta`) |
| `js/sync.js`, `hub/` | 映画ハブ(自分のスプレッドシート+Apps Script)との同期 |
| `js/gemini.js` | Gemini API呼び出し |
| `js/backup.js` | JSONの書き出し・読み込み |
| `css/hig-*.css` | Apple HIGに沿ったデザイントークンと部品(読書メモと共通) |

### データ

- `films`: `{ id, tmdbId, title, originalTitle, year, directors, countries, genres, runtime, posterPath, backdropPath, crew: { Director: [{id,name}], ... }, cast, providers: { flatrate, rent, buy, link, checkedAt }, status: 'seen'|'want', category, categoryAuto, lastSeen, seenCount, want: { addedAt, reasons } }`
- `views`: `{ id, filmId, date, dateNote, recall, place, venue, with, score, text }`

This product uses the TMDB API but is not endorsed or certified by TMDB. 配信状況のデータは JustWatch による。
