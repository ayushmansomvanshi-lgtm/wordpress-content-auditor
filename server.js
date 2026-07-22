const express = require('express');
const path = require('path');
const { auditWordPressSite } = require('./src/auditor');
const { createCsv } = require('./src/csv');
const { withRequestContext } = require('./src/http');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.post('/api/audit', async (req, res) => {
  try {
    const { siteUrl, stagingAuth = {}, skipDuplicateChecks = false } = req.body || {};

    if (!siteUrl || typeof siteUrl !== 'string') {
      return res.status(400).json({ error: 'A valid siteUrl is required.' });
    }

    if (stagingAuth.enabled && !String(stagingAuth.username || '').trim()) {
      return res.status(400).json({ error: 'Enter the staging username before starting the audit.' });
    }

    const context = {
      authEnabled: Boolean(stagingAuth.enabled),
      username: stagingAuth.username,
      password: stagingAuth.password,
      skipDuplicateChecks: Boolean(stagingAuth.enabled && skipDuplicateChecks)
    };

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
  res.json({ ok: true, product: 'Radish', version: '4.4.0' });
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Radish v4.4.0 is running on port ${PORT}`);
});
