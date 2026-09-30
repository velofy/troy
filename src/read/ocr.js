// OCR behind one interface, with honesty as the fallback.
//
// The pipeline never assumes an OCR engine exists. When none does, the
// regions cover found are still reported, as blocks that say plainly that
// pixels were there and nobody could read them. That is a deliberate
// product decision: an agent told "there is an untranscribed canvas at
// this box" can decide to screenshot it, ask a vision model, or tell the
// user; an agent shown nothing at all believes the page was empty there,
// which is exactly the failure mode this project exists to end.
//
// Engines implement the three-method OcrEngine interface from types.js and
// are asked available() before any pixels move. Nothing in this module or
// downstream of it ever throws because an engine is missing or broken:
// recognition failures degrade to the untranscribed block, per region, so
// one bad crop cannot cost the rest of the page.

/** @typedef {import('./types.js').OcrEngine} OcrEngine */
/** @typedef {import('./types.js').OcrLine} OcrLine */
/** @typedef {import('./types.js').CoverRegion} CoverRegion */
/** @typedef {import('./types.js').FusedBlock} FusedBlock */
/** @typedef {import('./types.js').ReadPort} ReadPort */

/**
 * The engine that is always available and reads nothing. Kept as a real
 * OcrEngine rather than a null check at every call site so the pipeline
 * has exactly one code path.
 *
 * @returns {OcrEngine}
 */
export function stubEngine() {
  return {
    name: 'none',
    available: async () => false,
    recognize: async () => [],
  }
}

/**
 * What a region reads as when no engine could transcribe it. One sentence,
 * with geometry and provenance, because "something was here" is the whole
 * message and the box is what makes it actionable.
 *
 * @param {CoverRegion} region
 * @returns {FusedBlock}
 */
function untranscribedBlock(region) {
  const what = region.kinds.join(' and ')
  return {
    text: `[untranscribed ${what} region, ${region.box.w}x${region.box.h}px at (${region.box.x}, ${region.box.y}); no OCR engine available]`,
    box: region.box,
    source: 'ocr',
    untranscribed: true,
  }
}

/**
 * The width a PNG says it is, from the IHDR chunk, or zero when the buffer
 * is not a PNG. Needed because a screenshot crop on a retina display comes
 * back at device-pixel scale: the engine reports boxes in image pixels,
 * and dividing the region's css width by the image width is the exact
 * factor that brings them home. Parsing four bytes here beats dragging an
 * image library into a project that otherwise has zero runtime deps.
 *
 * @param {Buffer} png
 * @returns {number}
 */
function pngWidth(png) {
  if (png.length < 24) return 0
  if (png.readUInt32BE(0) !== 0x89504e47) return 0
  return png.readUInt32BE(16)
}

/**
 * Turn cover regions into fused-ready OCR blocks.
 *
 * Each region is cropped from the live page through the port's screenshot
 * and handed to the engine. Recognized lines come back in crop image
 * pixels and are scaled and translated into viewport coordinates here, so
 * everything downstream speaks one coordinate space. A region whose crop
 * or recognition fails degrades to its untranscribed block; the error is
 * carried in the result rather than thrown, because a page read must not
 * die on its least important region.
 *
 * @param {ReadPort} port
 * @param {CoverRegion[]} regions
 * @param {OcrEngine} engine
 * @returns {Promise<{ blocks: FusedBlock[], engine: string, transcribed: number }>}
 */
export async function transcribe(port, regions, engine) {
  if (regions.length === 0) return { blocks: [], engine: engine.name, transcribed: 0 }

  let usable = false
  try {
    usable = (await engine.available()) && typeof port.screenshot === 'function'
  } catch {
    usable = false
  }
  if (!usable) {
    return { blocks: regions.map(untranscribedBlock), engine: 'none', transcribed: 0 }
  }

  /** @type {FusedBlock[]} */
  const blocks = []
  let transcribed = 0
  for (const region of regions) {
    try {
      const screenshot = /** @type {NonNullable<ReadPort['screenshot']>} */ (port.screenshot)
      const png = await screenshot(region.box)
      const width = pngWidth(png)
      const scale = width > 0 ? region.box.w / width : 1
      const lines = await engine.recognize(png)
      if (lines.length === 0) {
        // The engine ran and saw nothing. A blank chart area or a
        // decorative canvas reads as empty, and reporting emptiness as
        // emptiness is correct; only an engine that could not run gets
        // the untranscribed marker.
        continue
      }
      transcribed += 1
      for (const line of lines) {
        blocks.push({
          text: line.text,
          box: {
            x: Math.round(region.box.x + line.box.x * scale),
            y: Math.round(region.box.y + line.box.y * scale),
            w: Math.round(line.box.w * scale),
            h: Math.round(line.box.h * scale),
          },
          source: 'ocr',
        })
      }
    } catch {
      blocks.push(untranscribedBlock(region))
    }
  }
  return { blocks, engine: engine.name, transcribed }
}
