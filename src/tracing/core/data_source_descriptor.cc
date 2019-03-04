/*
 * Copyright (C) 2017 The Android Open Source Project
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

/*******************************************************************************
 * AUTOGENERATED - DO NOT EDIT
 *******************************************************************************
 * This file has been generated from the protobuf message
 * perfetto/config/data_source_descriptor.proto
 * by
 * ../../tools/proto_to_cpp/proto_to_cpp.cc.
 * If you need to make changes here, change the .proto file and then run
 * ./tools/gen_tracing_cpp_headers_from_protos
 */

#include "perfetto/tracing/core/data_source_descriptor.h"

#include "perfetto/config/data_source_descriptor.pb.h"

namespace perfetto {

DataSourceDescriptor::DataSourceDescriptor() = default;
DataSourceDescriptor::~DataSourceDescriptor() = default;
DataSourceDescriptor::DataSourceDescriptor(const DataSourceDescriptor&) =
    default;
DataSourceDescriptor& DataSourceDescriptor::operator=(
    const DataSourceDescriptor&) = default;
DataSourceDescriptor::DataSourceDescriptor(DataSourceDescriptor&&) noexcept =
    default;
DataSourceDescriptor& DataSourceDescriptor::operator=(DataSourceDescriptor&&) =
    default;

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wfloat-equal"
bool DataSourceDescriptor::operator==(const DataSourceDescriptor& other) const {
  return (name_ == other.name_) &&
         (will_notify_on_stop_ == other.will_notify_on_stop_);
}
#pragma GCC diagnostic pop

void DataSourceDescriptor::FromProto(
    const perfetto::protos::DataSourceDescriptor& proto) {
  static_assert(sizeof(name_) == sizeof(proto.name()), "size mismatch");
  name_ = static_cast<decltype(name_)>(proto.name());

  static_assert(
      sizeof(will_notify_on_stop_) == sizeof(proto.will_notify_on_stop()),
      "size mismatch");
  will_notify_on_stop_ =
      static_cast<decltype(will_notify_on_stop_)>(proto.will_notify_on_stop());
  unknown_fields_ = proto.unknown_fields();
}

void DataSourceDescriptor::ToProto(
    perfetto::protos::DataSourceDescriptor* proto) const {
  proto->Clear();

  static_assert(sizeof(name_) == sizeof(proto->name()), "size mismatch");
  proto->set_name(static_cast<decltype(proto->name())>(name_));

  static_assert(
      sizeof(will_notify_on_stop_) == sizeof(proto->will_notify_on_stop()),
      "size mismatch");
  proto->set_will_notify_on_stop(
      static_cast<decltype(proto->will_notify_on_stop())>(
          will_notify_on_stop_));
  *(proto->mutable_unknown_fields()) = unknown_fields_;
}

}  // namespace perfetto
