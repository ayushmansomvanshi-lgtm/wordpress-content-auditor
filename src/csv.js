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
      slug: post.slug,
      url: post.url,
      date: post.date,
      modified: post.modified,
      authorId: post.authorId,
      categoryIds: post.categoryIds,
      categoryNames: post.categoryNames,
      categoryCount: post.categoryCount
    }));
    return rowsToCsv(Object.keys(rows[0] || { id: '', title: '' }), rows);
  }

  if (type === 'categories') {
    const rows = (data.categories || []).map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      parentId: category.parentId,
      wordpressCount: category.wordpressCount,
      localCount: category.localCount,
      difference: category.difference,
      status: category.status,
      archiveUrl: category.archiveUrl
    }));
    return rowsToCsv(Object.keys(rows[0] || { id: '', name: '' }), rows);
  }

  if (type === 'issues') {
    const rows = data.issues || [];
    return rowsToCsv(
      Object.keys(rows[0] || { severity: '', type: '', details: '' }),
      rows
    );
  }

  throw new Error('Unsupported export type.');
}

module.exports = { createCsv };
