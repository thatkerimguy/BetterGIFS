import type { JsonStorage } from "@valenced/json-storage";

import type { Quality } from "./lowres";

export interface Settings {
    quality: Quality;
    sequential: boolean;
    concurrency: number;
    loadTimeout: number;
    showProgress: boolean;
    klipyLookup: boolean;
    /** Unload GIFs that are far off screen and reload them (from cache) when they come back */
    unloadOffscreen: boolean;
    /** How many items above/below the visible ones stay loaded */
    offscreenBuffer: number;
    /** How many loaded GIF URLs to remember, so they show instantly when scrolled back to */
    cacheSize: number;
    /** Show still (not animated) previews in the favourites tab */
    stillFavorites: boolean;
    /** Switch to the GIF tab first and build the picker a moment later */
    fastTabSwitch: boolean;
    /** When not searching, show favourites instead of Trending and the other featured categories */
    favoritesOnly: boolean;
}

export const DefaultSettings: Settings = {
    // Discord mobile already shows the S (tinywebp) rendition of Klipy GIFs
    quality: "xs",
    sequential: true,
    concurrency: 3,
    loadTimeout: 10,
    showProgress: true,
    klipyLookup: true,
    unloadOffscreen: true,
    offscreenBuffer: 12,
    cacheSize: 1000,
    stillFavorites: false,
    fastTabSwitch: true,
    favoritesOnly: false,
};

/** One line of cache stats in settings */
export interface CacheStat {
    label: string;
    value: string;
}

/** Set by the plugin while it runs, so settings can show stats and reset the caches */
export const cacheControl: {
    stats?: () => CacheStat[];
    reset?: () => void;
} = {};

let storage: JsonStorage<Settings> | undefined;
/**
 * The storage components subscribe to. Kept after the plugin stops, so a
 * component that re-renders then still calls the same hook (React requires the
 * same hooks on every render). It's only unset before the first start, when no
 * patched component can be mounted yet.
 */
let hookStorage: JsonStorage<Settings> | undefined;

export function setStorage(s: JsonStorage<Settings> | undefined) {
    storage = s;
    if (s) hookStorage = s;
}

/** Current settings, outside of React */
export function getSettings(): Settings {
    return { ...DefaultSettings, ...(storage?.cache as Partial<Settings> | undefined) };
}

/** Current settings in a component, re-rendering when they change */
export function useSettings(): Settings {
    return { ...DefaultSettings, ...hookStorage?.use() };
}
