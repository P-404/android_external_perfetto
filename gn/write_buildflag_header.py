#!/usr/bin/env python
# Copyright (C) 2019 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# This writes headers for build flags. See the gen_buildflags target in
# /gn/BUILD.gn for usage.
#
# The parameters are passed in a response file so we don't have to worry
# about command line lengths. The name of the response file is passed on the
# command line.
#
# The format of the response file is:
#    [--flags <list of one or more flag values>]

import argparse
import os
import shlex
import sys

def main():
  parser = argparse.ArgumentParser()
  parser.add_argument('--rsp', help='Input response file containing the flags.')
  parser.add_argument('--out', help='Output path of the generated header file.')
  args = parser.parse_args()

  flags = []
  with open(args.rsp, 'r') as def_file:
    marker_seen = False
    for flag in shlex.split(def_file.read()):
      if not marker_seen:
        marker_seen = flag == '--flags'
        continue
      key, value = flag.split('=', 1)
      value = '1' if value == 'true' else '0' if value == 'false' else value
      flags.append((key, value))

  guard = '%s_' % args.out.upper()
  guard = guard.replace('/', '_').replace('\\', '_').replace('.', '_')
  lines = []
  lines.append('// Generated by %s' % __file__)
  lines.append('')
  lines.append('// fix_include_guards: off')
  lines.append('#ifndef %s' % guard)
  lines.append('#define %s' % guard)
  lines.append('')
  lines.append('// clang-format off')
  for kv in flags:
    lines.append('#define PERFETTO_BUILDFLAG_DEFINE_%s() (%s)' % kv)
  lines.append('')
  lines.append('// clang-format on')
  lines.append('#endif  // %s' % guard)
  lines.append('')

  with open(args.out, 'w') as out:
    out.write('\n'.join(lines))

if __name__ == '__main__':
  sys.exit(main())
