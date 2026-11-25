// Streamdown caches its unified processor under a key built from each
// plugin's function *name* (plus JSON options), not the function itself. A
// closure-based plugin (local images, notebook attachments) would otherwise
// reuse the processor of whichever document or cell rendered first, with that
// one's paths and asset grant. Naming the plugin after the data it closes
// over gives each its own processor.

let next = 0;
const ids = new WeakMap<object, number>();
const NONE = {};

/** Names `plugin` uniquely for `owner` (by identity), for Streamdown's cache. */
export function nameForCache<T extends (...args: never[]) => unknown>(
  plugin: T,
  label: string,
  owner: object | null,
): T {
  const key = owner ?? NONE;
  let id = ids.get(key);
  if (id === undefined) {
    id = ++next;
    ids.set(key, id);
  }
  Object.defineProperty(plugin, "name", { value: `${label}#${id}` });
  return plugin;
}
