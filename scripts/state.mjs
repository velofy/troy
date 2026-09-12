/**
 * State snapshots: the primitive that makes an action verifiable.
 *
 * The first clicker reported six toggles clicked when five had not moved. It
 * had no way to tell, because it only knew whether `el.click()` threw. A click
 * that lands on the wrong element throws nothing.
 *
 * The fix is to make "did that happen" a first-class question: snapshot the
 * page, act, snapshot again, diff. If nothing changed, the action did not
 * happen, whatever the click reported.
 */

/**
 * Capture a cheap, comparable summary of page state.
 *
 * Deliberately not the full DOM: an innerHTML diff is noisy (timestamps,
 * carets, animation classes) and would report change on every snapshot. These
 * are the signals that actually move when a form control is operated.
 */
export async function snapshot(page, opts = {}) {
  const scope = opts.scope || null;
  return page.evaluate((sel) => {
    const root = sel ? document.querySelector(sel) : document;
    if (!root) return { missing: true, scope: sel };

    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };

    const fields = [...root.querySelectorAll('input, textarea, select')].map((el) => ({
      k: el.name || el.id || el.tagName.toLowerCase(),
      v: el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : (el.value || ''),
    }));

    // Custom controls carry their state in a class, an aria attribute, or a
    // data attribute. Native `checked` misses all three, which is exactly how
    // the original bug hid.
    const marked = [...root.querySelectorAll(
      '[class*="on"],[class*="active"],[class*="selected"],[class*="checked"],' +
      '[aria-checked],[aria-selected],[aria-expanded],[data-state]'
    )].map((el) => {
      const bits = [el.tagName.toLowerCase()];
      if (el.id) bits.push('#' + el.id);
      for (const a of ['aria-checked', 'aria-selected', 'aria-expanded', 'data-state']) {
        const v = el.getAttribute(a);
        if (v !== null) bits.push(a + '=' + v);
      }
      const cls = (el.className || '').toString().split(/\s+/)
        .filter((c) => /^(on|active|selected|checked|open|show)$/.test(c)).sort().join('.');
      if (cls) bits.push('.' + cls);
      bits.push(el.textContent.replace(/\s+/g, ' ').trim().slice(0, 24));
      return bits.join('|');
    });

    return {
      url: location.href,
      title: document.title,
      // Counts of VISIBLE controls: a revealed field is the most reliable
      // evidence that a toggle actually fired.
      visibleFields: [...root.querySelectorAll('input,textarea,select')].filter(vis).length,
      fieldCount: fields.length,
      fields,
      marked,
      textLen: (root.innerText || '').replace(/\s+/g, ' ').trim().length,
    };
  }, scope);
}

/** Diff two snapshots into something a human can read in one line. */
export function diff(before, after) {
  if (!before || !after) return { changed: false, reasons: ['missing snapshot'] };
  if (before.missing || after.missing) return { changed: false, reasons: ['scope not found'] };

  const reasons = [];
  if (before.url !== after.url) reasons.push(`url ${before.url} -> ${after.url}`);
  if (before.visibleFields !== after.visibleFields)
    reasons.push(`visible fields ${before.visibleFields} -> ${after.visibleFields}`);
  if (before.fieldCount !== after.fieldCount)
    reasons.push(`field count ${before.fieldCount} -> ${after.fieldCount}`);

  const bm = new Set(before.marked), am = new Set(after.marked);
  const gained = [...am].filter((x) => !bm.has(x));
  const lost = [...bm].filter((x) => !am.has(x));
  if (gained.length) reasons.push(`selected: ${gained.slice(0, 3).join(', ')}`);
  if (lost.length) reasons.push(`deselected: ${lost.slice(0, 3).join(', ')}`);

  const bf = Object.fromEntries(before.fields.map((f) => [f.k, f.v]));
  for (const f of after.fields) {
    if (bf[f.k] !== undefined && bf[f.k] !== f.v) reasons.push(`${f.k}: "${bf[f.k]}" -> "${f.v}"`);
  }

  return { changed: reasons.length > 0, reasons };
}

/**
 * Wait for a stated expectation, rather than sleeping and hoping.
 * Returns {met, detail}. Never throws: a missed expectation is a result.
 */
export async function expect(page, kind, value, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  const check = async () => {
    switch (kind) {
      case 'selector':
        return page.evaluate((s) => !!document.querySelector(s), value);
      case 'visible':
        return page.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
        }, value);
      case 'text':
        return page.evaluate((t) => document.body.innerText.includes(t), value);
      case 'gone':
        return page.evaluate((s) => !document.querySelector(s), value);
      default:
        return false;
    }
  };
  while (Date.now() < deadline) {
    if (await check()) return { met: true, detail: `${kind}=${value}` };
    await page.waitForTimeout(120);
  }
  return { met: false, detail: `${kind}=${value} not satisfied in ${timeoutMs}ms` };
}
