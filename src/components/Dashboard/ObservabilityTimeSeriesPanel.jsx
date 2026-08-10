// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import React, { useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
    ChartContainer, EmptyState, ToggleGroup, TimeSeriesLineChart, MAX_SERIES, seriesColor,
} from '../ui';
import { buildBenchmarkLabel } from '../../utils/dashboardHelpers';

// Elapsed-time observability charts for the browser-upload comparison view.
// Fully generic: the metric selector is the union of embedded time_series keys
// found across the selected runs, so any metric the producer embeds in the
// future appears here with no code change. One line per selected run × pod.

export function ObservabilityTimeSeriesPanel({
    filteredBySource,
    selectedBenchmarks,
    getBenchmarkKey,
    brv02CustomLabels,
}) {
    // Runs in the current comparison that carry embedded time series.
    const runs = useMemo(() => (
        (filteredBySource || [])
            .filter(d => selectedBenchmarks.has(getBenchmarkKey(d)))
            .map(d => ({ d, ts: d.metrics?.observability?.timeSeries }))
            .filter(r => r.ts && typeof r.ts === 'object')
    ), [filteredBySource, selectedBenchmarks, getBenchmarkKey]);

    // Metric keys available across those runs, each with a human label.
    const metricOptions = useMemo(() => {
        const seen = new Map();
        for (const { ts } of runs) {
            for (const [key, entry] of Object.entries(ts)) {
                if (!seen.has(key)) seen.set(key, entry.label || key);
            }
        }
        return Array.from(seen, ([value, label]) => ({ value, label }));
    }, [runs]);

    const [metricKey, setMetricKey] = useState(null);
    const activeKey = metricKey && metricOptions.some(o => o.value === metricKey)
        ? metricKey
        : metricOptions[0]?.value;

    // Color follows the entity (see skills/style.md): hues are assigned over the
    // full run × pod set in a stable order, ignoring which metric is selected and
    // which series happen to carry data for it. Switching metrics or hiding a run
    // therefore leaves every remaining line the color it already had.
    const colorOf = useMemo(() => {
        const ids = [];
        for (const { d, ts } of runs) {
            const key = getBenchmarkKey(d);
            const pods = new Set();
            for (const entry of Object.values(ts)) {
                for (const comp of entry.components || []) pods.add(comp.pod || 'agg');
            }
            for (const pod of Array.from(pods).sort()) ids.push(`${key}::${pod}`);
        }
        const map = new Map(ids.map((id, i) => [id, seriesColor(i)]));
        return (id) => map.get(id) || seriesColor(0);
    }, [runs, getBenchmarkKey]);

    const { series, unit, yLabel, unitsConflict } = useMemo(() => {
        if (!activeKey) return { series: [], unit: '', yLabel: '', unitsConflict: false };
        const out = [];
        let units = null;
        let label = activeKey;
        let conflict = false;
        for (const { d, ts } of runs) {
            const entry = ts[activeKey];
            if (!entry) continue;
            // Units belong to the metric, not to a run. Runs reporting the same
            // metric in different units must not be co-plotted under a single
            // axis label, so flag it rather than silently keeping the first.
            if (units === null) units = entry.units ?? null;
            else if ((entry.units ?? null) !== units) conflict = true;
            if (entry.unitsConflict) conflict = true;
            label = entry.label || label;
            const key = getBenchmarkKey(d);
            const runLabel = buildBenchmarkLabel(key, d, brv02CustomLabels);
            const comps = entry.components || [];
            const multiPod = comps.length > 1;
            for (const comp of comps) {
                const podLabel = multiPod && comp.pod ? `${runLabel} · ${comp.pod}` : runLabel;
                const id = `${key}::${comp.pod || 'agg'}`;
                out.push({
                    id,
                    label: podLabel,
                    color: colorOf(id),
                    points: comp.points,
                });
            }
        }
        const pct = !conflict && typeof units === 'string' && units.toLowerCase() === 'percent';
        return {
            series: out,
            unitsConflict: conflict,
            unit: pct ? '%' : (units && !conflict ? ` ${units}` : ''),
            yLabel: conflict
                ? `${label} (mixed units)`
                : (pct ? `${label} (%)` : (units ? `${label} (${units})` : label)),
        };
    }, [runs, activeKey, getBenchmarkKey, brv02CustomLabels, colorOf]);

    // The chart drops series with no points, so gate the empty state on the same
    // basis -- otherwise a metric that is present but empty for every run renders
    // a blank plot instead of the empty state.
    const drawable = useMemo(
        () => series.filter(s => Array.isArray(s.points) && s.points.length > 0),
        [series],
    );

    // Past MAX_SERIES lines one axis is unreadable and the palette has no 6th
    // hue, so split into small multiples: every series stays visible instead of
    // the tail being dropped.
    const panels = useMemo(
        () => (drawable.length <= MAX_SERIES ? [drawable] : drawable.map(s => [s])),
        [drawable],
    );
    const smallMultiples = panels.length > 1;
    const isPercent = unit === '%';

    if (selectedBenchmarks.size < 1) return null;

    return (
        <ChartContainer title="Observability Time Series">
            {metricOptions.length > 0 && (
                <div className="flex items-center gap-3 flex-wrap mb-4">
                    <span id="obs-ts-metric-label" className="text-[10px] text-theme-muted font-bold uppercase tracking-wider">Metric</span>
                    <ToggleGroup
                        options={metricOptions}
                        value={activeKey}
                        onChange={setMetricKey}
                        className="flex-wrap"
                        aria-labelledby="obs-ts-metric-label"
                    />
                </div>
            )}

            {unitsConflict && (
                <div className="flex items-start gap-2 mb-3 text-xs text-amber-700 dark:text-amber-500">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-px" aria-hidden="true" />
                    <span>
                        The selected runs report this metric in different units. Values are
                        shown as reported and are not directly comparable.
                    </span>
                </div>
            )}

            {drawable.length > 0 ? (
                <>
                    {smallMultiples ? (
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            {panels.map((p) => (
                                <div key={p[0].id}>
                                    <p className="text-[11px] text-theme-muted font-medium mb-1 truncate" title={p[0].label}>
                                        {p[0].label}
                                    </p>
                                    <TimeSeriesLineChart
                                        series={p}
                                        yLabel={yLabel}
                                        unit={unit}
                                        height={200}
                                        showLegend={false}
                                        clampPercent={isPercent}
                                        ariaLabel={`${yLabel} over elapsed time for ${p[0].label}`}
                                    />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <TimeSeriesLineChart
                            series={drawable}
                            yLabel={yLabel}
                            unit={unit}
                            clampPercent={isPercent}
                        />
                    )}
                    <p className="text-[10px] text-theme-muted mt-2 text-center">
                        One line per selected benchmark (per pod when a stack has multiple) ·
                        elapsed time rebased to each metric's first sample
                        {smallMultiples && ' · split into one chart per series to stay readable'}
                    </p>
                </>
            ) : (
                <EmptyState
                    className="h-72 py-0"
                    title="No time-series data"
                    message="The selected benchmarks don't include embedded per-timestamp metrics. Time series are only present in v0.2 reports produced with time-series embedding enabled."
                />
            )}
        </ChartContainer>
    );
}
