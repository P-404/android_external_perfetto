--
-- Copyright 2019 The Android Open Source Project
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     https://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.
--

-- Create all the views used to generate the Android Cpu metrics proto.
SELECT RUN_METRIC('android/android_cpu_agg.sql');

CREATE VIEW core_layout_mapping AS
SELECT
  CASE
    WHEN (
      str_value LIKE '%flame%' OR
      str_value LIKE '%coral%'
    ) THEN 'big_little_bigger'
    WHEN (
      str_value LIKE '%taimen%' OR
      str_value LIKE '%walleye%' OR
      str_value LIKE '%bonito%' OR
      str_value LIKE '%sargo%' OR
      str_value LIKE '%blueline%' OR
      str_value LIKE '%crosshatch%'
    ) THEN 'big_little'
    ELSE 'unknown'
  END AS layout
FROM metadata
WHERE name = 'android_build_fingerprint';

CREATE TABLE core_layout_type AS
SELECT *
FROM (
  SELECT layout from core_layout_mapping
  UNION
  SELECT 'unknown'
)
LIMIT 1;

CREATE TABLE raw_metrics_per_core AS
SELECT
  utid,
  cpu,
  (
    SELECT
      CASE
        WHEN layout = 'big_little_bigger' AND cpu < 4 THEN 'little'
        WHEN layout = 'big_little_bigger' AND cpu < 7 THEN 'big'
        WHEN layout = 'big_little_bigger' AND cpu = 7 THEN 'bigger'
        WHEN layout = 'big_little' AND cpu < 4 THEN 'little'
        WHEN layout = 'big_little' AND cpu < 8 THEN 'big'
        ELSE 'unknown'
      END
    FROM core_layout_type
  ) AS core_type,
  CAST(SUM(dur * freq) AS INT) AS cycles,
  CAST(SUM(dur * freq / 1000000) AS INT) AS mcycles,
  CAST(SUM(dur) AS INT) AS runtime_ns,
  CAST(MIN(freq) AS INT) AS min_freq_khz,
  CAST(MAX(freq) AS INT) AS max_freq_khz,
  CAST((SUM(dur * freq) / SUM(dur)) AS INT) AS avg_freq_khz
FROM cpu_freq_sched_per_thread
GROUP BY utid, cpu;

CREATE VIEW metrics_per_core_type AS
SELECT
  utid,
  core_type,
  AndroidCpuMetric_Metrics(
    'mcycles', SUM(mcycles),
    'runtime_ns', SUM(runtime_ns),
    'min_freq_khz', MIN(min_freq_khz),
    'max_freq_khz', MAX(max_freq_khz),
    'avg_freq_khz', (SUM(cycles) / SUM(runtime_ns))
  ) AS proto
FROM raw_metrics_per_core
GROUP BY utid, core_type;

-- Aggregate everything per thread.
CREATE VIEW core_proto_per_thread AS
SELECT
  utid,
  RepeatedField(
    AndroidCpuMetric_CoreData(
      'id', cpu,
      'metrics', AndroidCpuMetric_Metrics(
        'mcycles', mcycles,
        'runtime_ns', runtime_ns,
        'min_freq_khz', min_freq_khz,
        'max_freq_khz', max_freq_khz,
        'avg_freq_khz', avg_freq_khz
      )
    )
  ) as proto
FROM raw_metrics_per_core
GROUP BY utid;

CREATE VIEW core_type_proto_per_thread AS
SELECT
  utid,
  RepeatedField(
    AndroidCpuMetric_CoreTypeData(
      'type', core_type,
      'metrics', metrics_per_core_type.proto
    )
  ) as proto
FROM metrics_per_core_type
GROUP BY utid;

CREATE VIEW metrics_proto_per_thread AS
SELECT
  utid,
  AndroidCpuMetric_Metrics(
    'mcycles', SUM(mcycles),
    'runtime_ns', SUM(runtime_ns),
    'min_freq_khz', MIN(min_freq_khz),
    'max_freq_khz', MAX(max_freq_khz),
    'avg_freq_khz', (SUM(cycles) / SUM(runtime_ns))
  ) AS proto
FROM raw_metrics_per_core
GROUP BY utid;

-- Aggregate everything per perocess
CREATE VIEW thread_proto_per_process AS
SELECT
  upid,
  RepeatedField(
    AndroidCpuMetric_Thread(
      'name', thread.name,
      'metrics', metrics_proto_per_thread.proto,
      'core', core_proto_per_thread.proto,
      'core_type', core_type_proto_per_thread.proto
    )
  ) as proto
FROM thread
LEFT JOIN core_proto_per_thread USING (utid)
LEFT JOIN core_type_proto_per_thread USING (utid)
LEFT JOIN metrics_proto_per_thread USING(utid)
GROUP BY upid;

CREATE VIEW metrics_proto_per_process AS
SELECT
  upid,
  AndroidCpuMetric_Metrics(
    'mcycles', SUM(mcycles),
    'runtime_ns', SUM(runtime_ns),
    'min_freq_khz', MIN(min_freq_khz),
    'max_freq_khz', MAX(max_freq_khz),
    'avg_freq_khz', (SUM(cycles) / SUM(runtime_ns))
  ) AS proto
FROM raw_metrics_per_core
JOIN thread USING (utid)
GROUP BY upid;

CREATE VIEW android_cpu_output AS
SELECT AndroidCpuMetric(
  'process_info', (
    SELECT RepeatedField(
      AndroidCpuMetric_Process(
        'name', process.name,
        'metrics', metrics_proto_per_process.proto,
        'threads', thread_proto_per_process.proto
      )
    )
    FROM process
    JOIN metrics_proto_per_process USING(upid)
    JOIN thread_proto_per_process USING (upid)
  )
);
