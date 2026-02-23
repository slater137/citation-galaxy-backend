import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import {
  getCitationsByWorkId,
  getFieldGalaxy,
  getReferencesByWorkId,
  getTopPapersByField
} from './openalex.js';
import {
  createAppError,
  getSupportedFieldKeys,
  normalizeFieldKey
} from './utils.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DEV_MODE = process.env.NODE_ENV !== 'production';

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  const startMs = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startMs;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`);
  });
  next();
});

function parseBoolean(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/papers', async (req, res, next) => {
  try {
    const rawField = req.query.field;
    if (!rawField) {
      throw createAppError(400, 'Missing required query parameter: field', {
        supported_fields: getSupportedFieldKeys()
      });
    }

    const fallbackOnly = parseBoolean(req.query.fallback);
    const result = await getTopPapersByField(String(rawField), { fallbackOnly });

    const payload = {
      field: result.fieldKey,
      strategy: result.strategy,
      count: result.papers.length,
      papers: result.papers
    };

    if (DEV_MODE) {
      payload.debug = result.debug;
    }

    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get('/api/galaxy/field/:fieldKey', async (req, res, next) => {
  try {
    const normalizedField = normalizeFieldKey(req.params.fieldKey);
    const fallbackOnly = parseBoolean(req.query.fallback);
    const result = await getFieldGalaxy(normalizedField, { fallbackOnly });

    const payload = {
      field: result.fieldKey,
      strategy: result.strategy,
      count: result.papers.length,
      papers: result.papers
    };

    if (DEV_MODE) {
      payload.debug = result.debug;
    }

    res.json(payload);
  } catch (error) {
    next(error);
  }
});

app.get('/api/works/:openAlexId/references', async (req, res, next) => {
  try {
    const result = await getReferencesByWorkId(req.params.openAlexId, {
      limit: req.query.limit
    });

    res.json({
      openalex_id: result.openalexId,
      count: result.count,
      papers: result.papers,
      reason: result.reason
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/works/:openAlexId/citations', async (req, res, next) => {
  try {
    const result = await getCitationsByWorkId(req.params.openAlexId, {
      limit: req.query.limit
    });

    res.json({
      openalex_id: result.openalexId,
      count: result.count,
      papers: result.papers,
      reason: result.reason
    });
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: 'Route does not exist'
  });
});

app.use((error, req, res, next) => {
  const statusCode = error.statusCode || 500;
  const payload = {
    error: statusCode >= 500 ? 'Internal server error' : 'Request error',
    message: error.message || 'Unexpected error'
  };

  if (error.details) {
    payload.details = error.details;
  }

  console.error('[ERROR]', {
    statusCode,
    message: error.message,
    details: error.details || null,
    stack: statusCode >= 500 ? error.stack : undefined
  });

  res.status(statusCode).json(payload);
});

app.listen(PORT, () => {
  console.log(`[BOOT] Citation Galaxy backend running on port ${PORT}`);
  console.log(`[BOOT] Supported fields: ${getSupportedFieldKeys().join(', ')}`);
});
