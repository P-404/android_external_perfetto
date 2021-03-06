// Copyright (C) 2019 The Android Open Source Project
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

import {
  AggregateData,
  Column,
  ColumnDef,
  ThreadStateExtra,
} from '../../common/aggregation_data';
import {Engine} from '../../common/engine';
import {slowlyCountRows} from '../../common/query_iterator';
import {Area, Sorting} from '../../common/state';
import {Controller} from '../controller';
import {globals} from '../globals';

export interface AggregationControllerArgs {
  engine: Engine;
  kind: string;
}

export abstract class AggregationController extends Controller<'main'> {
  readonly kind: string;
  private previousArea?: Area;
  private previousSorting?: Sorting;
  private requestingData = false;
  private queuedRequest = false;

  abstract async createAggregateView(engine: Engine, area: Area):
      Promise<boolean>;

  abstract async getExtra(engine: Engine, area: Area):
      Promise<ThreadStateExtra|void>;

  abstract getTabName(): string;
  abstract getDefaultSorting(): Sorting;
  abstract getColumnDefinitions(): ColumnDef[];

  constructor(private args: AggregationControllerArgs) {
    super('main');
    this.kind = this.args.kind;
  }

  run() {
    const selection = globals.state.currentSelection;
    if (selection === null || selection.kind !== 'AREA') {
      globals.publish('AggregateData', {
        data: {
          tabName: this.getTabName(),
          columns: [],
          strings: [],
          columnSums: [],
        },
        kind: this.args.kind
      });
      return;
    }
    const selectedArea = globals.state.areas[selection.areaId];
    const aggregatePreferences =
        globals.state.aggregatePreferences[this.args.kind];

    const areaChanged = this.previousArea !== selectedArea;
    const sortingChanged = aggregatePreferences &&
        this.previousSorting !== aggregatePreferences.sorting;
    if (!areaChanged && !sortingChanged) return;

    if (this.requestingData) {
      this.queuedRequest = true;
    } else {
      this.requestingData = true;
      if (sortingChanged) this.previousSorting = aggregatePreferences.sorting;
      if (areaChanged) this.previousArea = Object.assign({}, selectedArea);
      this.getAggregateData(selectedArea, areaChanged)
          .then(
              data => globals.publish(
                  'AggregateData', {data, kind: this.args.kind}))
          .finally(() => {
            this.requestingData = false;
            if (this.queuedRequest) {
              this.queuedRequest = false;
              this.run();
            }
          });
    }
  }

  async getAggregateData(area: Area, areaChanged: boolean):
      Promise<AggregateData> {
    if (areaChanged) {
      const viewExists = await this.createAggregateView(this.args.engine, area);
      if (!viewExists) {
        return {
          tabName: this.getTabName(),
          columns: [],
          strings: [],
          columnSums: [],
        };
      }
    }

    const defs = this.getColumnDefinitions();
    const colIds = defs.map(col => col.columnId);
    const pref = globals.state.aggregatePreferences[this.kind];
    let sorting = `${this.getDefaultSorting().column} ${
        this.getDefaultSorting().direction}`;
    if (pref && pref.sorting) {
      sorting = `${pref.sorting.column} ${pref.sorting.direction}`;
    }
    const query = `select ${colIds} from ${this.kind} order by ${sorting}`;
    const result = await this.args.engine.query(query);

    const numRows = slowlyCountRows(result);
    const columns = defs.map(def => this.columnFromColumnDef(def, numRows));
    const columnSums = await Promise.all(defs.map(def => this.getSum(def)));
    const extraData = await this.getExtra(this.args.engine, area);
    const extra = extraData ? extraData : undefined;
    const data: AggregateData =
        {tabName: this.getTabName(), columns, columnSums, strings: [], extra};

    const stringIndexes = new Map<string, number>();
    function internString(str: string) {
      let idx = stringIndexes.get(str);
      if (idx !== undefined) return idx;
      idx = data.strings.length;
      data.strings.push(str);
      stringIndexes.set(str, idx);
      return idx;
    }

    for (let row = 0; row < numRows; row++) {
      const cols = result.columns;
      for (let col = 0; col < result.columns.length; col++) {
        if (cols[col].stringValues && cols[col].stringValues!.length > 0) {
          data.columns[col].data[row] =
              internString(cols[col].stringValues![row]);
        } else if (cols[col].longValues && cols[col].longValues!.length > 0) {
          data.columns[col].data[row] = cols[col].longValues![row];
        } else if (
            cols[col].doubleValues && cols[col].doubleValues!.length > 0) {
          data.columns[col].data[row] = cols[col].doubleValues![row];
        }
      }
    }
    return data;
  }

  async getSum(def: ColumnDef): Promise<string> {
    if (!def.sum) return '';
    const result = await this.args.engine.queryOneRow(
        `select sum(${def.columnId}) from ${this.kind}`);
    let sum = result[0];
    if (def.kind === 'TIMESTAMP_NS') {
      sum = sum / 1e6;
    }
    return `${sum}`;
  }

  columnFromColumnDef(def: ColumnDef, numRows: number): Column {
    // TODO(hjd): The Column type should be based on the
    // ColumnDef type or vice versa to avoid this cast.
    return {
      title: def.title,
      kind: def.kind,
      data: new def.columnConstructor(numRows),
      columnId: def.columnId,
    } as Column;
  }
}
