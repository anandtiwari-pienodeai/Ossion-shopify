import { ThemeEvents, VariantUpdateEvent } from '@theme/events';

/**
 * Keeps the PDP size badge in sync with the selected variant by swapping in the
 * badge from the section HTML that the variant picker fetches.
 */
class OssianSizeBadge extends HTMLElement {
  /** @type {AbortController | undefined} */
  #abortController;

  connectedCallback() {
    this.#abortController?.abort();
    this.#abortController = new AbortController();
    this.closest('.shopify-section, dialog')?.addEventListener(ThemeEvents.variantUpdate, this.#handleVariantUpdate, {
      signal: this.#abortController.signal,
    });
  }

  disconnectedCallback() {
    this.#abortController?.abort();
  }

  /**
   * @param {Event} event
   */
  #handleVariantUpdate = (event) => {
    if (!(event instanceof VariantUpdateEvent)) return;

    const html = event.detail.data.html;
    if (!html) return;

    const source = html.querySelector(`ossian-size-badge[data-block-id="${CSS.escape(this.dataset.blockId ?? '')}"]`);
    if (source) this.innerHTML = source.innerHTML;
  };
}

if (!customElements.get('ossian-size-badge')) {
  customElements.define('ossian-size-badge', OssianSizeBadge);
}
