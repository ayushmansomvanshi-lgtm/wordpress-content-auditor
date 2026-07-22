const crypto = require('crypto');
const cheerio = require('cheerio');
const { normalizeSiteUrl, fetchWithTimeout } = require('./http');
const {
  detectApiRoot,
  fetchAllPages,
  fetchPostTypes
} = require('./wordpress');
const { scanRepresentativePages } = require('./browser-audit');
const { runLighthouseAudit } = require('./performance-audit');

function decodeEntities(value = '') {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code) => {
      const point = Number(code);
      return Number.isFinite(point) ? String.fromCodePoint(point) : ' ';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const point = Number.parseInt(code, 16);
      return Number.isFinite(point) ? String.fromCodePoint(point) : ' ';
    });
}

function stripHtml(value = '') {
  return decodeEntities(String(value))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTitle(value = '') {
  return stripHtml(value)
    .toLocaleLowerCase('en')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBody(value = '') {
  return stripHtml(value)
    .toLocaleLowerCase('en')
    .replace(/\s+/g, ' ')
    .trim();
}


const COMMON_TYPOS = new Map([
  ['teh', 'the'],
  ['recieve', 'receive'],
  ['seperate', 'separate'],
  ['definately', 'definitely'],
  ['occured', 'occurred'],
  ['untill', 'until'],
  ['wich', 'which'],
  ['alot', 'a lot'],
  ['grammer', 'grammar'],
  ['heirarchy', 'hierarchy'],
  ['improvment', 'improvement']
]);

function isValidDate(value) {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}

function extractPostContentData(html = '', baseUrl = '') {
  if (!html) return { images: [], headings: [] };
  const $ = cheerio.load(html);
  const images = [];

  $('img').each((index, element) => {
    if (images.length >= 100) return;
    const node = $(element);
    const rawUrl = node.attr('src') || node.attr('data-src') || node.attr('data-lazy-src') || '';
    const url = absoluteUrl(rawUrl, baseUrl);
    if (!url || /^data:/i.test(url)) return;
    const linkNode = node.closest('a[href]');
    const linkUrl = absoluteUrl(linkNode.attr('href') || '', baseUrl);
    images.push({
      index: index + 1,
      url,
      alt: stripHtml(node.attr('alt') || ''),
      linked: Boolean(linkUrl),
      linkUrl,
      width: Number(node.attr('width') || 0),
      height: Number(node.attr('height') || 0),
      loading: node.attr('loading') || ''
    });
  });

  const headings = $('h2,h3,h4,h5,h6')
    .toArray()
    .slice(0, 200)
    .map((element, index) => ({
      index: index + 1,
      level: Number(String(element.tagName || element.name || '').slice(1)),
      text: stripHtml($(element).text()),
      html: $.html(element).slice(0, 800)
    }));

  return { images, headings };
}

function checkWritingText(text = '', context = 'text') {
  const value = stripHtml(text);
  if (!value) return [];
  const findings = [];
  const lower = value.toLowerCase();
  const add = (code, message, suggestion = '') => {
    if (!findings.some((item) => item.code === code && item.message === message)) {
      findings.push({ code, message, suggestion });
    }
  };

  const repeated = value.match(/\b([\p{L}\p{N}']+)\s+\1\b/iu);
  if (repeated) add('REPEATED_WORD', `The word “${repeated[1]}” is repeated.`, `Remove one “${repeated[1]}”.`);

  const punctuation = value.match(/([!?.,])\1{1,}/);
  if (punctuation) add('REPEATED_PUNCTUATION', 'Punctuation is repeated.', 'Use one punctuation mark unless repetition is intentional.');

  const firstLetter = value.match(/[\p{L}]/u)?.[0] || '';
  if (firstLetter && firstLetter === firstLetter.toLowerCase() && firstLetter !== firstLetter.toUpperCase()) {
    add('LOWERCASE_START', `${context === 'title' ? 'The title' : 'This heading'} starts with a lowercase letter.`, 'Start it with a capital letter.');
  }

  if (value.length > 12 && value === value.toUpperCase() && /[A-Z]/.test(value)) {
    add('ALL_CAPS', `${context === 'title' ? 'The title' : 'This heading'} uses all capital letters.`, 'Use normal title or sentence case.');
  }

  if (context === 'title' && value.length < 8) add('SHORT_TITLE', 'The title is very short.', 'Add enough detail to explain what the post is about.');
  if (context === 'heading' && value.length > 110) add('LONG_HEADING', 'This subheading is very long.', 'Split it into a shorter heading and supporting text.');

  if (context === 'heading') {
    const bracketValue = value
      .replace(/(^|\s)\d{1,3}\)\s+/g, '$1')
      .replace(/(^|\s)[a-z]\)\s+/gi, '$1');
    const pairs = [['(', ')'], ['[', ']'], ['{', '}']];
    for (const [open, close] of pairs) {
      const openCount = [...bracketValue].filter((character) => character === open).length;
      const closeCount = [...bracketValue].filter((character) => character === close).length;
      if (openCount !== closeCount) {
        add('UNBALANCED_BRACKETS', 'Opening and closing brackets do not match.', `Check the ${open}${close} pair.`);
        break;
      }
    }
  }

  for (const [wrong, correct] of COMMON_TYPOS) {
    if (new RegExp(`\\b${wrong}\\b`, 'i').test(lower)) {
      add('COMMON_TYPO', `Possible spelling mistake: “${wrong}”.`, `Consider “${correct}”.`);
    }
  }

  return findings;
}


function checkSlug(slug = '') {
  const value = String(slug || '').trim();
  if (!value || value.length <= 75) return [];
  return [{
    code: 'LONG_SLUG',
    message: `The post slug is ${value.length} characters. Keep it under 75 characters.`,
    suggestion: 'Shorten the slug while keeping the main topic words.'
  }];
}

function containsLorem(value = '') {
  return /\blorem\s+ipsum\b/i.test(stripHtml(value));
}

function simpleIssueLabel(type = '') {
  const labels = {
    MISSING_FEATURED_IMAGE: 'Featured image missing',
    FEATURED_IMAGE_URL_MISSING: 'Featured image link missing',
    UNLINKED_MAIN_PAGE_IMAGE: 'Main-page image is not linked',
    REPRESENTATIVE_POST_TITLE_LINK_MISSING: 'Post title link missing',
    REPRESENTATIVE_POST_IMAGE_LINK_MISSING: 'Post image link missing',
    REPRESENTATIVE_POST_BUTTON_MISSING: 'Post button missing',
    REPRESENTATIVE_POST_BUTTON_LINK_MISSING: 'Post button link missing',
    MISSING_PUBLISH_DATE: 'Post date missing',
    AUTHOR_NOT_FOUND: 'Author not found',
    MISSING_AUTHOR_PAGE: 'Author page missing',
    BROKEN_AUTHOR_PAGE: 'Author page not working',
    MISSING_AUTHOR_BIO: 'Author bio missing',
    DUPLICATE_TITLE: 'Repeated post title',
    DUPLICATE_CONTENT: 'Repeated full post',
    MISSING_H1_TAG: 'H1 tag missing',
    H1_NOT_VISIBLE: 'H1 is hidden',
    MULTIPLE_H1_TAGS: 'More than one H1',
    SKIPPED_HEADING_LEVEL: 'Heading level skipped',
    EMPTY_HEADING: 'Empty heading',
    PAGE_INSPECTION_FAILED: 'Page check failed',
    PERFORMANCE_AUDIT_UNAVAILABLE: 'Performance test unavailable'
  };
  return labels[type] || String(type).replaceAll('_', ' ').toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
}

function simpleIssueMessage(type = '', fallback = '') {
  const messages = {
    MISSING_FEATURED_IMAGE: 'One or more posts do not have a featured image.',
    FEATURED_IMAGE_URL_MISSING: 'A featured image is assigned, but its image link could not be read.',
    UNLINKED_MAIN_PAGE_IMAGE: 'One or more images on a main site page are not wrapped in a link.',
    REPRESENTATIVE_POST_TITLE_LINK_MISSING: 'A post card title on a representative page is not linked to the post.',
    REPRESENTATIVE_POST_IMAGE_LINK_MISSING: 'A post card image on a representative page is not linked to the post.',
    REPRESENTATIVE_POST_BUTTON_MISSING: 'A post card on a representative page has no read-more button.',
    REPRESENTATIVE_POST_BUTTON_LINK_MISSING: 'A post card button on a representative page is not a working link.',
    MISSING_PUBLISH_DATE: 'One or more posts do not expose a valid publish date.',
    AUTHOR_NOT_FOUND: 'The post author could not be found.',
    MISSING_AUTHOR_PAGE: 'An author is shown, but no author page link was found.',
    BROKEN_AUTHOR_PAGE: 'An author page did not open successfully.',
    MISSING_AUTHOR_BIO: 'The author page works, but no biography was found in the author section.',
    DUPLICATE_TITLE: 'The same post title is used more than once.',
    DUPLICATE_CONTENT: 'The same full post content is used more than once.',
    MISSING_H1_TAG: 'No H1 tag was found in the page code or rendered page.',
    H1_NOT_VISIBLE: 'The H1 tag is in the code, but it is hidden on the page.',
    MULTIPLE_H1_TAGS: 'The page has more than one H1 tag.',
    SKIPPED_HEADING_LEVEL: 'The heading order skips a level.',
    EMPTY_HEADING: 'An empty heading tag was found.',
    PAGE_INSPECTION_FAILED: 'This page could not be checked in the browser.',
    PERFORMANCE_AUDIT_UNAVAILABLE: 'The Lighthouse performance test did not finish.'
  };
  if (messages[type]) return messages[type];
  if (String(type).startsWith('POOR_')) return 'This performance metric is in the poor range.';
  if (String(type).startsWith('INTERACTION_')) return 'This interface pattern needs a manual check.';
  return fallback || 'Open the locations to review this check.';
}

function groupIssues(issues = []) {
  const groups = new Map();
  const severityRank = { info: 0, warning: 1, error: 2 };
  for (const issue of issues) {
    const key = issue.type || 'OTHER';
    if (!groups.has(key)) {
      groups.set(key, {
        type: key,
        label: simpleIssueLabel(key),
        severity: issue.severity || 'warning',
        count: 0,
        message: simpleIssueMessage(key, issue.details || ''),
        locations: []
      });
    }
    const group = groups.get(key);
    group.count += 1;
    if ((severityRank[issue.severity] || 0) > (severityRank[group.severity] || 0)) group.severity = issue.severity;
    const locationKey = `${issue.url}|${issue.postId}|${issue.title}`;
    if (!group.locations.some((location) => location.key === locationKey)) {
      group.locations.push({
        key: locationKey,
        title: issue.title || 'Location',
        url: issue.url || '',
        postId: issue.postId || '',
        postType: issue.postType || '',
        details: issue.details || ''
      });
    }
  }
  return [...groups.values()]
    .map((group) => ({ ...group, locations: group.locations.slice(0, 250) }))
    .sort((a, b) => (severityRank[b.severity] - severityRank[a.severity]) || (b.count - a.count));
}

function buildWordPressDiagnostics({ siteAnalysis, posts, pages }) {
  const tech = siteAnalysis.technologyDiagnostics || {};
  const imageItems = siteAnalysis.imageDiagnostics?.items || [];
  const largeOver500 = imageItems.filter((image) => Number(image.transferSize || image.decodedBodySize || 0) > 500 * 1024);
  const loremPosts = posts.filter((post) => post.hasLoremIpsum);
  const loremPages = pages.filter((page) => page.hasLoremIpsum);
  const checks = [
    {
      key: 'cache-plugin',
      label: 'Caching plugin',
      value: tech.wpRocketDetected ? 'WP Rocket detected' : 'WP Rocket not detected publicly',
      status: tech.wpRocketDetected ? 'pass' : 'info',
      note: tech.wpRocketDetected ? 'WP Rocket markers were found in public page code or assets.' : 'A public scan cannot always identify a caching plugin.'
    },
    {
      key: 'image-optimisation',
      label: 'Image optimisation',
      value: tech.imagifyDetected ? 'Imagify or modern image delivery detected' : 'Imagify not detected publicly',
      status: tech.imagifyDetected ? 'pass' : 'info',
      note: 'This is based on public HTML and asset URLs.'
    },
    {
      key: 'cdn',
      label: 'CDN',
      value: tech.cloudflareDetected ? 'Cloudflare detected' : 'Cloudflare not detected',
      status: tech.cloudflareDetected ? 'pass' : 'info',
      note: tech.cloudflareDetected ? 'Cloudflare response headers were found.' : 'Another CDN may still be in use.'
    },
    {
      key: 'minification',
      label: 'CSS and JavaScript minification',
      value: `${tech.minificationRatio || 0}% of detected assets look minified`,
      status: (tech.minificationRatio || 0) >= 60 ? 'pass' : (tech.totalCss || tech.totalJs) ? 'review' : 'info',
      note: `${tech.minifiedCss || 0}/${tech.totalCss || 0} CSS and ${tech.minifiedJs || 0}/${tech.totalJs || 0} JavaScript files.`
    },
    {
      key: 'lazy-loading',
      label: 'Lazy loading',
      value: `${tech.lazyImageCount || 0} lazy-loaded images found`,
      status: (tech.lazyImageCount || 0) > 0 ? 'pass' : (tech.imageCount || 0) > 0 ? 'review' : 'info',
      note: 'Above-the-fold lazy loading is reported separately in the Images tab.'
    },
    {
      key: 'plugin-count',
      label: 'Plugin count',
      value: `${tech.publiclyVisiblePluginCount || 0} plugin folders visible publicly`,
      status: (tech.publiclyVisiblePluginCount || 0) <= 15 ? 'pass' : (tech.publiclyVisiblePluginCount || 0) <= 25 ? 'review' : 'warning',
      note: 'This is not the full active-plugin count. Hidden plugins cannot be seen without WordPress admin access.'
    },
    {
      key: 'large-images',
      label: 'Images over 500 KB',
      value: `${largeOver500.length} large images found`,
      status: largeOver500.length ? 'warning' : 'pass',
      note: largeOver500.length ? 'Open the Images tab to see the files and pages.' : 'No image over 500 KB was seen on the representative pages.'
    },
    {
      key: 'autoloaded-options',
      label: 'Autoloaded options',
      value: 'WordPress admin access required',
      status: 'unavailable',
      note: 'The public REST API does not expose database autoload size.'
    },
    {
      key: 'post-revisions',
      label: 'Post revisions',
      value: 'WordPress admin access required',
      status: 'unavailable',
      note: 'Published public data does not include revision counts.'
    },
    {
      key: 'lorem-posts',
      label: 'Lorem Ipsum in posts',
      value: loremPosts.length ? `${loremPosts.length} posts contain placeholder text` : 'No Lorem Ipsum found',
      status: loremPosts.length ? 'warning' : 'pass',
      note: loremPosts.slice(0, 5).map((post) => post.title).join(', ')
    },
    {
      key: 'lorem-pages',
      label: 'Lorem Ipsum in pages',
      value: loremPages.length ? `${loremPages.length} pages contain placeholder text` : 'No Lorem Ipsum found',
      status: loremPages.length ? 'warning' : 'pass',
      note: loremPages.slice(0, 5).map((page) => page.title).join(', ')
    },
    {
      key: 'lorem-widgets',
      label: 'Lorem Ipsum in widgets',
      value: 'WordPress admin access required',
      status: 'unavailable',
      note: 'Widget settings are not exposed in the public REST API.'
    }
  ];

  return {
    checks,
    pluginSlugs: tech.pluginSlugs || [],
    largeImagesOver500kb: largeOver500,
    loremPostCount: loremPosts.length,
    loremPageCount: loremPages.length
  };
}

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function minutesBetween(start, end) {
  const startMs = Date.parse(start || '');
  const endMs = Date.parse(end || '');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, Math.round((endMs - startMs) / 60000));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      try {
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      } catch (error) {
        results[currentIndex] = { error: error.message || String(error) };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length || 1) }, run)
  );

  return results;
}

