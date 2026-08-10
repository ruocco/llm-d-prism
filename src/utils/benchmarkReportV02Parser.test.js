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

import {
    parseReportV02, stripDerivedTimeSeries, rehydrateDerivedTimeSeries,
} from './benchmarkReportV02Parser.js';
import assert from 'node:assert';

console.log('Running benchmarkReportV02Parser time-series unit tests...');

// parseReportV02 accepts a pre-parsed object, so these build docs directly.
const report = (observability) => ({
    version: '0.2',
    run: { uid: 'u1', time: { start: '2026-01-01T00:00:00Z' } },
    results: { observability },
});

// startSec offsets from RUN_START, matching the literal timestamps used below,
// so cross-component alignment can be asserted meaningfully.
const RUN_START = Date.parse('2026-01-01T00:00:00Z');

const seriesOf = (units, values, startSec = 0) => ({
    units,
    series: values.map((value, i) => ({
        ts: new Date(RUN_START + (startSec + i * 15) * 1000).toISOString(),
        value,
    })),
});

// v0.2 shape: results.observability.components[] holds ComponentObservability
// entries whose time_series is a TimeSeriesResourceMetrics (named fields).
const comps = (...components) => ({ components });

const comp = (replicaId, timeSeries, componentLabel = 'decode-engine') => ({
    component_label: componentLabel,
    replica_id: replicaId,
    time_series: timeSeries,
});

const tsOf = (doc, field) => parseReportV02(doc, 'f.yaml').observability.timeSeries[field];

// 1. A fraction series scales once, uniformly, to 0-100.
{
    const entry = tsOf(report(comps(
        comp('p1', { kv_cache_usage: seriesOf('fraction', [0.008, 0.01, 0.5, 1]) }),
    )), 'kv_cache_usage');
    assert.deepStrictEqual(
        entry.components[0].points.map(p => p.value),
        [0.8, 1, 50, 100],
    );
    assert.strictEqual(entry.units, 'percent', 'a rescaled fraction reports as percent');
}

// 2. A percent series that dips below 1 must NOT have only its small samples
//    rescaled — the regression that fabricated spikes.
{
    const entry = tsOf(report(comps(
        comp('p1', { gpu_utilization: seriesOf('percent', [0.8, 1.2, 55, 99]) }),
    )), 'gpu_utilization');
    assert.deepStrictEqual(
        entry.components[0].points.map(p => p.value),
        [0.8, 1.2, 55, 99],
        'already-percent series must pass through unscaled',
    );
}

// 3. Non-portion units are never scaled.
{
    const entry = tsOf(report(comps(
        comp('p1', { gpu_memory_usage: seriesOf('bytes', [0.25, 0.5, 3]) }),
    )), 'gpu_memory_usage');
    assert.deepStrictEqual(entry.components[0].points.map(p => p.value), [0.25, 0.5, 3]);
    assert.strictEqual(entry.units, 'bytes');
}

// 4. tSec rebases to the field's earliest sample across ALL components, so a pod
//    that joined late stays offset instead of being drawn as if it started with
//    the run. Order is normalized.
{
    const entry = tsOf(report(comps(
        comp('p1', { gpu_memory_usage: seriesOf('bytes', [1, 2, 3], 600) }),
        comp('p2', {
            gpu_memory_usage: {
                units: 'bytes',
                series: [
                    { ts: '2026-01-01T00:00:30Z', value: 9 },
                    { ts: '2026-01-01T00:00:00Z', value: 7 },
                ],
            },
        }),
    )), 'gpu_memory_usage');
    assert.deepStrictEqual(entry.components[0].points.map(p => p.tSec), [600, 615, 630]);
    assert.deepStrictEqual(entry.components[1].points.map(p => p.tSec), [0, 30]);
    assert.deepStrictEqual(entry.components[1].points.map(p => p.value), [7, 9]);
}

// 5. Unparseable timestamps and null values are dropped, not turned into NaN.
{
    const entry = tsOf(report(comps(
        comp('p1', {
            gpu_memory_usage: {
                units: 'bytes',
                series: [
                    { ts: 'not-a-date', value: 5 },
                    { ts: '2026-01-01T00:00:00Z', value: 4 },
                    { ts: '2026-01-01T00:00:15Z', value: null },
                    { ts: '2026-01-01T00:00:30Z', value: 6 },
                ],
            },
        }),
    )), 'gpu_memory_usage');
    assert.deepStrictEqual(entry.components[0].points, [
        { tSec: 0, value: 4 },
        { tSec: 30, value: 6 },
    ]);
}

