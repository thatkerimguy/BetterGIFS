import Page from "@valenced/components/Page";
import { Design } from "@valenced/discord/design";
import { ScrollView } from "react-native";

import type { PluginSettingsComponent } from "@valenced/plugins/types";
import type { ComponentProps } from "react";

import type { Quality } from "./lowres";
import { DefaultSettings, type Settings } from "./shared";

const { Stack, TableRadioGroup, TableRadioRow, TableRowGroup, TableSwitchRow } = Design;

const qualities: { value: Quality; label: string; subLabel: string; }[] = [
    { value: "xs", label: "XS", subLabel: "Smallest previews, fastest loading" },
    { value: "s", label: "S", subLabel: "Small previews (Discord's mobile default for Klipy)" },
    { value: "sd", label: "SD", subLabel: "Medium previews" },
    { value: "original", label: "Original", subLabel: "Don't downscale previews" },
];

const concurrencies = [1, 2, 3, 4, 6];
const timeouts = [5, 10, 20, 30];
const buffers = [
    { value: 6, label: "Small", subLabel: "About 3 rows. Least memory." },
    { value: 12, label: "Medium", subLabel: "About 6 rows. Recommended." },
    { value: 24, label: "Large", subLabel: "About 12 rows. Less reloading while scrolling." },
];
const cacheSizes = [
    { value: 300, label: "300 GIFs" },
    { value: 1000, label: "1000 GIFs" },
    { value: 3000, label: "3000 GIFs" },
];

type Props = ComponentProps<PluginSettingsComponent<{ jsonStorage: Settings; }>>;

export default function SettingsComponent({ api: { jsonStorage: storage } }: Props) {
    const s: Settings = { ...DefaultSettings, ...storage.use() };
    const update = (patch: Partial<Settings>) => storage.set(patch);

    return (
        <Page>
            {/* Page doesn't scroll by itself, and these settings are taller than the screen */}
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 48 }}>
                <Stack spacing={24}>
                    <TableRadioGroup
                        title="Preview quality (sent GIFs are always full resolution)"
                        defaultValue={s.quality}
                        onChange={(quality: Quality) => update({ quality })}
                    >
                        {qualities.map(q => (
                            <TableRadioRow key={q.value} label={q.label} subLabel={q.subLabel} value={q.value} />
                        ))}
                    </TableRadioGroup>

                    <TableRowGroup title="Loading">
                        <TableSwitchRow
                            label="Sequential loading"
                            subLabel="Load GIFs one after another, left to right and top to bottom"
                            value={s.sequential}
                            onValueChange={(sequential: boolean) => update({ sequential })}
                        />
                        <TableSwitchRow
                            label="Show loading progress"
                            subLabel="Show an indicator on GIFs that haven't loaded yet"
                            value={s.showProgress}
                            onValueChange={(showProgress: boolean) => update({ showProgress })}
                        />
                        <TableSwitchRow
                            label="Small Klipy previews"
                            subLabel="Ask Discord's GIF API for the smaller Klipy files (one extra request per search page)"
                            value={s.klipyLookup}
                            onValueChange={(klipyLookup: boolean) => update({ klipyLookup })}
                        />
                    </TableRowGroup>

                    <TableRowGroup title="Performance">
                        <TableSwitchRow
                            label="Unload off-screen GIFs"
                            subLabel="Free memory by unloading GIFs you scrolled far away from. They come back from cache when you scroll back."
                            value={s.unloadOffscreen}
                            onValueChange={(unloadOffscreen: boolean) => update({ unloadOffscreen })}
                        />
                        <TableSwitchRow
                            label="Still previews in favourites"
                            subLabel="Show a still image instead of a playing GIF in the favourites tab (Tenor, Giphy, Twitter and Discord links). Sent GIFs still animate."
                            value={s.stillFavorites}
                            onValueChange={(stillFavorites: boolean) => update({ stillFavorites })}
                        />
                        <TableSwitchRow
                            label="Favourites only"
                            subLabel="Hide Trending GIFs and the other featured categories. The GIF tab's main page keeps search and the Favorites category."
                            value={s.favoritesOnly}
                            onValueChange={(favoritesOnly: boolean) => update({ favoritesOnly })}
                        />
                        <TableSwitchRow
                            label="Faster GIF tab switch"
                            subLabel="Switch to the GIF tab right away and build the picker a moment later, instead of freezing until it's ready"
                            value={s.fastTabSwitch}
                            onValueChange={(fastTabSwitch: boolean) => update({ fastTabSwitch })}
                        />
                    </TableRowGroup>

                    <TableRadioGroup
                        title="Keep loaded around the screen"
                        defaultValue={String(s.offscreenBuffer)}
                        onChange={(v: string) => update({ offscreenBuffer: Number(v) })}
                    >
                        {buffers.map(b => (
                            <TableRadioRow key={b.value} label={b.label} subLabel={b.subLabel} value={String(b.value)} />
                        ))}
                    </TableRadioGroup>

                    <TableRadioGroup
                        title="Remember loaded GIFs"
                        defaultValue={String(s.cacheSize)}
                        onChange={(v: string) => update({ cacheSize: Number(v) })}
                    >
                        {cacheSizes.map(c => (
                            <TableRadioRow key={c.value} label={c.label} value={String(c.value)} />
                        ))}
                    </TableRadioGroup>

                    <TableRadioGroup
                        title="GIFs loading at the same time"
                        defaultValue={String(s.concurrency)}
                        onChange={(v: string) => update({ concurrency: Number(v) })}
                    >
                        {concurrencies.map(c => (
                            <TableRadioRow key={c} label={String(c)} value={String(c)} />
                        ))}
                    </TableRadioGroup>

                    <TableRadioGroup
                        title="Move on from a slow GIF after"
                        defaultValue={String(s.loadTimeout)}
                        onChange={(v: string) => update({ loadTimeout: Number(v) })}
                    >
                        {timeouts.map(t => (
                            <TableRadioRow key={t} label={`${t} seconds`} value={String(t)} />
                        ))}
                    </TableRadioGroup>
                </Stack>
            </ScrollView>
        </Page>
    );
}
