/**
 * Window events that carry a composer shortcut from the Studio keymap (which
 * owns key capture) to the composer (which owns the action). Plain strings in
 * their own module so the shell can name them without importing a component.
 */
export const COMPOSER_ATTACH_EVENT = 'ion:composer-attach'
export const COMPOSER_SCREENSHOT_EVENT = 'ion:composer-screenshot'
export const COMPOSER_QUICK_TOOLS_EVENT = 'ion:composer-quick-tools'

/** Insert text at the composer's cursor. `detail` is the text. Dispatched by surfaces that add context to the prompt. */
export const COMPOSER_INSERT_EVENT = 'ion:composer-insert'
