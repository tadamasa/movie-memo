// Gemini API を端末から直接呼ぶ。APIキーは端末内(IndexedDB)にだけ保存する。
// 無料枠では入力がGoogleの製品改善に使われうるため、呼ぶのはユーザーがボタンを押したときだけ。

export const DEFAULT_MODEL = 'gemini-3.8-flash';

// 構造化した答え(JSON文字列)を返してもらう。映画の提案などに使う。
export async function generateJson({ apiKey, model = DEFAULT_MODEL, prompt }) {
  if (!apiKey) throw new Error('設定でGemini APIキーを入れてください');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`Geminiの呼び出しに失敗しました: ${data.error ? data.error.message : res.statusText}`);
    e.status = res.status;
    throw e;
  }
  const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || '').join('').trim();
}

// Google検索で裏づけを取りながら書いてもらう(グラウンディング)。参照したページも返す。
// 検索ツールが使えないモデル・キーのときは、検索なしでもう一度呼ぶ。
export async function generateGrounded({ apiKey, model = DEFAULT_MODEL, prompt }) {
  if (!apiKey) throw new Error('設定でGemini APIキーを入れてください');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const call = async search => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], ...(search ? { tools: [{ google_search: {} }] } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(`Geminiの呼び出しに失敗しました: ${data.error ? data.error.message : res.statusText}`);
      e.status = res.status;
      throw e;
    }
    const cand = (data.candidates || [])[0] || {};
    const text = ((cand.content || {}).parts || []).map(p => p.text || '').join('').trim();
    const chunks = ((cand.groundingMetadata || {}).groundingChunks || []).map(c => c.web).filter(Boolean);
    const seen = new Set();
    const sources = chunks.filter(w => w.uri && !seen.has(w.title || w.uri) && seen.add(w.title || w.uri)).map(w => ({ title: w.title || w.uri, url: w.uri }));
    return { text, sources, searched: search };
  };
  try { return await call(true); } catch (e) {
    if (e.status !== 400) throw e;
    return call(false);
  }
}
