import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { getTopPapersByField } from './openalex.js';
import { createAppError, getSupportedFields, normalizeField } from './utils.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);

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

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/papers', async (req, res, next) => {
  try {
    const rawField = req.query.field;
    if (!rawField) {
      throw createAppError(400, 'Missing required query parameter: field', {
        supported_fields: getSupportedFields()
      });
    }

    const normalizedField = normalizeField(String(rawField));
    const papers = await getTopPapersByField(normalizedField);

    res.json({
      field: normalizedField,
      count: papers.length,
      papers
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
  const response = {
    error: statusCode >= 500 ? 'Internal server error' : 'Request error',
    message: error.message || 'Unexpected error'
  };

  if (error.details) {
    response.details = error.details;
  }

  console.error('[ERROR]', {
    message: error.message,
    statusCode,
    details: error.details || null,
    stack: statusCode >= 500 ? error.stack : undefined
  });

  res.status(statusCode).json(response);
});

app.listen(PORT, () => {
  console.log(`[BOOT] Citation Galaxy backend running on port ${PORT}`);
  console.log(`[BOOT] Supported fields: ${getSupportedFields().join(', ')}`);
});
