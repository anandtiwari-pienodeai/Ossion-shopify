import { CartAddEvent } from '@theme/events';

/**
 * Ossion search pop-up (snippets/ossian-search-modal.liquid).
 *
 * - Opens from any [data-ossian-search-open] element, closes on ESC / close button / backdrop.
 * - Typing fetches live product results from sections/ossian-search-results.liquid through
 *   the Section Rendering API and swaps them in place of the promo + featured products.
 * - Recent searches are kept per visitor in localStorage.
 * - Cards support quick add-to-cart (single-variant products) and a local wishlist toggle.
 */

const RECENT_KEY = 'ossian-recent-searches';
const WISHLIST_KEY = 'ossian-wishlist';
const RECENT_LIMIT = 6;
const DEBOUNCE_MS = 250;

/** @param {string} key */
function readList(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} key
 * @param {unknown[]} list
 */
function writeList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Storage unavailable (private mode etc.): features degrade silently.
  }
}

class OssianSearch {
  /** @param {HTMLDialogElement} dialog */
  constructor(dialog) {
    this.dialog = dialog;
    this.input = /** @type {HTMLInputElement} */ (dialog.querySelector('[data-search-input]'));
    this.form = /** @type {HTMLFormElement} */ (dialog.querySelector('[data-search-form]'));
    this.resultsGrid = /** @type {HTMLElement} */ (dialog.querySelector('[data-search-results]'));
    this.emptyMessage = /** @type {HTMLElement} */ (dialog.querySelector('[data-search-empty]'));
    this.loading = /** @type {HTMLElement} */ (dialog.querySelector('[data-search-loading]'));
    this.productsTitle = /** @type {HTMLElement} */ (dialog.querySelector('[data-search-products-title]'));
    this.viewAll = /** @type {HTMLAnchorElement} */ (dialog.querySelector('[data-search-view-all]'));
    this.viewAllLabel = /** @type {HTMLElement} */ (dialog.querySelector('[data-search-view-all-label]'));
    this.recentSection = /** @type {HTMLElement} */ (dialog.querySelector('[data-search-recent]'));
    this.recentList = /** @type {HTMLElement} */ (dialog.querySelector('[data-search-recent-list]'));
    this.searchUrl = dialog.dataset.searchUrl || '/search';
    this.cartAddUrl = dialog.dataset.cartAddUrl || '/cart/add';

    /** @type {AbortController | null} */
    this.abortController = null;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.debounceTimer = undefined;
    /** @type {HTMLElement | null} */
    this.opener = null;

    this.bindEvents();
    this.renderRecent();
    this.syncWishlist(dialog);
  }

  bindEvents() {
    document.addEventListener('click', (event) => {
      const opener = /** @type {HTMLElement | null} */ (
        /** @type {HTMLElement} */ (event.target).closest('[data-ossian-search-open]')
      );
      if (!opener) return;
      event.preventDefault();
      this.open(opener);
    });

    this.dialog.addEventListener('close', () => this.onClose());
    this.dialog.addEventListener('click', (event) => {
      // Clicks on the ::backdrop land on the dialog element itself
      if (event.target === this.dialog) this.close();
    });
    this.dialog.querySelector('[data-search-close]')?.addEventListener('click', () => this.close());

    this.input.addEventListener('input', () => {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.search(this.input.value), DEBOUNCE_MS);
    });

    this.form.addEventListener('submit', () => {
      this.saveRecent(this.input.value);
    });

