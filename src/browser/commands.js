// Browser commands live in one registry so the menu, palette and future voice
// route call the same handlers and derive the same enabled state.

/**
 * @typedef {object} CommandDefinition
 * @property {string} id
 * @property {string} title
 * @property {string} category
 * @property {string[]} [keywords]
 * @property {string} [shortcut]
 * @property {(context: any) => boolean} [enabled]
 * @property {(context: any) => unknown | Promise<unknown>} run
 */

/**
 * @param {CommandDefinition[]} definitions
 */
export function createCommandRegistry(definitions) {
  /** @type {Map<string, CommandDefinition>} */
  const byId = new Map()
  for (const definition of definitions) {
    if (!definition?.id || byId.has(definition.id)) {
      throw new Error(`duplicate or empty command id: ${definition?.id ?? ''}`)
    }
    byId.set(definition.id, definition)
  }

  return {
    /**
     * Return serializable command metadata only. Executable callbacks remain in
     * main and never cross IPC.
     *
     * @param {any} context
     */
    list(context) {
      return definitions.map((definition) => ({
        id: definition.id,
        title: definition.title,
        category: definition.category,
        keywords: [...(definition.keywords ?? [])],
        shortcut: definition.shortcut ?? '',
        enabled: definition.enabled ? Boolean(definition.enabled(context)) : true,
      }))
    },

    /**
     * @param {string} id
     * @param {any} context
     */
    async execute(id, context) {
      const definition = byId.get(id)
      if (!definition) return { error: `unknown command ${id}` }
      if (definition.enabled && !definition.enabled(context)) {
        return { error: `command ${id} is unavailable right now` }
      }
      return definition.run(context)
    },
  }
}
