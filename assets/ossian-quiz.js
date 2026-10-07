import { Component } from '@theme/component';
import { recommend } from '@theme/ossian-quiz-rules';

const AUTO_ADVANCE_DELAY = 280;
const JOURNEYS = ['hair', 'skin'];

/**
 * @typedef {Object} QuizRefs
 * @property {HTMLElement} landing
 * @property {HTMLElement} flow
 * @property {HTMLElement} result
 * @property {HTMLFormElement} form
 * @property {HTMLElement} progress
 * @property {HTMLElement} progressFill
 * @property {HTMLElement} progressCount
 * @property {HTMLButtonElement} continue
 * @property {HTMLButtonElement} skip
 * @property {HTMLElement} resultHeading
 * @property {HTMLElement} resultContent
 * @property {HTMLElement} heroSlot
 * @property {HTMLElement} routine
 * @property {HTMLElement} routineList
 * @property {HTMLElement} error
 * @property {HTMLElement} status
 * @property {HTMLTemplateElement} heroTemplate
 * @property {HTMLTemplateElement} cardTemplate
 * @property {HTMLScriptElement} data
 */

/**
 * @typedef {Object} QuizState
 * @property {'hair' | 'skin' | null} journey
 * @property {Record<string, string>} answers
 * @property {number} index
 * @property {'landing' | 'flow' | 'result'} view
 */

/**
 * Ossion product recommendation quiz. Markup and copy are rendered by
 * sections/ossian-quiz.liquid; this component owns navigation, persistence and
 * result rendering. Scoring lives in assets/ossian-quiz-rules.js.
 *
 * Emits a bubbling `ossion-quiz:track` CustomEvent (and Shopify.analytics.publish
 * when available) for: quiz_started, quiz_category_selected, quiz_question_answered,
 * quiz_completed, quiz_recommendation_viewed, quiz_product_clicked, quiz_retake.
 *
 * @extends {Component<QuizRefs>}
 */
class OssianQuiz extends Component {
  requiredRefs = ['landing', 'flow', 'result', 'form', 'continue', 'heroTemplate', 'cardTemplate', 'data'];

  /** @type {QuizState} */
  state = { journey: null, answers: {}, index: 0, view: 'landing' };

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #advanceTimer;

  /** @type {{ sets: any[], products: any[] } | null} */
  #data = null;

  /** True when the latest answer came from the keyboard; arrow keys select radios, so those wait for Continue. */
  #keyboardSelection = false;

  /** @type {AbortController | undefined} */
  #abortController;

  connectedCallback() {
    super.connectedCallback();
    this.#abortController = new AbortController();
    const { signal } = this.#abortController;
    this.refs.form.addEventListener('pointerdown', () => (this.#keyboardSelection = false), { signal });
    this.refs.form.addEventListener('keydown', () => (this.#keyboardSelection = true), { signal });
    this.#restore();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#abortController?.abort();
    clearTimeout(this.#advanceTimer);
  }

  get #storageKey() {
    return `ossion-quiz:${this.dataset.sectionId}`;
  }

  get #questions() {
    return /** @type {HTMLFieldSetElement[]} */ ([...this.refs.form.querySelectorAll('fieldset[data-question]')]);
  }

  /**
   * Questions for the current journey whose conditions are met, in order.
   * @returns {HTMLFieldSetElement[]}
   */
  get #sequence() {
    return this.#questions.filter((fieldset) => {
      if (fieldset.dataset.journey !== this.state.journey) return false;
      const when = fieldset.dataset.when;
      if (!when) return true;
      const [question, value] = when.split(':');
      return question !== undefined && this.state.answers[question] === value;
    });
  }

