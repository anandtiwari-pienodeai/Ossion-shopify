/**
 * Ossion quiz recommendation engine.
 *
 * Products come from the merchant's "Recommendation set" blocks in sections/ossian-quiz.liquid.
 * This module only scores them: it never names products, so the catalogue can change in the
 * theme editor without touching code.
 *
 * Scoring
 *  +5 (4, 3)  product sits in a set for the shopper's primary concern; earlier = stronger
 *  +3         that set targets the shopper's follow-up answer
 *  +2 / +1    product title or type matches keywords for the other answers
 *
 * A product needs at least two keyword matches to overtake the merchant's next pick.
 */

/** @typedef {Record<string, string>} QuizAnswers */

/**
 * @typedef {Object} QuizProduct
 * @property {string} handle
 * @property {string} title
 * @property {string} url
 * @property {string} type
 * @property {string[]} tags
 * @property {boolean} available
 * @property {string} price
 * @property {string | null} compareAtPrice
 * @property {string} excerpt
 * @property {{ src: string, srcset: string, width: number, height: number, alt: string } | null} image
 */

/**
 * @typedef {Object} RecommendationSet
 * @property {string} concern - `<journey>-<concern>`, e.g. `hair-colour`.
 * @property {string} refine - `any` or `<question>:<answer>`.
 * @property {string} reason
 * @property {string[]} products - Product handles in merchant order.
 */

/**
 * @typedef {Object} Recommendation
 * @property {QuizProduct} primaryProduct
 * @property {QuizProduct[]} supportingProducts
 * @property {string} reason
 * @property {string[]} matchedConcerns
 */

/** The question whose answer is the primary concern, per journey. */
export const CONCERN_QUESTION = {
  hair: 'primary_concern',
  skin: 'skin_goal',
};

/** Follow-up question asked for each primary concern. */
export const FOLLOW_UP_QUESTION = {
  colour: 'colour_goal',
  blonde: 'blonde_need',
  smoothing: 'smooth_result',
  hydration: 'hair_condition',
  scalp: 'scalp_need',
  pigmentation: 'pigment_concern',
  waxing: 'wax_need',
  glow: 'glow_type',
};

const SCORE = {
  concern: 5,
  positionStep: 1,
  concernFloor: 3,
  followUp: 3,
  typeMatch: 2,
  preferenceMatch: 1,
};

/**
 * Keyword signals for the remaining answers. Weight `typeMatch` is used for the hair/skin
 * type questions; everything else counts as a routine preference.
 * @type {Record<string, Record<string, string[]>>}
 */
const KEYWORDS = {
  hair_pattern: {
    straight: ['silk'],
    wavy: ['silk', 'nano'],
    curly: ['shea', 'mask', 'intense'],
    coily: ['shea', 'mask', 'repair', 'caviar'],
  },
  strand_thickness: {
    fine: ['mild', 'silk'],
    coarse: ['classic', 'shea', 'caviar'],
  },
  scalp_condition: {
    oily: ['backwash', 'shampoo'],
    dry: ['shea', 'mask', 'spa'],
    sensitive: ['mild', 'shea'],
  },
  heat_frequency: {
    daily: ['repair', 'silk', 'spa', 'mask'],
    often: ['repair', 'silk', 'mask'],
    weekly: ['silk'],
  },
  colour_goal: {
    grey_coverage: ['color', 'colour', 'chromatic'],
    shine: ['caviar', 'silk'],
  },
  blonde_need: {
    strengthen: ['plex', 'fiber', 'silk'],
    hydrate: ['mask', 'silk', 'shea'],
  },
  smooth_result: {
    sleek: ['nano', 'protein'],
    lasting: ['nano', 'protein'],
  },
  hair_condition: {
    chemical: ['silk', 'intense', 'spa'],
    heat: ['silk', 'repair'],
    very_dry: ['shea', 'mask'],
    brittle: ['repair', 'spa', 'silk'],
  },
  scalp_need: {
    buildup: ['backwash'],
    deep_cleanse: ['backwash', 'shampoo'],
  },
  skin_feel: {
    oily: ['tea tree', 'peel', 'de-tan'],
    dry: ['hyaluronic', 'hydra', 'aloe'],
    sensitive: ['aloe', 'rose', 'lavender', 'calming', 'japanese'],
  },
  pigment_concern: {
    acne_marks: ['tea tree'],
    dull: ['vitamin c', 'illuminate'],
    sun_tan: ['de-tan'],
  },
  wax_need: {
    very_sensitive: ['aloe', 'lavender', 'calming'],
    first_time: ['aloe', 'pre-wax', 'after-wax'],
  },
  glow_type: {
    hydration: ['hydra', 'hyaluronic'],
    brightening: ['lumi', 'vitamin c'],
    calming: ['japanese', 'rose'],
    antioxidant: ['korean', 'kiwi'],
  },
  skin_finish: {
    fresh: ['vitamin c', 'illuminate', 'lumi'],
    hydrated: ['hyaluronic', 'hydra', 'kiwi'],
    calm: ['rose', 'tea tree', 'aloe', 'japanese', 'lavender'],
    bright: ['vitamin c', 'lumi', 'de-tan', 'korean', 'illuminate'],
  },
};

