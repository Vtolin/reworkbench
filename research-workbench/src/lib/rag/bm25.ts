// Pure TypeScript implementation of Okapi BM25 scoring & ranking.
// Zero external dependencies — fast, deterministic, runs in browser and Vercel.
// Formula:
//   IDF(q_i) = ln( (N - n(q_i) + 0.5) / (n(q_i) + 0.5) + 1 )
//   Score(D, Q) = Σ IDF(q_i) * ( f(q_i, D) * (k1 + 1) ) / ( f(q_i, D) + k1 * (1 - b + b * (|D| / avgdl)) )
// Standard defaults: k1 = 1.2, b = 0.75.

export interface BM25Document {
  id: string;
  content: string;
  section?: string | null;
  page?: number | null;
}

export interface BM25ScoredItem {
  id: string;
  score: number;
  rank: number; // 1-based rank
}

const STOPWORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
  "any", "are", "as", "at", "be", "because", "been", "before", "being", "below",
  "between", "both", "but", "by", "could", "did", "do", "does", "doing", "down",
  "during", "each", "few", "for", "from", "further", "had", "has", "have",
  "having", "he", "her", "here", "hers", "herself", "him", "himself", "his",
  "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just", "me",
  "more", "most", "my", "myself", "no", "nor", "not", "of", "off", "on", "once",
  "only", "or", "other", "ought", "our", "ours", "ourselves", "out", "over",
  "own", "same", "she", "should", "so", "some", "such", "than", "that", "the",
  "their", "theirs", "them", "themselves", "then", "there", "these", "they",
  "this", "those", "through", "to", "too", "under", "until", "up", "very",
  "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom",
  "why", "with", "would", "you", "your", "yours", "yourself", "yourselves"
]);

const TOKEN_RE = /[a-zA-Z0-9_\u00C0-\u024F]+/g;

export function tokenize(text: string, filterStopwords = true): string[] {
  if (!text) return [];
  const matches = text.toLowerCase().match(TOKEN_RE) || [];
  if (!filterStopwords) return matches;
  return matches.filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

export interface BM25Options {
  k1?: number;
  b?: number;
  exactPhraseBonus?: number;
}

export class BM25Engine {
  private k1: number;
  private b: number;
  private exactPhraseBonus: number;

  constructor(opts: BM25Options = {}) {
    this.k1 = opts.k1 ?? 1.2;
    this.b = opts.b ?? 0.75;
    this.exactPhraseBonus = opts.exactPhraseBonus ?? 1.5;
  }

  /**
   * Scores and ranks a collection of documents against a query string.
   */
  public score(
    query: string,
    docs: BM25Document[]
  ): BM25ScoredItem[] {
    const N = docs.length;
    if (N === 0) return [];

    const queryTokens = tokenize(query, true);
    // If all tokens were stopwords (e.g. "what is that"), keep non-stopwords
    const effectiveQueryTokens = queryTokens.length > 0 ? queryTokens : tokenize(query, false);
    if (effectiveQueryTokens.length === 0) {
      return docs.map((d, i) => ({ id: d.id, score: 0, rank: i + 1 }));
    }

    // Tokenize all documents
    const docTokenLists = docs.map((d) => tokenize(d.content, false));
    const docLengths = docTokenLists.map((tokens) => tokens.length);
    const avgdl = docLengths.reduce((acc, len) => acc + len, 0) / (N || 1);

    // Compute document frequency n(q_i) for each query token
    const dfMap = new Map<string, number>();
    for (const qTerm of effectiveQueryTokens) {
      if (dfMap.has(qTerm)) continue;
      let count = 0;
      for (const dTokens of docTokenLists) {
        if (dTokens.includes(qTerm)) {
          count++;
        }
      }
      dfMap.set(qTerm, count);
    }

    // Compute IDF for each query token
    const idfMap = new Map<string, number>();
    for (const [qTerm, df] of dfMap.entries()) {
      // Standard Okapi BM25 IDF with +1 smoothing inside log
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1.0);
      idfMap.set(qTerm, Math.max(idf, 0.01)); // keep non-negative
    }

    // Normalized lower-case query for exact phrase detection
    const queryNormalized = query.toLowerCase().trim();
    const isMultiWord = queryNormalized.split(/\s+/).length >= 2;

    // Score each document
    const scores: Array<{ id: string; score: number }> = [];

    for (let i = 0; i < N; i++) {
      const dTokens = docTokenLists[i];
      const docLen = docLengths[i];
      const docContentLower = docs[i].content.toLowerCase();

      // Count term frequencies in this document
      const tfMap = new Map<string, number>();
      for (const t of dTokens) {
        tfMap.set(t, (tfMap.get(t) || 0) + 1);
      }

      let bm25Score = 0;
      const lenNorm = 1 - this.b + this.b * (docLen / (avgdl || 1));

      for (const qTerm of effectiveQueryTokens) {
        const tf = tfMap.get(qTerm) || 0;
        if (tf === 0) continue;
        const idf = idfMap.get(qTerm) || 0;
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * lenNorm;
        bm25Score += idf * (numerator / denominator);
      }

      // Bonus for exact contiguous phrase match
      if (isMultiWord && docContentLower.includes(queryNormalized)) {
        bm25Score *= this.exactPhraseBonus;
      }

      // Bonus if query terms appear in the section header
      if (docs[i].section) {
        const secLower = docs[i].section!.toLowerCase();
        let sectionMatch = 0;
        for (const qTerm of effectiveQueryTokens) {
          if (secLower.includes(qTerm)) sectionMatch++;
        }
        if (sectionMatch > 0) {
          bm25Score += (sectionMatch / effectiveQueryTokens.length) * 0.5;
        }
      }

      scores.push({ id: docs[i].id, score: bm25Score });
    }

    // Sort descending by score
    scores.sort((a, b) => b.score - a.score);

    // Assign 1-based ranks
    return scores.map((item, idx) => ({
      id: item.id,
      score: item.score,
      rank: idx + 1,
    }));
  }
}

/** Convenience function for one-off BM25 scoring */
export function bm25Rank(
  query: string,
  docs: BM25Document[],
  opts?: BM25Options
): BM25ScoredItem[] {
  const engine = new BM25Engine(opts);
  return engine.score(query, docs);
}
