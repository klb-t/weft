#include "json.hpp"

#include <cctype>
#include <cmath>
#include <sstream>

namespace weft {
namespace {

class Parser {
 public:
  explicit Parser(std::string_view in) : s_(in) {}

  bool run(Json& out, std::string& err) {
    skip();
    if (!value(out, err)) return false;
    skip();
    if (i_ != s_.size()) {
      err = "trailing data at " + std::to_string(i_);
      return false;
    }
    return true;
  }

 private:
  std::string_view s_;
  std::size_t i_ = 0;

  void skip() {
    while (i_ < s_.size() && std::isspace(static_cast<unsigned char>(s_[i_]))) ++i_;
  }
  bool fail(std::string& err, const char* what) {
    err = std::string(what) + " at " + std::to_string(i_);
    return false;
  }

  bool value(Json& out, std::string& err) {
    skip();
    if (i_ >= s_.size()) return fail(err, "unexpected end");
    const char c = s_[i_];
    if (c == '{') return object(out, err);
    if (c == '[') return array(out, err);
    if (c == '"') return string(out, err);
    if (c == 't') return literal(out, err, "true", Json::boolean(true));
    if (c == 'f') return literal(out, err, "false", Json::boolean(false));
    if (c == 'n') return literal(out, err, "null", Json::nul());
    if (c == '-' || std::isdigit(static_cast<unsigned char>(c))) return number(out, err);
    return fail(err, "unexpected character");
  }

  bool literal(Json& out, std::string& err, const char* word, Json made) {
    const std::size_t n = std::char_traits<char>::length(word);
    if (s_.substr(i_, n) != word) return fail(err, "bad literal");
    i_ += n;
    out = std::move(made);
    return true;
  }

  bool number(Json& out, std::string& err) {
    const std::size_t start = i_;
    if (s_[i_] == '-') ++i_;
    if (i_ >= s_.size() || !std::isdigit(static_cast<unsigned char>(s_[i_]))) return fail(err, "bad number");
    if (s_[i_] == '0') {
      ++i_;
    } else {
      while (i_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[i_]))) ++i_;
    }
    bool integral = true;
    if (i_ < s_.size() && s_[i_] == '.') {
      integral = false;
      ++i_;
      if (i_ >= s_.size() || !std::isdigit(static_cast<unsigned char>(s_[i_]))) return fail(err, "bad number");
      while (i_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[i_]))) ++i_;
    }
    if (i_ < s_.size() && (s_[i_] == 'e' || s_[i_] == 'E')) {
      integral = false;
      ++i_;
      if (i_ < s_.size() && (s_[i_] == '+' || s_[i_] == '-')) ++i_;
      if (i_ >= s_.size() || !std::isdigit(static_cast<unsigned char>(s_[i_]))) return fail(err, "bad number");
      while (i_ < s_.size() && std::isdigit(static_cast<unsigned char>(s_[i_]))) ++i_;
    }
    try {
      const std::string token(s_.substr(start, i_ - start));
      const double n = std::stod(token);
      out = Json::number(n, integral);
      return true;
    } catch (...) {
      return fail(err, "bad number");
    }
  }

  bool string(Json& out, std::string& err) {
    if (s_[i_] != '"') return fail(err, "expected string");
    ++i_;
    std::string value;
    while (i_ < s_.size()) {
      const unsigned char c = static_cast<unsigned char>(s_[i_++]);
      if (c == '"') {
        out = Json::str(std::move(value));
        return true;
      }
      if (c == '\\') {
        if (i_ >= s_.size()) return fail(err, "bad escape");
        const char e = s_[i_++];
        switch (e) {
          case '"':
          case '\\':
          case '/':
            value.push_back(e);
            break;
          case 'b':
            value.push_back('\b');
            break;
          case 'f':
            value.push_back('\f');
            break;
          case 'n':
            value.push_back('\n');
            break;
          case 'r':
            value.push_back('\r');
            break;
          case 't':
            value.push_back('\t');
            break;
          case 'u': {
            if (i_ + 4 > s_.size()) return fail(err, "bad unicode escape");
            int cp = 0;
            for (int k = 0; k < 4; ++k) {
              const char h = s_[i_++];
              cp <<= 4;
              if (h >= '0' && h <= '9') cp += h - '0';
              else if (h >= 'a' && h <= 'f') cp += h - 'a' + 10;
              else if (h >= 'A' && h <= 'F') cp += h - 'A' + 10;
              else return fail(err, "bad unicode escape");
            }
            append_utf8(value, cp);
            break;
          }
          default:
            return fail(err, "bad escape");
        }
      } else if (c < 0x20) {
        return fail(err, "raw control in string");
      } else {
        value.push_back(static_cast<char>(c));
      }
    }
    return fail(err, "unterminated string");
  }

  static void append_utf8(std::string& out, int cp) {
    if (cp < 0x80) {
      out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }

  bool array(Json& out, std::string& err) {
    ++i_;
    out = Json::arr();
    skip();
    if (i_ < s_.size() && s_[i_] == ']') {
      ++i_;
      return true;
    }
    while (i_ < s_.size()) {
      Json item;
      if (!value(item, err)) return false;
      out.push(std::move(item));
      skip();
      if (i_ >= s_.size()) return fail(err, "unterminated array");
      if (s_[i_] == ',') {
        ++i_;
        skip();
        continue;
      }
      if (s_[i_] == ']') {
        ++i_;
        return true;
      }
      return fail(err, "expected comma or ]");
    }
    return fail(err, "unterminated array");
  }

  bool object(Json& out, std::string& err) {
    ++i_;
    out = Json::obj();
    skip();
    if (i_ < s_.size() && s_[i_] == '}') {
      ++i_;
      return true;
    }
    while (i_ < s_.size()) {
      skip();
      Json key;
      if (!string(key, err)) return false;
      skip();
      if (i_ >= s_.size() || s_[i_] != ':') return fail(err, "expected colon");
      ++i_;
      Json item;
      if (!value(item, err)) return false;
      out[key.s] = std::move(item);
      skip();
      if (i_ >= s_.size()) return fail(err, "unterminated object");
      if (s_[i_] == ',') {
        ++i_;
        continue;
      }
      if (s_[i_] == '}') {
        ++i_;
        return true;
      }
      return fail(err, "expected comma or }");
    }
    return fail(err, "unterminated object");
  }
};

