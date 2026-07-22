const express = require('express');
const path = require('path');
const { auditWordPressSite } = require('./src/auditor');
const { createCsv } = require('./src/csv');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/audit', async (req, res) => {
  try {
    const { siteUrl } = req.body;

    if (!siteUrl || typeof siteUrl !== 'string') {
      return res.status(400).json({ error: 'A valid siteUrl is required.' });
    }

    const result = await auditWordPressSite(siteUrl);
    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Audit failed.'
    });
  }
});

app.post('/api/export/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const { data } = req.body;

    if (!data) {
      return res.status(400).json({ error: 'Audit data is required.' });
    }

    const csv = createCsv(type, data);
    const safeType = ['posts', 'categories', 'issues'].includes(type)
      ? type
      : 'report';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="wordpress-${safeType}.csv"`
    );
    return res.send('\uFEFF' + csv);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`WordPress Content Auditor running at http://localhost:${PORT}`);
});
