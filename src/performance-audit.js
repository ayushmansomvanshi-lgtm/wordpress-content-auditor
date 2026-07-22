const { getBasicAuthorizationHeader } = require('./http');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  chromium = null;
}

function bytes(value = 0) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(number) / Math.log(1024)), units.length - 1);
  const amount = number / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function milliseconds(value = 0) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 'Not available';
  return number >= 1000 ? `${(number / 1000).toFixed(2)} s` : `${Math.round(number)} ms`;
}

function metricStatus(id, value) {
  const number = Number(value || 0);
  const thresholds = {
    'largest-contentful-paint': [2500, 4000],
    'first-contentful-paint': [1800, 3000],
    'server-response-time': [800, 1800],
    'speed-index': [3400, 5800],
    'total-blocking-time': [200, 600],
    'cumulative-layout-shift': [0.1, 0.25]
  };
  const [good, poor] = thresholds[id] || [0, 0];
  if (!good && !poor) return 'unknown';
  if (number <= good) return 'good';
  if (number <= poor) return 'needs-improvement';
  return 'poor';
}

function auditItems(audit, max = 30) {
  const items = Array.isArray(audit?.details?.items) ? audit.details.items : [];
  return items.slice(0, max).map((item) => ({
    url: item.url || item.source?.url || item.node?.snippet || '',
    label: item.label || item.node?.nodeLabel || item.source?.url || '',
    totalBytes: Number(item.totalBytes || item.resourceSize || 0),
    wastedBytes: Number(item.wastedBytes || item.wastedSize || 0),
    wastedPercent: Number(item.wastedPercent || 0),
    cacheLifetimeMs: Number(item.cacheLifetimeMs || 0),
    transferSize: Number(item.transferSize || 0),
    resourceType: item.resourceType || item.mimeType || '',
    displayValue: item.displayValue || '',
    snippet: item.node?.snippet || ''
  }));
}

function opportunity(lhr, id, fallbackTitle) {
  const audit = lhr.audits?.[id];
  if (!audit) {
    return {
      id,
      title: fallbackTitle,
      available: false,
      score: null,
      displayValue: 'Not available in this Lighthouse version',
      savingsMs: 0,
      savingsBytes: 0,
      items: []
    };
  }

  return {
    id,
    title: audit.title || fallbackTitle,
    description: audit.description || '',
    available: true,
    score: typeof audit.score === 'number' ? audit.score : null,
    displayValue: audit.displayValue || '',
    savingsMs: Number(audit.details?.overallSavingsMs || 0),
    savingsBytes: Number(audit.details?.overallSavingsBytes || 0),
    items: auditItems(audit)
  };
}

function buildMetric(lhr, id, label) {
  const audit = lhr.audits?.[id];
  const value = Number(audit?.numericValue || 0);
  const isCls = id === 'cumulative-layout-shift';
  return {
    id,
    label,
    value,
    displayValue: isCls ? value.toFixed(3) : milliseconds(value),
    score: typeof audit?.score === 'number' ? Math.round(audit.score * 100) : null,
    status: audit ? metricStatus(id, value) : 'unavailable',
    description: audit?.description || ''
  };
}


async function safelyStopChrome(chrome) {
  if (!chrome || typeof chrome.kill !== 'function') return;

  try {
    const result = chrome.kill();
    if (result && typeof result.then === 'function') {
      await result;
    }
  } catch {
    // Chrome may already be closed. Cleanup errors must never abort the audit.
  }
}

