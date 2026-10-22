// The shapes the read pipeline passes between its stages, written down once.
//
// This file is plain JavaScript on purpose. The pipeline has to be importable
// at runtime by two hosts that never see a compile step: Electron's main
// process (src/browser/main.js, launched straight from source) and the CLI
// scripts under scripts/ (launched with plain node). TypeScript source would
// need a build both hosts do not have, so the types live in JSDoc and the
// compiler still checks every use of them through checkJs.
//
// The pipeline deliberately does not depend on the full Cdp port. It needs
// exactly two capabilities, evaluate and screenshot, so that is all ReadPort
// asks for. The Cdp port satisfies it structurally, and so does a ten-line
// adapter over Electron's webContents.debugger, which is what lets one
// pipeline serve the CLI and the live browser tab without a fork.

/**
 * @typedef {object} Box
 * @property {number} x viewport coordinates, css pixels
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/**
 * The minimal surface the pipeline runs against. `screenshot` is optional
 * because only the OCR stage needs pixels, and a host that cannot supply
 * them (or a page that needs none) still gets the full DOM read.
 *
 * @typedef {object} ReadPort
 * @property {(expression: string) => Promise<unknown>} evaluate
 * @property {(clip?: Box) => Promise<Buffer>} [screenshot]
 */

/**
 * One run of text the extraction walk found, tied to the element that owns
 * it. Blocks are extracted whether or not they are painted; `visible` is the
 * verdict, and `hiddenReason` says which rule condemned an invisible one,
 * because "this text was dropped" is only trustworthy when it can say why.
 *
 * @typedef {object} DomBlock
 * @property {string} text
 * @property {string} role heading, paragraph, link, listitem, textbox, img, ...
 * @property {string} tag the element's tag name, lower case
 * @property {Box} box
 * @property {string} selector stable selector, shadow hops joined with " >>> "
 * @property {boolean} visible
 * @property {string} [hiddenReason] zero-rect, display-none, visibility-hidden,
 *   transparent, clipped, offscreen, camouflage
 * @property {string} [href] for links, the resolved destination
 * @property {number} [headingLevel] 1..6 when the role is heading
 */

/**
 * A page region the walk flagged as possibly unexplainable by the DOM:
 * a canvas, a bare image, a wordless svg, a cross-origin iframe, a large
 * painted area. The walk only nominates; cover decides.
 *
 * @typedef {object} CoverCandidate
 * @property {'canvas' | 'img' | 'svg' | 'video' | 'iframe' | 'object' | 'painted'} kind
 * @property {Box} box
 * @property {string} selector
 * @property {boolean} [hasAlt] img only: alt text exists and is non-empty
 * @property {boolean} [hasText] svg only: accessible text exists inside
 * @property {boolean} [crossOrigin] iframe only: content document unreachable
 */

/**
 * A region cover decided the DOM cannot explain, after merging overlaps.
 *
 * @typedef {object} CoverRegion
 * @property {Box} box
 * @property {string[]} kinds every candidate kind merged into this region
 * @property {string[]} selectors every candidate selector merged in
 */

/**
 * One line of recognized text, in the coordinates of the crop it came from.
 * The caller translates back into viewport coordinates before fusing.
 *
 * @typedef {object} OcrLine
 * @property {string} text
 * @property {Box} box
 * @property {number} confidence 0..1
 */

/**
 * The one interface every OCR backend implements. `available` is asked
 * before any pixels move, so an engine that needs a binary, a platform or a
 * network can refuse cleanly and the pipeline degrades instead of breaking.
 *
 * @typedef {object} OcrEngine
 * @property {string} name
 * @property {() => Promise<boolean>} available
 * @property {(png: Buffer) => Promise<OcrLine[]>} recognize
 */

/**
 * One entry in the fused document. This is the contract the CLI's --json
 * output and the agent bridge both promise: text, geometry, provenance, and
 * for DOM blocks a selector the action layer accepts unchanged.
 *
 * @typedef {object} FusedBlock
 * @property {string} text
 * @property {Box} box
 * @property {'dom' | 'ocr'} source
 * @property {string} [selector] absent for OCR blocks, which have no element
 * @property {string} [role]
 * @property {string} [href]
 * @property {number} [headingLevel]
 * @property {boolean} [untranscribed] an OCR region no engine could read
 */

/**
 * What extract returns from its single in-page evaluation.
 *
 * @typedef {object} Extraction
 * @property {string} url
 * @property {string} title
 * @property {{ w: number, h: number }} viewport
 * @property {DomBlock[]} blocks
 * @property {CoverCandidate[]} candidates
 */

/**
 * The whole read, ready to render or serialize.
 *
 * @typedef {object} ReadDocument
 * @property {string} url
 * @property {string} title
 * @property {FusedBlock[]} blocks
 * @property {CoverRegion[]} regions
 * @property {object} stats
 * @property {boolean} stats.settled
 * @property {number} stats.settleMs
 * @property {number} stats.elapsedMs
 * @property {number} stats.regionCount
 * @property {string} stats.ocrEngine "none" when no engine was available
 * @property {number} stats.transcribed regions an engine actually read
 */

export {}
