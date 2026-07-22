const DEFAULT_TIMEOUT = 20000;

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

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeout || DEFAULT_TIMEOUT
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'WordPress-Content-Auditor/1.0',
        Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
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

async function fetchJson(url) {
  const response = await fetchWithTimeout(url);
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
  fetchJson
};
