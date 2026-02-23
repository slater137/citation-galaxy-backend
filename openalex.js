import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createAppError,
  getFieldConfig,
  getSupportedFieldKeys,
  normalizeFieldKey,
  normalizeOpenAlexWorkId,
  normalizePaper,
  normalizeText
} from './utils.js';

const OPENALEX_BASE_URL = process.env.OPENALEX_BASE_URL || 'https://api.openalex.org';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);
const INITIAL_PAGE_SIZE = 60;
const INITIAL_MAX_PAGES = Number(process.env.INITIAL_MAX_PAGES || 8);
const MIN_INITIAL_WORKS = 200;
const MAX_INITIAL_WORKS = 200;
const DEFAULT_DRILLDOWN_LIMIT = 100;
const MAX_DRILLDOWN_LIMIT = 100;
const REFERENCE_HYDRATION_CANDIDATE_CAP = 200;
const ID_FILTER_CHUNK_SIZE = 50;
const CONCEPT_SCORE_THRESHOLD = Number(process.env.CONCEPT_SCORE_THRESHOLD || 0.15);
const WORK_SELECT_FIELDS = [
  'id',
  'display_name',
  'authorships',
  'publication_year',
  'cited_by_count',
  'doi',
  'primary_location',
  'primary_topic',
  'topics',
  'concepts',
  'referenced_works'
].join(',');
const RESOLUTION_CACHE_FILE = path.join(process.cwd(), '.openalex-resolution-cache.json');

const galaxyCache = new Map();
const fieldIdCache = new Map();
const conceptIdCache = new Map();
const topicIdCache = new Map();
let resolutionCacheLoaded = false;
let resolutionCachePromise = null;

function getBaseUrl() {
  return OPENALEX_BASE_URL.endsWith('/')
    ? OPENALEX_BASE_URL.slice(0, -1)
    : OPENALEX_BASE_URL;
}

function readTimedCache(store, key) {
  const entry = store.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }

  return entry.data;
}

function writeTimedCache(store, key, value) {
  store.set(key, {
    data: value,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}

function dedupeWorksById(works) {
  const map = new Map();
  for (const work of works) {
    const id = normalizeOpenAlexWorkId(work?.id);
    if (!id || map.has(id)) {
      continue;
    }
    map.set(id, work);
  }
  return [...map.values()];
}

function sortByCitationsDesc(works) {
  return [...works].sort((a, b) => {
    const aCites = Number.isFinite(a?.cited_by_count) ? a.cited_by_count : 0;
    const bCites = Number.isFinite(b?.cited_by_count) ? b.cited_by_count : 0;
    return bCites - aCites;
  });
}

function clampLimit(value, fallback = DEFAULT_DRILLDOWN_LIMIT) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.min(parsed, MAX_DRILLDOWN_LIMIT));
}

function normalizeEntityId(value, prefix) {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.match(new RegExp(`${prefix}\\d+`, 'i'));
  return match ? match[0].toUpperCase() : null;
}

function normalizeFieldFilterId(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const urlMatch = trimmed.match(/fields\/(\d+)/i);
  if (urlMatch) {
    return urlMatch[1];
  }

  const legacyMatch = trimmed.match(/F(\d+)/i);
  if (legacyMatch) {
    return legacyMatch[1];
  }

  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function normalizeTopicId(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.match(/T\d+/i);
  return match ? match[0].toUpperCase() : null;
}

function chunkArray(items, chunkSize) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

async function ensureResolutionCacheLoaded() {
  if (resolutionCacheLoaded) {
    return;
  }

  if (resolutionCachePromise) {
    await resolutionCachePromise;
    return;
  }

  resolutionCachePromise = (async () => {
    try {
      const raw = await fs.readFile(RESOLUTION_CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw);

      if (parsed?.fields && typeof parsed.fields === 'object') {
        Object.entries(parsed.fields).forEach(([key, id]) => {
          const normalizedId = normalizeFieldFilterId(String(id));
          if (normalizedId) {
            fieldIdCache.set(key, normalizedId);
          }
        });
      }

      if (parsed?.concepts && typeof parsed.concepts === 'object') {
        Object.entries(parsed.concepts).forEach(([key, id]) => {
          const normalizedId = normalizeEntityId(String(id), 'C');
          if (normalizedId) {
            conceptIdCache.set(key, normalizedId);
          }
        });
      }

      if (parsed?.topics && typeof parsed.topics === 'object') {
        Object.entries(parsed.topics).forEach(([key, id]) => {
          const normalizedId = normalizeTopicId(String(id));
          if (normalizedId) {
            topicIdCache.set(key, normalizedId);
          }
        });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('[CACHE] Failed to read OpenAlex resolution cache:', error.message);
      }
    } finally {
      resolutionCacheLoaded = true;
      resolutionCachePromise = null;
    }
  })();

  await resolutionCachePromise;
}

async function persistResolutionCache() {
  const payload = {
    updatedAt: new Date().toISOString(),
    fields: Object.fromEntries(fieldIdCache.entries()),
    concepts: Object.fromEntries(conceptIdCache.entries()),
    topics: Object.fromEntries(topicIdCache.entries())
  };

  try {
    await fs.writeFile(RESOLUTION_CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    console.warn('[CACHE] Failed to persist OpenAlex resolution cache:', error.message);
  }
}

async function fetchOpenAlexJson(url, errorMessage) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'citation-galaxy-backend/1.0'
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw createAppError(502, errorMessage, {
      status: response.status,
      url,
      body: body.slice(0, 500)
    });
  }

  return response.json();
}