// 6. Components with no usable points are omitted; a field left with none does
//    not appear at all.
{
    const doc = report({
        ...comps(
            comp('empty', { gpu_memory_usage: { units: 'bytes', series: [] } }),
            comp('bad', { gpu_memory_usage: { units: 'bytes', series: [{ ts: 'nope', value: 1 }] } }),
        ),
        vllm_num_requests_running: { aggregated: { mean: 2 } },
    });
    const parsed = parseReportV02(doc, 'f.yaml');
    assert.strictEqual(parsed.observability.timeSeries, null);
    assert.strictEqual(parsed.observability.numRequestsRunningMean, 2);
}

// 7. A field with no curated label still surfaces, humanized (the time_series
//    block is an open record, so a new schema field needs no parser change).
{
    const entry = tsOf(report(comps(
        comp('p1', { some_future_field: seriesOf('count', [3, 4]) }),
    )), 'some_future_field');
    assert.strictEqual(entry.label, 'Some Future Field');
    assert.strictEqual(entry.units, 'count');
}

// 8. Known fields use their curated label.
{
    const entry = tsOf(report(comps(
        comp('p1', { kv_cache_usage: seriesOf('fraction', [0.5]) }),
    )), 'kv_cache_usage');
    assert.strictEqual(entry.label, 'KV Cache Usage');
}

// 9. A report whose observability holds ONLY time series still yields an
//    observability object (every aggregate null).
{
    const parsed = parseReportV02(report(comps(
        comp('p1', { kv_cache_usage: seriesOf('fraction', [0.25, 0.75]) }),
    )), 'f.yaml');
    assert.notStrictEqual(parsed.observability, null);
    assert.strictEqual(parsed.observability.kvCacheUsageMean, null);
    assert.strictEqual(parsed.observability.timeSeries.kv_cache_usage.components.length, 1);
}

// 10. Observability with neither aggregates nor series stays null.
{
    const parsed = parseReportV02(report({
        vllm_kv_cache_usage_perc: { aggregated: {} },
    }), 'f.yaml');
    assert.strictEqual(parsed.observability, null);
}

// 11. One component carrying several fields fans out into one entry per field,
//     each keeping that component's identity.
{
    const parsed = parseReportV02(report(comps(
        comp('decode-1', {
            kv_cache_usage: seriesOf('fraction', [0.2, 0.4]),
            gpu_utilization: seriesOf('percent', [40, 80]),
            power_consumption: seriesOf('Watts', [250.5, 310]),
        }),
    )), 'f.yaml');
    const ts = parsed.observability.timeSeries;
    assert.deepStrictEqual(
        Object.keys(ts).sort(),
        ['gpu_utilization', 'kv_cache_usage', 'power_consumption'],
    );
    assert.strictEqual(ts.power_consumption.units, 'Watts');
    assert.strictEqual(ts.kv_cache_usage.components[0].pod, 'decode-1');
    assert.strictEqual(ts.kv_cache_usage.components[0].role, 'decode-engine');
}

// 12. Multiple replicas of one field become distinct components, in order.
{
    const entry = tsOf(report(comps(
        comp('decode-1', { kv_cache_usage: seriesOf('fraction', [0.1]) }, 'decode-engine'),
        comp('prefill-1', { kv_cache_usage: seriesOf('fraction', [0.9]) }, 'prefill-engine'),
    )), 'kv_cache_usage');
    assert.deepStrictEqual(entry.components.map(c => c.pod), ['decode-1', 'prefill-1']);
    assert.deepStrictEqual(entry.components.map(c => c.role), ['decode-engine', 'prefill-engine']);
}

