const FIELD_CONFIG = Object.freeze({
  quantum_mechanics: Object.freeze({
    displayName: 'Physics and Astronomy',
    fieldSearchTerms: Object.freeze(['Physics']),
    primaryTopicTerm: 'Quantum mechanics',
    conceptTerms: Object.freeze([
      'quantum mechanics'
    ]),
    topicKeywords: Object.freeze([
      'quantum mechanics'
    ]),
    excludeKeywords: Object.freeze([
      'economics',
      'business',
      'marketing',
      'medicine',
      'epidemiology',
      'genetic',
      'biology',
      'psychiatry',
      'psychology'
    ])
  }),
  machine_learning: Object.freeze({
    displayName: 'Computer science',
    fieldSearchTerms: Object.freeze(['Computer science']),
    conceptTerms: Object.freeze([
      'machine learning',
      'deep learning',
      'neural network',
      'reinforcement learning',
      'representation learning'
    ]),
    topicKeywords: Object.freeze([
      'machine learning',
      'deep learning',
      'neural network',
      'reinforcement learning',
      'representation learning',
      'supervised learning',
      'unsupervised learning'
    ]),
    excludeKeywords: Object.freeze([
      'economics',
      'business',
      'marketing'
    ])
  }),
  neuroscience: Object.freeze({
    displayName: 'Neuroscience',
    fieldSearchTerms: Object.freeze(['Neuroscience']),
    conceptTerms: Object.freeze([
      'neuroscience',
      'cognitive neuroscience',
      'computational neuroscience',
      'neural coding',
      'brain'
    ]),
    topicKeywords: Object.freeze([
      'neuroscience',
      'cognitive neuroscience',
      'neural coding',
      'brain',
      'neural',
      'cortex',
      'synaptic'
    ]),
    excludeKeywords: Object.freeze([
      'economics',
      'business',
      'marketing'
    ])
  }),
  philosophy: Object.freeze({
    displayName: 'Philosophy',
    fieldSearchTerms: Object.freeze(['Philosophy', 'Arts and Humanities']),
    conceptTerms: Object.freeze([
      'philosophy of mind',
      'philosophy',
      'consciousness',
      'phenomenology',
      'dualism',
      'physicalism'
    ]),
    topicKeywords: Object.freeze([
      'philosophy',
      'mind',
      'consciousness',
      'philosophy of mind',
      'phenomenology',
      'dualism',
      'physicalism',
      'qualia',
      'intentionality',
      'metaphysics',
      'epistemology'
    ]),
    excludeKeywords: Object.freeze([
      'economics',
      'business',
      'marketing',
      'medicine',
      'epidemiology',
      'genetic',
      'biology',
      'psychiatry',
      'clinical trial'
    ])
  })
});

const FIELD_ALIASES = Object.freeze({
  physics: 'quantum_mechanics',
  quantum_mechanics: 'quantum_mechanics',
  'quantum mechanics': 'quantum_mechanics',
  qm: 'quantum_mechanics',
  machine_learning: 'machine_learning',
  'machine learning': 'machine_learning',
  ml: 'machine_learning',
  computer_science: 'machine_learning',
  'computer science': 'machine_learning',
  neuroscience: 'neuroscience',
  neuro: 'neuroscience',
  philosophy: 'philosophy'
});

export function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeFieldKey(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const lowered = value.trim().toLowerCase();
  const underscored = lowered.replace(/[-\s]+/g, '_');

  return FIELD_ALIASES[lowered] || FIELD_ALIASES[underscored] || underscored;
}

export function getFieldConfig(fieldKey) {
  const normalized = normalizeFieldKey(fieldKey);
  return FIELD_CONFIG[normalized] || null;
}

export function getSupportedFieldKeys() {
  return Object.keys(FIELD_CONFIG);
}

export function normalizeOpenAlexWorkId(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const decoded = decodeURIComponent(value).trim();
  if (!decoded) {
    return null;
  }

  const match = decoded.match(/W\d+/i);
  if (!match) {
    return null;
  }

  return `https://openalex.org/${match[0].toUpperCase()}`;
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

function normalizeDoi(doi) {
  if (!doi || typeof doi !== 'string') {
    return null;
  }

  return doi.replace(/^https?:\/\/doi\.org\//i, '').trim() || null;
}

function pickLandingUrl(work, doi) {
  if (typeof work?.primary_location?.landing_page_url === 'string') {
    const trimmed = work.primary_location.landing_page_url.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  if (doi) {
    return `https://doi.org/${doi}`;
  }

  return null;
}

export function toBubbleSize(citedByCount) {
  const safeCount = Number.isFinite(citedByCount) && citedByCount > 0 ? citedByCount : 0;
  return Number(Math.log10(safeCount + 1).toFixed(4));
}

export function normalizePaper(work) {
  const citedByCount = Number.isFinite(work?.cited_by_count) ? work.cited_by_count : 0;
  const doi = normalizeDoi(work?.doi);
  const openalexId = normalizeOpenAlexWorkId(work?.id);

  return {
    id: openalexId,
    openalex_id: openalexId,
    title: typeof work?.display_name === 'string' && work.display_name.trim().length > 0
      ? work.display_name.trim()
      : 'Untitled',
    authors: extractAuthors(work?.authorships),
    publication_year: Number.isFinite(work?.publication_year) ? work.publication_year : null,
    cited_by_count: citedByCount,
    doi,
    url: pickLandingUrl(work, doi),
    primary_topic: work?.primary_topic?.display_name || null,
    primary_topic_field: work?.primary_topic?.field?.display_name || null,
    topics: Array.isArray(work?.topics)
      ? work.topics
        .map((topic) => topic?.display_name)
        .filter(Boolean)
        .slice(0, 3)
      : [],
    refCount: Array.isArray(work?.referenced_works) ? work.referenced_works.length : null,
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