function bestFieldCandidate(searchName, candidates) {
  const target = normalizeText(searchName);

  return [...candidates]
    .map((candidate) => {
      const display = normalizeText(candidate?.display_name || '');
      const worksCount = Number.isFinite(candidate?.works_count) ? candidate.works_count : 0;
      const relevance = Number.isFinite(candidate?.relevance_score) ? candidate.relevance_score : 0;
      const exact = display === target ? 2 : 0;
      const includes = display.includes(target) || target.includes(display) ? 1 : 0;
      const levelScore = Math.log10(worksCount + 1);
      return {
        candidate,
        score: (exact * 10) + (includes * 4) + (relevance * 2) + levelScore
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const bWorks = Number.isFinite(b.candidate?.works_count) ? b.candidate.works_count : 0;
      const aWorks = Number.isFinite(a.candidate?.works_count) ? a.candidate.works_count : 0;
      return bWorks - aWorks;
    })[0]?.candidate || null;
}

function bestConceptCandidate(searchTerm, candidates) {
  const target = normalizeText(searchTerm);

  return [...candidates]
    .map((candidate) => {
      const display = normalizeText(candidate?.display_name || '');
      const worksCount = Number.isFinite(candidate?.works_count) ? candidate.works_count : 0;
      const relevance = Number.isFinite(candidate?.relevance_score) ? candidate.relevance_score : 0;
      const level = Number.isFinite(candidate?.level) ? candidate.level : 99;
      const exact = display === target ? 2 : 0;
      const includes = display.includes(target) || target.includes(display) ? 1 : 0;
      const levelBonus = level === 0 ? 2 : level === 1 ? 1.5 : level === 2 ? 1 : 0.5;
      const worksScore = Math.log10(worksCount + 1);

      return {
        candidate,
        score: (exact * 8) + (includes * 3) + levelBonus + worksScore + relevance
      };
    })
    .sort((a, b) => b.score - a.score)[0]?.candidate || null;
}

function bestTopicCandidate(searchTerm, candidates) {
  const target = normalizeText(searchTerm);

  return [...candidates]
    .map((candidate) => {
      const display = normalizeText(candidate?.display_name || '');
      const worksCount = Number.isFinite(candidate?.works_count) ? candidate.works_count : 0;
      const relevance = Number.isFinite(candidate?.relevance_score) ? candidate.relevance_score : 0;
      const exact = display === target ? 2 : 0;
      const includes = display.includes(target) || target.includes(display) ? 1 : 0;
      const worksScore = Math.log10(worksCount + 1);

      return {
        candidate,
        score: (exact * 8) + (includes * 3) + worksScore + relevance
      };
    })
    .sort((a, b) => b.score - a.score)[0]?.candidate || null;
}

async function resolveFieldId(fieldKey) {
  const config = getFieldConfig(fieldKey);
  if (!config) {
    throw createAppError(400, `Unsupported field key: ${fieldKey}`, {
      supported_fields: getSupportedFieldKeys()
    });
  }

  await ensureResolutionCacheLoaded();
  if (fieldIdCache.has(fieldKey)) {
    return fieldIdCache.get(fieldKey);
  }

  const searchTerms = Array.isArray(config.fieldSearchTerms) && config.fieldSearchTerms.length > 0
    ? config.fieldSearchTerms
    : [config.displayName];

  let best = null;
  for (const searchTerm of searchTerms) {
    const url = new URL(`${getBaseUrl()}/fields`);
    url.searchParams.set('search', searchTerm);
    url.searchParams.set('per-page', '5');
    console.log(`[OPENALEX] resolve-field field=${fieldKey} term="${searchTerm}" url=${url.toString()}`);

    const payload = await fetchOpenAlexJson(
      url.toString(),
      `Failed to resolve OpenAlex field for ${fieldKey}`
    );

    const candidates = Array.isArray(payload?.results) ? payload.results : [];
    best = bestFieldCandidate(searchTerm, candidates);
    if (best) {
      break;
    }
  }

  const fieldId = normalizeFieldFilterId(best?.id);

  if (!fieldId) {
    throw createAppError(502, `Could not resolve OpenAlex field ID for ${fieldKey}`);
  }

  fieldIdCache.set(fieldKey, fieldId);
  await persistResolutionCache();
  return fieldId;
}

async function resolveConceptId(searchTerm) {
  const cacheKey = normalizeText(searchTerm);
  await ensureResolutionCacheLoaded();

  if (conceptIdCache.has(cacheKey)) {
    return conceptIdCache.get(cacheKey);
  }

  const url = new URL(`${getBaseUrl()}/concepts`);
  url.searchParams.set('search', searchTerm);
  url.searchParams.set('per-page', '10');
  console.log(`[OPENALEX] resolve-concept term="${searchTerm}" url=${url.toString()}`);

  const payload = await fetchOpenAlexJson(
    url.toString(),
    `Failed to resolve OpenAlex concept for "${searchTerm}"`
  );

  const candidates = Array.isArray(payload?.results) ? payload.results : [];
  const best = bestConceptCandidate(searchTerm, candidates);
  const conceptId = normalizeEntityId(best?.id, 'C');

  if (!conceptId) {
    throw createAppError(502, `Could not resolve OpenAlex concept ID for "${searchTerm}"`);
  }

  conceptIdCache.set(cacheKey, conceptId);
  await persistResolutionCache();
  return conceptId;
}

async function resolveTopicId(searchTerm) {
  const cacheKey = normalizeText(searchTerm);
  await ensureResolutionCacheLoaded();

  if (topicIdCache.has(cacheKey)) {
    return topicIdCache.get(cacheKey);
  }

  const url = new URL(`${getBaseUrl()}/topics`);
  url.searchParams.set('search', searchTerm);
  url.searchParams.set('per-page', '10');
  console.log(`[OPENALEX] resolve-topic term="${searchTerm}" url=${url.toString()}`);

  const payload = await fetchOpenAlexJson(
    url.toString(),
    `Failed to resolve OpenAlex topic for "${searchTerm}"`
  );

  const candidates = Array.isArray(payload?.results) ? payload.results : [];
  const best = bestTopicCandidate(searchTerm, candidates);
  const topicId = normalizeTopicId(best?.id);

  if (!topicId) {
    throw createAppError(502, `Could not resolve OpenAlex topic ID for "${searchTerm}"`);
  }

  topicIdCache.set(cacheKey, topicId);
  await persistResolutionCache();
  return topicId;
}

async function resolveFieldConstraintIds(fieldKey) {
  const config = getFieldConfig(fieldKey);
  if (!config) {
    throw createAppError(400, `Unsupported field key: ${fieldKey}`);
  }

  const broadTerm = config.conceptTerms[0];
  const broadConceptId = await resolveConceptId(broadTerm);

  const subConceptIds = [];
  for (const term of config.conceptTerms.slice(1)) {
    try {
      const conceptId = await resolveConceptId(term);
      if (conceptId) {
        subConceptIds.push(conceptId);
      }
    } catch (error) {
      console.warn(`[OPENALEX] concept resolve skipped term="${term}" field=${fieldKey}`);
    }
  }

  let primaryTopicId = null;
  if (typeof config.primaryTopicTerm === 'string' && config.primaryTopicTerm.trim().length > 0) {
    try {
      primaryTopicId = await resolveTopicId(config.primaryTopicTerm);
    } catch (error) {
      console.warn(
        `[OPENALEX] topic resolve skipped term="${config.primaryTopicTerm}" field=${fieldKey}`
      );
    }
  }

  return {
    broadTerm,
    broadConceptId,
    subConceptIds,
    primaryTopicId
  };
}

function buildInitialWorksUrl({ fieldId, broadConceptId, primaryTopicId, page }) {
  const url = new URL(`${getBaseUrl()}/works`);
  const filterParts = [
    `primary_topic.field.id:${fieldId}`,
    'type:article|journal-article',
    'has_doi:true',
    `concepts.id:${broadConceptId}`
  ];

  if (primaryTopicId) {
    filterParts.push(`primary_topic.id:${primaryTopicId}`);
  }

  const filter = filterParts.join(',');

  url.searchParams.set('filter', filter);
  url.searchParams.set('sort', 'cited_by_count:desc');
  url.searchParams.set('per-page', String(INITIAL_PAGE_SIZE));
  url.searchParams.set('page', String(page));
  url.searchParams.set('select', WORK_SELECT_FIELDS);
  return url;
}

async function fetchInitialCandidates(fieldKey, fieldId, broadConceptId, primaryTopicId = null) {
  const allWorks = [];

  for (let page = 1; page <= INITIAL_MAX_PAGES; page += 1) {
    const url = buildInitialWorksUrl({ fieldId, broadConceptId, primaryTopicId, page });
    console.log(`[OPENALEX] galaxy field=${fieldKey} page=${page} url=${url.toString()}`);

    const payload = await fetchOpenAlexJson(
      url.toString(),
      `Failed to fetch initial galaxy works for ${fieldKey}`
    );
    const works = Array.isArray(payload?.results) ? payload.results : [];
    allWorks.push(...works);

    if (works.length < INITIAL_PAGE_SIZE) {
      break;
    }
  }

  return sortByCitationsDesc(dedupeWorksById(allWorks));
}

function topicStringsForWork(work) {
  const topicNames = [];
  if (typeof work?.primary_topic?.display_name === 'string') {
    topicNames.push(work.primary_topic.display_name);
  }

  if (Array.isArray(work?.topics)) {
    work.topics.forEach((topic) => {
      if (typeof topic?.display_name === 'string') {
        topicNames.push(topic.display_name);
      }
    });
  }

  return topicNames.map((name) => normalizeText(name)).filter(Boolean);
}

function strictRelevanceFilter(works, fieldKey, subConceptIds, broadTerm = '') {
  const config = getFieldConfig(fieldKey);
  const subConceptSet = new Set(subConceptIds);
  const subConceptTerms = config.conceptTerms.slice(1).map((term) => normalizeText(term));
  const normalizedBroadTerm = normalizeText(broadTerm);

  return works.filter((work) => {
    const concepts = Array.isArray(work?.concepts) ? work.concepts : [];
    const conceptMatch = concepts.some((concept) => {
      const conceptId = normalizeEntityId(concept?.id, 'C');
      const score = Number.isFinite(concept?.score) ? concept.score : 0;
      return conceptId && subConceptSet.has(conceptId) && score >= CONCEPT_SCORE_THRESHOLD;
    });

    if (conceptMatch) {
      return true;
    }

    const topicStrings = topicStringsForWork(work);
    if (subConceptTerms.length === 0) {
      return normalizedBroadTerm.length > 0 && topicStrings.some(
        (topicName) => topicName.includes(normalizedBroadTerm)
      );
    }

    return subConceptTerms.some((term) => (
      topicStrings.some((topicName) => topicName.includes(term))
    ));
  });
}

function topicKeywordFallbackFilter(works, fieldKey) {
  const config = getFieldConfig(fieldKey);
  const keywords = config.topicKeywords.map((keyword) => normalizeText(keyword));

  return works.filter((work) => {
    const primaryTopic = normalizeText(work?.primary_topic?.display_name || '');
    return keywords.some((keyword) => primaryTopic.includes(keyword));
  });
}

function applyExcludeKeywordsFilter(works, fieldKey) {
  const config = getFieldConfig(fieldKey);
  const excludeKeywords = Array.isArray(config?.excludeKeywords)
    ? config.excludeKeywords.map((keyword) => normalizeText(keyword)).filter(Boolean)
    : [];

  if (excludeKeywords.length === 0) {
    return works;
  }

  return works.filter((work) => {
    const topicStrings = topicStringsForWork(work);
    const haystack = normalizeText([
      work?.display_name || '',
      work?.primary_topic?.field?.display_name || '',
      ...topicStrings
    ].join(' '));

    return !excludeKeywords.some((keyword) => haystack.includes(keyword));
  });
}

function topUpToTarget(works, targetCount, fieldKey, fallbackPool = []) {
  const target = Math.max(0, targetCount);
  const dedupedPrimary = sortByCitationsDesc(dedupeWorksById(works));
  if (dedupedPrimary.length >= target) {
    return dedupedPrimary.slice(0, target);
  }

  const selectedMap = new Map();
  dedupedPrimary.forEach((work) => {
    const id = normalizeOpenAlexWorkId(work?.id);
    if (id) {
      selectedMap.set(id, work);
    }
  });

  const fallbackFiltered = sortByCitationsDesc(
    applyExcludeKeywordsFilter(dedupeWorksById(fallbackPool), fieldKey)
  );

  for (const work of fallbackFiltered) {
    const id = normalizeOpenAlexWorkId(work?.id);
    if (!id || selectedMap.has(id)) {
      continue;
    }

    selectedMap.set(id, work);
    if (selectedMap.size >= target) {
      break;
    }
  }

  return sortByCitationsDesc([...selectedMap.values()]).slice(0, target);
}

function logFieldMismatches(fieldKey, expectedFieldLabel, works) {
  const expected = normalizeText(expectedFieldLabel);
  if (!expected) {
    return;
  }

  let mismatchCount = 0;
  for (const work of works) {
    const actualField = normalizeText(work?.primary_topic?.field?.display_name || '');
    if (!actualField || actualField === expected) {
      continue;
    }

    mismatchCount += 1;
    console.warn(
      `[RELEVANCE] field=${fieldKey} mismatch expected="${expectedFieldLabel}" actual="${work?.primary_topic?.field?.display_name || 'unknown'}" title="${work?.display_name || 'Untitled'}"`
    );

    if (mismatchCount >= 5) {
      break;
    }
  }
}

function parseBoolean(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export async function getFieldGalaxy(fieldInput, options = {}) {
  const fieldKey = normalizeFieldKey(fieldInput);
  const config = getFieldConfig(fieldKey);
  if (!config) {
    throw createAppError(400, `Invalid field "${fieldInput}"`, {
      supported_fields: getSupportedFieldKeys()
    });
  }

  const fallbackOnly = Boolean(options.fallbackOnly);
  const cacheKey = `${fieldKey}:${fallbackOnly ? 'fallback' : 'auto'}`;
  const cached = readTimedCache(galaxyCache, cacheKey);
  if (cached) {
    console.log(`[CACHE] HIT galaxy field=${fieldKey} mode=${fallbackOnly ? 'fallback' : 'auto'}`);
    return cached;
  }

  console.log(`[CACHE] MISS galaxy field=${fieldKey} mode=${fallbackOnly ? 'fallback' : 'auto'}`);

  const fieldId = await resolveFieldId(fieldKey);
  const constraints = await resolveFieldConstraintIds(fieldKey);

  const candidates = await fetchInitialCandidates(
    fieldKey,
    fieldId,
    constraints.broadConceptId,
    constraints.primaryTopicId
  );
  const strictFiltered = sortByCitationsDesc(
    applyExcludeKeywordsFilter(
      strictRelevanceFilter(
        candidates,
        fieldKey,
        constraints.subConceptIds,
        constraints.broadTerm
      ),
      fieldKey
    )
  );

  let strategy = 'strict';
  let selected = strictFiltered;
  let fallbackFiltered = [];

  if (fallbackOnly || strictFiltered.length < MIN_INITIAL_WORKS) {
    fallbackFiltered = sortByCitationsDesc(
      applyExcludeKeywordsFilter(topicKeywordFallbackFilter(candidates, fieldKey), fieldKey)
    );
    if (fallbackOnly || fallbackFiltered.length >= strictFiltered.length) {
      selected = fallbackFiltered;
      strategy = 'topic_fallback';
    }
  }

  selected = topUpToTarget(selected, MAX_INITIAL_WORKS, fieldKey, candidates);
  logFieldMismatches(fieldKey, config.displayName, selected);

  const result = {
    fieldKey,
    strategy,
    count: selected.length,
    papers: selected.map(normalizePaper),
    debug: {
      fieldId,
      broadConceptId: constraints.broadConceptId,
      subConceptIds: constraints.subConceptIds,
      primaryTopicId: constraints.primaryTopicId,
      candidatesFetched: candidates.length,
      strictKept: strictFiltered.length,
      fallbackKept: fallbackFiltered.length,
      fallbackRequested: fallbackOnly,
      strategy
    }
  };

  writeTimedCache(galaxyCache, cacheKey, result);
  console.log(
    `[CACHE] STORED galaxy field=${fieldKey} mode=${fallbackOnly ? 'fallback' : 'auto'} items=${result.count}`
  );

  return result;
}

async function fetchWorkById(rawWorkId) {
  const openalexId = normalizeOpenAlexWorkId(rawWorkId);
  if (!openalexId) {
    throw createAppError(400, 'Invalid OpenAlex work ID');
  }

  const encodedId = encodeURIComponent(openalexId);
  const url = `${getBaseUrl()}/works/${encodedId}`;
  console.log(`[OPENALEX] work-detail url=${url}`);
  const payload = await fetchOpenAlexJson(url, `Failed to fetch work details for ${openalexId}`);

  return {
    openalexId,
    work: payload
  };
}

async function fetchWorksByIds(workIds) {
  const canonicalIds = [...new Set(workIds.map((id) => normalizeOpenAlexWorkId(id)).filter(Boolean))];
  if (canonicalIds.length === 0) {
    return [];
  }

  const chunks = chunkArray(canonicalIds, ID_FILTER_CHUNK_SIZE);
  const allWorks = [];

  for (const chunk of chunks) {
    const url = new URL(`${getBaseUrl()}/works`);
    url.searchParams.set('filter', `openalex_id:${chunk.join('|')}`);
    url.searchParams.set('per-page', String(Math.min(200, chunk.length)));
    url.searchParams.set('select', WORK_SELECT_FIELDS);
    console.log(`[OPENALEX] hydrate-ids url=${url.toString()}`);

    const payload = await fetchOpenAlexJson(
      url.toString(),
      `Failed to hydrate OpenAlex works for ${chunk.length} IDs`
    );
    const results = Array.isArray(payload?.results) ? payload.results : [];
    allWorks.push(...results);
  }

  return sortByCitationsDesc(dedupeWorksById(allWorks));
}

export async function getReferencesByWorkId(rawWorkId, options = {}) {
  const limit = clampLimit(options.limit);
  const { openalexId, work } = await fetchWorkById(rawWorkId);

  const referencedWorks = Array.isArray(work?.referenced_works)
    ? work.referenced_works
      .map((id) => normalizeOpenAlexWorkId(id))
      .filter(Boolean)
    : [];
  const dedupedReferences = [...new Set(referencedWorks)];

  if (dedupedReferences.length === 0) {
    return {
      openalexId,
      count: 0,
      papers: [],
      reason: 'no_references'
    };
  }

  const hydrationCandidateIds = dedupedReferences.slice(0, Math.min(
    REFERENCE_HYDRATION_CANDIDATE_CAP,
    dedupedReferences.length
  ));
  const hydratedWorks = await fetchWorksByIds(hydrationCandidateIds);
  const papers = hydratedWorks
    .slice(0, limit)
    .map(normalizePaper);

  return {
    openalexId,
    count: papers.length,
    papers,
    reason: papers.length === 0 ? 'no_hydrated_references' : null
  };
}

export async function getCitationsByWorkId(rawWorkId, options = {}) {
  const limit = clampLimit(options.limit);
  const openalexId = normalizeOpenAlexWorkId(rawWorkId);
  if (!openalexId) {
    throw createAppError(400, 'Invalid OpenAlex work ID');
  }

  const url = new URL(`${getBaseUrl()}/works`);
  url.searchParams.set('filter', `cites:${openalexId}`);
  url.searchParams.set('sort', 'cited_by_count:desc');
  url.searchParams.set('per-page', String(limit));
  url.searchParams.set('select', WORK_SELECT_FIELDS);
  console.log(`[OPENALEX] citations url=${url.toString()}`);

  const payload = await fetchOpenAlexJson(
    url.toString(),
    `Failed to fetch citing works for ${openalexId}`
  );
  const works = Array.isArray(payload?.results) ? payload.results : [];

  return {
    openalexId,
    count: works.length,
    papers: sortByCitationsDesc(works).slice(0, limit).map(normalizePaper),
    reason: works.length === 0 ? 'no_citations' : null
  };
}

export async function getTopPapersByField(fieldInput, options = {}) {
  const fallbackOnly = parseBoolean(options?.fallback) || Boolean(options?.fallbackOnly);
  const result = await getFieldGalaxy(fieldInput, { fallbackOnly });
  return result;
}
