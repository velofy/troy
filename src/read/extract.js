// Extract: one evaluation, one walk, everything the page can tell us.
//
// The whole DOM story is collected in a single Runtime.evaluate round trip.
// One walk instead of many queries because every extra round trip is a
// chance for the page to change under us: a walk that asks the page fifty
// questions gets fifty answers about fifty slightly different pages.
//
// The walk descends open shadow roots (closed ones are unreachable by
// design, theirs to keep) and produces two things:
//
//   - blocks: runs of text tied to the element that owns them, each with a
//     role, a bounding box, a stable selector and a visibility verdict;
//   - candidates: regions that might need pixels to explain (canvas, bare
//     images, wordless svg, cross-origin iframes, large painted areas).
//     The walk only nominates; the cover stage decides.
//
// Visibility is a verdict, not a guess. Text is invisible when any of these
// hold: its element has no rendered box; display:none or visibility:hidden
// applies; effective opacity along the ancestor chain is zero; an
// overflow-clipping ancestor leaves it no intersection (the height-zero
// trap); it sits entirely at negative page coordinates or is text-indented
// out of existence; or its resolved text colour matches the backdrop it
// paints onto. That last rule is the white-on-white check: text that passes
// every other test and still cannot be seen, which is the most common way
// scraper output gets poisoned. Invisible text is still extracted, with the
// rule that condemned it, so a caller can audit the drop; it simply never
// reaches the fused document.

/**
 * The in-page walk, as an expression string for Runtime.evaluate. It
 * returns a JSON string rather than an object because returnByValue
 * serialization of a large object graph is slower and less predictable
 * than one string, and because a string forces the shape through one
 * explicit parse on the Node side where it can be validated.
 *
 * @returns {string}
 */
