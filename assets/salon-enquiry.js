import { DialogComponent, DialogCloseEvent } from '@theme/dialog';
import { ThemeEvents } from '@theme/events';

/**
 * Salon-only product enquiry popup.
 *
 * Rendered once per page by snippets/salon-enquiry-modal.liquid. Any
 * `[data-salon-enquiry]` button (snippets/salon-enquiry-button.liquid) opens it with that
 * button's product details. On a valid submit it opens WhatsApp (wa.me) with a pre-filled
 * message. It never adds anything to the cart.
 *
 * Extends DialogComponent for the modal itself: scroll lock, Escape, outside click and the
 * open/close animation.
 *
 * @typedef {object} Refs
 * @property {HTMLDialogElement} dialog
 * @property {HTMLFormElement} form
 * @property {HTMLElement} formView
 * @property {HTMLElement} successView
 * @property {HTMLElement} successHeading
 * @property {HTMLElement} productTitle
 * @property {HTMLElement} productMeta
 * @property {HTMLImageElement} productImage
 * @property {HTMLElement} formError
 * @property {HTMLButtonElement} submitButton
 * @property {HTMLAnchorElement} whatsappLink
 * @property {HTMLScriptElement} messageStrings
 *
 * @typedef {object} EnquiryProduct
 * @property {string} title
 * @property {string} url
 * @property {string} sku
 * @property {string} variant
 * @property {string} image
 */

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// 2-digit state code (01–38, 97 other territory, 99 centre), PAN (5 letters, 4 digits, 1 letter),
// entity number, the fixed "Z", then the check character.
const GSTIN_PATTERN = /^(0[1-9]|[12][0-9]|3[0-8]|97|99)[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * Validates an Indian GSTIN: format plus its mod-36 check character.
 * @param {string} value - Uppercased GSTIN without spaces
 * @returns {boolean}
 */
export function isValidGstin(value) {
  if (!GSTIN_PATTERN.test(value)) return false;

  let sum = 0;
  for (let index = 0; index < 14; index++) {
    const product = GSTIN_CHARS.indexOf(value.charAt(index)) * (index % 2 ? 2 : 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS.charAt((36 - (sum % 36)) % 36) === value.charAt(14);
}

/**
 * Normalises an Indian mobile number to 10 digits, or returns null when invalid.
 * Accepts spaces, dashes and a leading +91, 91 or 0.
 * @param {string} value
 * @returns {string | null}
 */
export function normaliseIndianMobile(value) {
  let digits = value.replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(digits)) return null;
  digits = digits.replace(/^\+/, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/**
 * Decodes HTML entities in a plain string without running any markup.
 * @param {string} value
 * @returns {string}
 */
function decodeEntities(value) {
  if (!value.includes('&')) return value;
  return new DOMParser().parseFromString(`<!doctype html><body>${value}`, 'text/html').body.textContent || '';
}

/** @extends {DialogComponent} */
class SalonEnquiryComponent extends DialogComponent {
  requiredRefs = ['dialog', 'form', 'formView', 'successView', 'submitButton', 'messageStrings'];

  /** @type {EnquiryProduct | null} */
  #product = null;

  /** @type {HTMLElement | null} */
  #trigger = null;

  /** @type {AbortController | null} */
  #abortController = null;

  /** @type {Record<string, any>} */
  #strings = {};

  connectedCallback() {
    super.connectedCallback();

    try {
      // Liquid's `t` filter HTML-escapes text (aren't → aren&#39;t); decode it for textContent and the message.
      this.#strings = JSON.parse(this.refs.messageStrings.textContent || '{}', (_key, value) =>
        typeof value === 'string' ? decodeEntities(value) : value
      );
    } catch {
      this.#strings = {};
    }

    this.#abortController = new AbortController();
    const { signal } = this.#abortController;

    // Delegated so buttons rendered later (search results, section re-renders) work too.
    document.addEventListener('click', this.#handleTriggerClick, { signal });
    document.addEventListener(ThemeEvents.variantUpdate, this.#handleVariantUpdate, { signal });
    this.refs.form.addEventListener('input', this.#handleInput, { signal });
    this.refs.form.addEventListener('focusout', this.#handleFocusOut, { signal });
    this.addEventListener(DialogCloseEvent.eventName, this.#handleClosed, { signal });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abortController?.abort();
    this.#abortController = null;
  }

  get whatsappNumber() {
    return (this.dataset.whatsappNumber || '').replace(/\D/g, '');
  }

  /** @param {MouseEvent} event */
  #handleTriggerClick = (event) => {
    if (!(event.target instanceof Element)) return;
    const trigger = event.target.closest('[data-salon-enquiry]');
    if (!(trigger instanceof HTMLElement)) return;

    // Card buttons can sit near links; never follow them or submit a surrounding form.
    event.preventDefault();
    event.stopPropagation();
    this.open(trigger);
  };

  /**
   * Opens the popup for the product described by a trigger's data attributes.
   * @param {HTMLElement} trigger
   */
  open(trigger) {
    const { dataset } = trigger;
    this.#trigger = trigger;
    this.#product = {
      title: dataset.productTitle || '',
      url: dataset.productUrl || window.location.href,
      sku: dataset.productSku || '',
      variant: dataset.productVariant || '',
      image: dataset.productImage || '',
    };

    this.#renderProduct();
    this.#showForm();
    this.showDialog();

    // showDialog opens on the next frame; focus the first field once it is visible.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const firstInvalid = this.refs.form.querySelector('[aria-invalid="true"]');
        const target = firstInvalid || this.refs.form.querySelector('input');
        if (target instanceof HTMLInputElement) target.focus();
      });
    });
  }

  #renderProduct() {
    const product = this.#product;
    if (!product) return;
    const { productTitle, productMeta, productImage } = this.refs;

    if (productTitle) productTitle.textContent = product.title;
    if (productMeta) {
      productMeta.textContent = [product.variant, product.sku ? `SKU: ${product.sku}` : '']
        .filter(Boolean)
        .join(' · ');
    }
    if (productImage) {
      if (product.image) {
        productImage.src = product.image;
        productImage.alt = '';
        productImage.hidden = false;
      } else {
        productImage.removeAttribute('src');
        productImage.hidden = true;
      }
    }
  }

  #showForm() {
    this.refs.dialog.dataset.view = 'form';
    this.refs.formView.hidden = false;
    this.refs.successView.hidden = true;
    this.#setBusy(false);
    this.#setFormError('');
  }

  #handleClosed = () => {
    // Return focus to the button that opened the popup.
    if (this.#trigger?.isConnected) this.#trigger.focus();
    // After a sent enquiry, start fresh next time.
    if (!this.refs.successView.hidden) {
      this.refs.form.reset();
      this.#clearErrors();
    }
  };

  /**
   * Keeps product-page triggers in step with the selected variant. The variant picker
   * delivers the re-rendered section; copy the matching trigger's details from it.
   * @param {Event} event
   */
  #handleVariantUpdate = (event) => {
    const detail = /** @type {any} */ (event).detail;
    const html = detail?.data?.html;
    const productId = detail?.data?.productId;
    if (!html || !productId || typeof html.querySelector !== 'function') return;

    const source = html.querySelector(`[data-salon-enquiry][data-product-id="${CSS.escape(String(productId))}"]`);
    if (!(source instanceof HTMLElement)) return;

    const keys = ['productTitle', 'productUrl', 'productSku', 'productVariant', 'productImage'];
    for (const trigger of document.querySelectorAll(
      `[data-salon-enquiry][data-product-id="${CSS.escape(String(productId))}"]`
    )) {
      if (!(trigger instanceof HTMLElement)) continue;
      for (const key of keys) {
        const value = source.dataset[key];
        if (value === undefined) delete trigger.dataset[key];
        else trigger.dataset[key] = value;
      }
    }
  };

  /** @param {Event} event */
  #handleInput = (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;

    if (input.name === 'gst_number') {
      const cleaned = input.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
      if (cleaned !== input.value) input.value = cleaned;
    }

    // Re-check a field the shopper is correcting so its error clears as soon as it is valid.
    if (input.getAttribute('aria-invalid') === 'true') this.#validateField(input);
  };

  /** @param {FocusEvent} event */
  #handleFocusOut = (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.value.trim() !== '') this.#validateField(input);
  };

  /**
   * @param {HTMLInputElement} input
   * @returns {boolean}
   */
  #validateField(input) {
    const errors = this.#strings.errors || {};
    const value = input.value.trim();
    let message = '';

    if (value === '') {
      message = errors.required || 'This field is required.';
    } else if (input.name === 'gst_number' && !isValidGstin(value.toUpperCase())) {
      message = errors.gst || 'Enter a valid 15-character GSTIN.';
    } else if (input.name === 'contact_number' && !normaliseIndianMobile(value)) {
      message = errors.phone || 'Enter a valid 10-digit mobile number.';
    }

    this.#setFieldError(input, message);
    return message === '';
  }

  /**
   * @param {HTMLInputElement} input
   * @param {string} message
   */
  #setFieldError(input, message) {
    const error = this.querySelector(`#${input.id}-error`);
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (error) {
      error.textContent = message;
      error.hidden = !message;
    }
  }

  #clearErrors() {
    for (const input of this.refs.form.querySelectorAll('input')) this.#setFieldError(input, '');
    this.#setFormError('');
  }

  /** @param {string} message */
  #setFormError(message) {
    const { formError } = this.refs;
    if (!formError) return;
    formError.textContent = message;
    formError.hidden = !message;
  }

  /** @param {boolean} busy */
  #setBusy(busy) {
    const { submitButton } = this.refs;
    submitButton.disabled = busy;
    submitButton.setAttribute('aria-busy', String(busy));
  }

  /** @param {SubmitEvent} event */
  handleSubmit(event) {
    event.preventDefault();
    const { form } = this.refs;
    const errors = this.#strings.errors || {};

    const inputs = /** @type {HTMLInputElement[]} */ (Array.from(form.querySelectorAll('input')));
    const invalid = inputs.filter((input) => !this.#validateField(input));
    if (invalid.length > 0) {
      this.#setFormError(errors.summary || 'Please correct the highlighted fields.');
      invalid[0]?.focus();
      return;
    }
    this.#setFormError('');

    const number = this.whatsappNumber;
    if (!number) {
      this.#setFormError(errors.notConfigured || 'WhatsApp enquiries are not available right now.');
      return;
    }

    const url = `https://wa.me/${number}?text=${encodeURIComponent(this.#buildMessage())}`;

    this.#setBusy(true);
    // Open synchronously inside the submit gesture so pop-up blockers allow it. On phones
    // wa.me hands over to the WhatsApp app; on desktop it opens WhatsApp Web.
    const whatsappWindow = window.open(url, '_blank');
    if (whatsappWindow) {
      whatsappWindow.opener = null;
    } else {
      // Pop-up blocked (common in in-app browsers): go there in this tab instead.
      window.location.href = url;
    }

    if (this.refs.whatsappLink) this.refs.whatsappLink.href = url;
    window.setTimeout(() => {
      this.#setBusy(false);
      this.refs.formView.hidden = true;
      this.refs.successView.hidden = false;
      this.refs.dialog.dataset.view = 'success';
      this.refs.successHeading?.focus();
    }, 400);
  }

  #buildMessage() {
    const s = this.#strings;
    const form = this.refs.form;
    const field = (/** @type {string} */ name) => {
      const input = form.elements.namedItem(name);
      return input instanceof HTMLInputElement ? input.value.trim().replace(/\s+/g, ' ') : '';
    };
    const product = this.#product || { title: '', url: window.location.href, sku: '', variant: '', image: '' };
    const na = s.notApplicable || 'N/A';
    const phone = normaliseIndianMobile(field('contact_number'));

    return [
      s.intro,
      '',
      s.salonDetails,
      `${s.salonName}: ${field('salon_name')}`,
      `${s.ownerName}: ${field('owner_name')}`,
      `${s.gstNumber}: ${field('gst_number').toUpperCase()}`,
      `${s.contactNumber}: ${phone ? `+91 ${phone}` : field('contact_number')}`,
      '',
      s.productDetails,
      `${s.productName}: ${product.title}`,
      `${s.productSku}: ${product.sku || na}`,
      `${s.variant}: ${product.variant || na}`,
      `${s.productUrl}: ${product.url}`,
      '',
      s.outro,
      '',
      s.thanks,
    ].join('\n');
  }
}

if (!customElements.get('salon-enquiry-component')) {
  customElements.define('salon-enquiry-component', SalonEnquiryComponent);
}
