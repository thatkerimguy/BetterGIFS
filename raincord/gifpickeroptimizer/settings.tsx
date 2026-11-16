import { Stack, TableRadioGroup, TableRadioRow, TableRowGroup, TableSwitchRow } from "@metro/common/components";
import { ScrollView } from "react-native";

import { useGifPickerOptimizerSettings } from "./storage";

const qualities = [
    { value: "xs", label: "XS", subLabel: "Smallest previews, fastest loading" },
    { value: "s", label: "S", subLabel: "Small previews (Discord's mobile default for Klipy)" },
    { value: "sd", label: "SD", subLabel: "Medium previews" },
    { value: "original", label: "Original", subLabel: "Don't downscale previews" },
];

const concurrencies = [1, 2, 3, 4, 6];
const timeouts = [5, 10, 20, 30];

export default function GifPickerOptimizerSettings() {
    const store = useGifPickerOptimizerSettings();

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 38 }}>
            <Stack style={{ paddingVertical: 24, paddingHorizontal: 12 }} spacing={24}>
                <TableRadioGroup
                    title="Preview quality (sent GIFs are always full resolution)"
                    value={store.quality}
                    onChange={(v: any) => store.updateSettings({ quality: v })}
                >
                    {qualities.map(q => (
                        <TableRadioRow key={q.value} label={q.label} subLabel={q.subLabel} value={q.value} />
                    ))}
                </TableRadioGroup>

                <TableRowGroup title="Loading">
                    <TableSwitchRow
                        label="Sequential loading"
                        subLabel="Load GIFs one after another, left to right and top to bottom"
                        value={store.sequential}
                        onValueChange={(v: boolean) => store.updateSettings({ sequential: v })}
                    />
                    <TableSwitchRow
                        label="Show loading progress"
                        subLabel="Show an indicator on GIFs that haven't loaded yet"
                        value={store.showProgress}
                        onValueChange={(v: boolean) => store.updateSettings({ showProgress: v })}
                    />
                    <TableSwitchRow
                        label="Small Klipy previews"
                        subLabel="Ask Discord's GIF API for the smaller Klipy files (one extra request per search page)"
                        value={store.klipyLookup}
                        onValueChange={(v: boolean) => store.updateSettings({ klipyLookup: v })}
                    />
                </TableRowGroup>

                <TableRadioGroup
                    title="GIFs loading at the same time"
                    value={String(store.concurrency)}
                    onChange={(v: string) => store.updateSettings({ concurrency: Number(v) })}
                >
                    {concurrencies.map(c => (
                        <TableRadioRow key={c} label={String(c)} value={String(c)} />
                    ))}
                </TableRadioGroup>

                <TableRadioGroup
                    title="Move on from a slow GIF after"
                    value={String(store.loadTimeout)}
                    onChange={(v: string) => store.updateSettings({ loadTimeout: Number(v) })}
                >
                    {timeouts.map(t => (
                        <TableRadioRow key={t} label={`${t} seconds`} value={String(t)} />
                    ))}
                </TableRadioGroup>
            </Stack>
        </ScrollView>
    );
}
