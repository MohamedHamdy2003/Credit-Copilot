export const hybridRanking = { branchLimit: 20, k1: 1.2, b: 0.75, rrfK: 60 } as const;

export const eligibleChunks = `
  FROM knowledge.chunks c JOIN knowledge.embeddings e ON e.chunk_id = c.id
  WHERE c.active AND c.product = $2
    AND c.effective_from <= $3::date AND (c.effective_to IS NULL OR $3::date < c.effective_to)
    AND e.model = $4 AND e.dimensions = $5`;

// Use the GIN-indexed tsvector for matches and its positions for term frequencies
// and document lengths. Corpus statistics cover every eligible chunk.
export const hybridSearch = `
  WITH eligible AS NOT MATERIALIZED (
    SELECT c.id, c.metadata, c.search_vector, e.embedding
    ${eligibleChunks}
  ),
  vector_top AS (
    SELECT id, row_number() OVER (ORDER BY embedding <=> $1::vector, id) AS rank
    FROM eligible
    ORDER BY embedding <=> $1::vector, id
    LIMIT $7
  ),
  query_terms AS (
    SELECT unnest(tsvector_to_array(to_tsvector('english', $8))) AS lexeme
  ),
  lexical_query AS (
    SELECT string_agg(array_to_tsvector(ARRAY[lexeme])::text, ' | ')::tsquery AS terms
    FROM query_terms
  ),
  document_lengths AS (
    SELECT id, length.tokens
    FROM eligible
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(cardinality(term.positions)), 0) AS tokens
      FROM unnest(search_vector) AS term
    ) AS length
  ),
  corpus_stats AS (
    SELECT count(*) AS document_count, avg(tokens)::double precision AS average_length
    FROM document_lengths
  ),
  term_matches AS (
    SELECT id, term.lexeme, cardinality(term.positions) AS frequency
    FROM eligible
    CROSS JOIN lexical_query
    CROSS JOIN LATERAL unnest(search_vector) AS term
    JOIN query_terms USING (lexeme)
    WHERE search_vector @@ lexical_query.terms
  ),
  term_stats AS (
    SELECT lexeme, count(*) AS document_frequency
    FROM term_matches
    GROUP BY lexeme
  ),
  bm25_scores AS (
    SELECT match.id, sum(
      ln(1 + ((stats.document_count - term.document_frequency + 0.5)
        / (term.document_frequency + 0.5))::double precision)
      * match.frequency * (${hybridRanking.k1} + 1)
      / (match.frequency + ${hybridRanking.k1} * (1 - ${hybridRanking.b} +
        ${hybridRanking.b} * length.tokens / nullif(stats.average_length, 0)))
      ORDER BY match.lexeme
    ) AS score
    FROM term_matches AS match
    JOIN term_stats AS term USING (lexeme)
    JOIN document_lengths AS length USING (id)
    CROSS JOIN corpus_stats AS stats
    GROUP BY match.id
  ),
  bm25_top AS (
    SELECT id, score, row_number() OVER (ORDER BY score DESC, id) AS rank
    FROM bm25_scores
    ORDER BY score DESC, id
    LIMIT $7
  ),
  fused AS (
    SELECT id, vector_top.rank AS vector_rank, bm25_top.rank AS bm25_rank,
      bm25_top.score AS bm25_score,
      COALESCE(1.0::double precision / (${hybridRanking.rrfK} + vector_top.rank), 0)
      + COALESCE(1.0::double precision / (${hybridRanking.rrfK} + bm25_top.rank), 0) AS rrf_score
    FROM vector_top FULL JOIN bm25_top USING (id)
  )
  SELECT eligible.metadata AS chunk, 1 - (eligible.embedding <=> $1::vector) AS similarity,
    jsonb_build_object(
      'vectorRank', fused.vector_rank,
      'bm25Rank', fused.bm25_rank,
      'bm25Score', fused.bm25_score,
      'rrfScore', fused.rrf_score
    ) AS ranking
  FROM fused JOIN eligible USING (id)
  ORDER BY fused.rrf_score DESC, fused.id
  LIMIT $6`;
