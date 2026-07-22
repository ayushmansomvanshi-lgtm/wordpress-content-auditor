const cheerio = require('cheerio');
const { fetchWithTimeout, getPlaywrightHttpCredentials } = require('./http');

let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function cleanText(value = '') {
  return String(value)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function analyzeHeadingSequence(headings, h1Inspection = {}) {
  const issues = [];
  const sourceH1Count = Number(h1Inspection.sourceH1Count || 0);
  const domH1Count = Number(h1Inspection.domH1Count || 0);
  const visibleH1Count = Number(h1Inspection.visibleH1Count || 0);
  const hiddenH1Count = Number(h1Inspection.hiddenH1Count || 0);

  if (sourceH1Count === 0 && domH1Count === 0) {
    issues.push({
      code: 'MISSING_H1_TAG',
      message: 'No <h1> tag was found in either the downloaded HTML source or the rendered browser DOM.'
    });
  } else if (sourceH1Count > 0 && domH1Count === 0) {
    issues.push({
      code: 'SOURCE_H1_NOT_RENDERED',
      message: `${sourceH1Count} <h1> tag${sourceH1Count === 1 ? '' : 's'} exist in the downloaded HTML source, but none are present in the final rendered DOM.`
    });
  } else if (visibleH1Count === 0 && domH1Count > 0) {
    issues.push({
      code: 'H1_NOT_VISIBLE',
      message: `The page contains ${domH1Count} rendered <h1> tag${domH1Count === 1 ? '' : 's'}, but ${hiddenH1Count || domH1Count} ${domH1Count === 1 ? 'is' : 'are'} hidden from the layout. The tag is present in code.`
    });
  }

  if (Math.max(sourceH1Count, domH1Count) > 1) {
    issues.push({
      code: 'MULTIPLE_H1_TAGS',
      message: `${Math.max(sourceH1Count, domH1Count)} H1 tags were detected; ${visibleH1Count} are visible in the rendered page.`
    });
  }

  const sequenceHeadings = headings.filter((heading) => heading.inDom !== false);
  for (let index = 1; index < sequenceHeadings.length; index += 1) {
    const previous = sequenceHeadings[index - 1];
    const current = sequenceHeadings[index];
    if (current.level - previous.level > 1) {
      issues.push({
        code: 'SKIPPED_HEADING_LEVEL',
        message: `Heading order jumps from H${previous.level} to H${current.level} before “${current.text.slice(0, 80)}”.`
      });
    }
  }

  for (const heading of sequenceHeadings) {
    if (!heading.text) {
      issues.push({
        code: 'EMPTY_HEADING',
        message: `An empty H${heading.level} tag was found in the rendered DOM.`
      });
    }
  }

  return issues;
}

function mergeFontUsage(pageResults) {
  const map = new Map();

  for (const page of pageResults) {
    for (const font of page.fonts || []) {
      const key = font.family;
      if (!map.has(key)) {
        map.set(key, {
          family: font.family,
          primaryFamily: font.primaryFamily,
          textElementCount: 0,
          pages: [],
          sizes: [],
          weights: [],
          tags: [],
          samples: []
        });
      }

      const item = map.get(key);
      item.textElementCount += font.textElementCount;
      item.pages.push({
        type: page.type,
        label: page.label,
        url: page.finalUrl || page.url,
        count: font.textElementCount
      });
      item.sizes.push(...font.sizes);
      item.weights.push(...font.weights);
      item.tags.push(...font.tags);
      item.samples.push(...font.samples);
    }
  }

  return [...map.values()]
    .map((font) => ({
      ...font,
      sizes: unique(font.sizes).slice(0, 12),
      weights: unique(font.weights).slice(0, 12),
      tags: unique(font.tags).slice(0, 16),
      samples: unique(font.samples).slice(0, 5),
      pageCount: unique(font.pages.map((page) => page.url)).length
    }))
    .sort((a, b) => b.textElementCount - a.textElementCount);
}

function sourceHeadingData(html = '') {
  if (!html) {
    return {
      sourceH1Count: 0,
      sourceH1Samples: [],
      sourceH1Tags: [],
      sourceHeadings: [],
      sourceHeadingCount: 0
    };
  }

  const $ = cheerio.load(html, { decodeEntities: true });
  const sourceHeadings = $('h1,h2,h3,h4,h5,h6')
    .toArray()
    .slice(0, 500)
    .map((element, index) => {
      const node = $(element);
      const level = Number(String(element.tagName || element.name || '').slice(1));
      const attributes = Object.entries(element.attribs || {})
        .slice(0, 8)
        .map(([key, value]) => `${key}="${String(value).slice(0, 160)}"`)
        .join(' ');
      return {
        order: index + 1,
        level,
        text: cleanText(node.text()).slice(0, 300),
        id: node.attr('id') || '',
        classes: String(node.attr('class') || '').split(/\s+/).filter(Boolean).slice(0, 8),
        openingTag: `<h${level}${attributes ? ` ${attributes}` : ''}>`,
        inDom: false,
        sourceOnly: true
      };
    });

  const h1s = sourceHeadings.filter((heading) => heading.level === 1);
  return {
    sourceH1Count: h1s.length,
    sourceH1Samples: h1s.map((heading) => heading.text).filter(Boolean).slice(0, 10),
    sourceH1Tags: h1s.map((heading) => heading.openingTag).slice(0, 10),
    sourceHeadings,
    sourceHeadingCount: sourceHeadings.length
  };
}

async function fetchSourceHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetchWithTimeout(url, {
      redirect: 'follow',
      signal: controller.signal,
      timeout: 30000,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Cache-Control': 'no-cache',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150 Safari/537.36 Radish/4.4'
      }
    });
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url || url,
      html: await response.text(),
      error: '',
      mode: 'network-source'
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      html: '',
      error: error.message || String(error),
      mode: 'unavailable'
    };
  } finally {
    clearTimeout(timer);
  }
}



