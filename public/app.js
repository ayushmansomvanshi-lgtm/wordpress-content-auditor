const form = document.querySelector('#auditForm');
const button = document.querySelector('#auditButton');
const statusBox = document.querySelector('#status');
const results = document.querySelector('#results');
const summaryCards = document.querySelector('#summaryCards');
const categoryRows = document.querySelector('#categoryRows');
const issueList = document.querySelector('#issueList');
const postRows = document.querySelector('#postRows');

let latestAudit = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setStatus(message, type = 'loading') {
  statusBox.className = `status ${type}`;
  statusBox.textContent = message;
}

function clearStatus() {
  statusBox.className = 'status hidden';
  statusBox.textContent = '';
}

function summaryCard(label, value) {
  return `
    <article class="card">
      <strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(label)}</span>
    </article>
  `;
}

function render(data) {
  latestAudit = data;
  const summary = data.summary;

  summaryCards.innerHTML = [
    summaryCard('Published posts', summary.uniquePublishedPosts),
    summaryCard('Categories', summary.categories),
    summaryCard('Category assignments', summary.totalCategoryAssignments),
    summaryCard('Uncategorized only', summary.uncategorizedOnlyPosts),
    summaryCard('Count mismatches', summary.categoryMismatches),
    summaryCard('Total issues', summary.totalIssues)
  ].join('');

  categoryRows.innerHTML = data.categories
    .map((category) => {
      const className = category.difference === 0 ? 'good' : 'bad';
      const archive = category.archiveUrl
        ? `<a href="${escapeHtml(category.archiveUrl)}" target="_blank" rel="noreferrer">${escapeHtml(category.name)}</a>`
        : escapeHtml(category.name);

      return `
        <tr>
          <td>${archive}</td>
          <td>${category.wordpressCount}</td>
          <td>${category.localCount}</td>
          <td>${category.difference}</td>
          <td><span class="pill ${className}">${escapeHtml(category.status)}</span></td>
        </tr>
      `;
    })
    .join('');

  issueList.innerHTML = data.issues.length
    ? data.issues
        .map(
          (issue) => `
            <article class="issue ${escapeHtml(issue.severity)}">
              <div>
                <span class="issue-type">${escapeHtml(issue.type)}</span>
                <h3>${escapeHtml(issue.title || 'Website issue')}</h3>
                <p>${escapeHtml(issue.details)}</p>
              </div>
              ${
                issue.url
                  ? `<a href="${escapeHtml(issue.url)}" target="_blank" rel="noreferrer">Open</a>`
                  : ''
              }
            </article>
          `
        )
        .join('')
    : '<p class="empty">No issues were detected by the basic audit.</p>';

  postRows.innerHTML = data.posts
    .map(
      (post) => `
        <tr>
          <td>${post.id}</td>
          <td><a href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">${escapeHtml(post.title || '(Untitled)')}</a></td>
          <td>${escapeHtml(post.type)}</td>
          <td>${escapeHtml(post.categoryNames.join(', ') || 'None')}</td>
          <td>${escapeHtml(post.modified || '')}</td>
        </tr>
      `
    )
    .join('');

  results.classList.remove('hidden');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  results.classList.add('hidden');
  button.disabled = true;
  button.textContent = 'Auditing...';
  setStatus('Connecting to the WordPress REST API and fetching all pages...');

  try {
    const response = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteUrl: document.querySelector('#siteUrl').value
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Audit failed.');
    }

    render(data);
    setStatus(
      `Audit complete: ${data.summary.uniquePublishedPosts} published posts found.`,
      'success'
    );
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Start audit';
  }
});

document.querySelectorAll('.export').forEach((exportButton) => {
  exportButton.addEventListener('click', async () => {
    if (!latestAudit) return;
    const type = exportButton.dataset.type;

    const response = await fetch(`/api/export/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: latestAudit })
    });

    if (!response.ok) {
      const result = await response.json();
      setStatus(result.error || 'Export failed.', 'error');
      return;
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `wordpress-${type}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });
});
