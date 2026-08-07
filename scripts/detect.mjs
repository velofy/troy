#!/usr/bin/env node
/**
 * Dump every fillable question on the authorized tab as JSON.
 * Reads nothing, writes nothing to the page.
 *
 *   node scripts/detect.mjs --target ycombinator [--url <substring>]
 */
import { parseArgs, loadTarget, resolveAllowedHosts, connect, findPage, out, die } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const target = loadTarget(args.target || 'ycombinator');
const allowedHosts = resolveAllowedHosts(target, args);

const browser = await connect();
const page = await findPage(browser, allowedHosts, args.url);

const fields = await page.evaluate(
  ({ fieldSelector, skipSelector }) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    function labelFor(el) {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l && clean(l.innerText)) return clean(l.innerText);
      }
      const anc = el.closest('label');
      if (anc && clean(anc.innerText)) return clean(anc.innerText);

      const aria = el.getAttribute('aria-label');
      if (clean(aria)) return clean(aria);

      const by = el.getAttribute('aria-labelledby');
      if (by) {
        const n = document.getElementById(by);
        if (n && clean(n.innerText)) return clean(n.innerText);
      }
      // Walk previous siblings, then climb, looking for the nearest text block.
      let node = el;
      for (let depth = 0; depth < 5 && node; depth++) {
        let sib = node.previousElementSibling;
        while (sib) {
          const t = clean(sib.innerText);
          if (t && t.length < 600) return t;
          sib = sib.previousElementSibling;
        }
        node = node.parentElement;
      }
      return '';
    }

    function selectorFor(el) {
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
      const parts = [];
      let n = el;
      while (n && n.nodeType === 1 && n !== document.body) {
        const tag = n.tagName.toLowerCase();
        const sibs = Array.from(n.parentElement ? n.parentElement.children : [])
          .filter((c) => c.tagName === n.tagName);
        parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(n) + 1})` : tag);
        n = n.parentElement;
      }
      return `body > ${parts.join(' > ')}`;
    }

    const skip = skipSelector ? Array.from(document.querySelectorAll(skipSelector)) : [];
    const skipSet = new Set(skip);

    return Array.from(document.querySelectorAll(fieldSelector))
      .filter((el) => !skipSet.has(el))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      })
      .map((el, i) => {
        const value = el.isContentEditable ? clean(el.innerText) : (el.value || '');
        const max = el.getAttribute('maxlength');
        return {
          index: i,
          selector: selectorFor(el),
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || '',
          name: el.getAttribute('name') || '',
          question: labelFor(el),
          maxLength: max ? Number(max) : null,
          currentValue: value,
          currentLength: value.length,
          answered: value.trim().length > 0,
        };
      });
  },
  { fieldSelector: target.fieldSelector, skipSelector: target.skipSelector }
);

out({
  url: page.url(),
  title: await page.title(),
  target: target.name,
  total: fields.length,
  answered: fields.filter((f) => f.answered).length,
  unanswered: fields.filter((f) => !f.answered).length,
  fields,
});

// Detach by exiting. We never call browser.close() on a CDP-attached browser:
// this is the user's real Chrome holding their application, and exiting the
// process tears down the socket without any chance of touching it.
process.exit(0);
