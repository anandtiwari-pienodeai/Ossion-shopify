import { Component } from '@theme/component';
import {
  supportsViewTransitions,
  startViewTransition,
  onAnimationEnd,
  prefersReducedMotion,
  debounce,
  preloadImage,
  isLowPowerDevice,
} from '@theme/utilities';
import { scrollIntoView } from '@theme/scrolling';
import { ZoomMediaSelectedEvent } from '@theme/events';
import { DialogCloseEvent } from '@theme/dialog';
/**
 * A custom element that renders a zoom dialog.
 *
 * @typedef {object} Refs
 * @property {HTMLDialogElement} dialog - The dialog element.
 * @property {HTMLElement[]} media - The media elements.
 * @property {HTMLElement} thumbnails - The thumbnails elements.
 *
 * @extends Component<Refs>
 */
export class ZoomDialog extends Component {
  requiredRefs = ['dialog', 'media', 'thumbnails'];

  #highResImagesLoaded = /** @type {Set<string>} */ (new Set());

  /** @type {HTMLElement | null} */
  #mediaList = null;

  connectedCallback() {
    super.connectedCallback();
    this.refs.dialog.addEventListener('scroll', this.handleScroll);
    // When the media list is its own (horizontal) scroller, track that too. Not a capturing listener:
    // the thumbnail strip scrolling must not re-derive the selection from a media list that hasn't moved yet.
    this.#mediaList = this.refs.dialog.querySelector('.dialog-zoomed-gallery');
    this.#mediaList?.addEventListener('scroll', this.handleScroll);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.refs.dialog.removeEventListener('scroll', this.handleScroll);
    this.#mediaList?.removeEventListener('scroll', this.handleScroll);
  }