void dump_string(std::ostream& o, const std::string& s) {
  o << '"';
  for (unsigned char c : s) {
    switch (c) {
      case '"':
        o << "\\\"";
        break;
      case '\\':
        o << "\\\\";
        break;
      case '\b':
        o << "\\b";
        break;
      case '\f':
        o << "\\f";
        break;
      case '\n':
        o << "\\n";
        break;
      case '\r':
        o << "\\r";
        break;
      case '\t':
        o << "\\t";
        break;
      default:
        if (c < 0x20) {
          static const char* hex = "0123456789abcdef";
          o << "\\u00" << hex[c >> 4] << hex[c & 0xF];
        } else {
          o << static_cast<char>(c);
        }
    }
  }
  o << '"';
}

void dump_into(std::ostream& o, const Json& j) {
  switch (j.type) {
    case Json::Type::Null:
      o << "null";
      break;
    case Json::Type::Bool:
      o << (j.b ? "true" : "false");
      break;
    case Json::Type::Number:
      if (j.integral && std::isfinite(j.n) && j.n == std::trunc(j.n) && j.n >= -1e15 && j.n <= 1e15) {
        o << static_cast<long long>(j.n);
      } else {
        o << j.n;
      }
      break;
    case Json::Type::String:
      dump_string(o, j.s);
      break;
    case Json::Type::Array: {
      o << '[';
      for (std::size_t i = 0; i < j.a.size(); ++i) {
        if (i) o << ',';
        dump_into(o, j.a[i]);
      }
      o << ']';
      break;
    }
    case Json::Type::Object: {
      o << '{';
      for (std::size_t i = 0; i < j.o.size(); ++i) {
        if (i) o << ',';
        dump_string(o, j.o[i].first);
        o << ':';
        dump_into(o, j.o[i].second);
      }
      o << '}';
      break;
    }
  }
}

}  // namespace

bool parse_json(std::string_view text, Json& out, std::string& err) {
  Parser p(text);
  return p.run(out, err);
}

std::string Json::dump() const {
  std::ostringstream o;
  dump_into(o, *this);
  return o.str();
}

std::string get_string(const Json& object, std::string_view key, const std::string& fallback) {
  const Json* v = object.find(key);
  if (!v || !v->is_string()) return fallback;
  return v->s;
}

bool get_bool(const Json& object, std::string_view key, bool fallback) {
  const Json* v = object.find(key);
  if (!v || !v->is_bool()) return fallback;
  return v->b;
}

double get_number(const Json& object, std::string_view key, double fallback) {
  const Json* v = object.find(key);
  if (!v || !v->is_number()) return fallback;
  return v->n;
}

}  // namespace weft