    this.dialog.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);

      const term = /** @type {HTMLElement | null} */ (target.closest('[data-search-term]'));
      if (term) {
        event.preventDefault();
        this.input.value = term.dataset.searchTerm || '';
        this.input.focus();
        this.search(this.input.value);
        this.saveRecent(this.input.value);
        return;
      }

      const remove = /** @type {HTMLElement | null} */ (target.closest('[data-search-recent-remove]'));
      if (remove) {
        this.removeRecent(remove.dataset.searchRecentRemove || '');
        return;
      }

      if (target.closest('[data-search-clear-recent]')) {
        writeList(RECENT_KEY, []);
        this.renderRecent();
        return;
      }

      const add = /** @type {HTMLButtonElement | null} */ (target.closest('button[data-search-add]'));
      if (add) {
        this.addToCart(add);
        return;
      }

      const wish = /** @type {HTMLButtonElement | null} */ (target.closest('[data-search-wishlist]'));
      if (wish) {
        this.toggleWishlist(wish);
        return;
      }

      if (target.closest('[data-search-product-link]') && this.input.value.trim()) {
        this.saveRecent(this.input.value);
      }
    });
  }

  /** @param {HTMLElement} opener */
  open(opener) {
    if (this.dialog.open) return;
    this.opener = opener;
    // Close the mobile nav drawer if the search was opened from it
    document.querySelector('[data-nav-drawer].is-open [data-nav-drawer-close]')?.dispatchEvent(new Event('click'));
    this.dialog.showModal();
    document.documentElement.classList.add('ossian-search-lock');
    this.renderRecent();
    requestAnimationFrame(() => this.input.focus());
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  onClose() {
    document.documentElement.classList.remove('ossian-search-lock');
    this.opener?.focus({ preventScroll: true });
  }

  /** @param {string} rawQuery */
  async search(rawQuery) {
    const query = rawQuery.trim();
    this.abortController?.abort();

    if (!query) {
      this.showDefault();
      return;
    }

    this.abortController = new AbortController();
    this.setMode('results');
    this.dialog.querySelector('.ossian-search__body')?.scrollTo({ top: 0 });
    this.loading.hidden = false;
    this.resultsGrid.hidden = true;
    this.emptyMessage.hidden = true;

    const params = new URLSearchParams({
      q: query,
      type: 'product',
      'options[prefix]': 'last',
      section_id: 'ossian-search-results',
    });

    try {
      const response = await fetch(`${this.searchUrl}?${params}`, { signal: this.abortController.signal });
      if (!response.ok) throw new Error(`Search failed: ${response.status}`);
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const results = doc.querySelector('.ossian-search-results');
      const count = parseInt(results?.getAttribute('data-results-count') || '0', 10);

      this.loading.hidden = true;
      this.productsTitle.textContent = `Results for “${query}”`;
      this.viewAll.href = `${this.searchUrl}?${new URLSearchParams({ q: query, type: 'product', 'options[prefix]': 'last' })}`;
      this.viewAllLabel.textContent = `View All Results (${count})`;
      this.viewAll.hidden = count === 0;

      if (!results || count === 0) {
        this.resultsGrid.replaceChildren();
        this.emptyMessage.textContent = `No products found for “${query}”. Try a different term or browse a category.`;
        this.emptyMessage.hidden = false;
        return;
      }

      results.querySelectorAll('img[loading="lazy"]').forEach((img) => img.setAttribute('loading', 'eager'));
      this.resultsGrid.replaceChildren(...results.children);
      this.syncWishlist(this.resultsGrid);
      this.resultsGrid.hidden = false;
    } catch (error) {
      if (/** @type {Error} */ (error).name === 'AbortError') return;
      this.loading.hidden = true;
      this.emptyMessage.textContent = 'Something went wrong. Press Enter to see all results.';
      this.emptyMessage.hidden = false;
    }
  }

  showDefault() {
    this.setMode('default');
    this.loading.hidden = true;
    this.resultsGrid.hidden = true;
    this.emptyMessage.hidden = true;
    this.productsTitle.textContent = this.productsTitle.dataset.defaultTitle || '';
    this.viewAll.href = this.viewAll.dataset.defaultHref || this.searchUrl;
    this.viewAllLabel.textContent = this.viewAll.dataset.defaultLabel || '';
    this.viewAll.hidden = false;
  }

  /** @param {'default' | 'results'} mode */
  setMode(mode) {
    this.dialog.querySelectorAll('[data-search-default]').forEach((el) => {
      /** @type {HTMLElement} */ (el).hidden = mode !== 'default';
    });
  }

  /* ---------- Recent searches ---------- */

  /** @param {string} rawTerm */
  saveRecent(rawTerm) {
    const term = rawTerm.trim();
    if (!term) return;
    const list = readList(RECENT_KEY).filter((item) => item.toLowerCase() !== term.toLowerCase());
    list.unshift(term);
    writeList(RECENT_KEY, list.slice(0, RECENT_LIMIT));
    this.renderRecent();
  }

  /** @param {string} term */
  removeRecent(term) {
    writeList(
      RECENT_KEY,
      readList(RECENT_KEY).filter((item) => item !== term)
    );
    this.renderRecent();
  }

  renderRecent() {
    const list = readList(RECENT_KEY);
    this.recentSection.hidden = list.length === 0;
    this.recentList.replaceChildren(
      ...list.map((term) => {
        const li = document.createElement('li');
        li.className = 'ossian-search__chip';

        const termButton = document.createElement('button');
        termButton.type = 'button';
        termButton.className = 'ossian-search__chip-term';
        termButton.dataset.searchTerm = term;
        termButton.innerHTML =
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
        termButton.append(document.createTextNode(term));

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'ossian-search__chip-remove';
        removeButton.dataset.searchRecentRemove = term;
        removeButton.setAttribute('aria-label', `Remove ${term} from recent searches`);
        removeButton.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';

        li.append(termButton, removeButton);
        return li;
      })
    );
  }

  /* ---------- Cart ---------- */

  /** @param {HTMLButtonElement} button */
  async addToCart(button) {
    const variantId = button.dataset.searchAdd;
    if (!variantId) return;
    button.classList.add('is-loading');

    try {
      const response = await fetch(`${this.cartAddUrl}.js`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ items: [{ id: Number(variantId), quantity: 1 }] }),
      });
      if (!response.ok) throw new Error('Add to cart failed');

      const cart = await (await fetch('/cart.js', { headers: { Accept: 'application/json' } })).json();
      document.dispatchEvent(
        new CartAddEvent(cart, 'ossian-search', {
          source: 'ossian-search',
          itemCount: cart.item_count,
          variantId,
        })
      );

      button.classList.add('is-added');
      setTimeout(() => button.classList.remove('is-added'), 1600);
    } catch (error) {
      console.error(error);
    } finally {
      button.classList.remove('is-loading');
    }
  }

  /* ---------- Wishlist (local) ---------- */

  /** @param {HTMLButtonElement} button */
  toggleWishlist(button) {
    const id = button.dataset.searchWishlist || '';
    const list = readList(WISHLIST_KEY);
    const index = list.indexOf(id);
    if (index === -1) list.push(id);
    else list.splice(index, 1);
    writeList(WISHLIST_KEY, list);
    this.syncWishlist(this.dialog);
  }

  /** @param {ParentNode} root */
  syncWishlist(root) {
    const list = readList(WISHLIST_KEY);
    root.querySelectorAll('[data-search-wishlist]').forEach((button) => {
      button.setAttribute('aria-pressed', String(list.includes(/** @type {HTMLElement} */ (button).dataset.searchWishlist)));
    });
  }
}

const dialog = /** @type {HTMLDialogElement | null} */ (document.querySelector('[data-ossian-search]'));
if (dialog) new OssianSearch(dialog);
