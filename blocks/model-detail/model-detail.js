import {
  div, span, h2, p,
} from '../../scripts/dom-helpers.js';
import { readBlockConfig, createOptimizedPicture, getMetadata } from '../../scripts/aem.js';

/**
 * Get description HTML from block for richtext support (readBlockConfig only returns textContent).
 * @param {Element} block - The block element
 * @returns {string} HTML or empty string
 */
function getDescriptionHtml(block) {
  const rows = block.querySelectorAll(':scope > div');
  for (const row of rows) {
    const cols = [...row.children];
    if (cols.length >= 2) {
      const key = cols[0].textContent.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (key === 'description') {
        const valueCell = cols[1];
        return valueCell.innerHTML?.trim() || valueCell.textContent?.trim() || '';
      }
    }
  }
  return '';
}

/**
 * Build spec row label + value.
 */
function specRow(label, value) {
  if (value == null || String(value).trim() === '') return null;
  return div({ class: 'model-detail-spec-row' },
    span({ class: 'model-detail-spec-label' }, label),
    span({ class: 'model-detail-spec-value' }, String(value).trim()),
  );
}

function emptyAsBlank(val) {
  if (val == null || val === '' || String(val).toLowerCase() === 'null' || String(val).toLowerCase() === 'undefined') return '';
  return String(val).trim();
}