// 13. The fraction/percent decision is made over every component of a field, so
//     two pods of one run can never end up on the same axis 100x apart.
{
    const entry = tsOf(report(comps(
        comp('p1', { kv_cache_usage: seriesOf('fraction', [0.2, 0.9]) }),
        comp('p2', { kv_cache_usage: seriesOf('fraction', [0.2, 1.0000001]) }),
    )), 'kv_cache_usage');
    // One sample >1 means the field is not a clean 0..1 fraction, so NOTHING is
    // rescaled and the units are reported as given.
    assert.deepStrictEqual(entry.components[0].points.map(p => p.value), [0.2, 0.9]);
    assert.deepStrictEqual(entry.components[1].points.map(p => p.value), [0.2, 1.0000001]);
    assert.strictEqual(entry.units, 'fraction', 'unscaled values must not be labelled percent');
}

// 14. A fraction series holding one >1 glitch sample keeps fraction units rather
//     than claiming percent while reading ~0 on a 0-100 axis.
{
    const entry = tsOf(report(comps(
        comp('p1', { kv_cache_usage: seriesOf('fraction', [0.2, 0.4, 1.05, 0.6]) }),
    )), 'kv_cache_usage');
    assert.deepStrictEqual(entry.components[0].points.map(p => p.value), [0.2, 0.4, 1.05, 0.6]);
    assert.strictEqual(entry.units, 'fraction');
}

// 15. Components disagreeing on units are flagged, not silently co-plotted under
//     whichever unit happened to be parsed first.
{
    const entry = tsOf(report(comps(
        comp('p1', { power_consumption: seriesOf('Watts', [300]) }),
        comp('p2', { power_consumption: seriesOf('milliwatts', [300000]) }),
    )), 'power_consumption');
    assert.strictEqual(entry.unitsConflict, true);
    assert.strictEqual(entry.components.length, 2);
}

// 16. Agreeing units set no conflict flag, and surrounding whitespace does not
//     defeat either the match or the portion detection.
{
    const entry = tsOf(report(comps(
        comp('p1', { kv_cache_usage: seriesOf(' fraction ', [0.5]) }),
        comp('p2', { kv_cache_usage: seriesOf('fraction', [0.25]) }),
    )), 'kv_cache_usage');
    assert.strictEqual(entry.unitsConflict, undefined);
    assert.strictEqual(entry.units, 'percent');
    assert.deepStrictEqual(entry.components.map(c => c.points[0].value), [50, 25]);
}

// 17. Repeated timestamps collapse to the first reading: a duplicate would draw a
//     vertical segment and the tooltip could only ever report one of them.
{
    const entry = tsOf(report(comps(
        comp('p1', {
            gpu_memory_usage: {
                units: 'bytes',
                series: [
                    { ts: '2026-01-01T00:00:00Z', value: 10 },
                    { ts: '2026-01-01T00:00:00Z', value: 90 },
                    { ts: '2026-01-01T00:00:15Z', value: 20 },
                ],
            },
        }),
    )), 'gpu_memory_usage');
    assert.deepStrictEqual(entry.components[0].points, [
        { tSec: 0, value: 10 },
        { tSec: 15, value: 20 },
    ]);
}

// 18. Time series are stripped before persisting and rebuilt from rawReport on
//     load, so localStorage carries no second copy of them.
{
    const doc = report(comps(
        comp('p1', { kv_cache_usage: seriesOf('fraction', [0.2, 0.4]) }),
    ));
    const stage = parseReportV02(doc, 'f.yaml');
    assert.notStrictEqual(stage.observability.timeSeries, null);

    const runs = [{ runId: 'r1', stages: [stage] }];
    const stripped = stripDerivedTimeSeries(runs);
    assert.strictEqual(stripped[0].stages[0].observability.timeSeries, undefined);
    assert.strictEqual('timeSeries' in stripped[0].stages[0].observability, false);
    // Aggregates and rawReport survive the strip.
    assert.notStrictEqual(stripped[0].stages[0].rawReport, undefined);
    // The original is untouched.
    assert.notStrictEqual(runs[0].stages[0].observability.timeSeries, undefined);

    const roundTripped = rehydrateDerivedTimeSeries(JSON.parse(JSON.stringify(stripped)));
    assert.deepStrictEqual(
        roundTripped[0].stages[0].observability.timeSeries,
        stage.observability.timeSeries,
    );
}

console.log('✓ all benchmarkReportV02Parser time-series tests passed');
