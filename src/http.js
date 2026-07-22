const { AsyncLocalStorage } = require('node:async_hooks');

const DEFAULT_TIMEOUT = 20000;
const requestContext = new AsyncLocalStorage();

function normalizeSiteUrl(value) {
  let input = String(value || '').trim();
  if (!input) throw new Error('Website URL is empty.');

  if (!/^https?:\/\//i.test(input)) {
    input = `https://${input}`;
  }

  const url = new URL(input);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function sanitizeContext(context = {}) {
  const username = String(context.username || '').trim();
  const password = String(context.password || '');
  return {
    username,
    password,
    authEnabled: Boolean(context.authEnabled && username),
    skipDuplicateChecks: Boolean(context.skipDuplicateChecks)
  };
}

function withRequestContext(context, worker) {
  return requestContext.run(sanitizeContext(context), worker);
}

function getRequestContext() {
  return requestContext.getStore() || sanitizeContext();
}

function getBasicAuthorizationHeader() {
  const context = getRequestContext();
  if (!context.authEnabled || !context.username) return '';
  return `Basic ${Buffer.from(`${context.username}:${context.password}`).toString('base64')}`;
}

function getPlaywrightHttpCredentials() {
  const context = getRequestContext();
  if (!context.authEnabled || !context.username) return undefined;
  return {
    username: context.username,
    password: context.password
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeout || DEFAULT_TIMEOUT
  );

  const authorization = getBasicAuthorizationHeader();

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'Radish-WordPress-Auditor/4.3',
        Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
        ...(authorization ? { Authorization: authorization } : {}),
        ...(options.headers || {})
      }
    });
    return response;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetchWithTimeout(url, options);
  const contentType = response.headers.get('content-type') || '';

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} for ${url}`);
    error.statusCode = response.status;
    throw error;
  }

  if (!contentType.includes('json')) {
    throw new Error(`Expected JSON but received ${contentType || 'unknown content type'} from ${url}`);
  }

  return {
    data: await response.json(),
    headers: response.headers,
    status: response.status
  };
}

module.exports = {
  normalizeSiteUrl,
  fetchWithTimeout,
  fetchJson,
  withRequestContext,
  getRequestContext,
  getBasicAuthorizationHeader,
  getPlaywrightHttpCredentials
};
