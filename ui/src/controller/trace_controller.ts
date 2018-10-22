// Copyright (C) 2018 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import '../tracks/all_controller';

import * as uuidv4 from 'uuid/v4';

import {assertExists, assertTrue} from '../base/logging';
import {
  Actions,
  DeferredAction,
} from '../common/actions';
import {SCROLLING_TRACK_GROUP} from '../common/state';
import {TimeSpan} from '../common/time';
import {QuantizedLoad, ThreadDesc} from '../frontend/globals';
import {SLICE_TRACK_KIND} from '../tracks/chrome_slices/common';
import {CPU_SLICE_TRACK_KIND} from '../tracks/cpu_slices/common';
import {PROCESS_SUMMARY_TRACK} from '../tracks/process_summary/common';

import {Child, Children, Controller} from './controller';
import {Engine} from './engine';
import {globals} from './globals';
import {QueryController, QueryControllerArgs} from './query_controller';
import {TrackControllerArgs, trackControllerRegistry} from './track_controller';

type States = 'init'|'loading_trace'|'ready';


declare interface FileReaderSync { readAsArrayBuffer(blob: Blob): ArrayBuffer; }

declare var FileReaderSync:
    {prototype: FileReaderSync; new (): FileReaderSync;};

// TraceController handles handshakes with the frontend for everything that
// concerns a single trace. It owns the WASM trace processor engine, handles
// tracks data and SQL queries. There is one TraceController instance for each
// trace opened in the UI (for now only one trace is supported).
export class TraceController extends Controller<States> {
  private readonly engineId: string;
  private engine?: Engine;

  constructor(engineId: string) {
    super('init');
    this.engineId = engineId;
  }

  onDestroy() {
    if (this.engine !== undefined) globals.destroyEngine(this.engine.id);
  }

  run() {
    const engineCfg = assertExists(globals.state.engines[this.engineId]);
    switch (this.state) {
      case 'init':
        globals.dispatch(Actions.setEngineReady({
          engineId: this.engineId,
          ready: false,
        }));
        this.loadTrace().then(() => {
          globals.dispatch(Actions.setEngineReady({
            engineId: this.engineId,
            ready: true,
          }));
        });
        this.updateStatus('Opening trace');
        this.setState('loading_trace');
        break;

      case 'loading_trace':
        // Stay in this state until loadTrace() returns and marks the engine as
        // ready.
        if (this.engine === undefined || !engineCfg.ready) return;
        this.setState('ready');
        break;

      case 'ready':
        // At this point we are ready to serve queries and handle tracks.
        const engine = assertExists(this.engine);
        assertTrue(engineCfg.ready);
        const childControllers: Children = [];

        // Create a TrackController for each track.
        for (const trackId of Object.keys(globals.state.tracks)) {
          const trackCfg = globals.state.tracks[trackId];
          if (trackCfg.engineId !== this.engineId) continue;
          if (!trackControllerRegistry.has(trackCfg.kind)) continue;
          const trackCtlFactory = trackControllerRegistry.get(trackCfg.kind);
          const trackArgs: TrackControllerArgs = {trackId, engine};
          childControllers.push(Child(trackId, trackCtlFactory, trackArgs));
        }

        // Create a QueryController for each query.
        for (const queryId of Object.keys(globals.state.queries)) {
          const queryArgs: QueryControllerArgs = {queryId, engine};
          childControllers.push(Child(queryId, QueryController, queryArgs));
        }

        return childControllers;

      default:
        throw new Error(`unknown state ${this.state}`);
    }
    return;
  }

