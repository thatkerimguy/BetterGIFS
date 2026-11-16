import { createPluginStore } from "@api/storage";

import type { Quality } from "./lowres";

export interface GifPickerOptimizerSettings {
    quality: Quality;
    sequential: boolean;
    concurrency: number;
    loadTimeout: number;
    showProgress: boolean;
    klipyLookup: boolean;
}

export const {
    useStore: useGifPickerOptimizerSettings,
    settings: gpoSettings,
} = createPluginStore<GifPickerOptimizerSettings>("gifpickeroptimizer", {
    quality: "xs",
    sequential: true,
    concurrency: 1,
    loadTimeout: 10,
    showProgress: true,
    klipyLookup: true,
});