function absoluteUrl(value, baseUrl) {
  if (!value) return '';
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return '';
  }
}

async function fetchHtml(url, timeout = 18000) {
  if (!url) {
    return { ok: false, status: 0, finalUrl: '', html: '', error: 'Missing URL' };
  }

  try {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      redirect: 'follow',
      timeout,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Cache-Control': 'no-cache'
      }
    });
    const html = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url || url,
      html,
      error: ''
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      html: '',
      error: error.message || String(error)
    };
  }
}

async function fetchPublicStatus(url) {
  const result = await fetchHtml(url, 15000);
  return {
    ok: result.ok,
    status: result.status,
    finalUrl: result.finalUrl,
    error: result.error
  };
}

function readJsonLdAuthors($, baseUrl) {
  const candidates = [];

  $('script[type="application/ld+json"]').each((_index, element) => {
    const raw = $(element).text().trim();
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const value = queue.shift();
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value)) {
          queue.push(...value);
          continue;
        }
        if (value['@graph']) queue.push(value['@graph']);

        const type = String(value['@type'] || '').toLowerCase();
        if (type.includes('article') && value.author) {
          queue.push(value.author);
        }
        if (type.includes('person') || (value.name && value.url && /author/i.test(String(value.url)))) {
          candidates.push({
            name: stripHtml(value.name || ''),
            pageUrl: absoluteUrl(value.url || value['@id'] || '', baseUrl),
            bio: stripHtml(value.description || ''),
            source: 'structured-data'
          });
        }
      }
    } catch {
      // Invalid JSON-LD must not stop the audit.
    }
  });

  return candidates.filter((item) => item.name || item.pageUrl);
}