  private async loadTrace() {
    this.updateStatus('Creating trace processor');
    const engineCfg = assertExists(globals.state.engines[this.engineId]);
    this.engine = globals.createEngine();

    const statusHeader = 'Opening trace';
    if (engineCfg.source instanceof File) {
      const blob = engineCfg.source as Blob;
      const reader = new FileReaderSync();
      const SLICE_SIZE = 1024 * 1024;
      for (let off = 0; off < blob.size; off += SLICE_SIZE) {
        const slice = blob.slice(off, off + SLICE_SIZE);
        const arrBuf = reader.readAsArrayBuffer(slice);
        await this.engine.parse(new Uint8Array(arrBuf));
        const progress = Math.round((off + slice.size) / blob.size * 100);
        this.updateStatus(`${statusHeader} ${progress} %`);
      }
    } else {
      const resp = await fetch(engineCfg.source);
      if (resp.status !== 200) {
        this.updateStatus(`HTTP error ${resp.status}`);
        throw new Error(`fetch() failed with HTTP error ${resp.status}`);
      }
      // tslint:disable-next-line no-any
      const rd = (resp.body as any).getReader() as ReadableStreamReader;
      const tStartMs = performance.now();
      let tLastUpdateMs = 0;
      for (let off = 0;;) {
        const readRes = await rd.read() as {value: Uint8Array, done: boolean};
        if (readRes.value !== undefined) {
          off += readRes.value.length;
          await this.engine.parse(readRes.value);
        }
        // For traces loaded from the network there doesn't seem to be a
        // reliable way to compute the %. The content-length exposed by GCS is
        // before compression (which is handled transparently by the browser).
        const nowMs = performance.now();
        if (nowMs - tLastUpdateMs > 100) {
          tLastUpdateMs = nowMs;
          const mb = off / 1e6;
          const tElapsed = (nowMs - tStartMs) / 1e3;
          let status = `${statusHeader} ${mb.toFixed(1)} MB `;
          status += `(${(mb / tElapsed).toFixed(1)} MB/s)`;
          this.updateStatus(status);
        }
        if (readRes.done) break;
      }
    }

    await this.engine.notifyEof();

    const traceTime = await this.engine.getTraceTimeBounds();
    const traceTimeState = {
      startSec: traceTime.start,
      endSec: traceTime.end,
      lastUpdate: Date.now() / 1000,
    };
    const actions = [
      Actions.setTraceTime(traceTimeState),
      Actions.navigate({route: '/viewer'}),
    ];

    if (globals.state.visibleTraceTime.lastUpdate === 0) {
      actions.push(Actions.setVisibleTraceTime(traceTimeState));
    }

    globals.dispatchMultiple(actions);

    {
      // When we reload from a permalink don't create extra tracks:
      const {pinnedTracks, scrollingTracks} = globals.state;
      if (!pinnedTracks.length && !scrollingTracks.length) {
        await this.listTracks();
      }
    }

    await this.listThreads();
    await this.loadTimelineOverview(traceTime);
  }

  private async listTracks() {
    this.updateStatus('Loading tracks');

    const engine = assertExists<Engine>(this.engine);
    const addToTrackActions: DeferredAction[] = [];
    const numCpus = await engine.getNumberOfCpus();

    // TODO(hjd): Move this code out of TraceController.
    for (const counterName of ['VSYNC-sf', 'VSYNC-app']) {
      const hasVsync =
          !!(await engine.query(
                 `select ts from counters where name like "${
                                                             counterName
                                                           }" limit 1`))
                .numRecords;
      if (!hasVsync) continue;
      addToTrackActions.push(Actions.addTrack({
        engineId: this.engineId,
        kind: 'VsyncTrack',
        name: `${counterName}`,
        config: {
          counterName,
        }
      }));
    }

    for (let cpu = 0; cpu < numCpus; cpu++) {
      addToTrackActions.push(Actions.addTrack({
        engineId: this.engineId,
        kind: CPU_SLICE_TRACK_KIND,
        name: `Cpu ${cpu}`,
        trackGroup: SCROLLING_TRACK_GROUP,
        config: {
          cpu,
        }
      }));
    }

    // Local experiments shows getting maxDepth separately is ~2x faster than
    // joining with threads and processes.
    const maxDepthQuery =
        await engine.query('select utid, max(depth) from slices group by utid');

    const utidToMaxDepth = new Map<number, number>();
    for (let i = 0; i < maxDepthQuery.numRecords; i++) {
      const utid = maxDepthQuery.columns[0].longValues![i] as number;
      const maxDepth = maxDepthQuery.columns[1].longValues![i] as number;
      utidToMaxDepth.set(utid, maxDepth);
    }

    const threadQuery = await engine.query(
        'select utid, tid, upid, pid, thread.name, process.name ' +
        'from thread inner join process using(upid)');

    const upidToUuid = new Map<number, string>();
    const addSummaryTrackActions: DeferredAction[] = [];
    const addTrackGroupActions: DeferredAction[] = [];
    for (let i = 0; i < threadQuery.numRecords; i++) {
      const utid = threadQuery.columns[0].longValues![i] as number;

      const maxDepth = utidToMaxDepth.get(utid);
      if (maxDepth === undefined) {
        // This thread does not have stackable slices.
        continue;
      }

      const tid = threadQuery.columns[1].longValues![i] as number;
      const upid = threadQuery.columns[2].longValues![i] as number;
      const pid = threadQuery.columns[3].longValues![i] as number;
      const threadName = threadQuery.columns[4].stringValues![i];
      const processName = threadQuery.columns[5].stringValues![i];

      let pUuid = upidToUuid.get(upid);
      if (pUuid === undefined) {
        pUuid = uuidv4();
        const summaryTrackId = uuidv4();
        upidToUuid.set(upid, pUuid);
        addSummaryTrackActions.push(Actions.addTrack({
          id: summaryTrackId,
          engineId: this.engineId,
          kind: PROCESS_SUMMARY_TRACK,
          name: `${pid} summary`,
          config: {upid, pid, maxDepth, utid},
        }));
        addTrackGroupActions.push(Actions.addTrackGroup({
          engineId: this.engineId,
          summaryTrackId,
          name: `${processName} ${pid}`,
          id: pUuid,
          collapsed: true,
        }));
      }

      addToTrackActions.push(Actions.addTrack({
        engineId: this.engineId,
        kind: SLICE_TRACK_KIND,
        name: threadName + `[${tid}]`,
        trackGroup: pUuid,
        config: {upid, utid, maxDepth},
      }));
    }
    const allActions =
        addSummaryTrackActions.concat(addTrackGroupActions, addToTrackActions);
    globals.dispatchMultiple(allActions);
  }

