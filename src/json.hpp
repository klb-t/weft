#pragma once

#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace weft {

struct Json {
  enum class Type { Null, Bool, Number, String, Array, Object };
  Type type = Type::Null;
  bool b = false;
  double n = 0;
  bool integral = false;
  std::string s;
  std::vector<Json> a;
  std::vector<std::pair<std::string, Json>> o;

  static Json nul() { return {}; }
  static Json boolean(bool v) {
    Json j;
    j.type = Type::Bool;
    j.b = v;
    return j;
  }
  static Json number(double v, bool as_int = false) {
    Json j;
    j.type = Type::Number;
    j.n = v;
    j.integral = as_int;
    return j;
  }
  static Json str(std::string v) {
    Json j;
    j.type = Type::String;
    j.s = std::move(v);
    return j;
  }
  static Json arr() {
    Json j;
    j.type = Type::Array;
    return j;
  }
  static Json obj() {
    Json j;
    j.type = Type::Object;
    return j;
  }

  bool is_null() const { return type == Type::Null; }
  bool is_bool() const { return type == Type::Bool; }
  bool is_number() const { return type == Type::Number; }
  bool is_string() const { return type == Type::String; }
  bool is_array() const { return type == Type::Array; }
  bool is_object() const { return type == Type::Object; }

  const Json* find(std::string_view key) const {
    if (!is_object()) return nullptr;
    for (const auto& kv : o)
      if (kv.first == key) return &kv.second;
    return nullptr;
  }
  Json* find(std::string_view key) {
    return const_cast<Json*>(static_cast<const Json*>(this)->find(key));
  }
  Json& operator[](const std::string& key) {
    if (!is_object()) *this = obj();
    if (Json* existing = find(key)) return *existing;
    o.emplace_back(key, Json{});
    return o.back().second;
  }
  void push(Json v) {
    if (!is_array()) *this = arr();
    a.push_back(std::move(v));
  }

  std::string dump() const;
};

struct ParseError {
  std::string message;
};

// On failure, out is null and err is set.
bool parse_json(std::string_view text, Json& out, std::string& err);

std::string get_string(const Json& object, std::string_view key, const std::string& fallback = {});
bool get_bool(const Json& object, std::string_view key, bool fallback = false);
double get_number(const Json& object, std::string_view key, double fallback = 0);

}  // namespace weft
