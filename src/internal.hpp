#pragma once

#include "json.hpp"

#include <string>

namespace weft {

Json decide_parsed(const Json& pack, const Json& request, std::string& err);
std::string url_shape_for_receipt(const std::string& url);

}  // namespace weft