function aggregateFeatureChecks(pageResults) {
  const definitions = [
    ['menus', 'Menus & mobile navigation'],
    ['tabs', 'Tabs'],
    ['accordions', 'Accordions'],
    ['carousels', 'Carousels & sliders'],
    ['popups', 'Popups & close buttons'],
    ['search', 'Search'],
    ['cookies', 'Cookie banners'],
    ['pagination', 'Pagination & load more'],
    ['dropdowns', 'Dropdowns']
  ];

  return definitions.map(([key, label]) => {
    const pageChecks = pageResults
      .map((page) => ({ page, check: (page.features || []).find((item) => item.key === key) }))
      .filter((entry) => entry.check);
    const detected = pageChecks.filter((entry) => entry.check.present);
    const tested = detected.filter((entry) => entry.check.tested);
    const failed = detected.filter((entry) => entry.check.passed === false);
    const passed = detected.filter((entry) => entry.check.passed === true);
    const instances = detected.reduce((total, entry) => total + Number(entry.check.count || 0), 0);

    let status = 'not-detected';
    if (detected.length) status = failed.length ? 'review' : 'pass';

    return {
      key,
      label,
      status,
      pagesDetected: detected.length,
      pagesScanned: pageResults.length,
      instances,
      tested: tested.length,
      passed: passed.length,
      failed: failed.length,
      pages: detected.slice(0, 12).map(({ page, check }) => ({
        type: page.type,
        label: page.label,
        url: page.finalUrl || page.url,
        count: check.count,
        tested: check.tested,
        passed: check.passed,
        details: check.details,
        samples: check.samples || []
      }))
    };
  });
}


function aggregateTechnologyDiagnostics(pageResults) {
  const pluginSlugs = new Set();
  let wpRocketDetected = false;
  let imagifyDetected = false;
  let lazyImageCount = 0;
  let imageCount = 0;
  let minifiedCss = 0;
  let totalCss = 0;
  let minifiedJs = 0;
  let totalJs = 0;
  let cloudflareDetected = false;

  for (const page of pageResults) {
    const signals = page.technologySignals || {};
    for (const slug of signals.pluginSlugs || []) pluginSlugs.add(slug);
    wpRocketDetected = wpRocketDetected || Boolean(signals.wpRocketDetected);
    imagifyDetected = imagifyDetected || Boolean(signals.imagifyDetected);
    lazyImageCount += Number(signals.lazyImageCount || 0);
    imageCount += Number(signals.imageCount || 0);
    minifiedCss += Number(signals.minifiedCss || 0);
    totalCss += Number(signals.totalCss || 0);
    minifiedJs += Number(signals.minifiedJs || 0);
    totalJs += Number(signals.totalJs || 0);

    for (const resource of page.networkResources || []) {
      if (String(resource.cfCacheStatus || '').trim() || /cloudflare/i.test(String(resource.server || ''))) {
        cloudflareDetected = true;
      }
    }
  }

  return {
    wpRocketDetected,
    imagifyDetected,
    cloudflareDetected,
    pluginSlugs: [...pluginSlugs].sort(),
    publiclyVisiblePluginCount: pluginSlugs.size,
    lazyImageCount,
    imageCount,
    minifiedCss,
    totalCss,
    minifiedJs,
    totalJs,
    minificationRatio: totalCss + totalJs
      ? Math.round(((minifiedCss + minifiedJs) / (totalCss + totalJs)) * 100)
      : 0
  };
}

function aggregateImageDiagnostics(pageResults) {
  const items = [];
  for (const page of pageResults) {
    for (const image of page.images || []) {
      items.push({ ...image, pageType: page.type, pageLabel: page.label, pageUrl: page.finalUrl || page.url });
    }
  }

  const uniqueMap = new Map();
  for (const item of items) {
    const key = `${item.pageUrl}|${item.url}|${item.index}`;
    if (!uniqueMap.has(key)) uniqueMap.set(key, item);
  }
  const images = [...uniqueMap.values()];

  const mainPageTypes = new Set(['home', 'category', 'about', 'privacy', 'contact', 'legal', 'unique-page']);
  const mainPageImages = images.filter((image) => mainPageTypes.has(image.pageType));
  const unlinkedMainPageImages = mainPageImages.filter((image) => !image.linked);

  return {
    totalImages: images.length,
    mainPageImages: mainPageImages.length,
    linkedMainPageImages: mainPageImages.filter((image) => image.linked).length,
    unlinkedMainPageImages: unlinkedMainPageImages.length,
    largeImages: images.filter((image) => image.large).length,
    missingDimensions: images.filter((image) => image.missingDimensions).length,
    aspectRatioMismatches: images.filter((image) => image.aspectRatioMismatch).length,
    aboveFoldLazy: images.filter((image) => image.aboveFoldLazy).length,
    items: images
      .filter(
        (image) =>
          image.large || image.missingDimensions || image.aspectRatioMismatch || image.aboveFoldLazy ||
          (mainPageTypes.has(image.pageType) && !image.linked)
      )
      .sort((a, b) => Number(b.transferSize || b.decodedBodySize || 0) - Number(a.transferSize || a.decodedBodySize || 0))
      .slice(0, 200)
  };
}


