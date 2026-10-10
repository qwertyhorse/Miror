/** Browser data and absolute URLs belong to the build's version, not its origin. */
const versionNamespace = "openbuy:versions:";

export function createVersionScope(base: string) {
  const normalized = base.replace(/^\/+|\/+$/g, "");
  const appBasePath = normalized ? `/${normalized}` : "";
  const namespace = appBasePath
    ? `${versionNamespace}${encodeURIComponent(appBasePath.slice(1))}:`
    : "";

  const scopeName = (name: string) => `${namespace}${name}`;
  const storageKey = (key: string) => scopeName(String(key));
  const unscopedStorageKey = (key: string | null): string | null | undefined => {
    if (key === null) return null;
    if (namespace) return key.startsWith(namespace) ? key.slice(namespace.length) : undefined;
    return key.startsWith(versionNamespace) ? undefined : key;
  };
  const appUrl = (path: string): string => {
    // External resources, object URLs, and links within the current page keep their meaning.
    if (!path || /^(?:[a-z][a-z\d+.-]*:|\/\/|[?#])/i.test(path)) return path;
    const absolute = `/${path.replace(/^(?:\.\/)+/, "").replace(/^\/+/, "")}`;
    if (!appBasePath || absolute === appBasePath ||
      absolute.startsWith(`${appBasePath}/`) ||
      absolute.startsWith(`${appBasePath}?`) ||
      absolute.startsWith(`${appBasePath}#`)) return absolute;
    return `${appBasePath}${absolute}`;
  };

  const storage = (source: Storage | (() => Storage)): Storage => {
    const native = () => typeof source === "function" ? source() : source;
    const keys = () => {
      const target = native();
      const result: string[] = [];
      for (let index = 0; index < target.length; index++) {
        const key = unscopedStorageKey(target.key(index));
        if (key !== null && key !== undefined) result.push(key);
      }
      return result;
    };
    return {
      get length() { return keys().length; },
      key(index: number) { return keys()[index] ?? null; },
      getItem(key: string) { return native().getItem(storageKey(key)); },
      setItem(key: string, value: string) { native().setItem(storageKey(key), String(value)); },
      removeItem(key: string) { native().removeItem(storageKey(key)); },
      clear() {
        const target = native();
        for (const key of keys()) target.removeItem(storageKey(key));
      },
    };
  };

  const storageEventKey = (event: StorageEvent, target: Storage) =>
    event.storageArea === target ? unscopedStorageKey(event.key) : undefined;

  return { appBasePath, appUrl, scopeName, storageKey, unscopedStorageKey, storage, storageEventKey };
}

const scope = createVersionScope(import.meta.env.BASE_URL);
export const appBasePath = scope.appBasePath;
export const appUrl = scope.appUrl;
export const scopeName = scope.scopeName;
export const scopedStorageKey = scope.storageKey;
export const scopedLocalStorage = scope.storage(() => globalThis.localStorage);
export const scopedSessionStorage = scope.storage(() => globalThis.sessionStorage);
/** Return a logical key only for this version and the original browser Storage object. */
export function scopedStorageEventKey(event: StorageEvent, area: "localStorage" | "sessionStorage" = "localStorage") {
  try { return scope.storageEventKey(event, globalThis[area]); }
  catch { return undefined; }
}