async function runLighthouseAudit(url) {
  let chrome;
  try {
    if (!chromium) throw new Error('Playwright Chromium is not installed. Run npm install.');
    const [lighthouseModule, chromeLauncherModule] = await Promise.all([
      import('lighthouse'),
      import('chrome-launcher')
    ]);
    const lighthouse = lighthouseModule.default || lighthouseModule;
    const launchChrome = chromeLauncherModule.launch || chromeLauncherModule.default?.launch;
    if (typeof lighthouse !== 'function' || typeof launchChrome !== 'function') {
      throw new Error('Lighthouse or Chrome Launcher could not be loaded.');
    }

    chrome = await launchChrome({
      chromePath: chromium.executablePath(),
      chromeFlags: [
        '--headless=new',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--ignore-certificate-errors'
      ]
    });

    const result = await lighthouse(
      url,
      {
        port: chrome.port,
        output: 'json',
        logLevel: 'error',
        onlyCategories: ['performance'],
        formFactor: 'mobile',
        throttlingMethod: 'simulate',
        screenEmulation: {
          mobile: true,
          width: 390,
          height: 844,
          deviceScaleFactor: 2,
          disabled: false
        },
        ...(getBasicAuthorizationHeader()
          ? { extraHeaders: { Authorization: getBasicAuthorizationHeader() } }
          : {})
      },
      null
    );

    const lhr = result?.lhr;
    if (!lhr) throw new Error('Lighthouse returned no report data.');

    const metrics = [
      buildMetric(lhr, 'largest-contentful-paint', 'Largest Contentful Paint'),
      buildMetric(lhr, 'cumulative-layout-shift', 'Cumulative Layout Shift'),
      buildMetric(lhr, 'server-response-time', 'Time to First Byte'),
      buildMetric(lhr, 'first-contentful-paint', 'First Contentful Paint'),
      buildMetric(lhr, 'speed-index', 'Speed Index'),
      buildMetric(lhr, 'total-blocking-time', 'Total Blocking Time')
    ];

    const unusedCss = opportunity(lhr, 'unused-css-rules', 'Reduce unused CSS');
    const unusedJavaScript = opportunity(
      lhr,
      'unused-javascript',
      'Reduce unused JavaScript'
    );
    const cacheLifetime = opportunity(
      lhr,
      'uses-long-cache-ttl',
      'Use efficient cache lifetimes'
    );
    const textCompression = opportunity(
      lhr,
      'uses-text-compression',
      'Enable text compression'
    );
    const responsiveImages = opportunity(
      lhr,
      'uses-responsive-images',
      'Properly size images'
    );
    const optimizedImages = opportunity(
      lhr,
      'uses-optimized-images',
      'Efficiently encode images'
    );
    const modernImages = opportunity(
      lhr,
      'modern-image-formats',
      'Serve images in modern formats'
    );
    const unsizedImages = opportunity(lhr, 'unsized-images', 'Image elements have explicit width and height');

    const diagnostics = lhr.audits?.diagnostics?.details?.items?.[0] || {};
    const networkRequests = lhr.audits?.['network-requests']?.details?.items || [];

    return {
      available: true,
      requestedUrl: url,
      finalUrl: lhr.finalDisplayedUrl || lhr.finalUrl || url,
      fetchTime: lhr.fetchTime || new Date().toISOString(),
      lighthouseVersion: lhr.lighthouseVersion || '',
      performanceScore: Math.round((lhr.categories?.performance?.score || 0) * 100),
      metrics,
      resources: {
        unusedCss,
        unusedJavaScript,
        cacheLifetime,
        textCompression,
        responsiveImages,
        optimizedImages,
        modernImages,
        unsizedImages
      },
      diagnostics: {
        totalByteWeight: Number(diagnostics.totalByteWeight || 0),
        totalTaskTime: Number(diagnostics.totalTaskTime || 0),
        numRequests: Number(diagnostics.numRequests || networkRequests.length || 0),
        numScripts: Number(diagnostics.numScripts || 0),
        numStylesheets: Number(diagnostics.numStylesheets || 0),
        numFonts: Number(diagnostics.numFonts || 0),
        numTasksOver50ms: Number(diagnostics.numTasksOver50ms || 0),
        maxRtt: Number(diagnostics.maxRtt || 0),
        maxServerLatency: Number(diagnostics.maxServerLatency || 0),
        mainDocumentTransferSize: Number(diagnostics.mainDocumentTransferSize || 0),
        totalByteWeightLabel: bytes(diagnostics.totalByteWeight || 0)
      },
      error: ''
    };
  } catch (error) {
    return {
      available: false,
      requestedUrl: url,
      finalUrl: url,
      fetchTime: new Date().toISOString(),
      lighthouseVersion: '',
      performanceScore: null,
      metrics: [],
      resources: {},
      diagnostics: {},
      error: error.message || String(error)
    };
  } finally {
    await safelyStopChrome(chrome);
  }
}

module.exports = { runLighthouseAudit };