export function extractExpression() {
  return `(() => {
    const win = window
    const doc = document
    const MAX_BLOCKS = 5000
    const MAX_CANDIDATES = 500
    const PAINTED_MIN_AREA = 10000

    const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, TITLE: 1 }

    const styleCache = new Map()
    const styleOf = (el) => {
      let s = styleCache.get(el)
      if (!s) {
        const view = el.ownerDocument.defaultView || win
        s = view.getComputedStyle(el)
        styleCache.set(el, s)
      }
      return s
    }

    // Walks upward across shadow boundaries: a shadow child's visual
    // ancestor is its host, and opacity, clipping and backdrop all flow
    // through that hop even though parentElement does not.
    const parentOf = (el) => {
      if (el.parentElement) return el.parentElement
      const root = el.getRootNode ? el.getRootNode() : null
      return root && root.host ? root.host : null
    }

    const parseColor = (raw) => {
      const m = /^rgba?\\(([^)]+)\\)$/.exec(raw || '')
      if (!m) return null
      const p = m[1].split(',').map((v) => parseFloat(v))
      if (p.length < 3 || p.some((v) => Number.isNaN(v))) return null
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
    }

    // The backdrop a piece of text paints onto: the nearest ancestor with a
    // solid background colour. A background image, or a translucent colour
    // that would need real compositing to resolve, makes the backdrop
    // unknowable from styles alone, and an unknowable backdrop must count
    // as visible: the camouflage rule exists to catch certain hiding, not
    // to gamble away real text.
    const backdropOf = (el) => {
      for (let a = el; a; a = parentOf(a)) {
        const s = styleOf(a)
        if (s.backgroundImage && s.backgroundImage !== 'none') return null
        const b = parseColor(s.backgroundColor)
        if (b && b.a >= 1) return b
        if (b && b.a > 0) return null
      }
      return { r: 255, g: 255, b: 255, a: 1 }
    }

    // Why this order: the cheap certain rules first, geometry second, the
    // colour rule last because it is the only one that needs a backdrop
    // walk. Returns the first reason that condemns the element, or null.
    const verdictCache = new Map()
    const verdictOf = (el) => {
      if (verdictCache.has(el)) return verdictCache.get(el)
      let reason = null
      const s = styleOf(el)
      const r = el.getBoundingClientRect()
      if (s.display === 'none') reason = 'display-none'
      else if (s.visibility === 'hidden' || s.visibility === 'collapse') reason = 'visibility-hidden'
      else if (r.width < 2 || r.height < 2) reason = 'zero-rect'
      else if (s.clip === 'rect(0px, 0px, 0px, 0px)') reason = 'clipped'
      else if (r.right + win.scrollX <= 0 || r.bottom + win.scrollY <= 0) reason = 'offscreen'
      else if (parseFloat(s.textIndent) <= -999) reason = 'offscreen'
      if (!reason) {
        let o = parseFloat(s.opacity)
        for (let a = parentOf(el); a && o > 0.02; a = parentOf(a)) o *= parseFloat(styleOf(a).opacity)
        if (o <= 0.02) reason = 'transparent'
      }
      if (!reason) {
        for (let a = parentOf(el); a; a = parentOf(a)) {
          const as = styleOf(a)
          const clipsX = as.overflowX === 'hidden' || as.overflowX === 'clip'
          const clipsY = as.overflowY === 'hidden' || as.overflowY === 'clip'
          if (!clipsX && !clipsY) continue
          const ar = a.getBoundingClientRect()
          const ix = Math.min(r.right, ar.right) - Math.max(r.left, ar.left)
          const iy = Math.min(r.bottom, ar.bottom) - Math.max(r.top, ar.top)
          if ((clipsX && ix <= 0) || (clipsY && iy <= 0)) { reason = 'clipped'; break }
        }
      }
      verdictCache.set(el, reason)
      return reason
    }

    // White-on-white and its relatives. The text colour is alpha-blended
    // over the backdrop and compared channel by channel, so rgba text that
    // dissolves into its background is caught the same way as a literal
    // #fff on #fff.
    const camouflageOf = (el) => {
      const c = parseColor(styleOf(el).color)
      if (!c) return null
      if (c.a === 0) return 'transparent'
      const bg = backdropOf(el)
      if (!bg) return null
      const blend = (channel, back) => channel * c.a + back * (1 - c.a)
      const near = (x, y) => Math.abs(x - y) < 2
      if (near(blend(c.r, bg.r), bg.r) && near(blend(c.g, bg.g), bg.g) && near(blend(c.b, bg.b), bg.b)) {
        return 'camouflage'
      }
      return null
    }

    const esc = win.CSS && win.CSS.escape ? win.CSS.escape : (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, '_')

    // A selector that stays stable across reloads: anchored to the nearest
    // uniquely-identified ancestor when one exists, positional only below
    // it. Shadow hops are joined with " >>> ", which the action layer
    // understands as "querySelector, enter shadowRoot, repeat".
    const selectorWithin = (el, root) => {
      const parts = []
      let node = el
      while (node && node !== root && node.nodeType === 1) {
        if (node.id && root.querySelectorAll('#' + esc(node.id)).length === 1) {
          parts.unshift('#' + esc(node.id))
          return parts.join(' > ')
        }
        let part = node.nodeName.toLowerCase()
        const parent = node.parentNode
        if (parent && parent.children) {
          const same = Array.prototype.filter.call(parent.children, (c) => c.nodeName === node.nodeName)
          if (same.length > 1) part += ':nth-of-type(' + (Array.prototype.indexOf.call(same, node) + 1) + ')'
        }
        parts.unshift(part)
        node = node.parentElement
      }
      return parts.join(' > ')
    }

    const boxOf = (r) => ({
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
    })

    const unionRect = (a, b) => {
      if (!a) return b
      const left = Math.min(a.left, b.left)
      const top = Math.min(a.top, b.top)
      const right = Math.max(a.right, b.right)
      const bottom = Math.max(a.bottom, b.bottom)
      return { left, top, right, bottom, width: right - left, height: bottom - top }
    }

    const HEADINGS = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 }
    const roleOf = (el) => {
      const explicit = el.getAttribute && el.getAttribute('role')
      if (explicit) return explicit
      const tag = el.nodeName
      if (HEADINGS[tag]) return 'heading'
      if (tag === 'LI') return 'listitem'
      if (tag === 'BUTTON') return 'button'
      if (tag === 'TD' || tag === 'TH') return 'cell'
      if (tag === 'BLOCKQUOTE') return 'quote'
      if (tag === 'PRE' || tag === 'CODE') return 'code'
      if (tag === 'FIGCAPTION' || tag === 'CAPTION') return 'caption'
      return 'paragraph'
    }

    const isInline = (el) => {
      const d = styleOf(el).display
      return d.indexOf('inline') === 0 || d === 'contents' || d === 'ruby'
    }

    const blockAncestorOf = (el) => {
      let node = el
      while (node && isInline(node)) {
        const up = parentOf(node)
        if (!up) break
        node = up
      }
      return node || el
    }

    const anchorOf = (el) => {
      for (let a = el; a; a = parentOf(a)) {
        if (a.nodeName === 'A' && a.href) return a
        if (!isInline(a)) return null
      }
      return null
    }

    const blocks = []
    const candidates = []
    let truncated = false

    const pushBlock = (b) => {
      if (blocks.length >= MAX_BLOCKS) { truncated = true; return }
      blocks.push(b)
    }
    const pushCandidate = (c) => {
      if (candidates.length >= MAX_CANDIDATES) { truncated = true; return }
      candidates.push(c)
    }

    // One run of text: consecutive text nodes that share a block ancestor,
    // a visibility verdict and a link target become one block. Splitting on
    // the link boundary gives every anchor its own selector and href, which
    // is what lets --json output feed a click without translation.
    let run = null
    const flushRun = () => {
      if (!run) return
      const text = run.text.replace(/\\s+/g, ' ').trim()
      if (text) {
        const el = run.anchor || run.block
        pushBlock({
          text,
          role: run.anchor ? 'link' : roleOf(run.block),
          tag: el.nodeName.toLowerCase(),
          box: boxOf(run.rect),
          selector: run.prefix + selectorWithin(el, run.root),
          visible: !run.reason,
          hiddenReason: run.reason || undefined,
          href: run.anchor ? run.anchor.href : undefined,
          headingLevel: HEADINGS[run.block.nodeName] || undefined,
        })
      }
      run = null
    }

    const addSegment = (textNode, parentEl, root, prefix) => {
      const raw = textNode.nodeValue || ''
      if (!raw.trim()) return
      const block = blockAncestorOf(parentEl)
      const reason = verdictOf(parentEl) || camouflageOf(parentEl)
      const anchor = anchorOf(parentEl)
      const rect = parentEl.getBoundingClientRect()
      if (run && run.block === block && run.reason === reason && run.anchor === anchor) {
        run.text += ' ' + raw
        run.rect = unionRect(run.rect, rect)
      } else {
        flushRun()
        run = { text: raw, block, reason, anchor, rect, root, prefix }
      }
    }

    // Form controls carry their text in attributes rather than text nodes.
    // Password values are never extracted: a read of a logged-in page must
    // not become an exfiltration of what was typed into it.
    const CONTROL_ROLES = { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', range: 'slider' }
    const controlBlock = (el, root, prefix) => {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      const isPassword = type === 'password'
      const value = isPassword ? '' : (el.value || '')
      const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || ''
      const text = isPassword ? '[password field]' : (value || label)
      if (!text) return
      pushBlock({
        text,
        role: el.nodeName === 'SELECT' ? 'combobox' : (CONTROL_ROLES[type] || 'textbox'),
        tag: el.nodeName.toLowerCase(),
        box: boxOf(el.getBoundingClientRect()),
        selector: prefix + selectorWithin(el, root),
        visible: !verdictOf(el),
        hiddenReason: verdictOf(el) || undefined,
      })
    }

    const svgText = (el) => {
      const label = el.getAttribute('aria-label')
      if (label && label.trim()) return label.trim()
      const title = el.querySelector('title')
      if (title && title.textContent && title.textContent.trim()) return title.textContent.trim()
      return (el.textContent || '').replace(/\\s+/g, ' ').trim()
    }

    const walk = (node, root, prefix) => {
      if (node.nodeType === 3) {
        const p = node.parentElement
        if (p && !SKIP[p.nodeName]) addSegment(node, p, root, prefix)
        return
      }
      if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return
      const el = node.nodeType === 1 ? node : null
      if (el) {
        const tag = el.nodeName
        if (SKIP[tag]) return
        if (tag === 'CANVAS' || tag === 'VIDEO' || tag === 'OBJECT' || tag === 'EMBED') {
          flushRun()
          if (!verdictOf(el)) {
            pushCandidate({
              kind: tag === 'CANVAS' ? 'canvas' : tag === 'VIDEO' ? 'video' : 'object',
              box: boxOf(el.getBoundingClientRect()),
              selector: prefix + selectorWithin(el, root),
            })
          }
          return
        }
        if (tag === 'IMG') {
          flushRun()
          const alt = (el.getAttribute('alt') || '').trim()
          const hidden = verdictOf(el)
          if (alt) {
            pushBlock({
              text: alt, role: 'img', tag: 'img',
              box: boxOf(el.getBoundingClientRect()),
              selector: prefix + selectorWithin(el, root),
              visible: !hidden, hiddenReason: hidden || undefined,
            })
          }
          if (!hidden) {
            pushCandidate({
              kind: 'img', hasAlt: Boolean(alt),
              box: boxOf(el.getBoundingClientRect()),
              selector: prefix + selectorWithin(el, root),
            })
          }
          return
        }
        if (tag === 'svg') {
          flushRun()
          const text = svgText(el)
          const hidden = verdictOf(el)
          if (text) {
            pushBlock({
              text, role: 'img', tag: 'svg',
              box: boxOf(el.getBoundingClientRect()),
              selector: prefix + selectorWithin(el, root),
              visible: !hidden, hiddenReason: hidden || undefined,
            })
          }
          if (!hidden) {
            pushCandidate({
              kind: 'svg', hasText: Boolean(text),
              box: boxOf(el.getBoundingClientRect()),
              selector: prefix + selectorWithin(el, root),
            })
          }
          return
        }
        if (tag === 'IFRAME' || tag === 'FRAME') {
          flushRun()
          if (verdictOf(el)) return
          let idoc = null
          try { idoc = el.contentDocument } catch (e) { idoc = null }
          const selector = prefix + selectorWithin(el, root)
          const box = boxOf(el.getBoundingClientRect())
          if (idoc && idoc.body) {
            // A same-origin frame can explain itself: its rendered text is
            // read as one block anchored to the frame element. Walking its
            // full tree would need per-frame coordinate translation for a
            // case the fixtures do not exercise, so the flat read is the
            // honest middle ground: the words are captured, the frame stays
            // out of the OCR bill, and selectors never silently cross a
            // frame boundary they could not be used through.
            const text = (idoc.body.innerText || '').replace(/\\s+/g, ' ').trim()
            if (text) {
              pushBlock({
                text: text.slice(0, 20000), role: 'iframe', tag: 'iframe',
                box, selector, visible: true,
              })
            }
            pushCandidate({ kind: 'iframe', crossOrigin: false, hasText: Boolean(text), box, selector })
          } else {
            pushCandidate({ kind: 'iframe', crossOrigin: true, hasText: false, box, selector })
          }
          return
        }
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
          flushRun()
          controlBlock(el, root, prefix)
          return
        }
        if (el.getBoundingClientRect && styleOf(el).backgroundImage !== 'none') {
          const r = el.getBoundingClientRect()
          if (r.width * r.height >= PAINTED_MIN_AREA && !verdictOf(el)) {
            pushCandidate({
              kind: 'painted',
              box: boxOf(r),
              selector: prefix + selectorWithin(el, root),
            })
          }
        }
        if (el.shadowRoot) {
          // Open shadow roots render in place of (or interleaved with) the
          // host's light children, so both trees are walked. Anything in
          // the light tree that no slot renders simply has no box and falls
          // to the zero-rect rule, so geometry keeps the walk honest about
          // what is actually on screen.
          flushRun()
          const hostSelector = prefix + selectorWithin(el, root) + ' >>> '
          for (const child of el.shadowRoot.childNodes) walk(child, el.shadowRoot, hostSelector)
        }
      }
      const children = node.childNodes
      for (let i = 0; i < children.length; i++) walk(children[i], root, prefix)
      if (el && !isInline(el)) flushRun()
    }

    walk(doc.documentElement, doc, '')
    flushRun()

    return JSON.stringify({
      url: location.href,
      title: doc.title || '',
      viewport: { w: win.innerWidth, h: win.innerHeight },
      blocks,
      candidates,
      truncated,
    })
  })()`
}

