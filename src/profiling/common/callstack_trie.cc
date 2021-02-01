/*
 * Copyright (C) 2020 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include "src/profiling/common/callstack_trie.h"

#include <vector>

#include "perfetto/ext/base/string_splitter.h"
#include "src/profiling/common/interner.h"
#include "src/profiling/common/unwind_support.h"

namespace perfetto {
namespace profiling {

GlobalCallstackTrie::Node* GlobalCallstackTrie::GetOrCreateChild(
    Node* self,
    const Interned<Frame>& loc) {
  Node* child = self->children_.Get(loc);
  if (!child)
    child = self->children_.Emplace(loc, ++next_callstack_id_, self);
  return child;
}

std::vector<Interned<Frame>> GlobalCallstackTrie::BuildInverseCallstack(
    const Node* node) const {
  std::vector<Interned<Frame>> res;
  while (node != &root_) {
    res.emplace_back(node->location_);
    node = node->parent_;
  }
  return res;
}

GlobalCallstackTrie::Node* GlobalCallstackTrie::CreateCallsite(
    const std::vector<unwindstack::FrameData>& callstack,
    const std::vector<std::string>& build_ids) {
  PERFETTO_CHECK(callstack.size() == build_ids.size());
  Node* node = &root_;
  // libunwindstack gives the frames top-first, but we want to bookkeep and
  // emit as bottom first.
  auto callstack_it = callstack.crbegin();
  auto build_id_it = build_ids.crbegin();
  for (; callstack_it != callstack.crend() && build_id_it != build_ids.crend();
       ++callstack_it, ++build_id_it) {
    const unwindstack::FrameData& loc = *callstack_it;
    const std::string& build_id = *build_id_it;
    node = GetOrCreateChild(node, InternCodeLocation(loc, build_id));
  }
  return node;
}

GlobalCallstackTrie::Node* GlobalCallstackTrie::CreateCallsite(
    const std::vector<Interned<Frame>>& callstack) {
  Node* node = &root_;
  // libunwindstack gives the frames top-first, but we want to bookkeep and
  // emit as bottom first.
  for (auto it = callstack.crbegin(); it != callstack.crend(); ++it) {
    const Interned<Frame>& loc = *it;
    node = GetOrCreateChild(node, loc);
  }
  return node;
}

void GlobalCallstackTrie::IncrementNode(Node* node) {
  while (node != nullptr) {
    node->ref_count_ += 1;
    node = node->parent_;
  }
}

void GlobalCallstackTrie::DecrementNode(Node* node) {
  PERFETTO_DCHECK(node->ref_count_ >= 1);

  bool delete_prev = false;
  Node* prev = nullptr;
  while (node != nullptr) {
    if (delete_prev)
      node->children_.Remove(*prev);
    node->ref_count_ -= 1;
    delete_prev = node->ref_count_ == 0;
    prev = node;
    node = node->parent_;
  }
}

Interned<Frame> GlobalCallstackTrie::InternCodeLocation(
    const unwindstack::FrameData& loc,
    const std::string& build_id) {
  Mapping map(string_interner_.Intern(build_id));
  map.exact_offset = loc.map_exact_offset;
  map.start_offset = loc.map_elf_start_offset;
  map.start = loc.map_start;
  map.end = loc.map_end;
  map.load_bias = loc.map_load_bias;
  base::StringSplitter sp(loc.map_name, '/');
  while (sp.Next())
    map.path_components.emplace_back(string_interner_.Intern(sp.cur_token()));

  Frame frame(mapping_interner_.Intern(std::move(map)),
              string_interner_.Intern(loc.function_name), loc.rel_pc);

  return frame_interner_.Intern(frame);
}

Interned<Frame> GlobalCallstackTrie::MakeRootFrame() {
  Mapping map(string_interner_.Intern(""));

  Frame frame(mapping_interner_.Intern(std::move(map)),
              string_interner_.Intern(""), 0);

  return frame_interner_.Intern(frame);
}

}  // namespace profiling
}  // namespace perfetto
