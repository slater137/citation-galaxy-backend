const FIELD_CONCEPT_MAP = Object.freeze({
  physics: 'C121332964',
  mathematics: 'C33923547',
  computer_science: 'C41008148',
  neuroscience: 'C55493867',
  economics: 'C162324750',
  philosophy: 'C166957645'
});

const FIELD_ALIASES = Object.freeze({
  'computer science': 'computer_science',
  compsci: 'computer_science',
  cs: 'computer_science',
  math: 'mathematics',
  econ: 'economics'
});

export function normalizeField(field) {
  if (typeof field !== 'string') {
    return '';
  }

  const cleaned = field.trim().toLowerCase().replace(/[-\s]+/g, '_');
  return FIELD_ALIASES[field.trim().toLowerCase()] || FIELD_ALIASES[cleaned] || cleaned;
}

export function fieldToConceptId(field) {
  const normalized = normalizeField(field);
  return FIELD_CONCEPT_MAP[normalized] || null;
}

export function getSupportedFields() {
  return Object.keys(FIELD_CONCEPT_MAP).sort();
}

function extractAuthors(authorships) {
  if (!Array.isArray(authorships)) {
    return [];
  }

  return authorships
    .map((authorship) => authorship?.author?.display_name)
    .filter(Boolean)
    .slice(0, 3);
}

function pickPrimaryTopic(work) {
  if (work?.primary_topic?.display_name) {
    return work.primary_topic.display_name;
  }

  if (!Array.isArray(work?.concepts) || work.concepts.length === 0) {
    return null;
  }

  return work.concepts[0]?.display_name || null;
}

function normalizeDoi(doi) {
  if (!doi || typeof doi !== 'string') {
    return null;
  }

  return doi.replace(/^https?:\/\/doi\.org\//i, '').trim() || null;
}

export function toBubbleSize(citedByCount) {
  const safeCount = Number.isFinite(citedByCount) && citedByCount > 0 ? citedByCount : 0;
  return Number(Math.log10(safeCount + 1).toFixed(4));
}

export function normalizePaper(work) {
  const citedByCount = Number.isFinite(work?.cited_by_count) ? work.cited_by_count : 0;

  return {
    title: work?.display_name || 'Untitled',
    authors: extractAuthors(work?.authorships),
    publication_year: work?.publication_year || null,
    cited_by_count: citedByCount,
    doi: normalizeDoi(work?.doi),
    primary_topic: pickPrimaryTopic(work),
    size: toBubbleSize(citedByCount)
  };
}

export function createAppError(statusCode, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) {
    error.details = details;
  }
  return error;
}