function aggregatePostCardDiagnostics(pageResults) {
  const mainPageTypes = new Set(['home', 'category', 'about', 'privacy', 'contact', 'legal', 'unique-page']);
  const items = pageResults
    .filter((page) => mainPageTypes.has(page.type))
    .flatMap((page) => (page.postCards || []).map((card) => ({
      ...card,
      pageType: page.type,
      pageLabel: page.label,
      pageUrl: page.finalUrl || page.url
    })));
  const unique = new Map();
  for (const item of items) {
    const key = `${item.pageUrl}|${item.title}|${item.targetUrl}|${item.index}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  const cards = [...unique.values()];
  const withProblems = cards.filter((card) =>
    !card.titleLinked || (card.hasImage && !card.imageLinked) || !card.hasButton || (card.hasButton && !card.buttonLinked)
  );
  return {
    totalCards: cards.length,
    passedCards: cards.length - withProblems.length,
    problemCards: withProblems.length,
    missingTitleLinks: cards.filter((card) => !card.titleLinked).length,
    missingImageLinks: cards.filter((card) => card.hasImage && !card.imageLinked).length,
    missingButtons: cards.filter((card) => !card.hasButton).length,
    missingButtonLinks: cards.filter((card) => card.hasButton && !card.buttonLinked).length,
    items: withProblems.slice(0, 300)
  };
}

function aggregateNetworkDiagnostics(pageResults) {
  const resources = pageResults.flatMap((page) =>
    (page.networkResources || []).map((resource) => ({
      ...resource,
      pageLabel: page.label,
      pageUrl: page.finalUrl || page.url
    }))
  );
  const textResources = resources.filter((item) =>
    /javascript|css|json|xml|html|svg|font|text\//i.test(`${item.resourceType} ${item.contentType}`)
  );
  const cacheable = resources.filter((item) =>
    ['script', 'stylesheet', 'image', 'font'].includes(item.resourceType)
  );

  const issues = [];
  for (const resource of cacheable) {
    const cache = String(resource.cacheControl || '').toLowerCase();
    const maxAgeMatch = cache.match(/(?:s-maxage|max-age)=(\d+)/);
    const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : null;
    if (!cache) {
      issues.push({ ...resource, issue: 'Missing Cache-Control header' });
    } else if (/no-store|no-cache/.test(cache)) {
      issues.push({ ...resource, issue: 'Caching disabled' });
    } else if (maxAge !== null && maxAge < 604800) {
      issues.push({ ...resource, issue: `Short cache lifetime (${maxAge}s)` });
    }
  }

  for (const resource of textResources) {
    if (!resource.contentEncoding && Number(resource.contentLength || 0) > 2048) {
      issues.push({ ...resource, issue: 'Text response appears uncompressed' });
    }
  }

  const issueMap = new Map();
  for (const issue of issues) {
    const key = `${issue.url}|${issue.issue}`;
    if (!issueMap.has(key)) issueMap.set(key, issue);
  }
  const uniqueIssues = [...issueMap.values()];
  const uniqueResources = new Set(resources.map((item) => item.url)).size;
  const uniqueTextResources = new Set(textResources.map((item) => item.url)).size;
  const uniqueCompressed = new Set(textResources.filter((item) => item.contentEncoding).map((item) => item.url)).size;

  return {
    resourcesObserved: uniqueResources,
    cacheableResources: new Set(cacheable.map((item) => item.url)).size,
    cacheIssues: uniqueIssues.filter((item) => /cache/i.test(item.issue)).length,
    textResources: uniqueTextResources,
    compressedTextResources: uniqueCompressed,
    uncompressedTextResources: uniqueIssues.filter((item) => /uncompressed/i.test(item.issue)).length,
    issues: uniqueIssues.slice(0, 150)
  };
}

async function inspectInteractiveFeatures(page) {
  const desktop = page.viewportSize() || { width: 1440, height: 1000 };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);

  const features = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const unique = (items) => [...new Set(items)];
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        !element.hidden &&
        element.getAttribute('aria-hidden') !== 'true' &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 1 &&
        rect.height > 1
      );
    };
    const query = (selectors) => {
      const found = [];
      for (const selector of selectors) {
        try {
          found.push(...document.querySelectorAll(selector));
        } catch {
          // Ignore selectors unsupported by an older browser.
        }
      }
      return [...new Set(found)];
    };
    const sample = (element) => clean(
      element.getAttribute('aria-label') || element.textContent || element.id || element.className || element.tagName
    ).slice(0, 100);
    const controlledTarget = (element) => {
      const targetValue = element.getAttribute('aria-controls') || element.getAttribute('data-target') || element.getAttribute('data-bs-target');
      if (!targetValue) return null;
      try {
        if (/^[#.[]/.test(targetValue)) return document.querySelector(targetValue);
        return document.getElementById(targetValue) || document.querySelector(`#${CSS.escape(targetValue)}`);
      } catch {
        return null;
      }
    };
    const safeToggleTest = async (element) => {
      if (!element || !visible(element)) return { tested: false, passed: null, details: 'No visible toggle available at the mobile viewport.' };
      const buttonType = String(element.getAttribute('type') || '').toLowerCase();
      const unsafeFormButton =
        element.tagName === 'BUTTON' &&
        element.closest('form') &&
        (!buttonType || buttonType === 'submit');
      if (element.matches('a[href], input[type="submit"]') || unsafeFormButton) {
        return { tested: false, passed: null, details: 'Detected, but skipped because the control may navigate or submit a form.' };
      }
      const target = controlledTarget(element);
      const beforeExpanded = element.getAttribute('aria-expanded');
      const beforeTargetVisible = target ? visible(target) : null;
      const beforeClass = element.className;
      try {
        element.click();
        await sleep(250);
        const afterExpanded = element.getAttribute('aria-expanded');
        const afterTargetVisible = target ? visible(target) : null;
        const afterClass = element.className;
        const changed =
          (beforeExpanded !== afterExpanded && afterExpanded !== null) ||
          (beforeTargetVisible !== afterTargetVisible && target) ||
          beforeClass !== afterClass;
        if (changed) {
          element.click();
          await sleep(80);
        }
        return {
          tested: true,
          passed: Boolean(changed),
          details: changed
            ? 'The control changed expanded state, target visibility or active classes.'
            : 'The detected control did not expose a measurable state change.'
        };
      } catch (error) {
        return { tested: true, passed: false, details: error.message || String(error) };
      }
    };

    const navs = query(['nav', '[role="navigation"]']);
    const menuToggles = query([
      'button[aria-label*="menu" i]',
      'button[class*="menu-toggle" i]',
      'button[class*="hamburger" i]',
      'button[class*="nav-toggle" i]',
      'button[aria-controls][aria-expanded]'
    ]).filter((item) => /menu|nav|hamburger/i.test(`${item.getAttribute('aria-label') || ''} ${item.className || ''} ${item.id || ''}`));
    const visibleMenuToggle = menuToggles.find(visible);
    const visibleMobileNav = navs.find(visible);
    const menuTest = visibleMenuToggle
      ? await safeToggleTest(visibleMenuToggle)
      : {
          tested: false,
          passed: navs.length ? Boolean(visibleMobileNav) : null,
          details: navs.length
            ? visibleMobileNav
              ? 'Navigation remains visible at the mobile viewport; no separate menu toggle was required.'
              : 'Navigation markup exists, but no visible mobile navigation or menu toggle was found.'
            : 'No navigation region was detected.'
        };

    const tabControls = query(['[role="tab"]', 'button[data-tab]', '.e-n-tab-title', '.elementor-tab-title']).filter(visible);
    const inactiveTab = tabControls.find((item) => item.getAttribute('aria-selected') !== 'true' && !item.classList.contains('active')) || tabControls[1];
    const tabTest = await safeToggleTest(inactiveTab);

    const accordionControls = query([
      'summary',
      'button[aria-expanded][aria-controls]',
      '.elementor-accordion-title',
      '.elementor-toggle-title',
      '.accordion-button'
    ]).filter((item) => !item.matches('[role="tab"]') && !/menu|nav|dropdown/i.test(`${item.className || ''} ${item.id || ''}`));
    const visibleAccordion = accordionControls.find(visible);
    const accordionTest = visibleAccordion?.tagName === 'SUMMARY'
      ? { tested: true, passed: true, details: 'Native <details>/<summary> accordion detected.' }
      : await safeToggleTest(visibleAccordion);

    const carouselContainers = query([
      '.swiper', '.swiper-container', '.slick-slider', '.owl-carousel', '[class*="carousel" i]', '[data-carousel]'
    ]);
    const carouselControls = query([
      '.swiper-button-next', '.slick-next', '.owl-next', '[class*="carousel"] button[aria-label*="next" i]',
      'button[aria-label*="next slide" i]'
    ]).filter(visible);
    let carouselTest = { tested: false, passed: carouselContainers.length ? false : null, details: carouselContainers.length ? 'A slider was detected, but no visible next control was available.' : 'No slider was detected.' };
    if (carouselControls[0] && visible(carouselControls[0])) {
      const container = carouselControls[0].closest('.swiper, .swiper-container, .slick-slider, .owl-carousel, [class*="carousel" i]') || carouselContainers[0];
      const signature = () => {
        if (!container) return '';
        const active = container.querySelector('.swiper-slide-active, .slick-active, .active, [aria-current="true"]');
        const track = container.querySelector('.swiper-wrapper, .slick-track, .owl-stage');
        return `${active?.textContent || active?.getAttribute('data-swiper-slide-index') || ''}|${active?.className || ''}|${track ? getComputedStyle(track).transform : ''}`;
      };
      const before = signature();
      try {
        carouselControls[0].click();
        await sleep(350);
        const after = signature();
        carouselTest = { tested: true, passed: Boolean(before !== after), details: before !== after ? 'The active slide or track transform changed after using the next control.' : 'The next control did not produce a measurable slide change.' };
      } catch (error) {
        carouselTest = { tested: true, passed: false, details: error.message || String(error) };
      }
    }

    const popupContainers = query([
      '[role="dialog"]', 'dialog', '.modal', '[class*="popup" i]', '[class*="lightbox" i]', '[class*="offcanvas" i]'
    ]).filter((element) => !/popover-trigger|popup-trigger/i.test(`${element.className || ''} ${element.id || ''}`));
    const dialogs = popupContainers.filter(visible);
    let visibleClose = null;
    let visibleDialog = null;
    let popupCloseCount = 0;
    for (const dialog of popupContainers) {
      const close = dialog.querySelector('button[aria-label*="close" i], .close, .modal-close, .popup-close, button[class*="close" i], [data-dismiss="modal"], [data-bs-dismiss="modal"]');
      if (close) popupCloseCount += 1;
      if (!visibleClose && close && visible(close) && visible(dialog)) {
        visibleClose = close;
        visibleDialog = dialog;
      }
    }
    let popupTest = {
      tested: false,
      passed: popupContainers.length ? popupCloseCount > 0 : null,
      details: popupContainers.length
        ? `${popupContainers.length} popup/dialog containers and ${popupCloseCount} close controls found; none was visibly open for a dismissal test.`
        : 'No popup or dialog markup was detected during the scan.'
    };
    if (visibleClose && visibleDialog) {
      try {
        const beforeVisible = visible(visibleDialog);
        visibleClose.click();
        await sleep(250);
        const afterVisible = visible(visibleDialog);
        popupTest = { tested: true, passed: beforeVisible && !afterVisible, details: beforeVisible && !afterVisible ? 'The visible close control dismissed the popup.' : 'The close control did not dismiss the popup.' };
      } catch (error) {
        popupTest = { tested: true, passed: false, details: error.message || String(error) };
      }
    }

    const searchInputs = query(['input[type="search"]', 'form[role="search"] input', 'input[name="s"]', 'input[name="q"]']);
    const visibleSearch = searchInputs.filter(visible);
    const searchForms = unique(searchInputs.map((input) => input.closest('form')).filter(Boolean));
    const searchButtons = searchForms.flatMap((form) => [...form.querySelectorAll('button, input[type="submit"]')]);

    const cookieCandidates = query([
      '[id*="cookie" i]', '[class*="cookie" i]', '[id*="consent" i]', '[class*="consent" i]',
      '[aria-label*="cookie" i]'
    ]).filter((element) => visible(element) && /cookie|consent|privacy preferences/i.test(clean(element.textContent).slice(0, 600)));
    let cookieActions = [];
    for (const banner of cookieCandidates.slice(0, 5)) {
      cookieActions.push(...banner.querySelectorAll('button, a'));
    }
    cookieActions = unique(cookieActions).filter(visible);

    const pagination = query([
      'nav[aria-label*="pagination" i]', '.pagination', '.page-numbers', 'a[rel="next"]', 'a[rel="prev"]',
      'button[class*="load-more" i]', 'button[id*="load-more" i]', 'a[class*="load-more" i]'
    ]);

    const dropdownToggles = query([
      'button[aria-haspopup="menu"]', 'button[aria-haspopup="listbox"]', '.dropdown-toggle',
      'button[class*="dropdown" i]', 'button[aria-controls][aria-expanded]'
    ]).filter((item) => !/menu-toggle|hamburger|nav-toggle/i.test(`${item.className || ''} ${item.id || ''}`));
    const dropdownTest = await safeToggleTest(dropdownToggles.find(visible));

    const feature = (key, label, present, count, test, details, elements = []) => ({
      key,
      label,
      present: Boolean(present),
      count: Number(count || 0),
      tested: Boolean(test?.tested),
      passed: test?.passed ?? null,
      details: test?.details || details,
      samples: elements.slice(0, 5).map(sample).filter(Boolean)
    });

    const features = [
      feature('menus', 'Menus & mobile navigation', navs.length || menuToggles.length, navs.length + menuToggles.length, menuTest, `${navs.length} navigation regions and ${menuToggles.length} menu toggles found.`, [...navs, ...menuToggles]),
      feature('tabs', 'Tabs', tabControls.length, tabControls.length, tabTest, `${tabControls.length} tab controls found.`, tabControls),
      feature('accordions', 'Accordions', accordionControls.length, accordionControls.length, accordionTest, `${accordionControls.length} accordion controls found.`, accordionControls),
      feature('carousels', 'Carousels & sliders', carouselContainers.length, carouselContainers.length, carouselTest, `${carouselContainers.length} slider containers and ${carouselControls.length} next controls found.`, carouselContainers),
      feature('popups', 'Popups & close buttons', popupContainers.length, popupContainers.length, popupTest, `${popupContainers.length} popup/dialog containers and ${popupCloseCount} close controls found.`, popupContainers),
      feature('search', 'Search', searchInputs.length, searchInputs.length, { tested: false, passed: visibleSearch.length > 0 && searchButtons.length > 0, details: visibleSearch.length ? `${visibleSearch.length} visible search fields and ${searchButtons.length} submit controls found.` : 'Search markup was detected, but no visible field was available.' }, '', searchInputs),
      feature('cookies', 'Cookie banners', cookieCandidates.length, cookieCandidates.length, { tested: false, passed: cookieCandidates.length ? cookieActions.length > 0 : null, details: cookieCandidates.length ? `${cookieCandidates.length} visible cookie/consent containers and ${cookieActions.length} action controls found.` : 'No visible cookie banner was present during the scan.' }, '', cookieCandidates),
      feature('pagination', 'Pagination & load more', pagination.length, pagination.length, { tested: false, passed: pagination.length ? true : null, details: pagination.length ? `${pagination.length} pagination, next/previous or load-more elements found.` : 'No pagination controls were detected on this representative page.' }, '', pagination),
      feature('dropdowns', 'Dropdowns', dropdownToggles.length, dropdownToggles.length, dropdownTest, `${dropdownToggles.length} dropdown toggles found.`, dropdownToggles)
    ];

    const mobileImages = [...document.images].slice(0, 500).map((image, index) => {
      const rect = image.getBoundingClientRect();
      const loading = String(image.loading || image.getAttribute('loading') || '').toLowerCase();
      return {
        index: index + 1,
        url: image.currentSrc || image.src || '',
        renderedWidth: Math.round(rect.width),
        renderedHeight: Math.round(rect.height),
        aboveFold: rect.top < innerHeight && rect.bottom > 0,
        visible: visible(image),
        loading,
        aboveFoldLazy:
          rect.top < innerHeight &&
          rect.bottom > 0 &&
          visible(image) &&
          loading === 'lazy'
      };
    });

    return { features, mobileImages };
  });

  await page.setViewportSize(desktop);
  await page.waitForTimeout(100);
  return features;
}