  /**
   * Brings a media item into view. A horizontally scrolling media list is scrolled directly, so other
   * scroll animations (thumbnail strip, page gallery sync) can't cancel it mid-way.
   * @param {HTMLElement} targetImage
   * @param {ScrollBehavior} behavior
   */
  #scrollMediaIntoView(targetImage, behavior) {
    const list = targetImage.parentElement;
    if (list && this.#isHorizontalList(list)) {
      // Jump instantly: a smooth scroll here gets cancelled part-way by the page gallery syncing to the
      // selection (ZoomMediaSelectedEvent). A short fade on the incoming slide keeps the change soft.
      list.scrollTo({ left: targetImage.offsetLeft - list.offsetLeft, behavior: 'instant' });
      if (behavior !== 'instant' && !prefersReducedMotion()) {
        targetImage.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
      }
      return;
    }
    targetImage.scrollIntoView({ behavior, block: 'nearest', inline: 'start' });
  }

  /**
   * The media item currently in view. With a horizontal one-per-view list the scroll position says exactly
   * which item that is; otherwise fall back to measuring visibility.
   * @returns {Promise<HTMLElement>}
   */
  async #currentMedia() {
    const { media } = this.refs;
    const list = this.#mediaList;
    if (list && this.#isHorizontalList(list) && list.clientWidth > 0) {
      const index = Math.min(media.length - 1, Math.max(0, Math.round(list.scrollLeft / list.clientWidth)));
      return /** @type {HTMLElement} */ (media[index]);
    }
    return getMostVisibleElement(media);
  }

  /**
   * @param {HTMLElement} list
   * @returns {boolean} Whether the media list scrolls horizontally (one item per view)
   */
  #isHorizontalList(list) {
    return list.scrollWidth > list.clientWidth + 1;
  }

  /**
   * Opens the zoom dialog.
   *
   * @param {number} index - The index of the media to zoom.
   * @param {PointerEvent} event - The pointer event.
   */
  async open(index, event) {
    event.preventDefault();

    const { dialog, media, thumbnails } = this.refs;
    const targetImage = media[index];
    const targetThumbnail = thumbnails.children[index];

    const open = () => {
      dialog.showModal();

      targetThumbnail?.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
      if (targetImage) this.#scrollMediaIntoView(targetImage, 'instant');
    };

    /** @type {HTMLElement | null} */
    const sourceImage = event.target instanceof Element ? event.target.closest('li,slideshow-slide') : null;

    if (!supportsViewTransitions() || isLowPowerDevice() || !sourceImage || !targetImage) return open();

    const itemTransitionName = `gallery-item-open`;
    sourceImage.style.setProperty('view-transition-name', itemTransitionName);

    const focalPoint = sourceImage.dataset.focalPoint;
    if (focalPoint) {
      document.documentElement.style.setProperty('--gallery-media-focal-point', focalPoint);
    }

    await startViewTransition(() => {
      open();
      sourceImage.style.removeProperty('view-transition-name');
      targetImage.style.setProperty('view-transition-name', itemTransitionName);
    });

    document.documentElement.style.removeProperty('--gallery-media-focal-point');
    targetImage.style.removeProperty('view-transition-name');

    this.selectThumbnail(index, { behavior: 'instant' });
  }

  /**
   * Loads a high-resolution image for a specific media container
   * @param {HTMLElement} mediaContainer - The media container element
   */
  loadHighResolutionImage(mediaContainer) {
    if (!mediaContainer.classList.contains('product-media-container--image')) return false;

    const image = mediaContainer.querySelector('img.product-media__image');
    if (!image || !(image instanceof HTMLImageElement)) return false;

    const highResolutionUrl = image.getAttribute('data_max_resolution');
    if (!highResolutionUrl || this.#highResImagesLoaded.has(highResolutionUrl)) return false;

    preloadImage(highResolutionUrl);

    const newImage = new Image();
    newImage.className = image.className;
    newImage.alt = image.alt;
    newImage.setAttribute('data_max_resolution', highResolutionUrl);
    newImage.setAttribute('ref', 'image');

    // When the high-resolution image loads, replace the existing image
    newImage.onload = () => {
      image.replaceWith(newImage);
      this.#highResImagesLoaded.add(highResolutionUrl);
    };

    newImage.src = highResolutionUrl;
  }

  /**
   * Handles the scroll event of the dialog, which is used to update the active thumbnail when the corresponding image is visible in the main view.
   * @param {Event} event - The scroll event.
   */
  handleScroll = debounce(async () => {
    const { media, thumbnails } = this.refs;

    const mostVisibleElement = await this.#currentMedia();
    const activeIndex = media.indexOf(mostVisibleElement);
    const targetThumbnail = thumbnails.children[activeIndex];

    if (!targetThumbnail || !(targetThumbnail instanceof HTMLElement)) return;

    Array.from(thumbnails.querySelectorAll('button')).forEach((button, i) => {
      button.setAttribute('aria-selected', `${i === activeIndex}`);
    });

    this.loadHighResolutionImage(mostVisibleElement);
    this.dispatchEvent(new ZoomMediaSelectedEvent(activeIndex));
  }, 50);

  /**
   * Closes the zoom dialog.
   */
  async close() {
    const { dialog, media } = this.refs;

    if (!supportsViewTransitions() || isLowPowerDevice()) return this.closeDialog();

    // Find the image currently in view
    const mostVisibleElement = await this.#currentMedia();

    // Get the index and set up transition
    const activeIndex = media.indexOf(mostVisibleElement);
    const itemTransitionName = `gallery-item-close`;

    const mediaGallery = /** @type {import('./media-gallery').MediaGallery | undefined} */ (
      this.closest('media-gallery')
    );

    const slideshowActive = mediaGallery?.presentation === 'carousel';

    const slide = slideshowActive ? mediaGallery.slideshow?.slides?.[activeIndex] : mediaGallery?.media?.[activeIndex];

    if (!slide) return this.closeDialog();
    const focalPoint = slide.dataset.focalPoint;
    if (focalPoint) {
      document.documentElement.style.setProperty('--gallery-media-focal-point', focalPoint);
    }

    dialog.classList.add('dialog--closed');

    await onAnimationEnd(this.refs.thumbnails);

    mostVisibleElement.style.setProperty('view-transition-name', itemTransitionName);

    try {
      await startViewTransition(() => {
        mostVisibleElement.style.removeProperty('view-transition-name');
        slide.style.setProperty('view-transition-name', itemTransitionName);
        this.closeDialog();
      });
    } catch {
      // The transition can be aborted (e.g. the tab was hidden mid-close); don't leave the dialog half-closed
    } finally {
      if (dialog.open) this.closeDialog();
      mostVisibleElement.style.removeProperty('view-transition-name');
      slide.style.removeProperty('view-transition-name');
      dialog.classList.remove('dialog--closed');
      document.documentElement.style.removeProperty('--gallery-media-focal-point');
    }
  }

  closeDialog() {
    const { dialog } = this.refs;
    dialog.close();
    window.dispatchEvent(new DialogCloseEvent());
  }

  /**
   * Closes the dialog when the user presses the escape key.
   *
   * @param {KeyboardEvent} event - The keyboard event.
   */
  handleKeyDown(event) {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.showNext();
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.showPrevious();
      return;
    }

    if (event.key !== 'Escape') return;

    event.preventDefault();
    this.close();
  }

  /**
   * Index of the currently selected media, read from the thumbnail state.
   * @returns {number}
   */
  get currentIndex() {
    const buttons = Array.from(this.refs.thumbnails?.querySelectorAll('button') ?? []);
    const index = buttons.findIndex((button) => button.getAttribute('aria-selected') === 'true');
    return Math.max(0, index);
  }

  /**
   * Shows the next media, wrapping to the first after the last.
   */
  showNext() {
    const count = this.refs.media.length;
    if (count < 2) return;
    this.handleThumbnailClick((this.currentIndex + 1) % count);
  }

  /**
   * Shows the previous media, wrapping to the last before the first.
   */
  showPrevious() {
    const count = this.refs.media.length;
    if (count < 2) return;
    this.handleThumbnailClick((this.currentIndex - 1 + count) % count);
  }

  /**
   * Closes the dialog when the click lands on the backdrop (the dialog element itself, outside the panel content).
   * @param {MouseEvent} event - The click event.
   */
  handleBackdropClick(event) {
    if (event.target !== this.refs.dialog) return;
    const rect = this.refs.dialog.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) this.close();
  }

  /**
   * Handles the click event of a thumbnail.
   * @param {number} index - The index of the thumbnail to select.
   */
  async handleThumbnailClick(index) {
    const behavior = prefersReducedMotion() ? 'instant' : 'smooth';
    this.selectThumbnail(index, { behavior });
  }

  /**
   * Handles the pointer enter event of a thumbnail.
   * @param {number} index - The index of the thumbnail to load the high-resolution image for.
   */
  async handleThumbnailPointerEnter(index) {
    const { media } = this.refs;
    if (!media[index]) return;

    this.loadHighResolutionImage(media[index]);
  }

  /**
   * Handles the selection of a thumbnail.
   * @param {number} index - The index of the thumbnail to select.
   * @param {Object} options - The options for the selection.
   * @param {ScrollBehavior} options.behavior - The behavior of the scroll.
   */
  async selectThumbnail(index, options = { behavior: 'smooth' }) {
    if (!this.refs.thumbnails || !this.refs.thumbnails.children.length) return;

    // Guard if invalid
    if (isNaN(index) || index < 0 || index >= this.refs.thumbnails.children.length) return;

    const { media, thumbnails } = this.refs;
    const targetThumbnail = thumbnails.children[index];

    if (!targetThumbnail || !(targetThumbnail instanceof HTMLElement)) return;

    Array.from(thumbnails.querySelectorAll('button')).forEach((button, i) => {
      button.setAttribute('aria-selected', `${i === index}`);
    });

    scrollIntoView(targetThumbnail, {
      ancestor: thumbnails,
      behavior: options.behavior,
      block: 'center',
      inline: 'center',
    });

    const targetImage = media[index];

    if (targetImage) {
      this.#scrollMediaIntoView(targetImage, options.behavior);

      this.loadHighResolutionImage(targetImage);
    }
    this.dispatchEvent(new ZoomMediaSelectedEvent(index));
  }
}

if (!customElements.get('zoom-dialog')) {
  customElements.define('zoom-dialog', ZoomDialog);
}

/**
 * Get the most visible element from a list of elements.
 * @param {HTMLElement[]} elements - The elements to get the most visible element from.
 * @returns {Promise<HTMLElement>} A promise that resolves to the most visible element.
 */
function getMostVisibleElement(elements) {
  return new Promise((resolve) => {
    const observer = new IntersectionObserver(
      (entries) => {
        const mostVisible = entries.reduce((prev, current) =>
          current.intersectionRatio > prev.intersectionRatio ? current : prev
        );
        observer.disconnect();
        resolve(/** @type {HTMLElement} */ (mostVisible.target));
      },
      {
        threshold: Array.from({ length: 100 }, (_, i) => i / 100),
      }
    );

    for (const element of elements) {
      observer.observe(element);
    }
  });
}