const TYPE_QUESTIONS = new Set(['scalp_condition', 'skin_feel']);

/**
 * @param {QuizProduct} product
 */
function searchableText(product) {
  // Tags are left out on purpose: merchants use them for merchandising and they add noise.
  return `${product.title} ${product.type}`.toLowerCase();
}

/**
 * Scores every product the merchant attached to the shopper's journey and returns the best
 * available match plus up to two supporting products.
 *
 * @param {'hair' | 'skin'} journey
 * @param {QuizAnswers} answers
 * @param {{ sets: RecommendationSet[], products: QuizProduct[] }} data
 * @param {Record<string, string>} [defaultReasons] - Reason copy keyed by concern.
 * @param {{ includeSoldOut?: boolean }} [options]
 * @returns {Recommendation | null}
 */
export function recommend(journey, answers, data, defaultReasons = {}, options = {}) {
  const concern = answers[CONCERN_QUESTION[journey]];
  if (!concern) return null;

  const followUpQuestion = FOLLOW_UP_QUESTION[concern];
  const followUp = followUpQuestion ? `${followUpQuestion}:${answers[followUpQuestion]}` : '';

  /** @type {Map<string, QuizProduct>} */
  const productsByHandle = new Map();
  for (const product of data.products || []) {
    if (product?.handle && !productsByHandle.has(product.handle)) productsByHandle.set(product.handle, product);
  }

  /** @type {Map<string, { base: number, followUp: boolean, order: number }>} */
  const candidates = new Map();
  let order = 0;
  let reason = '';

  for (const set of data.sets || []) {
    if (set.concern !== `${journey}-${concern}`) continue;
    const refined = set.refine !== 'any' && set.refine === followUp;
    if (set.refine !== 'any' && !refined) continue;
    if (refined && set.reason) reason = set.reason;
    else if (!reason && set.reason) reason = set.reason;

    set.products.forEach((handle, index) => {
      const base = Math.max(SCORE.concern - index * SCORE.positionStep, SCORE.concernFloor);
      const current = candidates.get(handle);
      candidates.set(handle, {
        base: Math.max(current?.base ?? 0, base),
        followUp: Boolean(current?.followUp || refined),
        order: current?.order ?? order++,
      });
    });
  }

  const scored = [];
  for (const [handle, candidate] of candidates) {
    const product = productsByHandle.get(handle);
    if (!product || (!product.available && !options.includeSoldOut)) continue;

    let score = candidate.base + (candidate.followUp ? SCORE.followUp : 0);
    const text = searchableText(product);

    for (const [question, answer] of Object.entries(answers)) {
      const keywords = KEYWORDS[question]?.[answer];
      if (!keywords?.some((keyword) => text.includes(keyword))) continue;
      score += TYPE_QUESTIONS.has(question) ? SCORE.typeMatch : SCORE.preferenceMatch;
    }

    scored.push({ product, score, order: candidate.order });
  }

  if (!scored.length) return null;

  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const [primary, ...rest] = scored;

  return {
    primaryProduct: primary.product,
    supportingProducts: rest.slice(0, 2).map((entry) => entry.product),
    reason: reason || defaultReasons[concern] || '',
    matchedConcerns: [concern, answers[followUpQuestion]].filter(Boolean),
  };
}