  private async listThreads() {
    this.updateStatus('Reading thread list');
    const sqlQuery = 'select utid, tid, pid, thread.name, process.name ' +
        'from thread inner join process using(upid)';
    const threadRows = await assertExists(this.engine).query(sqlQuery);
    const threads: ThreadDesc[] = [];
    for (let i = 0; i < threadRows.numRecords; i++) {
      const utid = threadRows.columns[0].longValues![i] as number;
      const tid = threadRows.columns[1].longValues![i] as number;
      const pid = threadRows.columns[2].longValues![i] as number;
      const threadName = threadRows.columns[3].stringValues![i];
      const procName = threadRows.columns[4].stringValues![i];
      threads.push({utid, tid, threadName, pid, procName});
    }  // for (record ...)
    globals.publish('Threads', threads);
  }

  private async loadTimelineOverview(traceTime: TimeSpan) {
    const engine = assertExists<Engine>(this.engine);
    const numSteps = 100;
    const stepSec = traceTime.duration / numSteps;
    for (let step = 0; step < numSteps; step++) {
      this.updateStatus(
          'Loading overview ' +
          `${Math.round((step + 1) / numSteps * 1000) / 10}%`);
      const startSec = traceTime.start + step * stepSec;
      const startNs = Math.floor(startSec * 1e9);
      const endSec = startSec + stepSec;
      const endNs = Math.ceil(endSec * 1e9);

      // Sched overview.
      const schedRows = await engine.query(
          `select sum(dur)/${stepSec}/1e9, cpu from sched ` +
          `where ts >= ${startNs} and ts < ${endNs} and utid != 0 ` +
          'group by cpu order by cpu');
      const schedData: {[key: string]: QuantizedLoad} = {};
      for (let i = 0; i < schedRows.numRecords; i++) {
        const load = schedRows.columns[0].doubleValues![i];
        const cpu = schedRows.columns[1].longValues![i] as number;
        schedData[cpu] = {startSec, endSec, load};
      }  // for (record ...)
      globals.publish('OverviewData', schedData);

    }  // for (step ...)

    // Slices overview.
    const traceStartNs = traceTime.start * 1e9;
    const stepSecNs = stepSec * 1e9;
    const sliceSummaryQuery = await engine.query(
        `select bucket, upid, sum(utid_sum) / cast(${stepSecNs} as float) ` +
        `as upid_sum from thread inner join ` +
        `(select cast((ts - ${traceStartNs})/${stepSecNs} as int) as bucket, ` +
        `sum(dur) as utid_sum, utid from slices group by bucket, utid) ` +
        `using(utid) group by bucket, upid`);

    const slicesData: {[key: string]: QuantizedLoad[]} = {};
    for (let i = 0; i < sliceSummaryQuery.numRecords; i++) {
      const bucket = sliceSummaryQuery.columns[0].longValues![i] as number;
      const upid = sliceSummaryQuery.columns[1].longValues![i] as number;
      const load = sliceSummaryQuery.columns[2].doubleValues![i];

      const startSec = traceTime.start + stepSec * bucket;
      const endSec = startSec + stepSec;

      const upidStr = upid.toString();
      let loadArray = slicesData[upidStr];
      if (loadArray === undefined) {
        loadArray = slicesData[upidStr] = [];
      }
      loadArray.push({startSec, endSec, load});
    }
    globals.publish('OverviewData', slicesData);
  }

  private updateStatus(msg: string): void {
    globals.dispatch(Actions.updateStatus({
      msg,
      timestamp: Date.now() / 1000,
    }));
  }
}