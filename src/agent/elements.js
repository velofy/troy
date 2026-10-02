// Opaque element capabilities. Models see refs such as e7, never selectors;
// each ref is bound to one tab, URL and document epoch and expires after any
// mutation or navigation.

export class ElementRegistry {
  constructor() {
    /** @type {Map<string, { selector: string, item: Record<string, any>, tabId: number, url: string, epoch: number }>} */
    this.entries = new Map()
    this.counter = 0
  }

  invalidate() {
    this.entries.clear()
  }

  /**
   * Replace the current capability set with one fresh page read.
   *
   * @param {Array<Record<string, any>>} items
   * @param {{ tabId: number, url: string, epoch: number }} context
   */
  register(items, context) {
    this.invalidate()
    return items.map((item) => {
      const ref = `e${++this.counter}`
      const selector = String(item.selector ?? '')
      const publicItem = /** @type {Record<string, any>} */ ({ ...item, ref })
      delete publicItem.selector
      this.entries.set(ref, {
        selector,
        item: { ...publicItem },
        tabId: context.tabId,
        url: context.url,
        epoch: context.epoch,
      })
      return publicItem
    })
  }

  /**
   * @param {unknown} ref
   * @param {{ tabId: number, url: string, epoch: number }} context
   * @returns {{ selector: string, item: Record<string, any> } | { error: string }}
   */
  resolve(ref, context) {
    const name = String(ref ?? '')
    if (!/^e\d+$/.test(name)) return { error: 'the element reference is missing or malformed; read the page again' }
    const entry = this.entries.get(name)
    if (!entry) return { error: `${name} is stale or unknown; read the page again` }
    if (entry.tabId !== context.tabId || entry.url !== context.url || entry.epoch !== context.epoch) {
      this.invalidate()
      return { error: `${name} belongs to an older page state; read the page again` }
    }
    return { selector: entry.selector, item: { ...entry.item } }
  }
}
