# 映画メモ

観た映画を、点数よりも「いちばんの場面」と「観終わった直後の気持ち」で残し、時間がたってからの余韻と合わせて振り返る、個人用のWebアプリ(PWA)。まだ観ていない映画は、ジャンルではなく好きな映画の「作り手」と、自分の記録の「空白」から探す。

構成は読書メモ(github.com/tadamasa/reading-memo)と同じ。サーバーなし・運用費0円で、データはiPhoneの中(IndexedDB)にある。

## 考え方

- **山場と終わりを残す**: 体験をあとから思い出したときの評価は、いちばん強かった瞬間と終わりの印象でほぼ決まり、長さはあまり効かない(Fredrickson & Kahneman 1993, "Duration neglect in retrospective evaluations of affective episodes", *JPSP* 65(1), 45-55。実験の素材は映画の短い場面だった)。そこで記録の中心を「いちばんの場面」と「観終わった直後の気持ち」にした。
- **余韻をたずねる**: 観て1週間後と3か月後に一度ずつ、「まだ鮮明か」と今の評価を聞く。観た直後より評価が上がった映画を「あとから効いた映画」として振り返りに出す。何度でも付け直せる形にしないのは、思い出すたびに記憶が組み立て直されるため(Bartlett, *Remembering*, 1932)、決まった時点で測らないと比べられないから。
- **心が動いた種類**: ジャンルではなく「自分に何が起きたか」を選ぶ。選択肢は美的感情の尺度 AESTHEMOS(Schindler ほか 2017, *PLOS ONE* 12(6): e0178899)の下位尺度から、映画で起きやすいものを選んだ。しばらく起きていない感情は「探す」の手がかりになる。
- **昔観た映画は思い出して記録**: 過去の記録がなくても、覚えている場面と大まかな時期(2015、2015-08、「学生時代」)だけで残せる。何年たっても残っている場面は、その映画が自分に残したものそのもの。

## 画面

| タブ | できること |
|---|---|
| 記録 | 観た映画を記録、昔の映画を思い出して記録、観たいを足す。余韻をたずねるカード、最近の鑑賞 |
| 映画棚 | 観た/観たい。観た日・評価・公開年・あとから効いた順で並べ替え |
| 振り返り | 今年の本数、いつかの今ごろ観ていた映画、名場面の壁、あとから効いた/その場かぎりだった映画、心が動いた種類、年ごとのいちばん |
| 探す | 観たいリスト(日本の配信状況つき)、作り手の糸、空白地図、AIに選んでもらう |
| 設定 | TMDbのキー、Geminiのキー、バックアップ、映画ハブ(同期) |

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
| `js/core.js` | 画面に触れない計算(余韻の時期、評価の動き、感情、空白地図、作り手の糸、AIへの指示と返答の読み取り) |
| `js/tmdb.js` | TMDb API(検索、詳細とクレジット、日本の配信、人の作品、地域と年代での探索) |
| `js/db.js` | IndexedDBの薄いラッパー(ストア `films` `views` `meta`) |
| `js/sync.js`, `hub/` | 映画ハブ(自分のスプレッドシート+Apps Script)との同期 |
| `js/gemini.js` | Gemini API呼び出し |
| `js/backup.js` | JSONの書き出し・読み込み |
| `css/hig-*.css` | Apple HIGに沿ったデザイントークンと部品(読書メモと共通) |

### データ

- `films`: `{ id, tmdbId, title, originalTitle, year, directors, countries, genres, runtime, crew: { Director: [{id,name}], ... }, cast, providers, status: 'seen'|'want', want: { addedAt, reasons } }`
- `views`: `{ id, filmId, date, dateNote, recall, place, venue, with, score, peak, ending, emotions, factors, memo, afterglow: [{ checkpoint: 7|90, at, vivid, score, note }] }`

This product uses the TMDB API but is not endorsed or certified by TMDB. 配信状況のデータは JustWatch による。
