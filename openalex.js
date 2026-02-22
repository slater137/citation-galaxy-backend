import { createAppError, fieldToConceptId, normalizeField, normalizePaper } from './utils.js';

const OPENALEX_BASE_URL = process.env.OPENALEX_BASE_URL || 'https://api.openalex.org';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);
const cache = new Map();

function readCache(field) {
  const cached = cache.get(field);
  if (!cached) {
    return null;
  }

  if (Date.now() >= cached.expiresAt) {
    cache.delete(field);
    return null;
  }

  return cached.data;
}

function writeCache(field, data) {
  cache.set(field, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}

function buildWorksUrl(conceptId) {
  const baseUrl = OPENALEX_BASE_URL.endsWith('/')
    ? OPENALEX_BASE_URL.slice(0, -1)
    : OPENALEX_BASE_URL;

  return `${baseUrl}/works?filter=concepts.id:${conceptId}&sort=cited_by_count:desc&per-page=200`;
}

export async function getTopPapersByField(field) {
  const normalizedField = normalizeField(field);
  const conceptId = fieldToConceptId(normalizedField);

  if (!conceptId) {
    throw createAppError(400, `Unsupported field: ${field}`);
  }

  const cachedResult = readCache(normalizedField);
  if (cachedResult) {
    console.log(`[CACHE] HIT field=${normalizedField}`);
    return cachedResult;
  }

  console.log(`[CACHE] MISS field=${normalizedField}`);

  const url = buildWorksUrl(conceptId);
  console.log(`[OPENALEX] Fetching ${url}`);

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'citation-galaxy-backend/1.0'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw createAppError(502, 'OpenAlex request failed', {
      status: response.status,
      body: errorText.slice(0, 500)
    });
  }

  const payload = await response.json();
  const works = Array.isArray(payload?.results) ? payload.results : [];
  const papers = works.map(normalizePaper);

  writeCache(normalizedField, papers);
  console.log(`[CACHE] STORED field=${normalizedField} ttl_ms=${CACHE_TTL_MS} items=${papers.length}`);

  return papers;
}
