// The refusal rules for writing into a field, kept in their own module so
// they can be imported and tested without pulling in lib.mjs's process
// helpers. These guards are what keeps a "filled and verified" claim honest:
// a field that cannot take the text must be refused up front, with a reason,
// never filled optimistically and reported as done.

/**
 * What the page says about the element a selector matched.
 *
 * @typedef {object} FieldInfo
 * @property {string} [tag]
 * @property {string} [type]
 * @property {string} [name]
 * @property {string} [text]
 * @property {boolean} [contentEditable]
 * @property {boolean} [disabled]
 * @property {boolean} [readOnly]
 * @property {number | null} [maxLength]
 */

const SUBMIT_PATTERN = /submit|send application|finalize|confirm and send/i;

/**
 * Why a field must not be filled, or null when it may be.
 *
 * @param {FieldInfo | null} info what the page says about the element
 * @param {string} [text] the text that would be written
 * @returns {string | null} the refusal reason, or null when filling may go ahead
 */
export function refusalFor(info, text = '') {
  if (!info) return 'element not found for that selector';
  const tag = (info.tag || '').toLowerCase();
  const type = (info.type || '').toLowerCase();

  if (tag === 'button' || type === 'submit' || type === 'button' || type === 'image') {
    return `refusing to act on a <${tag}${type ? ` type=${type}` : ''}>. apply-fill fills, it never submits.`;
  }
  if (SUBMIT_PATTERN.test(info.text || '') || SUBMIT_PATTERN.test(info.name || '')) {
    return `refusing: element looks like a submit control ("${(info.text || info.name || '').slice(0, 60)}")`;
  }
  if (type === 'password') {
    return 'refusing to type into a password field';
  }
  if (!['textarea', 'input'].includes(tag) && !info.contentEditable) {
    return `refusing: <${tag}> is not a text input`;
  }
  // A disabled or readonly field cannot take the text. Refusing here, on
  // real element facts, beats waiting out the driver's actionability timeout
  // and then dying with a stack dump, and it must never be filled silently:
  // writing into a field the page cannot accept is how a "done" gets faked.
  if (info.disabled) {
    return `refusing: <${tag}> is disabled, so it cannot take text`;
  }
  if (info.readOnly) {
    return `refusing: <${tag}> is readonly, so it cannot take text`;
  }
  // maxLength 0 is a real cap ("nothing may be typed"), not "no cap": the
  // truthiness of 0 would skip this check and let any text through.
  const cap = typeof info.maxLength === 'number' ? info.maxLength : null
  if (cap !== null && Number.isFinite(cap) && text.length > cap) {
    return `answer is ${text.length} chars but the field caps at ${cap}. shorten it.`;
  }
  return null;
}