/**
 * Run the walk through any evaluate-capable port and validate the shape on
 * the way back in. The page is an untrusted party: a document that shadows
 * JSON or returns garbage must surface as a clear error here, not as a
 * TypeError three stages later.
 *
 * @param {(expression: string) => Promise<unknown>} evaluate
 * @returns {Promise<import('./types.js').Extraction>}
 */
export async function extract(evaluate) {
  const raw = await evaluate(extractExpression())
  if (typeof raw !== 'string') throw new Error(`extract: the page returned ${typeof raw}, not a JSON string`)
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('extract: the page returned unparseable JSON')
  }
  const shape = /** @type {{ url?: unknown, title?: unknown, viewport?: unknown, blocks?: unknown, candidates?: unknown }} */ (
    parsed
  )
  if (!shape || !Array.isArray(shape.blocks) || !Array.isArray(shape.candidates)) {
    throw new Error('extract: the walk result is missing its block or candidate lists')
  }
  const viewport = /** @type {{ w?: unknown, h?: unknown }} */ (shape.viewport ?? {})
  return {
    url: String(shape.url ?? ''),
    title: String(shape.title ?? ''),
    viewport: { w: Number(viewport.w ?? 0), h: Number(viewport.h ?? 0) },
    blocks: /** @type {import('./types.js').DomBlock[]} */ (shape.blocks),
    candidates: /** @type {import('./types.js').CoverCandidate[]} */ (shape.candidates),
  }
}
