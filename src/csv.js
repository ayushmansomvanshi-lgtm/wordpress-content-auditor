function escapeCsv(value) {
  const text = Array.isArray(value) ? value.join(' | ') : String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function rowsToCsv(headers, rows) {
  const lines = [headers.map(escapeCsv).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCsv(row[header])).join(','));
  }
  return lines.join('\n');
}

function createCsv(type, data) {
  if (type === 'posts') {
    const rows = (data.posts || []).map((post) => ({
      id: post.id,
      type: post.type,
      title: post.title,
      url: post.url,
      publishedAt: post.publishedAt,
      updatedAt: post.updatedAt,
      wasUpdated: post.wasUpdated,
      contentWords: post.contentWords,
      hasFeaturedImage: post.hasFeaturedImage,
      featuredMediaId: post.featuredMediaId,
      featuredImageUrl: post.featuredImageUrl,
      hasPublishedDate: post.hasPublishedDate,
      contentImageCount: post.contentImageCount,
      writingFindingCount: post.writingFindingCount,
      hasLoremIpsum: post.hasLoremIpsum,
      authorId: post.authorId,
      authorName: post.authorName,
      authorDiscoverySource: post.authorDiscoverySource,
      authorPageUrl: post.authorPageUrl,
      authorPageOk: post.authorPageOk,
      authorPageStatus: post.authorPageStatus,
      authorBioStatus: post.authorBioStatus,
      authorBioSource: post.authorBioSource,
      hasAuthorBio: post.hasAuthorBio,
      duplicateTitleGroup: post.duplicateTitleGroup || '',
      duplicateTitleOccurrences: post.duplicateTitleOccurrences || 1,
      duplicateContentGroup: post.duplicateContentGroup || '',
      duplicateContentOccurrences: post.duplicateContentOccurrences || 1,
      issueCount: post.issueCount,
      issueCodes: post.issueCodes,
      healthStatus: post.healthStatus
    }));
    return rowsToCsv(
      Object.keys(rows[0] || { id: '', title: '', healthStatus: '' }),
      rows
    );
  }

  if (type === 'issues') {
    const rows = data.issues || [];
    return rowsToCsv(
      Object.keys(rows[0] || { severity: '', type: '', details: '' }),
      rows
    );
  }

  if (type === 'authors') {
    const rows = (data.authors || []).map((author) => ({
      id: author.id,
      name: author.name,
      slug: author.slug,
      pageUrl: author.pageUrl,
      pageOk: author.pageOk,
      pageStatus: author.pageStatus,
      discoverySource: author.discoverySource,
      bio: author.bio,
      bioSource: author.bioSource,
      bioStatus: author.bioStatus,
      hasBio: author.bioStatus === 'present',
      websiteUrl: author.websiteUrl
    }));
    return rowsToCsv(
      Object.keys(rows[0] || { id: '', name: '', pageOk: '' }),
      rows
    );
  }

  if (type === 'duplicates') {
    const rows = [];
    const groups = [
      ...(data.duplicateGroups?.titles || []),
      ...(data.duplicateGroups?.content || [])
    ];

    for (const group of groups) {
      for (const location of group.locations || []) {
        rows.push({
          kind: group.kind,
          groupId: group.id,
          label: group.label,
          occurrences: group.occurrences,
          repeatCount: group.repeatCount,
          postId: location.id,
          postType: location.type,
          title: location.title,
          url: location.url,
          authorName: location.authorName,
          publishedAt: location.publishedAt,
          updatedAt: location.updatedAt
        });
      }
    }

    return rowsToCsv(
      Object.keys(rows[0] || { kind: '', groupId: '', url: '' }),
      rows
    );
  }

  if (type === 'fonts') {
    const rows = (data.siteAnalysis?.typography?.fonts || []).map((font) => ({
      family: font.family,
      primaryFamily: font.primaryFamily,
      textElementCount: font.textElementCount,
      pageCount: font.pageCount,
      sizes: font.sizes,
      weights: font.weights,
      tags: font.tags,
      samples: font.samples,
      pages: (font.pages || []).map((page) => `${page.label}: ${page.url}`)
    }));
    return rowsToCsv(
      Object.keys(rows[0] || { family: '', textElementCount: '', pages: '' }),
      rows
    );
  }


  if (type === 'images') {
    const rows = [];
    for (const post of data.posts || []) {
      rows.push({
        section: 'featured-image',
        postId: post.id,
        postTitle: post.title,
        postUrl: post.url,
        publishedAt: post.publishedAt,
        imageUrl: post.featuredImageUrl || '',
        linkUrl: post.featuredImageUrl || '',
        linked: Boolean(post.featuredImageUrl),
        loading: '',
        fileSize: '',
        finding: post.hasFeaturedImage ? (post.featuredImageUrl ? '' : 'Featured image URL missing') : 'Featured image missing'
      });
      for (const image of post.contentImages || []) {
        rows.push({
          section: 'post-content-image',
          postId: post.id,
          postTitle: post.title,
          postUrl: post.url,
          publishedAt: post.publishedAt,
          imageUrl: image.url,
          linkUrl: image.linkUrl,
          linked: image.linked,
          loading: image.loading,
          fileSize: '',
          finding: ''
        });
      }
    }
    for (const image of data.siteAnalysis?.imageDiagnostics?.items || []) {
      rows.push({
        section: 'rendered-image-check',
        postId: '',
        postTitle: image.pageLabel,
        postUrl: image.pageUrl,
        publishedAt: '',
        imageUrl: image.url,
        linkUrl: image.linkUrl || '',
        linked: ['home', 'category', 'about', 'privacy', 'contact', 'legal', 'unique-page'].includes(image.pageType) ? Boolean(image.linked) : '',
        loading: image.loading,
        fileSize: image.transferSize || image.decodedBodySize || '',
        finding: [
          ['home', 'category', 'about', 'privacy', 'contact', 'legal', 'unique-page'].includes(image.pageType) && image.linked === false ? 'Main-page image is not linked' : '',
          image.large ? 'Large or oversized' : '',
          image.missingDimensions ? 'Width or height missing' : '',
          image.aspectRatioMismatch ? 'Shape mismatch' : '',
          image.aboveFoldLazy ? 'Lazy loaded above the fold' : ''
        ].filter(Boolean).join(' | ')
      });
    }
    return rowsToCsv(Object.keys(rows[0] || { section: '', postTitle: '', imageUrl: '', finding: '' }), rows);
  }

  if (type === 'wordpress') {
    const rows = (data.wordpressDiagnostics?.checks || []).map((check) => ({
      check: check.label,
      result: check.value,
      status: check.status,
      note: check.note
    }));
    return rowsToCsv(Object.keys(rows[0] || { check: '', result: '', status: '', note: '' }), rows);
  }

  if (type === 'writing') {
    const rows = (data.writingAnalysis?.findings || []).map((finding) => ({
      postId: finding.postId,
      postTitle: finding.postTitle,
      postUrl: finding.url,
      scope: finding.scope,
      text: finding.text || '',
      code: finding.code,
      message: finding.message,
      suggestion: finding.suggestion
    }));
    return rowsToCsv(Object.keys(rows[0] || { postTitle: '', scope: '', message: '' }), rows);
  }

  if (type === 'performance') {
    const rows = [];
    for (const metric of data.performanceAudit?.metrics || []) {
      rows.push({
        section: 'metric',
        name: metric.label,
        status: metric.status,
        value: metric.displayValue,
        score: metric.score,
        page: data.performanceAudit?.finalUrl || data.metadata?.siteUrl || '',
        details: metric.description || ''
      });
    }

    const resources = data.performanceAudit?.resources || {};
    for (const resource of Object.values(resources)) {
      if (!resource) continue;
      if (!(resource.items || []).length) {
        rows.push({
          section: 'resource',
          name: resource.title || resource.id || '',
          status: resource.score === 1 ? 'pass' : 'observation',
          value: resource.displayValue || '',
          score: resource.score,
          page: data.performanceAudit?.finalUrl || '',
          details: ''
        });
      }
      for (const item of resource.items || []) {
        rows.push({
          section: 'resource',
          name: resource.title || resource.id || '',
          status: resource.score === 1 ? 'pass' : 'observation',
          value: item.wastedBytes || item.totalBytes || '',
          score: resource.score,
          page: item.url || '',
          details: item.displayValue || item.resourceType || ''
        });
      }
    }

    for (const image of data.siteAnalysis?.imageDiagnostics?.items || []) {
      rows.push({
        section: 'image',
        name: image.alt || 'Image',
        status: image.aboveFoldLazy || image.large ? 'review' : 'observation',
        value: image.transferSize || image.decodedBodySize || '',
        score: '',
        page: image.pageUrl || image.url || '',
        details: [
          image.large ? 'large/oversized' : '',
          image.missingDimensions ? 'missing dimensions' : '',
          image.aspectRatioMismatch ? 'aspect ratio mismatch' : '',
          image.aboveFoldLazy ? 'above-fold lazy loading' : ''
        ].filter(Boolean).join(' | ')
      });
    }

    for (const feature of data.siteAnalysis?.interactiveFeatures || []) {
      rows.push({
        section: 'interaction',
        name: feature.label,
        status: feature.status,
        value: feature.instances,
        score: `${feature.passed || 0}/${feature.tested || 0}`,
        page: (feature.pages || []).map((page) => page.url),
        details: (feature.pages || []).map((page) => `${page.label}: ${page.details}`)
      });
    }

    return rowsToCsv(
      Object.keys(rows[0] || { section: '', name: '', status: '', value: '', page: '', details: '' }),
      rows
    );
  }

  if (type === 'headings') {
    const rows = [];
    for (const page of data.siteAnalysis?.pages || []) {
      if (!(page.headings || []).length) {
        rows.push({
          pageType: page.type,
          pageLabel: page.label,
          pageUrl: page.finalUrl || page.url,
          pageStatus: page.status,
          headingOrder: '',
          headingLevel: '',
          headingText: '',
          headingId: '',
          fontFamily: '',
          fontSize: '',
          fontWeight: '',
          sourceH1Count: page.h1Inspection?.sourceH1Count || 0,
          domH1Count: page.h1Inspection?.domH1Count || 0,
          visibleH1Count: page.h1Inspection?.visibleH1Count || 0,
          sourceMode: page.h1Inspection?.sourceMode || '',
          pageIssues: (page.headingIssues || []).map((issue) => issue.code)
        });
        continue;
      }

      for (const heading of page.headings) {
        rows.push({
          pageType: page.type,
          pageLabel: page.label,
          pageUrl: page.finalUrl || page.url,
          pageStatus: page.status,
          headingOrder: heading.order,
          headingLevel: `H${heading.level}`,
          headingText: heading.text,
          headingId: heading.id,
          fontFamily: heading.fontFamily,
          fontSize: heading.fontSize,
          fontWeight: heading.fontWeight,
          sourceH1Count: page.h1Inspection?.sourceH1Count || 0,
          domH1Count: page.h1Inspection?.domH1Count || 0,
          visibleH1Count: page.h1Inspection?.visibleH1Count || 0,
          sourceMode: page.h1Inspection?.sourceMode || '',
          pageIssues: (page.headingIssues || []).map((issue) => issue.code)
        });
      }
    }

    return rowsToCsv(
      Object.keys(rows[0] || { pageType: '', headingLevel: '', headingText: '' }),
      rows
    );
  }

  throw new Error('Unsupported export type.');
}

module.exports = { createCsv };
