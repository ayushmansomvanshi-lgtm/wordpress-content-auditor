const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const { auditWordPressSite } = require('./src/auditor');
const { createCsv } = require('./src/csv');
const { withRequestContext } = require('./src/http');

const app = express();
const PORT = process.env.PORT || 3000;
const VERSION = '4.4.1';
const JOB_TTL_MS = 60 * 60 * 1000;
const auditJobs = new Map();
let activeJobId = null;

app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
  }
}));

function validateAuditRequest(body = {}) {
  const { siteUrl, stagingAuth = {}, skipDuplicateChecks = false } = body;

  if (!siteUrl || typeof siteUrl !== 'string') {
    const error = new Error('A valid website URL is required.');
    error.statusCode = 400;
    throw error;
  }

  if (stagingAuth.enabled && !String(stagingAuth.username || '').trim()) {
    const error = new Error('Enter the staging username before starting the audit.');
    error.statusCode = 400;
    throw error;
  }

  return {
    siteUrl,
    context: {
      authEnabled: Boolean(stagingAuth.enabled),
      username: String(stagingAuth.username || ''),
      password: String(stagingAuth.password || ''),
      skipDuplicateChecks: Boolean(stagingAuth.enabled && skipDuplicateChecks)
    }
  };
}

function publicJob(job, includeResult = false) {
  const response = {
    ok: job.status !== 'failed',
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    message: job.message || ''
  };

  if (job.status === 'failed') response.error = job.error || 'Audit failed.';
  if (includeResult && job.status === 'complete') response.result = job.result;
  return response;
}

function cleanOldJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of auditJobs.entries()) {
    const updated = new Date(job.updatedAt).getTime();
    if (Number.isFinite(updated) && updated < cutoff && id !== activeJobId) {
      auditJobs.delete(id);
    }
  }
}

async function executeAuditJob(job, siteUrl, context) {
  job.status = 'running';
  job.message = 'The audit is running on the server.';
  job.updatedAt = new Date().toISOString();

  try {
    const result = await withRequestContext(context, () =>
      auditWordPressSite(siteUrl, {
        skipDuplicateChecks: context.skipDuplicateChecks,
        usedStagingAuthentication: context.authEnabled
      })
    );

    job.status = 'complete';
    job.message = 'Audit completed successfully.';
    job.result = result;
  } catch (error) {
    console.error('Background audit failed:', error);
    job.status = 'failed';
    job.message = 'The audit stopped before completion.';
    job.error = error?.message || 'Audit failed.';
  } finally {
    job.updatedAt = new Date().toISOString();
    if (activeJobId === job.id) activeJobId = null;
    context.username = '';
    context.password = '';
    cleanOldJobs();
  }
}

app.post('/api/audit/start', (req, res) => {
  try {
    cleanOldJobs();
    const { siteUrl, context } = validateAuditRequest(req.body || {});

    if (activeJobId) {
      const active = auditJobs.get(activeJobId);
      if (active && ['queued', 'running'].includes(active.status)) {
        return res.status(429).json({
          error: 'Another audit is already running. Wait for it to finish, then try again.',
          jobId: active.id,
          status: active.status
        });
      }
      activeJobId = null;
    }

    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      status: 'queued',
      message: 'The audit has been added to the queue.',
      createdAt: now,
      updatedAt: now,
      result: null,
      error: ''
    };

    auditJobs.set(job.id, job);
    activeJobId = job.id;

    // Return JSON immediately so hosting proxies do not need to keep one long
    // HTTP request open while Chromium and Lighthouse are running.
    res.status(202).json(publicJob(job));

    setImmediate(() => {
      executeAuditJob(job, siteUrl, context).catch((error) => {
        console.error('Unexpected audit worker error:', error);
      });
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.message || 'The audit could not be started.'
    });
  }
});

app.get('/api/audit/status/:jobId', (req, res) => {
  cleanOldJobs();
  const job = auditJobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      error: 'This audit job is no longer available. The server may have restarted. Run the audit again.'
    });
  }

  return res.json(publicJob(job, true));
});

// Backward-compatible endpoint for older clients. New clients use the
// background job routes above.
app.post('/api/audit', async (req, res) => {
  try {
    const { siteUrl, context } = validateAuditRequest(req.body || {});
    const result = await withRequestContext(context, () =>
      auditWordPressSite(siteUrl, {
        skipDuplicateChecks: context.skipDuplicateChecks,
        usedStagingAuthentication: context.authEnabled
      })
    );
    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Audit failed.'
    });
  }
});

app.post('/api/export/:type', (req, res) => {
  try {
    const { type } = req.params;
    const { data } = req.body;

    if (!data) {
      return res.status(400).json({ error: 'Audit data is required.' });
    }

    const csv = createCsv(type, data);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="radish-${type}.csv"`
    );
    return res.send(`\uFEFF${csv}`);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    product: 'Radish',
    version: VERSION,
    auditStatus: activeJobId ? 'busy' : 'ready'
  });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error('Unhandled request error:', error);
  if (res.headersSent) return;
  res.status(error.statusCode || 500).json({
    error: error.message || 'Unexpected server error.'
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Radish v${VERSION} is running on port ${PORT}`);
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
