const { fetchJson } = require('./http');

async function detectApiRoot(siteUrl) {
  const candidates = [
    `${siteUrl}/wp-json/`,
    `${siteUrl}/?rest_route=/`
  ];

  const errors = [];

  for (const candidate of candidates) {
    try {
      const result = await fetchJson(candidate);
      if (result.data && result.data.namespaces) {
        return {
          apiRoot: candidate.endsWith('/') ? candidate : `${candidate}/`,
          index: result.data
        };
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(
    `WordPress REST API could not be detected. Attempts: ${errors.join(' | ')}`
  );
}

function buildEndpoint(apiRoot, path, params = {}) {
  const prettyApi = apiRoot.includes('/wp-json/');

  if (prettyApi) {
    const url = new URL(path.replace(/^\//, ''), apiRoot);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });
    return url.toString();
  }

  const base = new URL(apiRoot);
  base.searchParams.set('rest_route', `/${path.replace(/^\//, '')}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      base.searchParams.set(key, String(value));
    }
  });
  return base.toString();
}

async function fetchAllPages(apiRoot, endpoint, params = {}) {
  const firstUrl = buildEndpoint(apiRoot, endpoint, {
    ...params,
    per_page: 100,
    page: 1
  });

  const first = await fetchJson(firstUrl);
  const total = Number(first.headers.get('x-wp-total') || first.data.length || 0);
  const totalPages = Number(first.headers.get('x-wp-totalpages') || 1);
  const items = [...first.data];

  for (let page = 2; page <= totalPages; page += 1) {
    const url = buildEndpoint(apiRoot, endpoint, {
      ...params,
      per_page: 100,
      page
    });
    const result = await fetchJson(url);
    items.push(...result.data);
  }

  return { items, total, totalPages };
}

async function fetchPostTypes(apiRoot) {
  const url = buildEndpoint(apiRoot, 'wp/v2/types');
  const { data } = await fetchJson(url);

  return Object.values(data).filter((type) => {
    return type && type.rest_base && type.viewable !== false;
  });
}

module.exports = {
  detectApiRoot,
  buildEndpoint,
  fetchAllPages,
  fetchPostTypes
};
