const form = document.querySelector('#auditForm');
const auditButton = document.querySelector('#auditButton');
const statusBox = document.querySelector('#auditStatus');
const statusTitle = document.querySelector('#statusTitle');
const statusText = document.querySelector('#statusText');
const statusProgressBar = document.querySelector('#statusProgressBar');
const results = document.querySelector('#results');
const summaryCards = document.querySelector('#summaryCards');
const postRows = document.querySelector('#postRows');
const postSearch = document.querySelector('#postSearch');
const postFilter = document.querySelector('#postFilter');
const issueFilter = document.querySelector('#issueFilter');
const issueList = document.querySelector('#issueList');
const previousPage = document.querySelector('#previousPage');
const nextPage = document.querySelector('#nextPage');
const pageLabel = document.querySelector('#pageLabel');
const postCount = document.querySelector('#postCount');
const fontSearch = document.querySelector('#fontSearch');
const headingPageFilter = document.querySelector('#headingPageFilter');
const headingSearch = document.querySelector('#headingSearch');
const headingLevelFilter = document.querySelector('#headingLevelFilter');
const performanceViewTabs = document.querySelector('#performanceViewTabs');
const imageViewTabs = document.querySelector('#imageViewTabs');
const imageSearch = document.querySelector('#imageSearch');
const imageFilter = document.querySelector('#imageFilter');
const writingSearch = document.querySelector('#writingSearch');
const stagingEnabled = document.querySelector('#stagingEnabled');
const stagingUsername = document.querySelector('#stagingUsername');
const stagingPassword = document.querySelector('#stagingPassword');
const credentialGrid = document.querySelector('#credentialGrid');
const skipDuplicateChecks = document.querySelector('#skipDuplicateChecks');
const previousWritingPage = document.querySelector('#previousWritingPage');
const nextWritingPage = document.querySelector('#nextWritingPage');
const writingPageLabel = document.querySelector('#writingPageLabel');
const writingCount = document.querySelector('#writingCount');
const previousIssuePage = document.querySelector('#previousIssuePage');
const nextIssuePage = document.querySelector('#nextIssuePage');
const issuePageLabel = document.querySelector('#issuePageLabel');
const issueCount = document.querySelector('#issueCount');

const PAGE_SIZE = 35;
const WRITING_PAGE_SIZE = 24;
const ISSUE_PAGE_SIZE = 10;
let latestAudit = null;
let filteredPosts = [];
let currentPage = 1;
let duplicateFilter = 'all';
let progressTimer = null;
let currentHeadingIndex = 0;
let activeHeadingLevel = 'all';
let headingExpanded = false;
let writingPage = 1;
let issuePage = 1;