function cleanAuthorName(value = '') {
  return stripHtml(value)
    .replace(/^\s*(written\s+by|posted\s+by|author\s*:|by)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAuthorFromPostHtml(html, postUrl) {
  if (!html) return null;
  const $ = cheerio.load(html);

  const linkSelectors = [
    '[itemprop="author"] a[href]',
    'a[rel~="author"][href]',
    '.elementor-post-info__item--type-author a[href]',
    '.elementor-post-info__item--type-author[href]',
    '.byline a[href]',
    '.post-author a[href]',
    '.author-name a[href]',
    '.entry-author a[href]',
    'a[href*="/author/"]'
  ];

  for (const selector of linkSelectors) {
    const matches = $(selector).toArray();
    for (const element of matches) {
      const node = $(element);
      const pageUrl = absoluteUrl(node.attr('href'), postUrl);
      const name = cleanAuthorName(node.text() || node.attr('title') || '');
      if (!pageUrl || !/\/author\//i.test(new URL(pageUrl).pathname)) continue;
      if (!name && !pageUrl) continue;
      return {
        name,
        pageUrl,
        slug: pageUrl.split('/author/')[1]?.split('/')[0] || '',
        source: 'single-post-byline'
      };
    }
  }

  const bylineTextSelectors = [
    '[itemprop="author"]',
    '.elementor-post-info__item--type-author',
    '.byline',
    '.post-author',
    '.author-name',
    '.entry-author'
  ];
  for (const selector of bylineTextSelectors) {
    const node = $(selector).first();
    const name = cleanAuthorName(node.text());
    if (name && name.length <= 120) {
      return { name, pageUrl: '', slug: '', source: 'single-post-byline-text' };
    }
  }

  const metaAuthor = cleanAuthorName($('meta[name="author"]').attr('content') || '');
  if (metaAuthor) {
    return { name: metaAuthor, pageUrl: '', slug: '', source: 'meta-author' };
  }

  const structured = readJsonLdAuthors($, postUrl)[0];
  return structured || null;
}

function extractAuthorBioFromPage(html, pageUrl, expectedName = '') {
  if (!html) {
    return { bio: '', bioSource: '', pageName: '', avatarUrl: '' };
  }

  const $ = cheerio.load(html);
  $('script:not([type="application/ld+json"]),style,noscript,template').remove();

  const pageName = cleanAuthorName(
    $('main h1, .site-main h1, body.author h1, h1').first().text() || expectedName
  );
  const avatarUrl = absoluteUrl(
    $('.author-avatar img, .author-box img, .elementor-widget-image img, body.author main img')
      .first()
      .attr('src') || '',
    pageUrl
  );

  const candidates = [];
  const addCandidate = (text, source, priority) => {
    const bio = stripHtml(text);
    if (bio.length < 55 || bio.length > 3000) return;
    if (/^(latest|recent|articles?|posts?)\s+(from|by)/i.test(bio)) return;
    if (/cookie|privacy preferences|subscribe|newsletter/i.test(bio) && bio.length < 180) return;
    candidates.push({ bio, bioSource: source, priority });
  };

  const specificSelectors = [
    '.elementor-author-box__bio',
    '.author-bio',
    '.author-biography',
    '.author-description',
    '.author-box__bio',
    '.author-box .description',
    '[class*="author-bio"]',
    '[class*="author-description"]',
    '[itemprop="description"]'
  ];
  specificSelectors.forEach((selector, index) => {
    $(selector).each((_i, element) => {
      addCandidate($(element).text(), `author-section:${selector}`, 100 - index);
    });
  });

  for (const item of readJsonLdAuthors($, pageUrl)) {
    if (!expectedName || !item.name || normalizeTitle(item.name) === normalizeTitle(expectedName)) {
      addCandidate(item.bio, 'author-page-structured-data', 85);
    }
  }

  const broadSelectors = [
    'body.author main p',
    'body[class*="author-"] main p',
    '.author-header p',
    '.author-hero p',
    '.site-main > .elementor p',
    'main .elementor-widget-text-editor p',
    'main p'
  ];
  broadSelectors.forEach((selector, index) => {
    $(selector).each((_i, element) => {
      const node = $(element);
      if (
        node.closest(
          'article, .post, .elementor-post, .e-loop-item, .loop-grid, .posts, .post-list, nav, header, footer, aside'
        ).length
      ) {
        return;
      }
      addCandidate(node.text(), `author-page-intro:${selector}`, 65 - index);
    });
  });

  candidates.sort((a, b) => b.priority - a.priority || b.bio.length - a.bio.length);
  const best = candidates[0] || { bio: '', bioSource: '' };

  return {
    bio: best.bio,
    bioSource: best.bioSource,
    pageName,
    avatarUrl
  };
}

async function fetchAuthors(apiRoot) {
  try {
    const result = await fetchAllPages(apiRoot, 'wp/v2/users', {
      orderby: 'id',
      order: 'asc',
      _fields: 'id,name,slug,description,link,url,avatar_urls'
    });

    return result.items.map((author) => ({
      id: author.id,
      name: stripHtml(author.name || ''),
      slug: author.slug || '',
      apiBio: stripHtml(author.description || ''),
      bio: '',
      bioSource: '',
      pageUrl: author.link || '',
      websiteUrl: author.url || '',
      avatarUrl:
        author.avatar_urls?.['96'] ||
        author.avatar_urls?.['48'] ||
        author.avatar_urls?.['24'] ||
        '',
      discoverySource: 'wordpress-users-api'
    }));
  } catch {
    return [];
  }
}

async function fetchCategories(apiRoot) {
  try {
    const result = await fetchAllPages(apiRoot, 'wp/v2/categories', {
      hide_empty: true,
      orderby: 'count',
      order: 'desc',
      _fields: 'id,name,slug,link,count'
    });
    return result.items.map((category) => ({
      id: category.id,
      name: stripHtml(category.name || ''),
      slug: category.slug || '',
      link: category.link || '',
      count: Number(category.count || 0)
    }));
  } catch {
    return [];
  }
}

async function fetchPages(apiRoot) {
  try {
    const result = await fetchAllPages(apiRoot, 'wp/v2/pages', {
      status: 'publish',
      orderby: 'id',
      order: 'asc',
      _fields: 'id,date,modified,slug,link,title,content,template,parent,status'
    });
    return result.items.map((page) => ({
      id: page.id,
      title: stripHtml(page.title?.rendered || ''),
      slug: page.slug || '',
      link: page.link || '',
      template: page.template || 'default',
      parent: page.parent || 0,
      publishedAt: page.date || '',
      updatedAt: page.modified || '',
      hasLoremIpsum: containsLorem(page.content?.rendered || '')
    }));
  } catch {
    return [];
  }
}

function createIssue({ severity, type, post, title, url, details }) {
  return {
    severity,
    type,
    postId: post?.id || '',
    postType: post?.type || '',
    title: title || post?.title || 'Website issue',
    url: url || post?.url || '',
    details
  };
}

function buildRawDuplicateGroups(posts, key, minimumLength = 1) {
  const buckets = new Map();

  for (const post of posts) {
    const value = post[key];
    if (!value || value.length < minimumLength) continue;
    if (!buckets.has(value)) buckets.set(value, []);
    buckets.get(value).push(post);
  }

  let groupNumber = 1;
  return [...buckets.values()]
    .filter((matchingPosts) => matchingPosts.length > 1)
    .map((matchingPosts) => ({
      id: groupNumber++,
      postIds: matchingPosts.map((post) => post.id),
      matchTitle: matchingPosts[0].title,
      preview: matchingPosts[0].contentPreview || ''
    }));
}

function groupIdForPost(groups, postId) {
  const group = groups.find((item) => item.postIds.includes(postId));
  return group ? group.id : null;
}

function buildRepresentativePages({ siteUrl, categories, pages, posts, authors }) {
  const descriptors = [];
  const usedUrls = new Set();

  const add = (type, label, url, sourceId = '') => {
    if (!url) return;
    let normalized;
    try {
      normalized = new URL(url, siteUrl).toString();
    } catch {
      return;
    }
    const key = normalized.replace(/\/$/, '');
    if (usedUrls.has(key)) return;
    usedUrls.add(key);
    descriptors.push({ type, label, url: normalized, sourceId });
  };

  add('home', 'Homepage', siteUrl);

  const category = categories.find((item) => item.link && item.count > 0);
  if (category) add('category', `Category · ${category.name}`, category.link, category.id);

  const findPage = (patterns) =>
    pages.find((page) => {
      const value = `${page.slug} ${page.title}`.toLowerCase();
      return patterns.some((pattern) => pattern.test(value));
    });

  const aboutPage = findPage([/\babout\b/, /our[-\s]story/, /who[-\s]we[-\s]are/]);
  const privacyPage = findPage([/privacy/, /data[-\s]policy/]);
  const contactPage = findPage([/\bcontact\b/, /get[-\s]in[-\s]touch/]);
  const termsPage = findPage([/\bterms\b/, /disclaimer/, /legal/]);

  if (aboutPage) add('about', `Page · ${aboutPage.title}`, aboutPage.link, aboutPage.id);
  if (privacyPage) add('privacy', `Page · ${privacyPage.title}`, privacyPage.link, privacyPage.id);
  if (contactPage) add('contact', `Page · ${contactPage.title}`, contactPage.link, contactPage.id);
  if (termsPage) add('legal', `Page · ${termsPage.title}`, termsPage.link, termsPage.id);

  const newestPost = [...posts]
    .filter((post) => post.url)
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))[0];
  if (newestPost) add('single-post', `Post · ${newestPost.title}`, newestPost.url, newestPost.id);

  const author = authors.find((item) => item.pageUrl);
  if (author) add('author', `Author · ${author.name || author.slug}`, author.pageUrl, author.id);

  const excludedIds = new Set(
    [aboutPage, privacyPage, contactPage, termsPage]
      .filter(Boolean)
      .map((page) => page.id)
  );
  const templateSeen = new Set();

  for (const page of pages) {
    if (descriptors.length >= 10) break;
    if (!page.link || excludedIds.has(page.id)) continue;
    const templateKey = page.template || 'default';
    if (templateSeen.has(templateKey)) continue;
    templateSeen.add(templateKey);
    add('unique-page', `Unique page · ${page.title}`, page.link, page.id);
  }

  return descriptors.slice(0, 10);
}

function enrichDuplicateGroups(rawGroups, posts, kind) {
  const postById = new Map(posts.map((post) => [post.id, post]));

  return rawGroups.map((group) => {
    const locations = group.postIds
      .map((postId) => postById.get(postId))
      .filter(Boolean)
      .map((post) => ({
        id: post.id,
        type: post.type,
        title: post.title,
        url: post.url,
        authorName: post.authorName,
        publishedAt: post.publishedAt,
        updatedAt: post.updatedAt
      }));

    return {
      id: group.id,
      kind,
      label: kind === 'title' ? group.matchTitle : 'Exact full-post body',
      preview: group.preview,
      occurrences: locations.length,
      repeatCount: Math.max(0, locations.length - 1),
      locations
    };
  });
}

async function discoverMissingAuthorsFromPosts(allPosts, authorById) {
  const representativeByAuthor = new Map();

  for (const post of allPosts) {
    const author = authorById.get(post.authorId);
    const needsDiscovery = !author || !author.name || !author.pageUrl;
    if (!needsDiscovery || !post.url) continue;
    const key = post.authorId || `post-${post.id}`;
    if (!representativeByAuthor.has(key)) representativeByAuthor.set(key, post);
  }

  const samples = [...representativeByAuthor.entries()].map(([key, post]) => ({ key, post }));
  const discoveries = await mapWithConcurrency(samples, 6, async ({ key, post }) => {
    const response = await fetchHtml(post.url);
    const found = response.ok ? extractAuthorFromPostHtml(response.html, response.finalUrl || post.url) : null;
    return { key, post, response, found };
  });

  for (const discovery of discoveries) {
    if (!discovery?.post || !discovery.found) continue;
    const post = discovery.post;
    const current = authorById.get(post.authorId) || {
      id: post.authorId || `post-${post.id}`,
      name: '',
      slug: '',
      apiBio: '',
      bio: '',
      bioSource: '',
      pageUrl: '',
      websiteUrl: '',
      avatarUrl: '',
      discoverySource: ''
    };

    authorById.set(current.id, {
      ...current,
      name: current.name || discovery.found.name,
      slug: current.slug || discovery.found.slug,
      pageUrl: current.pageUrl || discovery.found.pageUrl,
      discoverySource: current.discoverySource
        ? `${current.discoverySource}+${discovery.found.source}`
        : discovery.found.source,
      samplePostUrl: post.url
    });
  }
}

async function inspectAuthorPages(authors) {
  const inspections = await mapWithConcurrency(authors, 5, async (author) => {
    if (!author.pageUrl) {
      return {
        authorId: author.id,
        pageOk: false,
        pageStatus: 0,
        pageError: 'Missing author page URL',
        pageFinalUrl: '',
        bio: '',
        bioSource: '',
        bioStatus: 'unverified',
        pageName: '',
        pageAvatarUrl: ''
      };
    }

    const response = await fetchHtml(author.pageUrl);
    if (!response.ok) {
      return {
        authorId: author.id,
        pageOk: false,
        pageStatus: response.status,
        pageError: response.error || `HTTP ${response.status}`,
        pageFinalUrl: response.finalUrl,
        bio: '',
        bioSource: '',
        bioStatus: 'unverified',
        pageName: '',
        pageAvatarUrl: ''
      };
    }

    const inspected = extractAuthorBioFromPage(
      response.html,
      response.finalUrl || author.pageUrl,
      author.name
    );

    return {
      authorId: author.id,
      pageOk: true,
      pageStatus: response.status,
      pageError: '',
      pageFinalUrl: response.finalUrl,
      bio: inspected.bio,
      bioSource: inspected.bioSource,
      bioStatus: inspected.bio ? 'present' : 'missing',
      pageName: inspected.pageName,
      pageAvatarUrl: inspected.avatarUrl
    };
  });

  return new Map(inspections.filter(Boolean).map((item) => [item.authorId, item]));
}

async function auditWordPressSite(rawSiteUrl, options = {}) {
  const siteUrl = normalizeSiteUrl(rawSiteUrl);
  const startedAt = new Date().toISOString();
  const { apiRoot, index } = await detectApiRoot(siteUrl);

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

  const selectedTypes = postTypes.filter((type) => {
    const taxonomies = Array.isArray(type.taxonomies) ? type.taxonomies : [];
    return type.slug === 'post' || taxonomies.includes('category');
  });

  const allPosts = [];
  const embeddedAuthorById = new Map();
  const typeSummaries = [];
  const typeErrors = [];

  for (const type of selectedTypes) {
    try {
      const result = await fetchAllPages(apiRoot, `wp/v2/${type.rest_base}`, {
        status: 'publish',
        orderby: 'id',
        order: 'asc',
        _embed: '1',
        _fields:
          'id,date,date_gmt,modified,modified_gmt,slug,status,link,title,content,categories,author,type,featured_media,_embedded,_links'
      });

      typeSummaries.push({
        slug: type.slug,
        name: type.name,
        restBase: type.rest_base,
        total: result.total,
        pagesFetched: result.totalPages
      });

      for (const post of result.items) {
        const embeddedAuthor = post._embedded?.author?.[0];
        if (embeddedAuthor?.id && !embeddedAuthorById.has(embeddedAuthor.id)) {
          embeddedAuthorById.set(embeddedAuthor.id, {
            id: embeddedAuthor.id,
            name: stripHtml(embeddedAuthor.name || ''),
            slug: embeddedAuthor.slug || '',
            apiBio: stripHtml(embeddedAuthor.description || ''),
            bio: '',
            bioSource: '',
            pageUrl: embeddedAuthor.link || '',
            websiteUrl: embeddedAuthor.url || '',
            avatarUrl:
              embeddedAuthor.avatar_urls?.['96'] ||
              embeddedAuthor.avatar_urls?.['48'] ||
              embeddedAuthor.avatar_urls?.['24'] ||
              '',
            discoverySource: 'embedded-author'
          });
        }

        const title = stripHtml(post.title?.rendered || '');
        const normalizedBody = normalizeBody(post.content?.rendered || '');
        const contentData = extractPostContentData(post.content?.rendered || '', post.link || siteUrl);
        const featuredMedia = post._embedded?.['wp:featuredmedia']?.[0] || null;
        const featuredImageUrl = featuredMedia?.source_url || featuredMedia?.guid?.rendered || '';
        const featuredImageWidth = Number(featuredMedia?.media_details?.width || 0);
        const featuredImageHeight = Number(featuredMedia?.media_details?.height || 0);
        const titleWritingFindings = checkWritingText(title, 'title');
        const slugWritingFindings = checkSlug(post.slug || '');
        const headingWritingFindings = contentData.headings
          .filter((heading) => heading.level === 2)
          .flatMap((heading) =>
            checkWritingText(heading.text, 'heading').map((finding) => ({ ...finding, heading }))
          );

        allPosts.push({
          id: post.id,
          type: post.type || type.slug,
          title,
          normalizedTitle: normalizeTitle(title),
          contentFingerprint:
            normalizedBody.length >= 80 ? hashText(normalizedBody) : '',
          contentPreview: normalizedBody.slice(0, 260),
          contentWords: normalizedBody
            ? normalizedBody.split(/\s+/).filter(Boolean).length
            : 0,
          slug: post.slug || '',
          url: post.link || '',
          status: post.status || 'publish',
          publishedAt: post.date || post.date_gmt || '',
          updatedAt: post.modified || post.modified_gmt || '',
          authorId: post.author ?? '',
          categoryIds: Array.isArray(post.categories) ? post.categories : [],
          featuredMediaId: Number(post.featured_media || 0),
          hasFeaturedImage: Number(post.featured_media || 0) > 0,
          featuredImageUrl,
          featuredImageAlt: stripHtml(featuredMedia?.alt_text || ''),
          featuredImageWidth,
          featuredImageHeight,
          contentImages: contentData.images,
          contentHeadings: contentData.headings,
          titleWritingFindings,
          slugWritingFindings,
          headingWritingFindings,
          hasLoremIpsum: containsLorem(post.content?.rendered || '')
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

  const [apiAuthors, categories, pages] = await Promise.all([
    fetchAuthors(apiRoot),
    fetchCategories(apiRoot),
    fetchPages(apiRoot)
  ]);

  const authorById = new Map(embeddedAuthorById);
  for (const author of apiAuthors) {
    authorById.set(author.id, {
      ...(authorById.get(author.id) || {}),
      ...author
    });
  }

  await discoverMissingAuthorsFromPosts(allPosts, authorById);
  const authorsBeforeInspection = [...authorById.values()];
  const authorInspectionById = await inspectAuthorPages(authorsBeforeInspection);

  for (const author of authorsBeforeInspection) {
    const inspection = authorInspectionById.get(author.id);
    if (!inspection) continue;
    authorById.set(author.id, {
      ...author,
      bio: inspection.bio,
      bioSource: inspection.bioSource,
      bioStatus: inspection.bioStatus,
      pageOk: inspection.pageOk,
      pageStatus: inspection.pageStatus,
      pageError: inspection.pageError,
      pageFinalUrl: inspection.pageFinalUrl,
      pageName: inspection.pageName,
      avatarUrl: author.avatarUrl || inspection.pageAvatarUrl
    });
  }

  const authors = [...authorById.values()];
  const skipDuplicateChecks = Boolean(options.skipDuplicateChecks);
  const rawTitleGroups = skipDuplicateChecks
    ? []
    : buildRawDuplicateGroups(allPosts, 'normalizedTitle', 1);
  const rawContentGroups = skipDuplicateChecks
    ? []
    : buildRawDuplicateGroups(allPosts, 'contentFingerprint', 1);

  const issues = [];
  const posts = allPosts.map((post) => {
    const author = authorById.get(post.authorId) || null;
    const duplicateTitleGroup = groupIdForPost(rawTitleGroups, post.id);
    const duplicateContentGroup = groupIdForPost(rawContentGroups, post.id);
    const titleOccurrences = duplicateTitleGroup
      ? rawTitleGroups.find((group) => group.id === duplicateTitleGroup).postIds.length
      : 1;
    const contentOccurrences = duplicateContentGroup
      ? rawContentGroups.find((group) => group.id === duplicateContentGroup).postIds.length
      : 1;
    const updateDelayMinutes = minutesBetween(post.publishedAt, post.updatedAt);
    const wasUpdated = updateDelayMinutes > 1;
    const postIssueCodes = [];

    if (!isValidDate(post.publishedAt)) {
      postIssueCodes.push('MISSING_PUBLISH_DATE');
      issues.push(createIssue({
        severity: 'error',
        type: 'MISSING_PUBLISH_DATE',
        post,
        details: 'This published post does not expose a valid publish date.'
      }));
    }

    if (!post.hasFeaturedImage) {
      postIssueCodes.push('MISSING_FEATURED_IMAGE');
      issues.push(
        createIssue({
          severity: 'error',
          type: 'MISSING_FEATURED_IMAGE',
          post,
          details: 'This published post has no featured image assigned.'
        })
      );
    }

    if (post.hasFeaturedImage && !post.featuredImageUrl) {
      postIssueCodes.push('FEATURED_IMAGE_URL_MISSING');
      issues.push(createIssue({
        severity: 'warning',
        type: 'FEATURED_IMAGE_URL_MISSING',
        post,
        details: 'A featured image ID exists, but its public image URL was not returned.'
      }));
    }

    if (!author || (!author.name && !author.pageUrl)) {
      postIssueCodes.push('AUTHOR_NOT_FOUND');
      issues.push(
        createIssue({
          severity: 'error',
          type: 'AUTHOR_NOT_FOUND',
          post,
          details:
            'No author was found in the WordPress API, embedded data, structured data, or the single-post byline markup.'
        })
      );
    } else {
      if (!author.pageUrl) {
        postIssueCodes.push('MISSING_AUTHOR_PAGE');
        issues.push(
          createIssue({
            severity: 'error',
            type: 'MISSING_AUTHOR_PAGE',
            post,
            details: `${author.name || 'This author'} is shown in the post byline but no author archive URL was found.`
          })
        );
      } else if (!author.pageOk) {
        postIssueCodes.push('BROKEN_AUTHOR_PAGE');
        issues.push(
          createIssue({
            severity: 'error',
            type: 'BROKEN_AUTHOR_PAGE',
            post,
            details: `${author.name || 'Author'} page returned ${
              author.pageStatus || author.pageError || 'an error'
            }.`
          })
        );
      } else if (author.bioStatus === 'missing') {
        postIssueCodes.push('MISSING_AUTHOR_BIO');
        issues.push(
          createIssue({
            severity: 'warning',
            type: 'MISSING_AUTHOR_BIO',
            post,
            details: `${author.name || 'This author'} has a working author page, but no biography was found inside its author profile or introduction section.`
          })
        );
      }
    }

    if (duplicateTitleGroup) {
      postIssueCodes.push('DUPLICATE_TITLE');
      issues.push(
        createIssue({
          severity: 'error',
          type: 'DUPLICATE_TITLE',
          post,
          details: `This normalized title appears on ${titleOccurrences} posts (${titleOccurrences - 1} repeat${titleOccurrences - 1 === 1 ? '' : 's'}).`
        })
      );
    }

    if (duplicateContentGroup) {
      postIssueCodes.push('DUPLICATE_CONTENT');
      issues.push(
        createIssue({
          severity: 'error',
          type: 'DUPLICATE_CONTENT',
          post,
          details: `This exact normalized post body appears on ${contentOccurrences} posts (${contentOccurrences - 1} repeat${contentOccurrences - 1 === 1 ? '' : 's'}).`
        })
      );
    }

    return {
      id: post.id,
      type: post.type,
      title: post.title,
      slug: post.slug,
      url: post.url,
      status: post.status,
      publishedAt: post.publishedAt,
      updatedAt: post.updatedAt,
      wasUpdated,
      updateDelayMinutes,
      contentWords: post.contentWords,
      featuredMediaId: post.featuredMediaId,
      hasFeaturedImage: post.hasFeaturedImage,
      featuredImageUrl: post.featuredImageUrl,
      featuredImageAlt: post.featuredImageAlt,
      featuredImageWidth: post.featuredImageWidth,
      featuredImageHeight: post.featuredImageHeight,
      hasPublishedDate: isValidDate(post.publishedAt),
      contentImages: post.contentImages,
      contentImageCount: post.contentImages.length,
      linkedContentImageCount: post.contentImages.filter((image) => image.linked).length,
      unlinkedContentImageCount: post.contentImages.filter((image) => !image.linked).length,
      titleWritingFindings: post.titleWritingFindings,
      slugWritingFindings: post.slugWritingFindings,
      headingWritingFindings: post.headingWritingFindings,
      writingFindingCount: post.titleWritingFindings.length + post.slugWritingFindings.length + post.headingWritingFindings.length,
      hasLoremIpsum: post.hasLoremIpsum,
      authorId: post.authorId,
      authorName: author?.name || '',
      authorDiscoverySource: author?.discoverySource || '',
      authorPageUrl: author?.pageFinalUrl || author?.pageUrl || '',
      authorPageOk: Boolean(author?.pageOk),
      authorPageStatus: author?.pageStatus || 0,
      authorBio: author?.bio || '',
      authorBioSource: author?.bioSource || '',
      authorBioStatus: author?.bioStatus || 'unverified',
      hasAuthorBio: author?.bioStatus === 'present',
      duplicateTitleGroup,
      duplicateTitleOccurrences: titleOccurrences,
      duplicateContentGroup,
      duplicateContentOccurrences: contentOccurrences,
      issueCodes: postIssueCodes,
      issueCount: postIssueCodes.length,
      healthStatus: postIssueCodes.length === 0 ? 'Healthy' : 'Needs review'
    };
  });

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

  const representativePages = buildRepresentativePages({
    siteUrl,
    categories,
    pages,
    posts,
    authors
  });
  const siteAnalysis = await scanRepresentativePages(representativePages);

  let performanceAudit;
  try {
    performanceAudit = await runLighthouseAudit(siteUrl);
  } catch (error) {
    performanceAudit = {
      available: false,
      requestedUrl: siteUrl,
      finalUrl: siteUrl,
      fetchTime: new Date().toISOString(),
      lighthouseVersion: '',
      performanceScore: null,
      metrics: [],
      resources: {},
      diagnostics: {},
      error: error.message || String(error)
    };
  }

  for (const page of siteAnalysis.pages) {
    if (page.error) {
      issues.push(
        createIssue({
          severity: 'warning',
          type: 'PAGE_INSPECTION_FAILED',
          title: page.label,
          url: page.url,
          details: page.error
        })
      );
      continue;
    }

    for (const headingIssue of page.headingIssues) {
      issues.push(
        createIssue({
          severity: headingIssue.code === 'MISSING_H1_TAG' ? 'error' : 'warning',
          type: headingIssue.code,
          title: page.label,
          url: page.finalUrl || page.url,
          details: headingIssue.message
        })
      );
    }
  }

  if (!performanceAudit.available) {
    issues.push(
      createIssue({
        severity: 'warning',
        type: 'PERFORMANCE_AUDIT_UNAVAILABLE',
        title: 'Homepage performance audit',
        url: siteUrl,
        details: performanceAudit.error || 'Lighthouse could not finish the performance audit.'
      })
    );
  } else {
    for (const metric of performanceAudit.metrics || []) {
      if (metric.status !== 'poor') continue;
      issues.push(
        createIssue({
          severity: 'warning',
          type: `POOR_${String(metric.id).replace(/-/g, '_').toUpperCase()}`,
          title: metric.label,
          url: performanceAudit.finalUrl || siteUrl,
          details: `${metric.label} measured ${metric.displayValue}, which is in the poor range for the mobile Lighthouse run.`
        })
      );
    }
  }

  // Image findings are kept in the separate Images tab to avoid repeating them in the main issue list.

  // Representative post-card link findings are shown in the Images tab and grouped here for action tracking.
  for (const card of siteAnalysis.postCardDiagnostics?.items || []) {
    const missing = [];
    if (!card.titleLinked) missing.push(['REPRESENTATIVE_POST_TITLE_LINK_MISSING', 'Post title is not linked.']);
    if (card.hasImage && !card.imageLinked) missing.push(['REPRESENTATIVE_POST_IMAGE_LINK_MISSING', 'Post image is not linked.']);
    if (!card.hasButton) missing.push(['REPRESENTATIVE_POST_BUTTON_MISSING', 'Read-more button is missing.']);
    else if (!card.buttonLinked) missing.push(['REPRESENTATIVE_POST_BUTTON_LINK_MISSING', 'Read-more button is not linked.']);
    for (const [type, details] of missing) {
      issues.push(createIssue({ severity: 'warning', type, title: card.title || card.pageLabel, url: card.pageUrl, details }));
    }
  }

  for (const feature of siteAnalysis.interactiveFeatures || []) {
    if (feature.status !== 'review') continue;
    issues.push(
      createIssue({
        severity: 'warning',
        type: `INTERACTION_${feature.key.toUpperCase()}`,
        title: feature.label,
        url: feature.pages?.[0]?.url || siteUrl,
        details: `${feature.failed} tested representative page${feature.failed === 1 ? '' : 's'} did not expose the expected state change.`
      })
    );
  }

  const titleGroups = enrichDuplicateGroups(rawTitleGroups, posts, 'title');
  const contentGroups = enrichDuplicateGroups(rawContentGroups, posts, 'content');
  const duplicateTitlePosts = posts.filter((post) => post.duplicateTitleGroup).length;
  const duplicateContentPosts = posts.filter((post) => post.duplicateContentGroup).length;
  const writingFindings = posts.flatMap((post) => [
    ...post.titleWritingFindings.map((finding) => ({ ...finding, scope: 'Post title', postId: post.id, postTitle: post.title, url: post.url })),
    ...post.slugWritingFindings.map((finding) => ({ ...finding, scope: 'Post slug', postId: post.id, postTitle: post.title, url: post.url, text: post.slug })),
    ...post.headingWritingFindings.map((finding) => ({ ...finding, scope: 'H2 subheading', postId: post.id, postTitle: post.title, url: post.url, text: finding.heading?.text || '' }))
  ]).slice(0, 2000);
  const imageAudit = {
    postsChecked: posts.length,
    postsWithFeaturedImage: posts.filter((post) => post.hasFeaturedImage).length,
    postsWithFeaturedImageUrl: posts.filter((post) => post.featuredImageUrl).length,
    postsMissingFeaturedImage: posts.filter((post) => !post.hasFeaturedImage).length,
    postsMissingPublishDate: posts.filter((post) => !post.hasPublishedDate).length,
    contentImages: posts.reduce((total, post) => total + post.contentImageCount, 0),
    postImages: posts.flatMap((post) => (post.contentImages || []).map((image) => ({ ...image, postId: post.id, postTitle: post.title, postUrl: post.url }))).slice(0, 2000),
    mainPageImages: Number(siteAnalysis.imageDiagnostics?.mainPageImages || 0),
    linkedMainPageImages: Number(siteAnalysis.imageDiagnostics?.linkedMainPageImages || 0),
    unlinkedMainPageImages: Number(siteAnalysis.imageDiagnostics?.unlinkedMainPageImages || 0),
    rendered: siteAnalysis.imageDiagnostics || {},
    representativePostCards: siteAnalysis.postCardDiagnostics || { totalCards: 0, passedCards: 0, problemCards: 0, items: [] }
  };
  const wordpressDiagnostics = buildWordPressDiagnostics({ siteAnalysis, posts, pages });
  const issueGroups = groupIssues(issues);

  return {
    metadata: {
      productName: 'Radish',
      version: '4.4.0',
      siteUrl,
      siteName: index.name || '',
      siteDescription: index.description || '',
      apiRoot,
      startedAt,
      completedAt: new Date().toISOString(),
      usedStagingAuthentication: Boolean(options.usedStagingAuthentication),
      duplicateChecksSkipped: skipDuplicateChecks
    },
    summary: {
      uniquePublishedPosts: posts.length,
      healthyPosts: posts.filter((post) => post.issueCount === 0).length,
      postsNeedingReview: posts.filter((post) => post.issueCount > 0).length,
      postsMissingFeaturedImage: posts.filter((post) => !post.hasFeaturedImage).length,
      postsMissingAuthorBio: posts.filter((post) => post.authorBioStatus === 'missing').length,
      postsAuthorBioUnverified: posts.filter((post) => post.authorBioStatus === 'unverified').length,
      postsMissingOrBrokenAuthorPage: posts.filter((post) => !post.authorPageOk).length,
      authorsDiscoveredFromPostHtml: authors.filter((author) =>
        /single-post-byline/.test(author.discoverySource || '')
      ).length,
      duplicateTitlePosts,
      duplicateTitleGroups: titleGroups.length,
      duplicateTitleRepeats: titleGroups.reduce(
        (total, group) => total + group.repeatCount,
        0
      ),
      duplicateContentPosts,
      duplicateContentGroups: contentGroups.length,
      duplicateContentRepeats: contentGroups.reduce(
        (total, group) => total + group.repeatCount,
        0
      ),
      duplicateChecksSkipped: skipDuplicateChecks,
      postsUpdatedAfterPublishing: posts.filter((post) => post.wasUpdated).length,
      postsMissingPublishDate: posts.filter((post) => !post.hasPublishedDate).length,
      postsWithFeaturedImageUrl: posts.filter((post) => post.featuredImageUrl).length,
      postContentImages: posts.reduce((total, post) => total + post.contentImageCount, 0),
      unlinkedMainPageImages: Number(siteAnalysis.imageDiagnostics?.unlinkedMainPageImages || 0),
      writingFindings: writingFindings.length,
      totalIssues: issues.length,
      issueGroups: issueGroups.length,
      authorsChecked: authors.length,
      postTypesAudited: typeSummaries.length,
      representativePagesFound: representativePages.length,
      representativePagesScanned: siteAnalysis.typography.pagesScanned,
      headingIssues: siteAnalysis.headingIssueCount,
      textFontFamilies: siteAnalysis.typography.totalFamilies,
      performanceScore: performanceAudit.performanceScore,
      poorPerformanceMetrics: (performanceAudit.metrics || []).filter((metric) => metric.status === 'poor').length,
      imageAuditIssues: (siteAnalysis.imageDiagnostics?.items?.length || 0) + (siteAnalysis.postCardDiagnostics?.problemCards || 0),
      representativePostCardProblems: siteAnalysis.postCardDiagnostics?.problemCards || 0,
      interactionChecksNeedingReview: (siteAnalysis.interactiveFeatures || []).filter((feature) => feature.status === 'review').length
    },
    postTypes: typeSummaries,
    categories,
    pages,
    authors,
    duplicateGroups: {
      titles: titleGroups,
      content: contentGroups
    },
    performanceAudit,
    siteAnalysis,
    imageAudit,
    wordpressDiagnostics,
    writingAnalysis: {
      totalFindings: writingFindings.length,
      postsWithFindings: new Set(writingFindings.map((item) => item.postId)).size,
      findings: writingFindings
    },
    posts,
    issueGroups,
    issues
  };
}

module.exports = { auditWordPressSite };
