const { normalizeSiteUrl } = require('./http');
const {
  detectApiRoot,
  fetchAllPages,
  fetchPostTypes
} = require('./wordpress');

function stripHtml(value = '') {
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return String(value || '').trim().toLowerCase();
  }
}

async function auditWordPressSite(rawSiteUrl) {
  const siteUrl = normalizeSiteUrl(rawSiteUrl);
  const startedAt = new Date().toISOString();
  const { apiRoot, index } = await detectApiRoot(siteUrl);

  const categoryResult = await fetchAllPages(apiRoot, 'wp/v2/categories', {
    hide_empty: false,
    orderby: 'id',
    order: 'asc'
  });

  let postTypes = [];
  try {
    postTypes = await fetchPostTypes(apiRoot);
  } catch {
    postTypes = [
      {
        slug: 'post',
        name: 'Posts',
        rest_base: 'posts',
        taxonomies: ['category']
      }
    ];
  }

  const categoryPostTypes = postTypes.filter((type) => {
    const taxonomies = Array.isArray(type.taxonomies) ? type.taxonomies : [];
    return taxonomies.includes('category') || type.slug === 'post';
  });

  const selectedTypes = categoryPostTypes.length
    ? categoryPostTypes
    : postTypes.filter((type) => type.slug === 'post');

  const allPosts = [];
  const typeSummaries = [];
  const typeErrors = [];

  for (const type of selectedTypes) {
    try {
      const endpoint = `wp/v2/${type.rest_base}`;
      const result = await fetchAllPages(apiRoot, endpoint, {
        status: 'publish',
        orderby: 'id',
        order: 'asc',
        _fields: 'id,date,modified,slug,status,link,title,categories,author,type'
      });

      typeSummaries.push({
        slug: type.slug,
        name: type.name,
        restBase: type.rest_base,
        total: result.total,
        pagesFetched: result.totalPages
      });

      for (const post of result.items) {
        allPosts.push({
          id: post.id,
          type: post.type || type.slug,
          title: stripHtml(post.title?.rendered || ''),
          slug: post.slug || '',
          url: post.link || '',
          status: post.status || 'publish',
          date: post.date || '',
          modified: post.modified || '',
          authorId: post.author ?? '',
          categoryIds: Array.isArray(post.categories) ? post.categories : []
        });
      }
    } catch (error) {
      typeErrors.push({
        type: type.slug,
        restBase: type.rest_base,
        message: error.message
      });
    }
  }

  const categories = categoryResult.items.map((category) => ({
    id: category.id,
    name: stripHtml(category.name),
    slug: category.slug,
    description: stripHtml(category.description || ''),
    parentId: category.parent || 0,
    wordpressCount: Number(category.count || 0),
    archiveUrl: category.link || ''
  }));

  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const localCounts = new Map(categories.map((category) => [category.id, 0]));

  for (const post of allPosts) {
    for (const categoryId of post.categoryIds) {
      localCounts.set(categoryId, (localCounts.get(categoryId) || 0) + 1);
    }
  }

  const enrichedCategories = categories.map((category) => {
    const localCount = localCounts.get(category.id) || 0;
    const difference = localCount - category.wordpressCount;
    return {
      ...category,
      localCount,
      difference,
      status:
        difference === 0
          ? 'Complete'
          : difference > 0
            ? 'Local count is higher'
            : 'Posts may be missing'
    };
  });

  const uncategorized = categories.find(
    (category) => category.slug === 'uncategorized'
  );

  const issues = [];
  const seenUrls = new Map();

  const enrichedPosts = allPosts.map((post) => {
    const categoryNames = post.categoryIds.map(
      (id) => categoryById.get(id)?.name || `Unknown category ${id}`
    );

    if (post.categoryIds.length === 0) {
      issues.push({
        severity: 'warning',
        type: 'NO_CATEGORY',
        postId: post.id,
        postType: post.type,
        title: post.title,
        url: post.url,
        details: 'The post has no category assigned.'
      });
    }

    if (
      uncategorized &&
      post.categoryIds.length === 1 &&
      post.categoryIds[0] === uncategorized.id
    ) {
      issues.push({
        severity: 'warning',
        type: 'UNCATEGORIZED_ONLY',
        postId: post.id,
        postType: post.type,
        title: post.title,
        url: post.url,
        details: 'The post is assigned only to Uncategorized.'
      });
    }

    const normalizedUrl = canonicalizeUrl(post.url);
    if (normalizedUrl) {
      if (seenUrls.has(normalizedUrl)) {
        issues.push({
          severity: 'error',
          type: 'DUPLICATE_URL',
          postId: post.id,
          postType: post.type,
          title: post.title,
          url: post.url,
          details: `Same normalized URL as post ${seenUrls.get(normalizedUrl)}.`
        });
      } else {
        seenUrls.set(normalizedUrl, post.id);
      }
    }

    return {
      ...post,
      categoryNames,
      categoryCount: post.categoryIds.length
    };
  });

  for (const category of enrichedCategories) {
    if (category.difference !== 0) {
      issues.push({
        severity: 'error',
        type: 'CATEGORY_COUNT_MISMATCH',
        postId: '',
        postType: '',
        title: category.name,
        url: category.archiveUrl,
        details: `WordPress reports ${category.wordpressCount}; the fetched posts produce ${category.localCount}. Difference: ${category.difference}.`
      });
    }

    if (category.wordpressCount === 0) {
      issues.push({
        severity: 'info',
        type: 'EMPTY_CATEGORY',
        postId: '',
        postType: '',
        title: category.name,
        url: category.archiveUrl,
        details: 'This category currently has no published posts.'
      });
    }
  }

  for (const error of typeErrors) {
    issues.push({
      severity: 'error',
      type: 'POST_TYPE_FETCH_FAILED',
      postId: '',
      postType: error.type,
      title: error.type,
      url: '',
      details: error.message
    });
  }

  return {
    metadata: {
      siteUrl,
      siteName: index.name || '',
      siteDescription: index.description || '',
      apiRoot,
      startedAt,
      completedAt: new Date().toISOString()
    },
    summary: {
      uniquePublishedPosts: enrichedPosts.length,
      categories: enrichedCategories.length,
      totalCategoryAssignments: enrichedPosts.reduce(
        (sum, post) => sum + post.categoryCount,
        0
      ),
      postsWithoutCategory: issues.filter((issue) => issue.type === 'NO_CATEGORY').length,
      uncategorizedOnlyPosts: issues.filter(
        (issue) => issue.type === 'UNCATEGORIZED_ONLY'
      ).length,
      categoryMismatches: issues.filter(
        (issue) => issue.type === 'CATEGORY_COUNT_MISMATCH'
      ).length,
      duplicateUrls: issues.filter((issue) => issue.type === 'DUPLICATE_URL').length,
      totalIssues: issues.length,
      postTypesAudited: typeSummaries.length
    },
    postTypes: typeSummaries,
    categories: enrichedCategories,
    posts: enrichedPosts,
    issues
  };
}

module.exports = { auditWordPressSite };