async function inspectPage(page, descriptor) {
  const networkResources = [];
  const responseHandler = (networkResponse) => {
    try {
      const request = networkResponse.request();
      const headers = networkResponse.headers();
      networkResources.push({
        url: networkResponse.url(),
        status: networkResponse.status(),
        resourceType: request.resourceType(),
        contentType: headers['content-type'] || '',
        contentEncoding: headers['content-encoding'] || '',
        contentLength: Number(headers['content-length'] || 0),
        cacheControl: headers['cache-control'] || '',
        age: headers.age || '',
        server: headers.server || '',
        cfCacheStatus: headers['cf-cache-status'] || ''
      });
    } catch {
      // A response can disappear when the page navigates quickly.
    }
  };
  page.on('response', responseHandler);

  const sourcePromise = fetchSourceHtml(descriptor.url);
  const response = await page.goto(descriptor.url, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  await page.waitForTimeout(1200);

  const pageData = await page.evaluate((pageType) => {
    const clean = (value) =>
      String(value || '')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const visibilityDetails = (element) => {
      const reasons = [];
      let current = element;
      let depth = 0;

      while (current && current.nodeType === Node.ELEMENT_NODE && depth < 12) {
        const style = window.getComputedStyle(current);
        if (current.hidden) reasons.push(`${current.tagName.toLowerCase()}:hidden attribute`);
        if (current.getAttribute('aria-hidden') === 'true') {
          reasons.push(`${current.tagName.toLowerCase()}:aria-hidden=true`);
        }
        if (style.display === 'none') reasons.push(`${current.tagName.toLowerCase()}:display:none`);
        if (style.visibility === 'hidden' || style.visibility === 'collapse') {
          reasons.push(`${current.tagName.toLowerCase()}:visibility:${style.visibility}`);
        }
        if (Number(style.opacity) === 0) reasons.push(`${current.tagName.toLowerCase()}:opacity:0`);
        current = current.parentElement;
        depth += 1;
      }

      const elementStyle = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) reasons.push('zero-size box');

      const visible = reasons.length === 0;
      return {
        visible,
        reason: visible ? '' : [...new Set(reasons)].join(', '),
        display: elementStyle.display || '',
        visibility: elementStyle.visibility || '',
        opacity: elementStyle.opacity || '',
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100
      };
    };

    const isVisible = (element) => visibilityDetails(element).visible;

    const iconLike = (element) => {
      if (element.closest('svg, canvas, picture, video, audio')) return true;
      if (element.getAttribute('aria-hidden') === 'true') return true;
      const marker = `${element.tagName} ${element.id || ''} ${element.className || ''}`.toLowerCase();
      return /(^|[\s_-])(icon|icons|fa-|fas|far|fab|eicon|dashicons|material-icons|emoji|screen-reader|sr-only)([\s_-]|$)/.test(
        marker
      );
    };

    const hasReadableDirectText = (element) => {
      const directText = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => clean(node.textContent))
        .filter(Boolean)
        .join(' ');

      if (!directText) return '';
      if (!/[\p{L}\p{N}]/u.test(directText)) return '';
      return directText.slice(0, 180);
    };

    const headingElements = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].slice(0, 500);
    const headings = headingElements.map((element, index) => {
      const style = window.getComputedStyle(element);
      const visibility = visibilityDetails(element);
      return {
        order: index + 1,
        level: Number(element.tagName.slice(1)),
        text: clean(element.textContent).slice(0, 300),
        id: element.id || '',
        classes:
          typeof element.className === 'string'
            ? element.className.split(/\s+/).filter(Boolean).slice(0, 8)
            : [],
        outerHtml: element.outerHTML.slice(0, 1200),
        fontFamily: style.fontFamily || '',
        fontSize: style.fontSize || '',
        fontWeight: style.fontWeight || '',
        visible: visibility.visible,
        visibilityReason: visibility.reason,
        display: visibility.display,
        cssVisibility: visibility.visibility,
        opacity: visibility.opacity,
        boxWidth: visibility.width,
        boxHeight: visibility.height,
        inDom: true,
        sourceOnly: false
      };
    });

    const domH1s = headings.filter((heading) => heading.level === 1);
    const visibleH1s = domH1s.filter((heading) => heading.visible);

    const fontMap = new Map();
    const elements = [...document.body.querySelectorAll('*')].slice(0, 7000);

    for (const element of elements) {
      if (!isVisible(element) || iconLike(element)) continue;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(element.tagName)) continue;

      const sample = hasReadableDirectText(element);
      if (!sample) continue;

      const style = window.getComputedStyle(element);
      const family = clean(style.fontFamily);
      if (!family) continue;

      if (!fontMap.has(family)) {
        fontMap.set(family, {
          family,
          primaryFamily: family.split(',')[0].replace(/["']/g, '').trim(),
          textElementCount: 0,
          sizes: [],
          weights: [],
          tags: [],
          samples: []
        });
      }

      const font = fontMap.get(family);
      font.textElementCount += 1;
      font.sizes.push(style.fontSize || '');
      font.weights.push(style.fontWeight || '');
      font.tags.push(element.tagName.toLowerCase());
      if (font.samples.length < 5) font.samples.push(sample);
    }

    const resourceEntries = performance.getEntriesByType('resource').map((entry) => ({
      name: entry.name,
      transferSize: Number(entry.transferSize || 0),
      encodedBodySize: Number(entry.encodedBodySize || 0),
      decodedBodySize: Number(entry.decodedBodySize || 0),
      initiatorType: entry.initiatorType || ''
    }));
    const htmlLower = document.documentElement.outerHTML.toLowerCase();
    const resourcePluginSlugs = resourceEntries
      .map((entry) => {
        const match = entry.name.match(/\/wp-content\/plugins\/([^/?#]+)/i);
        return match ? decodeURIComponent(match[1]) : '';
      })
      .filter(Boolean);
    const htmlPluginSlugs = [...htmlLower.matchAll(/\/wp-content\/plugins\/([^/?#\"'<>\s]+)/gi)]
      .map((match) => decodeURIComponent(match[1] || ''))
      .filter(Boolean);
    const pluginSlugs = [...new Set([...resourcePluginSlugs, ...htmlPluginSlugs])];
    const cssResources = resourceEntries.filter((entry) => /\.css(?:[?#]|$)/i.test(entry.name));
    const jsResources = resourceEntries.filter((entry) => /\.js(?:[?#]|$)/i.test(entry.name));
    const technologySignals = {
      pluginSlugs,
      wpRocketDetected: /wp-rocket|data-rocket-src|rocket-lazyload|wpr-lazyload|rocketcdn/i.test(htmlLower) || pluginSlugs.includes('wp-rocket'),
      imagifyDetected: /imagify|\.webp(?:[?\"']|$)|\.avif(?:[?\"']|$)/i.test(htmlLower) || pluginSlugs.includes('imagify'),
      lazyImageCount: [...document.images].filter((image) => String(image.loading || image.getAttribute('loading') || '').toLowerCase() === 'lazy').length,
      imageCount: document.images.length,
      minifiedCss: cssResources.filter((entry) => /\.min\.css(?:[?#]|$)|\/cache\/|autoptimize|wp-rocket/i.test(entry.name)).length,
      totalCss: cssResources.length,
      minifiedJs: jsResources.filter((entry) => /\.min\.js(?:[?#]|$)|\/cache\/|autoptimize|wp-rocket/i.test(entry.name)).length,
      totalJs: jsResources.length
    };
    const resourceByUrl = new Map(resourceEntries.map((entry) => [entry.name, entry]));
    const images = [...document.images].slice(0, 500).map((image, index) => {
      const rect = image.getBoundingClientRect();
      const style = getComputedStyle(image);
      const currentUrl = image.currentSrc || image.src || '';
      const resource = resourceByUrl.get(currentUrl) || resourceEntries.find((entry) => currentUrl && entry.name.includes(currentUrl));
      const renderedWidth = Math.round(rect.width);
      const renderedHeight = Math.round(rect.height);
      const naturalWidth = Number(image.naturalWidth || 0);
      const naturalHeight = Number(image.naturalHeight || 0);
      const naturalRatio = naturalWidth && naturalHeight ? naturalWidth / naturalHeight : 0;
      const renderedRatio = renderedWidth && renderedHeight ? renderedWidth / renderedHeight : 0;
      const aboveFold = rect.top < innerHeight && rect.bottom > 0;
      const transferSize = Number(resource?.transferSize || resource?.encodedBodySize || 0);
      const decodedBodySize = Number(resource?.decodedBodySize || 0);
      const oversized =
        naturalWidth > renderedWidth * 1.5 &&
        naturalHeight > renderedHeight * 1.5 &&
        renderedWidth > 0 &&
        renderedHeight > 0;
      const aspectRatioMismatch =
        naturalRatio > 0 &&
        renderedRatio > 0 &&
        Math.abs(naturalRatio - renderedRatio) / naturalRatio > 0.08 &&
        !['cover', 'contain'].includes(style.objectFit);

      const link = image.closest('a[href]');
      return {
        index: index + 1,
        url: currentUrl,
        alt: clean(image.alt || ''),
        linked: Boolean(link),
        linkUrl: link ? link.href : '',
        loading: image.loading || image.getAttribute('loading') || '',
        fetchPriority: image.fetchPriority || image.getAttribute('fetchpriority') || '',
        renderedWidth,
        renderedHeight,
        naturalWidth,
        naturalHeight,
        transferSize,
        decodedBodySize,
        aboveFold,
        visible: isVisible(image),
        aboveFoldLazy: aboveFold && isVisible(image) && String(image.loading || image.getAttribute('loading') || '').toLowerCase() === 'lazy',
        hasWidthAttribute: image.hasAttribute('width'),
        hasHeightAttribute: image.hasAttribute('height'),
        missingDimensions: !image.hasAttribute('width') || !image.hasAttribute('height'),
        aspectRatioMismatch,
        oversized,
        large: transferSize > 250 * 1024 || decodedBodySize > 500 * 1024 || oversized,
        objectFit: style.objectFit || ''
      };
    });

    const mainPageTypes = new Set(['home', 'category', 'about', 'privacy', 'contact', 'legal', 'unique-page']);
    const postCards = [];
    if (mainPageTypes.has(pageType)) {
      const selectors = [
        'article', '.elementor-post', '.e-loop-item', '.elementor-grid-item', '.wp-block-post',
        '.type-post', '[class*="post-card"]', '[class*="blog-card"]', '[class*="loop-item"]'
      ];
      const candidates = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))];
      for (const card of candidates) {
        if (postCards.length >= 150 || !isVisible(card)) continue;
        const titleElement = card.querySelector('.entry-title,.elementor-post__title,.wp-block-post-title,[class*="post-title"],h2,h3,h4');
        if (!titleElement) continue;
        const title = clean(titleElement.textContent);
        if (!title || title.length < 3) continue;
        const titleAnchor = titleElement.closest('a[href]') || titleElement.querySelector('a[href]');
        const image = card.querySelector('img');
        const imageAnchor = image ? image.closest('a[href]') : null;
        const button = card.querySelector('.elementor-button,.read-more,[class*="read-more"],a.button,.wp-block-read-more,[class*="cta"] a');
        const buttonAnchor = button ? (button.matches('a[href]') ? button : button.closest('a[href]') || button.querySelector('a[href]')) : null;
        const anyTarget = titleAnchor?.href || imageAnchor?.href || buttonAnchor?.href || '';
        const classMarker = `${card.className || ''} ${card.id || ''}`.toLowerCase();
        const looksLikePost = /post|loop|blog|article|entry/.test(classMarker) || Boolean(anyTarget && image);
        if (!looksLikePost) continue;
        postCards.push({
          index: postCards.length + 1,
          title: title.slice(0, 240),
          targetUrl: anyTarget,
          titleLinked: Boolean(titleAnchor?.href),
          titleLinkUrl: titleAnchor?.href || '',
          hasImage: Boolean(image),
          imageUrl: image?.currentSrc || image?.src || '',
          imageLinked: !image || Boolean(imageAnchor?.href),
          imageLinkUrl: imageAnchor?.href || '',
          hasButton: Boolean(button),
          buttonText: clean(button?.textContent || '').slice(0, 100),
          buttonLinked: Boolean(buttonAnchor?.href),
          buttonLinkUrl: buttonAnchor?.href || ''
        });
      }
    }

    return {
      documentTitle: document.title || '',
      finalUrl: location.href,
      renderedHtml: document.documentElement.outerHTML,
      headings,
      h1Inspection: {
        domH1Count: domH1s.length,
        visibleH1Count: visibleH1s.length,
        hiddenH1Count: domH1s.length - visibleH1s.length,
        domH1Samples: domH1s.map((heading) => heading.text).filter(Boolean).slice(0, 10),
        domH1Html: domH1s.map((heading) => heading.outerHtml).slice(0, 5)
      },
      fonts: [...fontMap.values()].map((font) => ({
        ...font,
        sizes: [...new Set(font.sizes.filter(Boolean))],
        weights: [...new Set(font.weights.filter(Boolean))],
        tags: [...new Set(font.tags.filter(Boolean))],
        samples: [...new Set(font.samples.filter(Boolean))]
      })),
      images,
      postCards,
      technologySignals
    };
  }, descriptor.type);

  const interactionScan = await inspectInteractiveFeatures(page).catch((error) => ({
    features: [{
      key: 'scan-error',
      label: 'Interactive feature scan',
      present: false,
      count: 0,
      tested: false,
      passed: false,
      details: error.message || String(error),
      samples: []
    }],
    mobileImages: []
  }));
  const features = interactionScan.features || [];
  const mobileImageMap = new Map(
    (interactionScan.mobileImages || []).map((image) => [`${image.url}|${image.index}`, image])
  );
  const images = (pageData.images || []).map((image) => {
    const mobile =
      mobileImageMap.get(`${image.url}|${image.index}`) ||
      (interactionScan.mobileImages || []).find((item) => item.url && item.url === image.url);
    return {
      ...image,
      mobileRenderedWidth: mobile?.renderedWidth || 0,
      mobileRenderedHeight: mobile?.renderedHeight || 0,
      mobileAboveFold: Boolean(mobile?.aboveFold),
      mobileAboveFoldLazy: Boolean(mobile?.aboveFoldLazy),
      aboveFoldLazy: Boolean(image.aboveFoldLazy || mobile?.aboveFoldLazy)
    };
  });
  page.off('response', responseHandler);

  let sourceResult = await sourcePromise;
  if (!sourceResult.html) {
    try {
      const responseHtml = response ? await response.text() : '';
      if (responseHtml) {
        sourceResult = {
          ok: Boolean(response?.ok()),
          status: response?.status() || 0,
          finalUrl: response?.url() || descriptor.url,
          html: responseHtml,
          error: '',
          mode: 'playwright-response'
        };
      }
    } catch {
      // Fall through to rendered HTML fallback.
    }
  }
  if (!sourceResult.html && pageData.renderedHtml) {
    sourceResult = {
      ok: true,
      status: response?.status() || 0,
      finalUrl: pageData.finalUrl,
      html: pageData.renderedHtml,
      error: '',
      mode: 'rendered-html-fallback'
    };
  }

  const source = sourceHeadingData(sourceResult.html);
  const h1Inspection = {
    ...source,
    ...pageData.h1Inspection,
    sourceChecked: Boolean(sourceResult.html),
    sourceMode: sourceResult.mode,
    sourceStatus: sourceResult.status,
    sourceUrl: sourceResult.finalUrl,
    sourceError: sourceResult.error
  };

  const sourceOnlyH1s = source.sourceHeadings.filter((heading) => heading.level === 1).map((heading) => ({
    ...heading,
    visible: false,
    visibilityReason: 'Present in downloaded source; not found in rendered DOM',
    fontFamily: '',
    fontSize: '',
    fontWeight: ''
  }));

  return {
    ...descriptor,
    status: response?.status() || sourceResult.status || 0,
    ok: Boolean(response?.ok() || sourceResult.ok),
    finalUrl: pageData.finalUrl || sourceResult.finalUrl || descriptor.url,
    documentTitle: pageData.documentTitle,
    headings: pageData.headings,
    sourceOnlyH1s: pageData.h1Inspection.domH1Count ? [] : sourceOnlyH1s,
    sourceHeadings: source.sourceHeadings,
    h1Inspection,
    headingIssues: analyzeHeadingSequence(pageData.headings, h1Inspection),
    fonts: pageData.fonts,
    images,
    postCards: pageData.postCards || [],
    technologySignals: pageData.technologySignals || {},
    features,
    networkResources,
    error: ''
  };
}

function unavailablePage(descriptor, error) {
  return {
    ...descriptor,
    status: 0,
    ok: false,
    finalUrl: descriptor.url,
    documentTitle: '',
    headings: [],
    sourceOnlyH1s: [],
    sourceHeadings: [],
    h1Inspection: {
      sourceChecked: false,
      sourceMode: 'unavailable',
      sourceH1Count: 0,
      sourceH1Samples: [],
      sourceH1Tags: [],
      sourceHeadingCount: 0,
      domH1Count: 0,
      visibleH1Count: 0,
      hiddenH1Count: 0,
      domH1Samples: [],
      domH1Html: []
    },
    headingIssues: [],
    fonts: [],
    images: [],
    postCards: [],
    technologySignals: {},
    features: [],
    networkResources: [],
    error
  };
}

async function scanRepresentativePages(descriptors) {
  const pagesToScan = descriptors.slice(0, 10);

  if (!pagesToScan.length) {
    return {
      available: true,
      pages: [],
      typography: { fonts: [], totalFamilies: 0, pagesScanned: 0 },
      headingIssueCount: 0,
      imageDiagnostics: { totalImages: 0, mainPageImages: 0, linkedMainPageImages: 0, unlinkedMainPageImages: 0, largeImages: 0, missingDimensions: 0, aspectRatioMismatches: 0, aboveFoldLazy: 0, items: [] },
      postCardDiagnostics: { totalCards: 0, passedCards: 0, problemCards: 0, missingTitleLinks: 0, missingImageLinks: 0, missingButtons: 0, missingButtonLinks: 0, items: [] },
      networkDiagnostics: { resourcesObserved: 0, cacheableResources: 0, cacheIssues: 0, textResources: 0, compressedTextResources: 0, uncompressedTextResources: 0, issues: [] },
      technologyDiagnostics: { wpRocketDetected: false, imagifyDetected: false, cloudflareDetected: false, pluginSlugs: [], publiclyVisiblePluginCount: 0, lazyImageCount: 0, imageCount: 0, minifiedCss: 0, totalCss: 0, minifiedJs: 0, totalJs: 0, minificationRatio: 0 },
      interactiveFeatures: [],
      errors: []
    };
  }

  if (!playwright?.chromium) {
    return {
      available: false,
      pages: pagesToScan.map((descriptor) =>
        unavailablePage(descriptor, 'Playwright is not installed.')
      ),
      typography: { fonts: [], totalFamilies: 0, pagesScanned: 0 },
      headingIssueCount: 0,
      imageDiagnostics: { totalImages: 0, mainPageImages: 0, linkedMainPageImages: 0, unlinkedMainPageImages: 0, largeImages: 0, missingDimensions: 0, aspectRatioMismatches: 0, aboveFoldLazy: 0, items: [] },
      postCardDiagnostics: { totalCards: 0, passedCards: 0, problemCards: 0, missingTitleLinks: 0, missingImageLinks: 0, missingButtons: 0, missingButtonLinks: 0, items: [] },
      networkDiagnostics: { resourcesObserved: 0, cacheableResources: 0, cacheIssues: 0, textResources: 0, compressedTextResources: 0, uncompressedTextResources: 0, issues: [] },
      technologyDiagnostics: { wpRocketDetected: false, imagifyDetected: false, cloudflareDetected: false, pluginSlugs: [], publiclyVisiblePluginCount: 0, lazyImageCount: 0, imageCount: 0, minifiedCss: 0, totalCss: 0, minifiedJs: 0, totalJs: 0, minificationRatio: 0 },
      interactiveFeatures: [],
      errors: ['Playwright is not installed. Run npm install and npx playwright install chromium.']
    };
  }

  let browser;
  const results = [];
  const errors = [];

  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });

    const httpCredentials = getPlaywrightHttpCredentials();
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
      ...(httpCredentials ? { httpCredentials } : {}),
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150 Safari/537.36 Radish/4.4'
    });

    for (const descriptor of pagesToScan) {
      const page = await context.newPage();
      try {
        results.push(await inspectPage(page, descriptor));
      } catch (error) {
        const message = error.message || String(error);
        errors.push(`${descriptor.label}: ${message}`);
        results.push(unavailablePage(descriptor, message));
      } finally {
        await page.close().catch(() => {});
      }
    }

    await context.close();
  } catch (error) {
    const message = error.message || String(error);
    errors.push(message);
    for (const descriptor of pagesToScan) {
      if (results.some((result) => result.url === descriptor.url)) continue;
      results.push(unavailablePage(descriptor, message));
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const successfulPages = results.filter((page) => !page.error);
  const fonts = mergeFontUsage(successfulPages);
  const imageDiagnostics = aggregateImageDiagnostics(successfulPages);
  const postCardDiagnostics = aggregatePostCardDiagnostics(successfulPages);
  const networkDiagnostics = aggregateNetworkDiagnostics(successfulPages);
  const technologyDiagnostics = aggregateTechnologyDiagnostics(successfulPages);
  const interactiveFeatures = aggregateFeatureChecks(successfulPages);

  return {
    available: errors.length === 0 || successfulPages.length > 0,
    pages: results,
    typography: {
      fonts,
      totalFamilies: fonts.length,
      pagesScanned: successfulPages.length,
      textElementCount: fonts.reduce(
        (total, font) => total + font.textElementCount,
        0
      )
    },
    headingIssueCount: results.reduce(
      (total, page) => total + page.headingIssues.length,
      0
    ),
    imageDiagnostics,
    postCardDiagnostics,
    networkDiagnostics,
    technologyDiagnostics,
    interactiveFeatures,
    errors
  };
}

module.exports = { scanRepresentativePages };