  /** Total steps: unconditional questions plus one per conditional group, so the count never jumps. */
  get #totalSteps() {
    const groups = new Set();
    for (const fieldset of this.#questions) {
      if (fieldset.dataset.journey !== this.state.journey) continue;
      groups.add(fieldset.dataset.when ? `when:${fieldset.dataset.when.split(':')[0]}` : fieldset.dataset.question);
    }
    return groups.size;
  }

  get #currentQuestion() {
    return this.#sequence[this.state.index];
  }

  /* ---------- Public handlers (declarative events) ---------- */

  /** @param {MouseEvent} event */
  handleJourneyClick = (event) => {
    const link = event.target;
    if (!(link instanceof HTMLElement)) return;
    const journey = link.dataset.journey;
    if (!this.#isJourney(journey)) return;
    // Plain clicks stay in-page; modified clicks open the shareable link as usual.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    this.#start(journey);
  };

  /** @param {Event} event */
  handleAnswer = (event) => {
    // The framework retargets `event.target` to the form that declares on:change; the path keeps the radio.
    const input = event.composedPath()[0];
    if (!(input instanceof HTMLInputElement) || input.type !== 'radio') return;

    const fieldset = input.closest('fieldset[data-question]');
    if (!(fieldset instanceof HTMLFieldSetElement) || fieldset !== this.#currentQuestion) return;

    this.state.answers[input.name] = input.value;
    this.#save();
    this.#track('quiz_question_answered', {
      question: input.name,
      answer: input.value,
      step: this.state.index + 1,
    });
    this.#updateActions();

    const mode = fieldset.dataset.mode;
    if ((mode === 'auto' || mode === 'optional') && !this.#keyboardSelection) {
      clearTimeout(this.#advanceTimer);
      this.#advanceTimer = setTimeout(() => {
        if (this.#currentQuestion === fieldset) this.#next();
      }, AUTO_ADVANCE_DELAY);
    }
  };

  /** @param {SubmitEvent} event */
  handleSubmit = (event) => {
    event.preventDefault();
    const question = this.#currentQuestion;
    if (!question) return;
    if (!this.state.answers[question.dataset.question ?? ''] && question.dataset.mode !== 'optional') return;
    this.#next();
  };

  skipQuestion = () => {
    const question = this.#currentQuestion;
    if (!question || question.dataset.mode !== 'optional') return;
    const name = question.dataset.question ?? '';
    delete this.state.answers[name];
    for (const input of question.querySelectorAll('input')) input.checked = false;
    this.#track('quiz_question_answered', { question: name, answer: 'skipped', step: this.state.index + 1 });
    this.#next();
  };

  goBack = () => {
    clearTimeout(this.#advanceTimer);
    if (this.state.view === 'result') {
      this.state.index = Math.max(this.#sequence.length - 1, 0);
      this.#showFlow(-1);
      return;
    }
    if (this.state.index > 0) {
      this.state.index -= 1;
      this.#showFlow(-1);
      return;
    }
    this.#showLanding();
  };

  retake = () => {
    this.#track('quiz_retake', {});
    this.#clear();
    this.#showLanding();
  };

  /** @param {MouseEvent} event */
  trackProductClick = (event) => {
    const link = event.target;
    if (!(link instanceof HTMLElement)) return;
    this.#track('quiz_product_clicked', {
      product: link.dataset.handle,
      position: link.dataset.position,
    });
  };

  /* ---------- Flow ---------- */

  /** @param {'hair' | 'skin'} journey */
  #start(journey) {
    if (this.state.journey !== journey) {
      this.state = { journey, answers: {}, index: 0, view: 'flow' };
      this.#syncInputs();
    }
    this.state.index = 0;
    this.#track('quiz_started', {});
    this.#track('quiz_category_selected', { answer: journey });
    this.#showFlow(1);
  }

  #next() {
    clearTimeout(this.#advanceTimer);
    if (this.state.index < this.#sequence.length - 1) {
      this.state.index += 1;
      this.#showFlow(1);
    } else {
      this.#showResult();
    }
  }

  /** @param {1 | -1 | 0} direction */
  #showFlow(direction) {
    const sequence = this.#sequence;
    this.state.index = Math.min(Math.max(this.state.index, 0), Math.max(sequence.length - 1, 0));
    this.state.view = 'flow';
    this.#setScreen('flow');
    this.#setUrl(this.state.journey);

    const current = sequence[this.state.index];
    const total = this.#totalSteps;
    const stepNumber = this.state.index + 1;
    const stepText = (this.dataset.stepTemplate ?? '')
      .replace('[current]', String(stepNumber))
      .replace('[total]', String(total));

    for (const fieldset of this.#questions) {
      const active = fieldset === current;
      fieldset.hidden = !active;
      fieldset.disabled = !active;
      if (!active) continue;
      const label = fieldset.querySelector('[data-step-label]');
      if (label) label.textContent = stepText;
      fieldset.dataset.direction = direction < 0 ? 'back' : 'forward';
      fieldset.classList.remove('is-entering');
      if (direction !== 0) {
        void fieldset.offsetWidth;
        fieldset.classList.add('is-entering');
      }
    }

    const percent = total ? Math.round((stepNumber / total) * 100) : 0;
    this.refs.progressFill?.style.setProperty('--ossion-quiz-progress', `${percent}%`);
    this.refs.progress?.setAttribute('aria-valuenow', String(percent));
    this.refs.progress?.setAttribute('aria-valuetext', stepText);
    if (this.refs.progressCount) this.refs.progressCount.textContent = `${stepNumber}/${total}`;

    this.#updateActions();
    this.#save();

    if (direction !== 0) this.#focusHeading(current?.querySelector('h2'));
  }

  #updateActions() {
    const question = this.#currentQuestion;
    if (!question) return;
    const mode = question.dataset.mode;
    const answered = Boolean(this.state.answers[question.dataset.question ?? '']);

    // Auto-advancing questions only need Continue when revisiting an answered step.
    this.refs.continue.hidden = mode !== 'continue' && !answered;
    this.refs.continue.disabled = mode === 'continue' && !answered;
    if (this.refs.skip) this.refs.skip.hidden = mode !== 'optional';
  }

  #showLanding() {
    clearTimeout(this.#advanceTimer);
    this.state.view = 'landing';
    this.#setScreen('landing');
    this.#setUrl(null);
    this.#save();
    this.#focusHeading(this.refs.landing.querySelector('h1'));
  }

  #showResult() {
    const journey = this.state.journey;
    if (!journey) return;

    // Only answers on the active path influence the result.
    /** @type {Record<string, string>} */
    const answers = {};
    /** @type {Record<string, string>} */
    const reasons = {};
    for (const fieldset of this.#sequence) {
      const name = fieldset.dataset.question ?? '';
      if (this.state.answers[name]) answers[name] = this.state.answers[name];
      for (const input of fieldset.querySelectorAll('input[data-reason]')) {
        if (input instanceof HTMLInputElement) reasons[input.value] = input.dataset.reason ?? '';
      }
    }

    const recommendation = recommend(journey, answers, this.#getData(), reasons, {
      includeSoldOut: this.dataset.includeSoldOut === 'true',
    });

    this.state.view = 'result';
    this.#save();
    this.#setScreen('result');
    this.#renderResult(recommendation);
    this.#track('quiz_completed', { answers });

    if (recommendation) {
      this.#track('quiz_recommendation_viewed', {
        product: recommendation.primaryProduct.handle,
        supporting: recommendation.supportingProducts.map((product) => product.handle),
        matchedConcerns: recommendation.matchedConcerns,
      });
      this.#announce(this.dataset.resultReady ?? '');
    }

    this.#focusHeading(this.refs.resultHeading);
  }

  /** @param {import('@theme/ossian-quiz-rules').Recommendation | null} recommendation */
  #renderResult(recommendation) {
    const { heroSlot, routine, routineList, resultContent, error, heroTemplate, cardTemplate } = this.refs;
    heroSlot.replaceChildren();
    routineList?.replaceChildren();

    resultContent.hidden = !recommendation;
    error.hidden = Boolean(recommendation);
    if (!recommendation) {
      this.#announce(error.querySelector('.ossion-quiz__error-text')?.textContent?.trim() ?? '');
      return;
    }

    const hero = /** @type {DocumentFragment} */ (heroTemplate.content.cloneNode(true));
    const product = recommendation.primaryProduct;
    this.#fillProduct(hero, product, 1, '(min-width: 990px) 30vw, 90vw', true);
    this.#setSlotText(hero, 'reason', recommendation.reason || product.excerpt);
    this.#setSlotText(hero, 'type', product.type);
    heroSlot.append(hero);

    if (routine && routineList) {
      recommendation.supportingProducts.forEach((supporting, index) => {
        const card = /** @type {DocumentFragment} */ (cardTemplate.content.cloneNode(true));
        this.#fillProduct(card, supporting, index + 2, '96px', false);
        this.#setSlotText(card, 'excerpt', supporting.excerpt);
        routineList.append(card);
      });
      routine.hidden = recommendation.supportingProducts.length === 0;
    }
  }

  /**
   * @param {DocumentFragment} fragment
   * @param {import('@theme/ossian-quiz-rules').QuizProduct} product
   * @param {number} position
   * @param {string} sizes
   * @param {boolean} eager
   */
  #fillProduct(fragment, product, position, sizes, eager) {
    for (const link of fragment.querySelectorAll('a[data-slot="link"], a[data-slot="link-media"]')) {
      if (!(link instanceof HTMLAnchorElement)) continue;
      link.href = product.url;
      link.dataset.handle = product.handle;
      link.dataset.position = String(position);
    }

    this.#setSlotText(fragment, 'title', product.title);
    const price = product.compareAtPrice ? `${product.price} ` : product.price;
    this.#setSlotText(fragment, 'price', price);
    if (product.compareAtPrice) {
      const compare = document.createElement('s');
      compare.textContent = product.compareAtPrice;
      fragment.querySelector('[data-slot="price"]')?.append(compare);
    }

    const imageSlot = fragment.querySelector('[data-slot="image"]');
    if (imageSlot && product.image) {
      const img = document.createElement('img');
      img.src = product.image.src;
      img.srcset = product.image.srcset;
      img.sizes = sizes;
      if (product.image.width) img.width = product.image.width;
      if (product.image.height) img.height = product.image.height;
      img.alt = product.image.alt || product.title;
      img.loading = eager ? 'eager' : 'lazy';
      img.decoding = 'async';
      imageSlot.append(img);
    }
  }

  /**
   * @param {ParentNode} root
   * @param {string} slot
   * @param {string | undefined} text
   */
  #setSlotText(root, slot, text) {
    const element = root.querySelector(`[data-slot="${slot}"]`);
    if (!element) return;
    element.textContent = text ?? '';
    if (element instanceof HTMLElement) element.hidden = !text;
  }

  /* ---------- Helpers ---------- */

  /** @param {'landing' | 'flow' | 'result'} screen */
  #setScreen(screen) {
    this.refs.landing.hidden = screen !== 'landing';
    this.refs.flow.hidden = screen !== 'flow';
    this.refs.result.hidden = screen !== 'result';
    this.dataset.view = screen;
    if (this.state.journey) this.dataset.journey = this.state.journey;
  }

  /** @param {Element | null | undefined} heading */
  #focusHeading(heading) {
    if (!(heading instanceof HTMLElement)) return;
    heading.focus({ preventScroll: true });
    const top = this.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight / 2) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    }
  }

  /** @param {string} message */
  #announce(message) {
    if (!this.refs.status || !message) return;
    this.refs.status.textContent = '';
    // A short delay makes repeated messages register as new announcements.
    setTimeout(() => {
      if (this.refs.status) this.refs.status.textContent = message;
    }, 100);
  }

  /** @param {string | null} journey */
  #setUrl(journey) {
    const url = new URL(window.location.href);
    if (journey) url.searchParams.set('type', journey);
    else url.searchParams.delete('type');
    if (url.href !== window.location.href) history.replaceState(history.state, '', url);
  }

  /** @param {unknown} value @returns {value is 'hair' | 'skin'} */
  #isJourney(value) {
    return typeof value === 'string' && JOURNEYS.includes(value);
  }

  #getData() {
    if (this.#data) return this.#data;
    try {
      this.#data = JSON.parse(this.refs.data.textContent || '{}');
    } catch (error) {
      console.error('Ossion quiz: invalid recommendation data', error);
      this.#data = { sets: [], products: [] };
    }
    return /** @type {{ sets: any[], products: any[] }} */ (this.#data);
  }

  /** Reflect state.answers onto the radio inputs. */
  #syncInputs() {
    for (const input of this.refs.form.querySelectorAll('input[type="radio"]')) {
      if (input instanceof HTMLInputElement) input.checked = this.state.answers[input.name] === input.value;
    }
  }

  #save() {
    try {
      if (this.state.view === 'landing' && !this.state.journey) {
        sessionStorage.removeItem(this.#storageKey);
      } else {
        sessionStorage.setItem(this.#storageKey, JSON.stringify(this.state));
      }
    } catch {
      // Storage can be unavailable (private mode, blocked site data); the quiz still works without it.
    }
  }

  #clear() {
    clearTimeout(this.#advanceTimer);
    this.state = { journey: null, answers: {}, index: 0, view: 'landing' };
    this.#syncInputs();
    try {
      sessionStorage.removeItem(this.#storageKey);
    } catch {
      // See #save.
    }
  }

  #restore() {
    const requested = new URL(window.location.href).searchParams.get('type');

    /** @type {Partial<QuizState> | null} */
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(this.#storageKey) || 'null');
    } catch {
      saved = null;
    }

    if (!this.#isJourney(requested)) {
      this.#setScreen('landing');
      return;
    }

    if (saved && saved.journey === requested && saved.answers && typeof saved.answers === 'object') {
      this.state = {
        journey: requested,
        answers: saved.answers,
        index: Number(saved.index) || 0,
        view: saved.view === 'result' ? 'result' : 'flow',
      };
      this.#syncInputs();
      if (this.state.view === 'result') this.#showResult();
      else this.#showFlow(0);
      return;
    }

    this.state = { journey: requested, answers: {}, index: 0, view: 'flow' };
    this.#syncInputs();
    this.#track('quiz_started', {});
    this.#track('quiz_category_selected', { answer: requested });
    this.#showFlow(0);
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown>} detail
   */
  #track(name, detail) {
    const payload = { category: this.state.journey, ...detail };
    this.dispatchEvent(new CustomEvent('ossion-quiz:track', { bubbles: true, detail: { name, ...payload } }));
    try {
      // @ts-ignore Shopify customer events, available when the store has analytics enabled.
      window.Shopify?.analytics?.publish?.(name, payload);
    } catch {
      // Analytics must never break the quiz.
    }
  }
}

if (!customElements.get('ossian-quiz')) {
  customElements.define('ossian-quiz', OssianQuiz);
}