/** Normalize to kebab-case for config keys (matches aem toClassName). */
function toKey(str) {
  if (str == null || typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .replace(/[^0-9a-z]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** toCamelCase for key matching (e.g. productId -> productId). */
function toCamelCase(str) {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** Key aliases: other names the editor/source might use for the same field. */
const KEY_ALIASES = {
  image: 'imageUrl',
  imageUrl: 'imageUrl',
};

/** Get value from block config. Keys from readBlockConfig use toClassName() so camelCase labels become lowercase (e.g. productId -> productid). */
function getConfig(config, key) {
  const alias = KEY_ALIASES[key];
  const baseKey = alias || key;
  const hyphenated = baseKey.replace(/_/g, '-');
  const camel = toCamelCase(baseKey.replace(/_/g, '-'));
  const lower = (camel || baseKey).toLowerCase();
  const raw = config[baseKey] ?? config[hyphenated] ?? config[camel] ?? config[lower] ?? config[key] ?? '';
  return Array.isArray(raw) ? (raw[0] ?? '') : raw;
}

/** Get value from row by 1-based index (row 1 = productId, row 2 = modelName, ...). */
function getValueFromRow(block, rowIndex) {
  const row = block.querySelector(`:scope > div:nth-child(${rowIndex})`);
  if (!row || !row.children || row.children.length < 2) return '';
  const valueCell = row.children[1];
  const anchor = valueCell.querySelector('a');
  const img = valueCell.querySelector('img');
  const p = valueCell.querySelector('p');
  if (anchor) return anchor.href || '';
  if (img) return img.src || '';
  if (p) return p.textContent?.trim() || '';
  return valueCell.textContent?.trim() || '';
}

/**
 * Get value from a value cell (second column) for building config.
 * @param {Element} valueCell
 * @param {string} fieldKey - e.g. 'description' for innerHTML
 */
function getCellValue(valueCell, fieldKey) {
  if (!valueCell) return '';
  const anchor = valueCell.querySelector('a');
  const img = valueCell.querySelector('img');
  const pEl = valueCell.querySelector('p');
  if (anchor) return anchor.href || '';
  if (img) return img.src || '';
  if (fieldKey === 'description') return valueCell.innerHTML?.trim() || valueCell.textContent?.trim() || '';
  if (pEl) return pEl.textContent?.trim() || '';
  return valueCell.textContent?.trim() || '';
}

/** Field order for position-based reading (must match model field order and modelFields in JCR). */
const FIELD_ORDER = [
  'productId', 'modelName', 'bodyType', 'fuelType', 'comfortLevel',
  'priceRangeTag', 'imageUrl', 'description', 'color',
];

/**
 * Normalize a raw object (e.g. from JSON) to our config keys (hyphenated). Handles productId, product-id, productId.
 */
function objectToConfig(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const config = {};
  FIELD_ORDER.forEach((field) => {
    const hyphenated = field.replace(/_/g, '-');
    const camel = toCamelCase(field.replace(/_/g, '-'));
    const val = obj[field] ?? obj[hyphenated] ?? obj[camel];
    const str = val != null ? String(val).trim() : '';
    if (str) config[hyphenated] = str;
  });
  return config;
}

/**
 * Try to get block data from an inline script or data attribute (pipeline can inject JCR data here).
 * @param {Element} block
 * @returns {Promise<Record<string, string>|null>}
 */
function tryGetBlockDataFromScript(block) {
  const script = block.querySelector('script[type="application/json"][data-block="model-detail"]')
    || document.querySelector(`script[type="application/json"][data-block="model-detail"][data-block-id="${block.id || ''}"]`);
  if (script && script.textContent) {
    try {
      const data = JSON.parse(script.textContent);
      return Promise.resolve(objectToConfig(data));
    } catch {
      return Promise.resolve(null);
    }
  }
  const raw = block.getAttribute('data-block-data');
  if (raw) {
    try {
      const data = JSON.parse(raw);
      return Promise.resolve(objectToConfig(data));
    } catch {
      return Promise.resolve(null);
    }
  }
  return Promise.resolve(null);
}

/**
 * Try to fetch block data from the page JSON (e.g. when AEM stores props in JCR but they are not in HTML).
 * Uses meta hlx:proxyUrl or current origin; requests path.model.json and looks for model-detail block data.
 * @param {Element} block
 * @returns {Promise<Record<string, string>|null>}
 */
async function tryFetchBlockDataFromPage(block) {
  const pathname = window.location.pathname.replace(/\/?index\.html$/, '').replace(/\.html$/, '') || '/';
  const proxyUrl = getMetadata('hlx:proxyUrl') || getMetadata('proxyUrl');
  const base = proxyUrl
    ? new URL(proxyUrl).origin
    : window.location.origin;
  const url = `${base}${pathname}.model.json`;
  try {
    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || typeof data !== 'object') return null;
    const modelDetail = data.model_detail ?? data.modelDetail ?? data['model-detail'];
    if (modelDetail && typeof modelDetail === 'object') return objectToConfig(modelDetail);
    const root = data.root || data.jcr-content;
    const sections = root?.section || root?.sections;
    const arr = Array.isArray(sections) ? sections : (sections ? [sections] : []);
    for (const sec of arr) {
      const blocks = sec.model_detail ?? sec.modelDetail ?? sec['model-detail'] ?? sec.block;
      const blockArr = Array.isArray(blocks) ? blocks : (blocks ? [blocks] : []);
      for (const b of blockArr) {
        if (b && typeof b === 'object' && (b.productId != null || b.modelName != null || b.productId != null)) {
          return objectToConfig(b);
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read config from AEM/Universal Editor rendered block (JCR properties as data-aue-prop).
 * Same pattern as tabs and hero: elements with data-aue-prop="productId" etc. hold the value.
 * @param {Element} block
 * @returns {Record<string, string>}
 */
function readAuePropsConfig(block) {
  const config = {};
  const propVariants = (field) => [field, field.replace(/_/g, '-'), toCamelCase(field.replace(/_/g, '-'))];

  FIELD_ORDER.forEach((field) => {
    const hyphenated = field.replace(/_/g, '-');
    for (const prop of propVariants(field)) {
      const el = block.querySelector(`[data-aue-prop="${prop}"]`);
      if (!el) continue;
      let val = '';
      const anchor = el.querySelector('a') || (el.tagName === 'A' ? el : null);
      const img = el.querySelector('img');
      if (anchor) val = anchor.href || '';
      else if (img) val = img.src || '';
      else if (field === 'description') val = el.innerHTML?.trim() || el.textContent?.trim() || '';
      else val = el.textContent?.trim() || '';
      val = emptyAsBlank(val);
      if (val) {
        config[hyphenated] = val;
        break;
      }
    }
  });

  return config;
}

/**
 * Build config from block: AUE props (JCR) first, then key-value rows, then block dataset.
 * @param {Element} block
 * @returns {Record<string, string>}
 */
function readFullBlockConfig(block) {
  const config = { ...readAuePropsConfig(block) };
  const rowConfig = readBlockConfig(block);
  Object.keys(rowConfig).forEach((k) => {
    const v = rowConfig[k];
    if (v != null && String(v).trim() !== '') config[k] = v;
  });

  block.querySelectorAll(':scope > div').forEach((row) => {
    const cols = [...row.children];
    if (cols.length < 2) return;
    const keyCell = cols[0];
    const valueCell = cols[1];
    const keyFromAttr = keyCell.getAttribute?.('data-name')
      || keyCell.getAttribute?.('data-key')
      || valueCell.getAttribute?.('data-aue-prop');
    const key = toKey(keyFromAttr || keyCell.textContent);
    if (!key) return;
    const val = getCellValue(valueCell, key === 'description' ? 'description' : '');
    const trimmed = val != null ? String(val).trim() : '';
    if (trimmed) config[key] = val;
  });

  const dataset = block.dataset || {};
  FIELD_ORDER.forEach((field) => {
    const hyphenated = field.replace(/_/g, '-');
    if (config[hyphenated] && String(config[hyphenated]).trim() !== '') return;
    const camel = toCamelCase(field.replace(/_/g, '-'));
    const fromDataset = dataset[camel];
    if (fromDataset != null && String(fromDataset).trim() !== '') {
      config[hyphenated] = String(fromDataset).trim();
    }
  });

  return config;
}

/**
 * If block has two rows with many columns (header row + value row), build config from them.
 * Column order is assumed to match FIELD_ORDER.
 * @param {Element} block
 * @returns {Record<string, string>} Config object or empty if not horizontal format
 */
function readHorizontalConfig(block) {
  const rows = block.querySelectorAll(':scope > div');
  if (rows.length < 2) return {};
  const valueRow = rows[1];
  const valueCells = [...valueRow.children];
  if (valueCells.length < 3) return {};
  const config = {};
  const len = Math.min(valueCells.length, FIELD_ORDER.length);
  for (let i = 0; i < len; i += 1) {
    const valueCell = valueCells[i];
    let val = '';
    const anchor = valueCell?.querySelector('a');
    const img = valueCell?.querySelector('img');
    const pEl = valueCell?.querySelector('p');
    if (anchor) val = anchor.href || '';
    else if (img) val = img.src || '';
    else if (FIELD_ORDER[i] === 'description' && valueCell?.innerHTML) val = valueCell.innerHTML.trim();
    else if (pEl) val = pEl.textContent?.trim() || '';
    else val = valueCell?.textContent?.trim() || '';
    val = emptyAsBlank(val);
    if (val) config[FIELD_ORDER[i].replace(/_/g, '-')] = val;
  }
  return config;
}

/**
 * Render the block UI from config (used after config is fully resolved, including fetch fallback).
 * @param {Element} block
 * @param {Record<string, string>} config
 * @param {string} descriptionHtml
 */
function renderBlock(block, config, descriptionHtml) {
  const byPosition = FIELD_ORDER.map((_, i) => getValueFromRow(block, i + 1));
  const hasKnownKey = FIELD_ORDER.some((f) => emptyAsBlank(getConfig(config, f)) !== '');
  const isKeyValueConfig = hasKnownKey;
  const pick = (key, posIndex) => (isKeyValueConfig ? getConfig(config, key) : (getConfig(config, key) || byPosition[posIndex]));

  const productId = emptyAsBlank(pick('productId', 0));
  const modelName = emptyAsBlank(pick('modelName', 1));
  const bodyType = emptyAsBlank(pick('bodyType', 2));
  const fuelType = emptyAsBlank(pick('fuelType', 3));
  const comfortLevel = emptyAsBlank(pick('comfortLevel', 4));
  const priceRangeTag = emptyAsBlank(pick('priceRangeTag', 5));
  const imageUrl = emptyAsBlank(pick('imageUrl', 6));
  const description = descriptionHtml || emptyAsBlank(pick('description', 7));
  let color = emptyAsBlank(pick('color', 8));
  if (color && color.includes('#')) {
    const hashPart = color.slice(color.indexOf('#'));
    if (hashPart && hashPart.length <= 20) color = hashPart;
  }

  const specRows = [
    specRow('Body type', bodyType),
    specRow('Fuel type', fuelType),
    specRow('Comfort', comfortLevel),
    specRow('Color', color),
  ].filter(Boolean);

  const imageBlock = imageUrl
    ? (() => {
      const picture = createOptimizedPicture(imageUrl, modelName || 'Vehicle', false, [{ width: '900' }, { width: '600' }]);
      return div({ class: 'model-detail-image' }, picture);
    })()
    : div({ class: 'model-detail-image model-detail-image-placeholder' },
      span({ class: 'model-detail-placeholder-text' }, 'Add image in editor'),
    );

  const descriptionBlock = description
    ? (() => {
      const desc = div({ class: 'model-detail-description' });
      if (descriptionHtml || (typeof description === 'string' && description.includes('<'))) {
        desc.innerHTML = description;
      } else {
        desc.appendChild(p(description));
      }
      return desc;
    })()
    : null;

  const contentChildren = [
    productId ? span({ class: 'model-detail-product-id' }, productId) : null,
    modelName ? h2({ class: 'model-detail-title' }, modelName) : null,
    priceRangeTag ? p({ class: 'model-detail-price' }, priceRangeTag) : null,
    specRows.length ? div({ class: 'model-detail-specs' }, ...specRows) : null,
    descriptionBlock,
  ].filter((el) => el != null);

  const wrapper = div({ class: 'model-detail-wrapper' },
    div({ class: 'model-detail-main' },
      div({ class: 'model-detail-media' }, imageBlock),
      div({ class: 'model-detail-content' }, ...contentChildren),
    ),
  );

  block.innerHTML = '';
  block.appendChild(wrapper);
}

/**
 * @param {Element} block
 */
export default async function decorate(block) {
  let config = readFullBlockConfig(block);
  const horizontalConfig = readHorizontalConfig(block);
  if (Object.keys(config).length === 0 && Object.keys(horizontalConfig).length > 0) {
    config = horizontalConfig;
  }
  const descriptionHtml = getDescriptionHtml(block);

  const filledCount = FIELD_ORDER.filter((f) => emptyAsBlank(getConfig(config, f)) !== '').length;
  if (filledCount < 3) {
    const fromScript = await tryGetBlockDataFromScript(block);
    if (fromScript && Object.keys(fromScript).length > 0) {
      config = { ...fromScript, ...config };
    } else {
      const fromPage = await tryFetchBlockDataFromPage(block);
      if (fromPage && Object.keys(fromPage).length > 0) {
        config = { ...fromPage, ...config };
      }
    }
  }

  renderBlock(block, config, descriptionHtml);
}