const auditStages = [
  ['Connecting to WordPress', 'Detecting REST routes and public content types.'],
  ['Reading every post', 'Following all REST pagination and building the post inventory.'],
  ['Comparing content', 'Hashing normalized titles and full post bodies for exact matches.'],
  ['Checking authors', 'Reading single-post bylines, opening author pages and verifying profile biographies.'],
  ['Opening site pages', 'Chromium is inspecting representative page templates.'],
  ['Mapping typography', 'Collecting computed fonts from visible text elements only.'],
  ['Testing interfaces', 'Checking menus, tabs, accordions, sliders, popups, search and pagination.'],
  ['Running Lighthouse', 'Measuring mobile LCP, CLS, TTFB, FCP, Speed Index and TBT.'],
  ['Inspecting delivery', 'Reviewing images, cache headers, compression, CSS and JavaScript.'],
  ['Building heading trees', 'Reviewing H1–H6 order and skipped levels.'],
  ['Finishing report', 'Preparing filters, locations and CSV exports.']
];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value) {
  if (!value) return 'Not exposed';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(date);
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function plural(value, singular, pluralValue = `${singular}s`) {
  return `${value} ${value === 1 ? singular : pluralValue}`;
}

function badge(label, tone = 'neutral', title = '') {
  return `<span class="badge ${escapeHtml(tone)}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
}

function setStatus(title, text, type = 'loading') {
  statusBox.classList.remove('hidden', 'success', 'error');
  if (type !== 'loading') statusBox.classList.add(type);
  statusTitle.textContent = title;
  statusText.textContent = text;
}

function startProgress() {
  let stage = 0;
  clearInterval(progressTimer);
  setStatus(auditStages[0][0], auditStages[0][1]);
  statusProgressBar.style.width = '8%';

  progressTimer = setInterval(() => {
    stage = Math.min(stage + 1, auditStages.length - 1);
    setStatus(auditStages[stage][0], auditStages[stage][1]);
    statusProgressBar.style.width = `${Math.min(92, 8 + stage * 12)}%`;
    if (stage === auditStages.length - 1) clearInterval(progressTimer);
  }, 2600);
}

function finishProgress(success, message) {
  clearInterval(progressTimer);
  statusProgressBar.style.width = '100%';
  setStatus(success ? 'Audit complete' : 'Audit stopped', message, success ? 'success' : 'error');
}

function summaryCard(label, value, tone, help, icon) {
  return `
    <article class="summary-card ${escapeHtml(tone)} reveal-item">
      <div class="summary-top"><span class="summary-symbol">${escapeHtml(icon)}</span><span class="summary-label">${escapeHtml(label)}</span></div>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(help)}</small>
    </article>
  `;
}

function activateTab(name) {
  document.querySelectorAll('.rail-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === name);
  });
  document.querySelector('.workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function authorCell(post) {
  const name = escapeHtml(post.authorName || 'Not found');
  const source = post.authorDiscoverySource
    ? `<small class="cell-note author-source">Found via ${escapeHtml(post.authorDiscoverySource.replaceAll('-', ' '))}</small>`
    : '';
  if (!post.authorPageUrl) return `<strong>${name}</strong>${source}`;
  return `<a href="${escapeHtml(post.authorPageUrl)}" target="_blank" rel="noreferrer"><strong>${name}</strong></a>${source}`;
}

function authorPageBadge(post) {
  if (post.authorPageOk) return badge(`Working ${post.authorPageStatus}`, 'success');
  if (post.authorPageUrl && post.authorPageStatus) return badge(`HTTP ${post.authorPageStatus}`, 'danger');
  if (post.authorName) return badge('URL missing', 'danger');
  return badge('Author not found', 'danger');
}

function authorBioBadge(post) {
  if (post.authorBioStatus === 'present') {
    return badge('Present on author page', 'success', post.authorBioSource || 'Author profile section');
  }
  if (post.authorBioStatus === 'missing') {
    return badge('Missing on author page', 'warning');
  }
  return badge('Not verified', 'neutral', 'The author page was unavailable or the author was not found.');
}

function duplicateBadge(post) {
  if (latestAudit?.metadata?.duplicateChecksSkipped) {
    return badge('Skipped for staging', 'neutral');
  }
  const parts = [];
  if (post.duplicateTitleGroup) {
    parts.push(
      badge(
        `${post.duplicateTitleOccurrences} title copies`,
        'danger',
        `Duplicate title group ${post.duplicateTitleGroup}`
      )
    );
  }
  if (post.duplicateContentGroup) {
    parts.push(
      badge(
        `${post.duplicateContentOccurrences} full copies`,
        'danger',
        `Duplicate full-body group ${post.duplicateContentGroup}`
      )
    );
  }
  return parts.length ? parts.join(' ') : badge('Unique', 'success');
}

function renderPostRows() {
  const totalPages = Math.max(1, Math.ceil(filteredPosts.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pagePosts = filteredPosts.slice(start, start + PAGE_SIZE);

  postRows.innerHTML = pagePosts.length
    ? pagePosts.map((post) => {
        const featured = !post.hasFeaturedImage
          ? badge('Missing', 'danger')
          : post.featuredImageUrl
            ? `<a class="compact-link" href="${escapeHtml(post.featuredImageUrl)}" target="_blank" rel="noreferrer">Open image ↗</a>`
            : badge('Assigned, link missing', 'warning');
        const contentImages = post.contentImageCount
          ? `<strong>${post.contentImageCount}</strong><small class="cell-note">Found inside post content</small>`
          : badge('None', 'neutral');
        return `
          <tr class="${post.issueCount ? 'row-review' : ''}">
            <td class="post-cell"><a class="post-title" href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">${escapeHtml(post.title || '(Untitled)')}</a><span class="post-meta">ID ${post.id} · ${escapeHtml(post.type)} · ${post.contentWords} words</span></td>
            <td>${post.hasPublishedDate ? `<span class="date-value">${escapeHtml(formatDate(post.publishedAt))}</span>` : badge('Date missing', 'danger')}</td>
            <td><span class="date-value">${escapeHtml(formatDate(post.updatedAt))}</span><small class="cell-note">${post.wasUpdated ? 'Updated later' : 'Same as publish date'}</small></td>
            <td>${featured}</td>
            <td>${contentImages}</td>
            <td>${authorCell(post)}</td>
            <td>${authorPageBadge(post)}</td>
            <td>${authorBioBadge(post)}</td>
            <td class="duplicate-cell">${duplicateBadge(post)}</td>
            <td>${post.issueCount === 0 ? badge('Healthy', 'success') : badge(`${post.issueCount} check${post.issueCount === 1 ? '' : 's'}`, 'danger')}</td>
          </tr>`;
      }).join('')
    : '<tr><td colspan="10" class="empty-state">No posts match this search and filter.</td></tr>';

  pageLabel.textContent = `Page ${currentPage} of ${totalPages}`;
  postCount.textContent = filteredPosts.length ? `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, filteredPosts.length)} of ${filteredPosts.length}` : '0 posts';
  previousPage.disabled = currentPage <= 1;
  nextPage.disabled = currentPage >= totalPages;
}

function applyPostFilters() {
  if (!latestAudit) return;
  const query = postSearch.value.trim().toLowerCase();
  const filter = postFilter.value;

  filteredPosts = latestAudit.posts.filter((post) => {
    const haystack = `${post.id} ${post.title} ${post.authorName} ${post.type}`.toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (filter === 'healthy') return post.issueCount === 0;
    if (filter === 'review') return post.issueCount > 0;
    if (filter === 'featured') return !post.hasFeaturedImage;
    if (filter === 'author-page') return !post.authorPageOk;
    if (filter === 'author-bio') return post.authorBioStatus === 'missing';
    if (filter === 'duplicate-title') return Boolean(post.duplicateTitleGroup);
    if (filter === 'duplicate-content') return Boolean(post.duplicateContentGroup);
    if (filter === 'date') return !post.hasPublishedDate;
    if (filter === 'writing') return Number(post.writingFindingCount || 0) > 0;
    return true;
  });
  currentPage = 1;
  renderPostRows();
}

function renderDuplicateSnapshot() {
  const summary = latestAudit.summary;
  if (summary.duplicateChecksSkipped) {
    document.querySelector('#duplicateSnapshot').innerHTML = `
      <div><strong>Skipped</strong><span>duplicate checks</span><b>Staging access mode</b></div>
      <div><strong>0</strong><span>duplicate findings added</span><b>Run without staging credentials to compare posts</b></div>`;
    return;
  }
  document.querySelector('#duplicateSnapshot').innerHTML = `
    <div><strong>${summary.duplicateTitleGroups}</strong><span>repeated-title groups</span><b>${summary.duplicateTitleRepeats} extra copies</b></div>
    <div><strong>${summary.duplicateContentGroups}</strong><span>exact full-post groups</span><b>${summary.duplicateContentRepeats} extra copies</b></div>
  `;
}

function renderPageScanSnapshot() {
  const summary = latestAudit.summary;
  document.querySelector('#pageScanSnapshot').innerHTML = `
    <div><strong>${summary.representativePagesScanned}/${summary.representativePagesFound}</strong><span>representative pages scanned</span><b>${summary.headingIssues} heading issues</b></div>
    <div><strong>${summary.textFontFamilies}</strong><span>computed text font stacks</span><b>Icons and images excluded</b></div>
  `;
}

function renderPriorityIssues() {
  const priority = (latestAudit.issueGroups || []).slice(0, 6);
  document.querySelector('#priorityIssues').innerHTML = priority.length
    ? priority.map((group) => `
        <article class="priority-card ${escapeHtml(group.severity)}">
          <div>${badge(group.label, group.severity === 'error' ? 'danger' : 'warning')}</div>
          <h4>${group.count} location${group.count === 1 ? '' : 's'}</h4>
          <p>${escapeHtml(group.message || 'Open the issue group to see every location.')}</p>
          <button class="text-button" data-open-tab="issues">Open issue group →</button>
        </article>`).join('')
    : '<div class="empty-state">No issues detected.</div>';
}

function getDuplicateGroups() {
  const titleGroups = latestAudit?.duplicateGroups?.titles || [];
  const contentGroups = latestAudit?.duplicateGroups?.content || [];
  if (duplicateFilter === 'title') return titleGroups;
  if (duplicateFilter === 'content') return contentGroups;
  return [...contentGroups, ...titleGroups].sort(
    (a, b) => b.occurrences - a.occurrences || a.kind.localeCompare(b.kind)
  );
}

function renderDuplicates() {
  if (latestAudit?.metadata?.duplicateChecksSkipped) {
    document.querySelector('#duplicateSummary').innerHTML = `<article><span>Duplicate checks</span><strong>Skipped</strong><small>Staging access mode</small></article>`;
    document.querySelector('#duplicateGroups').innerHTML = '<div class="large-empty"><span>↷</span><h4>Duplicate checks were skipped</h4><p>Radish ignored title and full-post duplicate checks for this password-protected staging audit.</p></div>';
    return;
  }
  const titleGroups = latestAudit.duplicateGroups?.titles || [];
  const contentGroups = latestAudit.duplicateGroups?.content || [];
  document.querySelector('#duplicateSummary').innerHTML = `
    <article><span>Title groups</span><strong>${titleGroups.length}</strong><small>${latestAudit.summary.duplicateTitleRepeats} additional repeats</small></article>
    <article><span>Full-post groups</span><strong>${contentGroups.length}</strong><small>${latestAudit.summary.duplicateContentRepeats} additional repeats</small></article>
    <article><span>Affected posts</span><strong>${latestAudit.summary.duplicateTitlePosts + latestAudit.summary.duplicateContentPosts}</strong><small>Counts can overlap</small></article>
  `;

  const groups = getDuplicateGroups();
  document.querySelector('#duplicateGroups').innerHTML = groups.length
    ? groups
        .map(
          (group, index) => `
          <details class="duplicate-group" ${index < 2 ? 'open' : ''}>
            <summary>
              <span class="duplicate-kind ${group.kind}">${group.kind === 'content' ? 'Full post' : 'Title'}</span>
              <div class="duplicate-title-block">
                <strong>${escapeHtml(group.label)}</strong>
                ${group.preview && group.kind === 'content' ? `<small>${escapeHtml(group.preview)}${group.preview.length >= 260 ? '…' : ''}</small>` : ''}
              </div>
              <div class="repeat-metric"><strong>${group.occurrences}×</strong><span>${plural(group.repeatCount, 'repeat')}</span></div>
              <span class="chevron" aria-hidden="true">⌄</span>
            </summary>
            <div class="duplicate-locations">
              ${(group.locations || [])
                .map(
                  (location, locationIndex) => `
                    <article class="location-row">
                      <span class="location-index">${String(locationIndex + 1).padStart(2, '0')}</span>
                      <div>
                        <a href="${escapeHtml(location.url)}" target="_blank" rel="noreferrer">${escapeHtml(location.title)}</a>
                        <small>ID ${location.id} · ${escapeHtml(location.type)} · ${escapeHtml(location.authorName || 'Unknown author')}</small>
                      </div>
                      <div class="location-dates">
                        <span>Published ${escapeHtml(formatDate(location.publishedAt))}</span>
                        <span>Updated ${escapeHtml(formatDate(location.updatedAt))}</span>
                      </div>
                      <a class="open-circle" href="${escapeHtml(location.url)}" target="_blank" rel="noreferrer" aria-label="Open ${escapeHtml(location.title)}">↗</a>
                    </article>
                  `
                )
                .join('')}
            </div>
          </details>
        `
        )
        .join('')
    : '<div class="large-empty"><span>✓</span><h4>No exact duplicates found</h4><p>No repeated normalized titles or complete post bodies were detected.</p></div>';
}

function renderFonts() {
  const query = fontSearch.value.trim().toLowerCase();
  const fonts = (latestAudit.siteAnalysis?.typography?.fonts || []).filter((font) =>
    `${font.family} ${font.primaryFamily}`.toLowerCase().includes(query)
  );
  const typography = latestAudit.siteAnalysis?.typography || {};

  document.querySelector('#fontSummary').innerHTML = `
    <article><span>Font stacks</span><strong>${typography.totalFamilies || 0}</strong><small>Visible text only</small></article>
    <article><span>Pages checked</span><strong>${typography.pagesScanned || 0}</strong><small>Representative pages</small></article>
    <article><span>Text elements</span><strong>${typography.textElementCount || 0}</strong><small>Icons and images excluded</small></article>`;

  document.querySelector('#fontGrid').innerHTML = fonts.length
    ? `<div class="font-list">${fonts.map((font, index) => `
        <article class="font-row reveal-item">
          <div class="font-preview" style="font-family:${escapeHtml(font.family)}">Aa</div>
          <div class="font-main">
            <div class="font-title-line"><span>${String(index + 1).padStart(2, '0')}</span><h4>${escapeHtml(font.primaryFamily || font.family)}</h4>${badge(`${font.textElementCount} uses`, 'neutral')}</div>
            <p class="font-stack">${escapeHtml(font.family)}</p>
            <p class="font-example" style="font-family:${escapeHtml(font.family)}">${escapeHtml(font.samples?.[0] || 'The quick brown fox jumps over the lazy dog.')}</p>
          </div>
          <div class="font-facts">
            <span><b>${font.pageCount || 0}</b> pages</span>
            <span><b>${escapeHtml((font.sizes || []).slice(0, 4).join(', ') || '—')}</b> sizes</span>
            <span><b>${escapeHtml((font.weights || []).slice(0, 5).join(', ') || '—')}</b> weights</span>
          </div>
          <details class="font-details"><summary>Pages and elements</summary><div class="page-chips">${(font.pages || []).slice(0, 12).map((page) => `<a href="${escapeHtml(page.url)}" target="_blank" rel="noreferrer">${escapeHtml(page.label)} · ${page.count}</a>`).join('')}</div><p>${escapeHtml((font.tags || []).slice(0, 14).join(', ') || 'No element list')}</p></details>
        </article>`).join('')}</div>`
    : '<div class="large-empty"><span>Aa</span><h4>No text fonts available</h4><p>The browser scan may have failed, or no visible text was found.</p></div>';
}

function headingIssueTone(code) {
  if (code === 'MISSING_H1_TAG') return 'danger';
  if (code === 'MULTIPLE_H1_TAGS') return 'danger';
  return 'warning';
}

function headingLevelSummary(headings) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  headings.forEach((heading) => {
    if (counts[heading.level] !== undefined) counts[heading.level] += 1;
  });
  return counts;
}

function renderHeadingPage(pageIndex) {
  const pages = latestAudit.siteAnalysis?.pages || [];
  const page = pages[pageIndex];
  const container = document.querySelector('#headingDetails');
  currentHeadingIndex = pageIndex;

  if (!page) {
    container.innerHTML = '<div class="large-empty"><span>H</span><h4>No heading data</h4></div>';
    return;
  }

  const h1 = page.h1Inspection || {};
  const sourceH1Count = Number(h1.sourceH1Count || 0);
  const domH1Count = Number(h1.domH1Count || 0);
  const visibleH1Count = Number(h1.visibleH1Count || 0);
  const hiddenH1Count = Number(h1.hiddenH1Count || 0);
  const codeH1Count = Math.max(sourceH1Count, domH1Count);
  const h1PresentInCode = codeH1Count > 0;
  const sourceChecked = h1.sourceChecked !== false;

  const allOutlineHeadings = [
    ...((page.sourceOnlyH1s || []).map((heading) => ({ ...heading, sourceOnly: true }))),
    ...(page.headings || [])
  ];
  const query = headingSearch?.value.trim().toLowerCase() || '';
  const filtered = allOutlineHeadings.filter((heading) => {
    if (activeHeadingLevel !== 'all' && String(heading.level) !== activeHeadingLevel) return false;
    const haystack = `${heading.text || ''} ${(heading.classes || []).join(' ')} ${heading.id || ''}`.toLowerCase();
    return !query || haystack.includes(query);
  });
  const visibleRows = headingExpanded ? filtered : filtered.slice(0, 32);
  const levelCounts = headingLevelSummary(page.headings || []);

  const sourceTags = (h1.sourceH1Tags || []).slice(0, 3);
  const sourceSamples = (h1.sourceH1Samples || []).slice(0, 3);
  const domSamples = (h1.domH1Samples || []).slice(0, 3);

  let verdictTitle = 'H1 tag is missing from code';
  let verdictCopy = 'No <h1> element was found in the downloaded HTML source or in the rendered browser DOM.';
  let verdictClass = 'missing';
  let verdictBadge = badge('Missing', 'danger');

  if (h1PresentInCode) {
    verdictTitle = 'H1 tag is present in code';
    verdictClass = 'present';
    verdictBadge = badge(`${codeH1Count} tag${codeH1Count === 1 ? '' : 's'} found`, 'success');
    if (sourceH1Count && domH1Count) {
      verdictCopy = `Found in both downloaded HTML and rendered DOM. ${visibleH1Count} ${visibleH1Count === 1 ? 'is' : 'are'} visible in the layout.`;
    } else if (sourceH1Count && !domH1Count) {
      verdictCopy = 'Found in downloaded HTML source, but the final rendered DOM does not contain it. This is not a missing-source H1.';
    } else {
      verdictCopy = `Found in the rendered DOM. ${visibleH1Count ? 'At least one H1 is visible.' : 'The H1 is hidden from layout, but it is present in code.'}`;
    }
  } else if (!sourceChecked) {
    verdictTitle = 'H1 source check could not finish';
    verdictCopy = 'The HTML source could not be downloaded and no H1 was found in the rendered DOM.';
    verdictClass = 'unknown';
    verdictBadge = badge('Not verified', 'warning');
  }

  const sourceStatus = !sourceChecked
    ? badge('Source unavailable', 'warning')
    : sourceH1Count
      ? badge(`${sourceH1Count} found`, 'success')
      : badge('0 found', 'danger');
  const domStatus = domH1Count
    ? badge(`${domH1Count} found`, 'success')
    : badge('0 found', sourceH1Count ? 'warning' : 'danger');
  const visibilityStatus = visibleH1Count
    ? badge(`${visibleH1Count} visible`, 'success')
    : domH1Count
      ? badge(`${hiddenH1Count || domH1Count} hidden`, 'warning')
      : badge('No DOM H1', 'neutral');

  container.innerHTML = `
    <article class="heading-page panel no-margin">
      <header class="heading-page-header compact-heading-header">
        <div>
          <div class="heading-label-row">
            <span class="page-type-badge">${escapeHtml(page.type)}</span>
            ${page.ok ? badge(`HTTP ${page.status}`, 'success') : badge(page.status ? `HTTP ${page.status}` : 'Scan failed', 'danger')}
            ${h1PresentInCode ? badge('H1 in code', 'success') : badge('No H1 tag', 'danger')}
          </div>
          <h4>${escapeHtml(page.label)}</h4>
          <a href="${escapeHtml(page.finalUrl || page.url)}" target="_blank" rel="noreferrer">${escapeHtml(page.finalUrl || page.url)} ↗</a>
        </div>
        <div class="heading-stats compact-stats">
          <div><strong>${page.headings?.length || 0}</strong><span>rendered</span></div>
          <div><strong>${h1.sourceHeadingCount || 0}</strong><span>source</span></div>
          <div><strong>${page.headingIssues?.length || 0}</strong><span>issues</span></div>
        </div>
      </header>

      ${page.error ? `<div class="scan-error">${escapeHtml(page.error)}</div>` : ''}

      <section class="h1-verdict ${verdictClass}">
        <div class="h1-verdict-icon">${h1PresentInCode ? '&lt;H1&gt;' : 'H1?'}</div>
        <div class="h1-verdict-copy">
          <span class="panel-kicker">Definitive code result</span>
          <h5>${escapeHtml(verdictTitle)}</h5>
          <p>${escapeHtml(verdictCopy)}</p>
        </div>
        ${verdictBadge}
      </section>

      ${(page.headingIssues || []).length
        ? `<div class="heading-alerts compact-alerts">${page.headingIssues.map((issue) => `<div>${badge(issue.code.replaceAll('_', ' '), headingIssueTone(issue.code))}<span>${escapeHtml(issue.message)}</span></div>`).join('')}</div>`
        : '<div class="heading-clean">✓ H1 code presence and heading order passed the current checks.</div>'}

      <section class="outline-card">
        <div class="outline-header">
          <div>
            <span class="panel-kicker">Rendered document outline</span>
            <h5>H1–H6 structure</h5>
          </div>
          <div class="level-counts">
            ${[1, 2, 3, 4, 5, 6].map((level) => `<span class="level-count level-${level}"><b>H${level}</b>${levelCounts[level]}</span>`).join('')}
          </div>
        </div>

        <div class="heading-outline-list">
          ${visibleRows.length
            ? visibleRows.map((heading) => `
              <article class="outline-row level-${heading.level} ${heading.visible === false ? 'is-hidden-heading' : ''} ${heading.sourceOnly ? 'source-only-heading' : ''}" style="--heading-indent:${Math.max(0, heading.level - 1) * 18}px">
                <div class="outline-branch"><span></span></div>
                <span class="heading-level">H${heading.level}</span>
                <div class="heading-copy">
                  <div class="heading-copy-title">
                    <strong>${escapeHtml(heading.text || '(Empty heading)')}</strong>
                    ${heading.sourceOnly
                      ? badge('Source only', 'warning')
                      : heading.visible
                        ? badge('Visible', 'success')
                        : badge('Hidden', 'warning')}
                  </div>
                  <small>${heading.sourceOnly
                    ? escapeHtml(heading.openingTag || 'HTML source tag')
                    : `${escapeHtml(heading.fontFamily || 'Font unavailable')} · ${escapeHtml(heading.fontSize || '—')} · weight ${escapeHtml(heading.fontWeight || '—')}`}</small>
                  ${heading.visible === false && !heading.sourceOnly ? `<em>Reason: ${escapeHtml(heading.visibilityReason || 'No visible layout box')}</em>` : ''}
                </div>
                <span class="heading-order">#${heading.order}</span>
              </article>
            `).join('')
            : '<div class="empty-state">No headings match the current search and level filter.</div>'}
        </div>

        ${filtered.length > 32
          ? `<button id="toggleHeadingOutline" class="outline-toggle">${headingExpanded ? 'Show first 32 headings' : `Show all ${filtered.length} headings`} <span>${headingExpanded ? '↑' : '↓'}</span></button>`
          : ''}
      </section>
    </article>
  `;

  const toggle = document.querySelector('#toggleHeadingOutline');
  if (toggle) {
    toggle.addEventListener('click', () => {
      headingExpanded = !headingExpanded;
      renderHeadingPage(currentHeadingIndex);
    });
  }
}

function renderHeadings() {
  const pages = latestAudit.siteAnalysis?.pages || [];
  currentHeadingIndex = 0;
  headingExpanded = false;
  activeHeadingLevel = 'all';
  if (headingSearch) headingSearch.value = '';
  headingLevelFilter?.querySelectorAll('[data-heading-level]').forEach((button) => {
    button.classList.toggle('active', button.dataset.headingLevel === 'all');
  });

  headingPageFilter.innerHTML = pages
    .map((page, index) => `<option value="${index}">${escapeHtml(page.label)}</option>`)
    .join('');

  document.querySelector('#headingPageTabs').innerHTML = pages.length
    ? pages.map((page, index) => {
        const h1 = page.h1Inspection || {};
        const hasH1 = Number(h1.sourceH1Count || 0) > 0 || Number(h1.domH1Count || 0) > 0;
        return `<button class="heading-page-button ${index === 0 ? 'active' : ''}" data-heading-index="${index}">
          <span class="page-list-index">${String(index + 1).padStart(2, '0')}</span>
          <span class="page-list-copy"><small>${escapeHtml(page.type)}</small><strong>${escapeHtml(page.label.replace(/^.*?·\s*/, ''))}</strong></span>
          <span class="page-list-status ${hasH1 ? 'ok' : 'bad'}">${hasH1 ? 'H1' : '!'}</span>
          <b>${page.headingIssues?.length || 0}</b>
        </button>`;
      }).join('')
    : '<div class="large-empty"><span>H</span><h4>No pages were available for heading inspection</h4></div>';

  renderHeadingPage(0);
}

function renderIssues() {
  if (!latestAudit) return;
  const selectedType = issueFilter.value;
  const groups = (latestAudit.issueGroups || []).filter(
    (group) => selectedType === 'all' || group.type === selectedType
  );
  const totalPages = Math.max(1, Math.ceil(groups.length / ISSUE_PAGE_SIZE));
  if (issuePage > totalPages) issuePage = totalPages;
  const startIndex = (issuePage - 1) * ISSUE_PAGE_SIZE;
  const pageGroups = groups.slice(startIndex, startIndex + ISSUE_PAGE_SIZE);

  issueList.innerHTML = pageGroups.length
    ? pageGroups.map((group) => `
        <article class="issue-group-card ${escapeHtml(group.severity)}">
          <div class="issue-group-head">
            <div>${badge(group.label, group.severity === 'error' ? 'danger' : 'warning')}<h4>${escapeHtml(group.count)} location${group.count === 1 ? '' : 's'}</h4><p>${escapeHtml(group.message || 'Open the locations below to review this check.')}</p></div>
            <span class="issue-count-bubble">${group.count}</span>
          </div>
          <details><summary>Show locations</summary><div class="issue-location-list">${(group.locations || []).map((location) => `
            <div class="issue-location"><div><strong>${escapeHtml(location.title || 'Location')}</strong>${location.postId ? `<small>Post ${escapeHtml(location.postId)} · ${escapeHtml(location.postType || '')}</small>` : ''}${location.details ? `<small>${escapeHtml(location.details)}</small>` : ''}</div>${location.url ? `<a href="${escapeHtml(location.url)}" target="_blank" rel="noreferrer">Open ↗</a>` : ''}</div>`).join('')}</div></details>
        </article>`).join('')
    : '<div class="large-empty"><span>✓</span><h4>No issue groups in this filter</h4></div>';

  issuePageLabel.textContent = `Page ${issuePage} of ${totalPages}`;
  issueCount.textContent = groups.length
    ? `Showing ${startIndex + 1}–${Math.min(startIndex + ISSUE_PAGE_SIZE, groups.length)} of ${groups.length} issue groups`
    : '0 issue groups';
  previousIssuePage.disabled = issuePage <= 1;
  nextIssuePage.disabled = issuePage >= totalPages;
}

function formatBytes(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(number) / Math.log(1024)), units.length - 1);
  const amount = number / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function performanceTone(status) {
  if (status === 'good' || status === 'pass') return 'success';
  if (status === 'needs-improvement' || status === 'review') return 'warning';
  if (status === 'poor') return 'danger';
  return 'neutral';
}

function statusLabel(status) {
  if (status === 'needs-improvement') return 'Needs improvement';
  if (status === 'not-detected') return 'Not detected';
  if (status === 'unavailable') return 'Unavailable';
  return String(status || 'Unknown').replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function resourceOpportunityCard(resource, icon) {
  const items = resource?.items || [];
  const affected = items.length;
  const savings = resource?.savingsBytes
    ? formatBytes(resource.savingsBytes)
    : resource?.displayValue || 'No material savings found';
  const tone = resource?.score === 1 || affected === 0 ? 'success' : 'warning';

  return `
    <article class="panel resource-opportunity-card ${tone}">
      <header>
        <div class="resource-icon">${escapeHtml(icon)}</div>
        <div><span class="panel-kicker">Lighthouse opportunity</span><h4>${escapeHtml(resource?.title || 'Resource audit')}</h4></div>
        ${badge(affected ? `${affected} asset${affected === 1 ? '' : 's'}` : 'Passed', tone)}
      </header>
      <div class="opportunity-saving"><strong>${escapeHtml(savings)}</strong><span>${resource?.savingsBytes ? 'estimated transfer savings' : 'audit result'}</span></div>
      <p>${escapeHtml((resource?.description || '').replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1').slice(0, 360))}</p>
      ${items.length ? `
        <div class="resource-list">
          ${items.slice(0, 20).map((item) => `
            <div class="resource-row">
              <div><strong title="${escapeHtml(item.url)}">${escapeHtml((item.url || item.label || 'Inline resource').replace(/^https?:\/\//, '').slice(0, 92))}</strong><small>${escapeHtml(item.resourceType || '')}</small></div>
              <span>${formatBytes(item.wastedBytes || item.totalBytes)}</span>
            </div>
          `).join('')}
        </div>` : '<div class="audit-pass-message">No significant opportunity was reported.</div>'}
    </article>
  `;
}

function renderPerformance() {
  const audit = latestAudit?.performanceAudit || {};
  const analysis = latestAudit?.siteAnalysis || {};
  const images = analysis.imageDiagnostics || {};
  const network = analysis.networkDiagnostics || {};
  const runMeta = document.querySelector('#performanceRunMeta');

  if (!audit.available) {
    runMeta.innerHTML = badge('Lighthouse unavailable', 'warning');
    document.querySelector('#performanceScoreCard').innerHTML = `<div class="performance-unavailable"><span>!</span><h4>Performance test did not finish</h4><p>${escapeHtml(audit.error || 'Install Lighthouse and Chromium, then run the audit again.')}</p></div>`;
    document.querySelector('#performanceMetrics').innerHTML = '';
    document.querySelector('#performanceDiagnostics').innerHTML = '';
  } else {
    runMeta.innerHTML = `${badge(`Lighthouse ${audit.lighthouseVersion || ''}`, 'neutral')}<small>${escapeHtml(formatDateTime(audit.fetchTime))}</small>`;
    const score = Number(audit.performanceScore || 0);
    const scoreTone = score >= 90 ? 'good' : score >= 50 ? 'needs-improvement' : 'poor';
    document.querySelector('#performanceScoreCard').innerHTML = `
      <div class="simple-score ${scoreTone}"><span>Mobile score</span><strong>${score}<small>/100</small></strong><b>${statusLabel(scoreTone)}</b></div>
      <a class="score-url" href="${escapeHtml(audit.finalUrl || audit.requestedUrl || '#')}" target="_blank" rel="noreferrer">${escapeHtml(audit.finalUrl || audit.requestedUrl || '')}</a>`;
    document.querySelector('#performanceMetrics').innerHTML = (audit.metrics || []).map((metric) => `
      <article class="vital-card ${escapeHtml(metric.status)}">
        <div class="vital-head"><span>${escapeHtml(metric.label)}</span>${badge(statusLabel(metric.status), performanceTone(metric.status))}</div>
        <strong>${escapeHtml(metric.displayValue || '—')}</strong>
        <div class="vital-meter"><i style="--metric-score:${Number(metric.score ?? 0)}"></i></div>
        <small>Score ${metric.score ?? '—'}/100</small>
      </article>`).join('');
    const diagnostics = audit.diagnostics || {};
    document.querySelector('#performanceDiagnostics').innerHTML = [
      ['Page weight', diagnostics.totalByteWeightLabel || formatBytes(diagnostics.totalByteWeight)], ['Requests', diagnostics.numRequests || 0], ['Scripts', diagnostics.numScripts || 0], ['Stylesheets', diagnostics.numStylesheets || 0], ['Fonts', diagnostics.numFonts || 0], ['Long tasks', diagnostics.numTasksOver50ms || 0]
    ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  }

  const resourceRoot = audit.resources || {};
  document.querySelector('#resourceAuditGrid').innerHTML = [resourceOpportunityCard(resourceRoot.unusedCss, 'CSS'), resourceOpportunityCard(resourceRoot.unusedJavaScript, 'JS')].join('');

  const combined = latestAudit.imageAudit || {};
  const rendered = combined.rendered || images;
  const imageLighthouseChecks = [resourceRoot.responsiveImages, resourceRoot.optimizedImages, resourceRoot.modernImages, resourceRoot.unsizedImages].filter(Boolean);
  document.querySelector('#imageAuditSummary').innerHTML = `
    <article><span>Posts checked</span><strong>${combined.postsChecked || 0}</strong><small>${combined.postsWithFeaturedImage || 0} have featured images</small></article>
    <article class="${combined.postsMissingFeaturedImage ? 'warning' : 'success'}"><span>Featured image missing</span><strong>${combined.postsMissingFeaturedImage || 0}</strong><small>${combined.postsWithFeaturedImageUrl || 0} featured-image links available</small></article>
    <article><span>Main-page images</span><strong>${combined.mainPageImages || 0}</strong><small>Homepage, categories and regular pages</small></article>
    <article class="${combined.unlinkedMainPageImages ? 'warning' : 'success'}"><span>Main-page images not linked</span><strong>${combined.unlinkedMainPageImages || 0}</strong><small>Single-post content is excluded</small></article>
    <article class="${rendered.aboveFoldLazy ? 'danger' : 'success'}"><span>Loading problems</span><strong>${(rendered.items || []).length}</strong><small>${rendered.aboveFoldLazy || 0} above the fold and lazy</small></article>
    <article><span>Post card link problems</span><strong>${combined.representativePostCards?.problemCards || 0}</strong><small>Title, image and button links</small></article>`;

  document.querySelector('#imageAuditRows').innerHTML = (rendered.items || []).length
    ? rendered.items.slice(0, 200).map((image) => {
        const findings = [];
        const mainPage = ['home', 'category', 'about', 'privacy', 'contact', 'legal', 'unique-page'].includes(image.pageType);
        if (mainPage && image.linked === false) findings.push(badge('Not linked on main page', 'warning'));
        if (image.large) findings.push(badge('Large', 'warning'));
        if (image.missingDimensions) findings.push(badge('Width/height missing', 'warning'));
        if (image.aspectRatioMismatch) findings.push(badge('Shape mismatch', 'warning'));
        if (image.aboveFoldLazy) findings.push(badge('Lazy above fold', 'danger'));
        const linkCell = mainPage
          ? image.linked
            ? `<a class="compact-link" href="${escapeHtml(image.linkUrl)}" target="_blank" rel="noreferrer">Open link ↗</a>`
            : badge('Not linked', 'warning')
          : badge('Not checked', 'neutral', 'Single-post and author pages are excluded from link checks.');
        return `<tr><td class="image-resource-cell"><a href="${escapeHtml(image.url)}" target="_blank" rel="noreferrer">${escapeHtml(image.alt || image.url?.split('/').pop() || 'Image')}</a><small>${escapeHtml(image.url || '')}</small></td><td><a href="${escapeHtml(image.pageUrl)}" target="_blank" rel="noreferrer">${escapeHtml(image.pageLabel || 'Page')}</a></td><td>${linkCell}</td><td>${image.renderedWidth || 0} × ${image.renderedHeight || 0}</td><td>${image.naturalWidth || 0} × ${image.naturalHeight || 0}</td><td>${formatBytes(image.transferSize || image.decodedBodySize)}</td><td>${badge(image.loading || 'auto', image.aboveFoldLazy ? 'danger' : 'neutral')}</td><td class="finding-stack">${findings.join('') || badge('No problem', 'success')}</td></tr>`;
      }).join('')
    : '<tr><td colspan="8" class="empty-state">No main-page link, image loading or size problems were found.</td></tr>';

  const cacheAudit = resourceRoot.cacheLifetime || {};
  const compressionAudit = resourceRoot.textCompression || {};
  const postCards = combined.representativePostCards || {};
  const postCardRows = document.querySelector('#postCardLinkRows');
  if (postCardRows) {
    postCardRows.innerHTML = (postCards.items || []).length
      ? postCards.items.map((card) => `<tr>
          <td><strong>${escapeHtml(card.title || '(Untitled post card)')}</strong>${card.targetUrl ? `<a class="compact-link" href="${escapeHtml(card.targetUrl)}" target="_blank" rel="noreferrer">Open post ↗</a>` : ''}</td>
          <td><a class="compact-link" href="${escapeHtml(card.pageUrl)}" target="_blank" rel="noreferrer">${escapeHtml(card.pageLabel || card.pageUrl)} ↗</a></td>
          <td>${card.titleLinked ? badge('Linked', 'success') : badge('Missing link', 'danger')}</td>
          <td>${!card.hasImage ? badge('No image', 'warning') : card.imageLinked ? badge('Linked', 'success') : badge('Missing link', 'danger')}</td>
          <td>${!card.hasButton ? badge('Missing button', 'warning') : card.buttonLinked ? badge('Linked', 'success') : badge('Missing link', 'danger')}</td>
        </tr>`).join('')
      : '<tr><td colspan="5"><div class="audit-pass-message">All detected post cards have linked titles, images and buttons.</div></td></tr>';
  }

  document.querySelector('#deliverySummary').innerHTML = `<article><span>Resources seen</span><strong>${network.resourcesObserved || 0}</strong><small>Representative pages</small></article><article class="${network.cacheIssues ? 'warning' : 'success'}"><span>Cache problems</span><strong>${network.cacheIssues || 0}</strong><small>${escapeHtml(cacheAudit.displayValue || 'Header check')}</small></article><article class="${network.uncompressedTextResources ? 'warning' : 'success'}"><span>Text not compressed</span><strong>${network.uncompressedTextResources || 0}</strong><small>${network.compressedTextResources || 0} compressed</small></article><article><span>Possible savings</span><strong>${formatBytes((cacheAudit.savingsBytes || 0) + (compressionAudit.savingsBytes || 0))}</strong><small>Cache and compression</small></article>`;
  const deliveryItems = [...(network.issues || []), ...(cacheAudit.items || []).map((item) => ({ ...item, issue: 'Cache lifetime is short' })), ...(compressionAudit.items || []).map((item) => ({ ...item, issue: 'Text compression can be improved' }))];
  document.querySelector('#deliveryIssueList').innerHTML = deliveryItems.length ? deliveryItems.slice(0, 120).map((item) => `<article class="delivery-resource-card"><div class="delivery-resource-status">${/compress/i.test(item.issue || '') ? 'ZIP' : 'TTL'}</div><div><strong>${escapeHtml(item.issue || 'Delivery check')}</strong><a href="${escapeHtml(item.url || item.pageUrl || '#')}" target="_blank" rel="noreferrer">${escapeHtml((item.url || item.pageUrl || 'Resource').replace(/^https?:\/\//, '').slice(0, 120))}</a><small>${escapeHtml(item.cacheControl || item.contentEncoding || item.resourceType || '')}</small></div><span>${formatBytes(item.wastedBytes || item.contentLength || item.totalBytes)}</span></article>`).join('') : '<div class="large-empty compact-empty"><span>✓</span><h4>No major cache or compression problems</h4></div>';
}


function renderPostImages() {
  if (!latestAudit) return;
  const query = (imageSearch?.value || '').trim().toLowerCase();
  const filter = imageFilter?.value || 'all';
  const posts = (latestAudit.posts || []).filter((post) => {
    const haystack = `${post.id} ${post.title} ${post.featuredImageUrl}`.toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (filter === 'featured-missing') return !post.hasFeaturedImage;
    if (filter === 'featured-link-missing') return post.hasFeaturedImage && !post.featuredImageUrl;
    if (filter === 'date-missing') return !post.hasPublishedDate;
    return true;
  });
  const body = document.querySelector('#postImageRows');
  body.innerHTML = posts.length ? posts.slice(0, 600).map((post) => {
    return `<tr><td class="post-cell"><a class="post-title" href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">${escapeHtml(post.title || '(Untitled)')}</a><span class="post-meta">ID ${post.id}</span></td><td>${post.hasPublishedDate ? formatDate(post.publishedAt) : badge('Missing', 'danger')}</td><td>${post.featuredImageUrl ? `<a class="compact-link" href="${escapeHtml(post.featuredImageUrl)}" target="_blank" rel="noreferrer">Open featured image ↗</a>` : post.hasFeaturedImage ? badge('Link missing', 'warning') : badge('Missing', 'danger')}</td><td><strong>${post.contentImageCount || 0}</strong><small class="cell-note">Informational only; single-post image links are not graded</small></td></tr>`;
  }).join('') : '<tr><td colspan="4" class="empty-state">No posts match this image filter.</td></tr>';
}

function renderWordPressChecks() {
  const diagnostics = latestAudit?.wordpressDiagnostics || {};
  const checks = diagnostics.checks || [];
  const statusCopy = { pass: 'Pass', review: 'Review', warning: 'Review', info: 'Info', unavailable: 'Admin access needed' };
  document.querySelector('#wordpressCheckGrid').innerHTML = checks.length ? checks.map((check) => `
    <article class="wp-check-card ${escapeHtml(check.status)}"><div class="wp-check-icon">${check.status === 'pass' ? '✓' : check.status === 'unavailable' ? '—' : check.status === 'info' ? 'i' : '!'}</div><div><span>${escapeHtml(check.label)}</span><h4>${escapeHtml(check.value)}</h4><p>${escapeHtml(check.note || '')}</p></div>${badge(statusCopy[check.status] || statusLabel(check.status), check.status === 'pass' ? 'success' : check.status === 'unavailable' || check.status === 'info' ? 'neutral' : 'warning')}</article>`).join('') : '<div class="large-empty"><span>WP</span><h4>No WordPress setup data</h4></div>';
  const plugins = diagnostics.pluginSlugs || [];
  document.querySelector('#pluginChipList').innerHTML = plugins.length ? plugins.map((plugin) => `<span>${escapeHtml(plugin)}</span>`).join('') : '<p class="muted">No plugin folder names were visible in the assets loaded on the pages checked.</p>';
}

function renderUiChecks() {
  const features = latestAudit?.siteAnalysis?.interactiveFeatures || [];
  const iconMap = { menus: '☰', tabs: 'T', accordions: '↕', carousels: '⇆', popups: '□', search: '⌕', cookies: 'C', pagination: '…', dropdowns: '⌄' };
  document.querySelector('#interactionAuditGrid').innerHTML = features.length ? features.map((feature) => {
    const tone = performanceTone(feature.status);
    let summary = 'Not found on the pages checked.';
    if (feature.status === 'pass') summary = `${feature.instances || 0} found on ${feature.pagesDetected || 0} page${feature.pagesDetected === 1 ? '' : 's'}. ${feature.passed || 0} safe test${feature.passed === 1 ? '' : 's'} passed.`;
    if (feature.status === 'review') summary = `${feature.instances || 0} found. ${feature.failed || 0} page${feature.failed === 1 ? '' : 's'} need a manual check.`;
    const uniquePages = [];
    for (const page of feature.pages || []) if (!uniquePages.some((item) => item.url === page.url)) uniquePages.push(page);
    return `<article class="interaction-card ${escapeHtml(feature.status)}"><header><span class="interaction-icon">${escapeHtml(iconMap[feature.key] || 'UI')}</span><div><h4>${escapeHtml(feature.label)}</h4><p>${escapeHtml(summary)}</p></div>${badge(statusLabel(feature.status), tone)}</header>${uniquePages.length ? `<details><summary>Show ${uniquePages.length} page${uniquePages.length === 1 ? '' : 's'}</summary><div class="simple-page-list">${uniquePages.map((page) => `<a href="${escapeHtml(page.url)}" target="_blank" rel="noreferrer"><span>${escapeHtml(page.label)}</span><b>Open ↗</b></a>`).join('')}</div></details>` : ''}</article>`;
  }).join('') : '<div class="large-empty"><span>UI</span><h4>No UI check data</h4></div>';
}

function getFilteredWritingFindings() {
  const analysis = latestAudit?.writingAnalysis || {};
  const query = (writingSearch?.value || '').trim().toLowerCase();
  return (analysis.findings || []).filter((finding) =>
    `${finding.postTitle} ${finding.scope} ${finding.text || ''} ${finding.message}`.toLowerCase().includes(query)
  );
}

function renderWriting() {
  const analysis = latestAudit?.writingAnalysis || {};
  const findings = getFilteredWritingFindings();
  const totalPages = Math.max(1, Math.ceil(findings.length / WRITING_PAGE_SIZE));
  if (writingPage > totalPages) writingPage = totalPages;
  const startIndex = (writingPage - 1) * WRITING_PAGE_SIZE;
  const pageFindings = findings.slice(startIndex, startIndex + WRITING_PAGE_SIZE);

  document.querySelector('#writingSummary').innerHTML = `<article><span>Suggestions</span><strong>${analysis.totalFindings || 0}</strong><small>Post slugs, titles and H2 subheadings</small></article><article><span>Posts affected</span><strong>${analysis.postsWithFindings || 0}</strong><small>Quick local writing checks</small></article><article><span>Ordered lists</span><strong>Ignored</strong><small>Prefixes such as 1), 2) and a) are not bracket errors</small></article>`;
  document.querySelector('#writingList').innerHTML = pageFindings.length ? pageFindings.map((finding) => `<article class="writing-card"><div class="writing-scope">${escapeHtml(finding.scope || 'Text')}</div><div><a href="${escapeHtml(finding.url)}" target="_blank" rel="noreferrer"><h4>${escapeHtml(finding.postTitle || 'Post')}</h4></a>${finding.text ? `<blockquote>${escapeHtml(finding.text)}</blockquote>` : ''}<p>${escapeHtml(finding.message)}</p>${finding.suggestion ? `<small>Suggestion: ${escapeHtml(finding.suggestion)}</small>` : ''}</div></article>`).join('') : '<div class="large-empty"><span>✓</span><h4>No writing suggestions in this filter</h4></div>';
  writingPageLabel.textContent = `Page ${writingPage} of ${totalPages}`;
  writingCount.textContent = findings.length ? `Showing ${startIndex + 1}–${Math.min(startIndex + WRITING_PAGE_SIZE, findings.length)} of ${findings.length} suggestions` : '0 suggestions';
  previousWritingPage.disabled = writingPage <= 1;
  nextWritingPage.disabled = writingPage >= totalPages;
}

function populateIssueFilter(groups) {
  issueFilter.innerHTML = ['<option value="all">All issue groups</option>', ...(groups || []).map((group) => `<option value="${escapeHtml(group.type)}">${escapeHtml(group.label)} (${group.count})</option>`)].join('');
}

function render(data) {
  latestAudit = data;
  const summary = data.summary;
  const healthPercent = summary.uniquePublishedPosts
    ? Math.round((summary.healthyPosts / summary.uniquePublishedPosts) * 100)
    : 100;

  document.querySelector('#siteHeading').textContent = data.metadata.siteName || data.metadata.siteUrl;
  document.querySelector('#auditMeta').textContent = `${data.metadata.siteUrl} · Completed ${formatDateTime(data.metadata.completedAt)}${data.metadata.usedStagingAuthentication ? ' · Staging credentials used' : ' · Read-only public access'}`;
  document.querySelector('#railScore').innerHTML = `<strong>${healthPercent}%</strong><span>post health</span>`;
  document.querySelector('#postHealthScore').innerHTML = `<strong>${healthPercent}%</strong><span>healthy posts</span>`;
  document.querySelector('#duplicateTabCount').textContent = summary.duplicateTitleGroups + summary.duplicateContentGroups;
  document.querySelector('#issueTabCount').textContent = summary.issueGroups || 0;
  document.querySelector('#imageTabCount').textContent = (summary.postsMissingFeaturedImage || 0) + (summary.imageAuditIssues || 0);
  document.querySelector('#interactionTabCount').textContent = summary.interactionChecksNeedingReview || 0;
  document.querySelector('#writingTabCount').textContent = summary.writingFindings || 0;
  const performanceFindingCount = summary.poorPerformanceMetrics || 0;
  document.querySelector('#performanceTabCount').textContent =
    performanceFindingCount > 999 ? '999+' : performanceFindingCount;

  summaryCards.innerHTML = [
    summaryCard('Published posts', summary.uniquePublishedPosts, 'primary', data.metadata.usedStagingAuthentication ? 'REST-visible posts behind staging access' : 'All public REST-visible posts', 'P'),
    summaryCard('Healthy posts', summary.healthyPosts, 'success', `${healthPercent}% passed post checks`, '✓'),
    summaryCard(
      'Exact duplicate groups',
      summary.duplicateChecksSkipped ? 'Skipped' : summary.duplicateTitleGroups + summary.duplicateContentGroups,
      summary.duplicateChecksSkipped ? 'primary' : 'danger',
      summary.duplicateChecksSkipped ? 'Disabled for this staging audit' : `${summary.duplicateTitleRepeats + summary.duplicateContentRepeats} additional repeats`,
      '≋'
    ),
    summaryCard(
      'Performance score',
      summary.performanceScore ?? '—',
      summary.performanceScore == null
        ? 'primary'
        : summary.performanceScore >= 90
          ? 'success'
          : summary.performanceScore >= 50
            ? 'warning'
            : 'danger',
      'Mobile Lighthouse homepage run',
      '⚡'
    ),
    summaryCard('Heading issues', summary.headingIssues, 'warning', `${summary.representativePagesScanned} representative pages scanned`, 'H'),
    summaryCard('Issue groups', summary.issueGroups || 0, 'danger', `${summary.totalIssues} affected locations`, '!')
  ].join('');

  filteredPosts = [...data.posts];
  currentPage = 1;
  writingPage = 1;
  issuePage = 1;
  renderPostRows();
  renderDuplicateSnapshot();
  renderPageScanSnapshot();
  renderPriorityIssues();
  renderDuplicates();
  renderFonts();
  renderHeadings();
  renderPerformance();
  renderPostImages();
  renderWordPressChecks();
  renderUiChecks();
  renderWriting();
  populateIssueFilter(data.issueGroups);
  renderIssues();

  results.classList.remove('hidden');
  activateTab('overview');
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function readJsonResponse(response) {
  const raw = await response.text();

  if (!raw.trim()) {
    throw new Error(
      `The server returned an empty response (HTTP ${response.status}). ` +
      'This usually means the hosted service restarted or stopped during the audit. Check the hosting logs and run it again.'
    );
  }

  try {
    return JSON.parse(raw);
  } catch {
    const preview = raw.replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(
      `The server returned an unreadable response (HTTP ${response.status}).` +
      (preview ? ` Response: ${preview}` : '')
    );
  }
}

async function waitForAudit(jobId) {
  const startedAt = Date.now();
  const maximumWait = 30 * 60 * 1000;
  let temporaryFailures = 0;

  while (Date.now() - startedAt < maximumWait) {
    await sleep(2000);

    try {
      const response = await fetch(`/api/audit/status/${encodeURIComponent(jobId)}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      const data = await readJsonResponse(response);

      if (!response.ok) {
        throw new Error(data.error || `Audit status request failed with HTTP ${response.status}.`);
      }

      temporaryFailures = 0;

      if (data.status === 'complete') {
        if (!data.result) throw new Error('The audit finished, but no report data was returned.');
        return data.result;
      }

      if (data.status === 'failed') {
        throw new Error(data.error || 'The hosted audit stopped before completion.');
      }

      if (data.status === 'queued') {
        statusText.textContent = 'The audit is queued and will start shortly.';
      } else if (data.status === 'running') {
        statusText.textContent = 'The server is scanning the site. You can keep this tab open while it finishes.';
      }
    } catch (error) {
      temporaryFailures += 1;
      if (temporaryFailures >= 3) throw error;
      statusText.textContent = 'The hosting service is reconnecting. The audit status will be checked again.';
      await sleep(3000);
    }
  }

  throw new Error('The audit exceeded the 30-minute hosted limit. Try a smaller site or use a higher-memory hosting plan.');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  results.classList.add('hidden');
  auditButton.disabled = true;
  auditButton.querySelector('span').textContent = 'Auditing…';
  startProgress();

  try {
    const response = await fetch('/api/audit/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        siteUrl: document.querySelector('#siteUrl').value,
        stagingAuth: {
          enabled: Boolean(stagingEnabled?.checked),
          username: stagingUsername?.value || '',
          password: stagingPassword?.value || ''
        },
        skipDuplicateChecks: Boolean(stagingEnabled?.checked && skipDuplicateChecks?.checked)
      })
    });

    const startData = await readJsonResponse(response);
    if (!response.ok) throw new Error(startData.error || 'The audit could not be started.');
    if (!startData.jobId) throw new Error('The server did not return an audit job ID.');

    const data = await waitForAudit(startData.jobId);
    render(data);
    finishProgress(
      true,
      `${data.summary.uniquePublishedPosts} posts checked, ${data.summary.representativePagesScanned} page templates inspected, performance measured and ${data.summary.issueGroups} issue groups recorded.`
    );
  } catch (error) {
    finishProgress(false, error.message || 'The audit stopped unexpectedly.');
  } finally {
    auditButton.disabled = false;
    auditButton.querySelector('span').textContent = 'Run Radish';
  }
});

function syncStagingFields() {
  const enabled = Boolean(stagingEnabled?.checked);
  stagingUsername.disabled = !enabled;
  stagingPassword.disabled = !enabled;
  skipDuplicateChecks.disabled = !enabled;
  credentialGrid?.setAttribute('aria-disabled', String(!enabled));
  credentialGrid?.classList.toggle('disabled', !enabled);
  if (!enabled) {
    stagingUsername.value = '';
    stagingPassword.value = '';
  }
}

stagingEnabled?.addEventListener('change', syncStagingFields);
syncStagingFields();

previousWritingPage?.addEventListener('click', () => {
  if (writingPage <= 1) return;
  writingPage -= 1;
  renderWriting();
});
nextWritingPage?.addEventListener('click', () => {
  const pages = Math.max(1, Math.ceil(getFilteredWritingFindings().length / WRITING_PAGE_SIZE));
  if (writingPage >= pages) return;
  writingPage += 1;
  renderWriting();
});
previousIssuePage?.addEventListener('click', () => {
  if (issuePage <= 1) return;
  issuePage -= 1;
  renderIssues();
});
nextIssuePage?.addEventListener('click', () => {
  const selectedType = issueFilter.value;
  const groups = (latestAudit?.issueGroups || []).filter((group) => selectedType === 'all' || group.type === selectedType);
  const pages = Math.max(1, Math.ceil(groups.length / ISSUE_PAGE_SIZE));
  if (issuePage >= pages) return;
  issuePage += 1;
  renderIssues();
});

document.querySelector('#resultTabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tab]');
  if (button) activateTab(button.dataset.tab);
});

document.addEventListener('click', (event) => {
  const opener = event.target.closest('[data-open-tab]');
  if (opener) activateTab(opener.dataset.openTab);
});

postSearch.addEventListener('input', applyPostFilters);
postFilter.addEventListener('change', applyPostFilters);
fontSearch.addEventListener('input', renderFonts);
headingSearch.addEventListener('input', () => {
  headingExpanded = false;
  renderHeadingPage(currentHeadingIndex);
});
headingLevelFilter.addEventListener('click', (event) => {
  const button = event.target.closest('[data-heading-level]');
  if (!button) return;
  activeHeadingLevel = button.dataset.headingLevel;
  headingExpanded = false;
  headingLevelFilter.querySelectorAll('[data-heading-level]').forEach((item) => {
    item.classList.toggle('active', item === button);
  });
  renderHeadingPage(currentHeadingIndex);
});
issueFilter.addEventListener('change', () => { issuePage = 1; renderIssues(); });
imageSearch?.addEventListener('input', renderPostImages);
imageFilter?.addEventListener('change', renderPostImages);
writingSearch?.addEventListener('input', () => { writingPage = 1; renderWriting(); });

previousPage.addEventListener('click', () => {
  if (currentPage <= 1) return;
  currentPage -= 1;
  renderPostRows();
});

nextPage.addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(filteredPosts.length / PAGE_SIZE));
  if (currentPage >= totalPages) return;
  currentPage += 1;
  renderPostRows();
});

document.querySelector('#duplicateTypeFilter').addEventListener('click', (event) => {
  const button = event.target.closest('[data-duplicate-type]');
  if (!button) return;
  duplicateFilter = button.dataset.duplicateType;
  document.querySelectorAll('[data-duplicate-type]').forEach((item) => {
    item.classList.toggle('active', item === button);
  });
  renderDuplicates();
});

headingPageFilter.addEventListener('change', () => {
  const index = Number(headingPageFilter.value);
  currentHeadingIndex = index;
  headingExpanded = false;
  document.querySelectorAll('[data-heading-index]').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.headingIndex) === index);
  });
  renderHeadingPage(index);
});

document.querySelector('#headingPageTabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-heading-index]');
  if (!button) return;
  const index = Number(button.dataset.headingIndex);
  currentHeadingIndex = index;
  headingExpanded = false;
  headingPageFilter.value = String(index);
  document.querySelectorAll('[data-heading-index]').forEach((item) => item.classList.toggle('active', item === button));
  renderHeadingPage(index);
});


imageViewTabs?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-image-view]');
  if (!button) return;
  const view = button.dataset.imageView;
  imageViewTabs.querySelectorAll('[data-image-view]').forEach((item) => item.classList.toggle('active', item === button));
  document.querySelectorAll('[data-image-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.imagePanel === view));
});

performanceViewTabs?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-performance-view]');
  if (!button) return;
  const view = button.dataset.performanceView;
  performanceViewTabs.querySelectorAll('[data-performance-view]').forEach((item) => item.classList.toggle('active', item === button));
  document.querySelectorAll('[data-performance-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.performancePanel === view));
});

document.querySelectorAll('.export').forEach((exportButton) => {
  exportButton.addEventListener('click', async () => {
    if (!latestAudit) return;
    exportButton.disabled = true;
    const type = exportButton.dataset.export;

    try {
      const response = await fetch(`/api/export/${type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: latestAudit })
      });
      if (!response.ok) throw new Error('Export failed.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `radish-${type}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setStatus('Export failed', error.message, 'error');
    } finally {
      exportButton.disabled = false;
    }
  });
});

/* Radish v4 UI interactions */
(() => {
  const hero = document.querySelector('.hero-card');

  if (hero && window.matchMedia('(pointer: fine)').matches) {
    hero.addEventListener('pointermove', (event) => {
      const rect = hero.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;
      hero.style.setProperty('--mx', `${x.toFixed(1)}%`);
      hero.style.setProperty('--my', `${y.toFixed(1)}%`);
    });

    hero.addEventListener('pointerleave', () => {
      hero.style.setProperty('--mx', '70%');
      hero.style.setProperty('--my', '18%');
    });
  }

  document.addEventListener('pointerdown', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled || !window.matchMedia('(prefers-reduced-motion: no-preference)').matches) return;

    const style = getComputedStyle(button);
    if (style.position === 'static') button.style.position = 'relative';
    button.style.overflow = 'hidden';

    const rect = button.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'ui-ripple';
    ripple.style.left = `${event.clientX - rect.left}px`;
    ripple.style.top = `${event.clientY - rect.top}px`;
    button.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
  });
})();
