import { safeLocalStorage } from './chatStorage';

// Favorites are scoped per provider — a model id is only unique within its
// provider's catalog — matching the existing `${provider}-model` /
// `${provider}-effort` localStorage key conventions.
const favoriteModelsKey = (provider: string): string => `${provider}-favorite-models`;

/**
 * Reads the persisted favorite model ids for a provider. Returns an empty array
 * when nothing is stored or the stored value is malformed.
 */
export function readFavoriteModelIds(provider: string): string[] {
  const raw = safeLocalStorage.getItem(favoriteModelsKey(provider));
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
  } catch {
    return [];
  }
}

/** Persists the favorite model ids for a provider as a JSON id array. */
export function writeFavoriteModelIds(provider: string, ids: string[]): void {
  safeLocalStorage.setItem(favoriteModelsKey(provider), JSON.stringify(ids));
}

/**
 * Returns options with favorites floated to the top, preserving the original
 * (catalog) order within the favorited and non-favorited groups. Non-mutating;
 * returns the input array unchanged when there are no favorites.
 */
export function sortModelsByFavorite<T extends { value: string }>(
  options: T[],
  favoriteIds: ReadonlySet<string>,
): T[] {
  if (favoriteIds.size === 0) {
    return options;
  }

  const favorites: T[] = [];
  const rest: T[] = [];
  for (const option of options) {
    (favoriteIds.has(option.value) ? favorites : rest).push(option);
  }
  return [...favorites, ...rest];
}
