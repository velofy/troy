// Cover: decide which painted regions the DOM cannot explain.
//
// This stage is the product's differentiator and also its cost control.
// Every region it emits will be screenshotted and OCR'd, which is slow, so
// the bar for nomination is deliberately high and the acceptance criterion
// is stated in the PRD as an absolute: a plain article page must produce
// zero regions. The walk nominates candidates; this stage, a pure function
// with no browser in sight, decides which of them the extracted text
// genuinely fails to explain:
//
//   - a canvas, video, object or embed: their pixels are opaque to the DOM
//     by construction, so they are always gaps;
//   - an img with no alt text: nothing in the tree says what it shows;
//   - an svg with no accessible text inside it;
//   - a cross-origin iframe: a document we are not allowed to read;
//   - a large painted area (a background image of meaningful size) that no
//     visible text block overlaps, which is what a screenshot-of-text page
//     looks like from the DOM.
//
// Overlapping gaps are merged into their bounding union so one composite
// graphic costs one OCR call instead of five, regions are clamped to the
// viewport because that is what the screenshot can show, and anything that
// ends up smaller than the floor is dropped: a 12-pixel sliver is not
// going to come back from OCR as anything but noise.

/** @typedef {import('./types.js').Box} Box */
/** @typedef {import('./types.js').DomBlock} DomBlock */
/** @typedef {import('./types.js').CoverCandidate} CoverCandidate */
/** @typedef {import('./types.js').CoverRegion} CoverRegion */

/** Regions with less area than this are noise, not content. */
const MIN_REGION_AREA = 1200

/** And regions thinner than this in either direction cannot hold text. */
const MIN_REGION_SIDE = 16

/**
 * How much of a painted candidate visible text must cover before the DOM
 * counts as having explained it. Five percent is deliberately low: a photo
 * with a small caption on top is still mostly unexplained pixels, but a
 * text column laid over a decorative background is clearly explained.
 */
const EXPLAINED_OVERLAP = 0.05

/**
 * @param {Box} a
 * @param {Box} b
 * @returns {number} area of the intersection, zero when disjoint
 */
function intersectionArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * @param {Box} a
 * @param {Box} b
 * @returns {boolean}
 */
function overlaps(a, b) {
  return intersectionArea(a, b) > 0
}

/**
 * @param {Box} a
 * @param {Box} b
 * @returns {Box}
 */
function union(a, b) {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  }
}

/**
 * @param {Box} box
 * @param {{ w: number, h: number }} viewport
 * @returns {Box | null} the part of the box the screenshot can see
 */
function clampToViewport(box, viewport) {
  const x = Math.max(0, box.x)
  const y = Math.max(0, box.y)
  const w = Math.min(box.x + box.w, viewport.w) - x
  const h = Math.min(box.y + box.h, viewport.h) - y
  if (w <= 0 || h <= 0) return null
  return { x, y, w, h }
}

/**
 * Does a candidate need pixels, given what the DOM already said?
 *
 * @param {CoverCandidate} candidate
 * @param {DomBlock[]} visibleBlocks
 * @returns {boolean}
 */
function isGap(candidate, visibleBlocks) {
  switch (candidate.kind) {
    case 'canvas':
    case 'video':
    case 'object':
      return true
    case 'img':
      return !candidate.hasAlt
    case 'svg':
      return !candidate.hasText
    case 'iframe':
      return Boolean(candidate.crossOrigin)
    case 'painted': {
      const area = candidate.box.w * candidate.box.h
      if (area <= 0) return false
      let covered = 0
      for (const block of visibleBlocks) covered += intersectionArea(candidate.box, block.box)
      return covered / area < EXPLAINED_OVERLAP
    }
    default:
      return false
  }
}

/**
 * The cover decision. Pure: candidates and blocks in, regions out, so the
 * whole policy is testable with plain data and the zero-regions-on-articles
 * criterion is a unit test rather than a hope.
 *
 * @param {CoverCandidate[]} candidates
 * @param {DomBlock[]} blocks all extracted blocks; only visible ones explain
 * @param {{ w: number, h: number }} viewport
 * @returns {CoverRegion[]}
 */
export function cover(candidates, blocks, viewport) {
  const visibleBlocks = blocks.filter((b) => b.visible && b.text.trim().length > 0)

  /** @type {CoverRegion[]} */
  let regions = []
  for (const candidate of candidates) {
    if (!isGap(candidate, visibleBlocks)) continue
    const clamped = clampToViewport(candidate.box, viewport)
    if (!clamped) continue
    regions.push({ box: clamped, kinds: [candidate.kind], selectors: [candidate.selector] })
  }

  // Merge until stable. A merge can create a bigger region that now
  // overlaps something it previously missed, so one pass is not enough;
  // the loop reruns whenever a pass changed anything.
  let changed = true
  while (changed) {
    changed = false
    /** @type {CoverRegion[]} */
    const merged = []
    for (const region of regions) {
      const hit = merged.find((m) => overlaps(m.box, region.box))
      if (hit) {
        hit.box = union(hit.box, region.box)
        hit.kinds = [...new Set([...hit.kinds, ...region.kinds])]
        hit.selectors = [...new Set([...hit.selectors, ...region.selectors])]
        changed = true
      } else {
        merged.push(region)
      }
    }
    regions = merged
  }

  return regions.filter(
    (r) => r.box.w * r.box.h >= MIN_REGION_AREA && r.box.w >= MIN_REGION_SIDE && r.box.h >= MIN_REGION_SIDE,
  )
}
