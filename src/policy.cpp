#include "json.hpp"
#include "weft/weft.h"

#include <algorithm>
#include <cctype>
#include <regex>
#include <sstream>

namespace weft {
namespace {

std::string lower_copy(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

const Json* defaults_of(const Json& pack) {
  if (const Json* d = pack.find("defaults"); d && d->is_object()) return d;
  return nullptr;
}

const Json* patterns_of(const Json& pack) {
  const Json* d = defaults_of(pack);
  if (!d) return nullptr;
  const Json* p = d->find("patterns");
  return p && p->is_object() ? p : nullptr;
}

bool regex_search_pack(const Json& patterns, const char* name, const std::string& text) {
  if (text.empty()) return false;
  const Json* spec = patterns.find(name);
  if (!spec || !spec->is_string() || spec->s.empty()) return false;
  try {
    const std::regex re(spec->s, std::regex::ECMAScript | std::regex::icase);
    return std::regex_search(text, re);
  } catch (const std::regex_error&) {
    return false;
  }
}

bool key_is_secret(const Json& defaults, const std::string& key) {
  const Json* keys = defaults.find("secret_keys");
  if (!keys || !keys->is_array()) return false;
  const std::string folded = lower_copy(key);
  for (const Json& k : keys->a) {
    if (k.is_string() && lower_copy(k.s) == folded) return true;
  }
  return false;
}

bool value_is_secret(const Json& patterns, const std::string& text) {
  if (text.empty()) return false;
  if (regex_search_pack(patterns, "secret_value", text)) return true;
  if (regex_search_pack(patterns, "userinfo", text)) return true;
  return false;
}

void walk_secret(const Json& defaults, const Json& patterns, const Json& node, const std::string& key, bool& hit) {
  if (hit) return;
  if (node.is_string()) {
    if (key_is_secret(defaults, key) && !node.s.empty()) hit = true;
    else if (value_is_secret(patterns, node.s)) hit = true;
    return;
  }
  if (node.is_array()) {
    for (const Json& item : node.a) walk_secret(defaults, patterns, item, "", hit);
    return;
  }
  if (node.is_object()) {
    for (const auto& kv : node.o) walk_secret(defaults, patterns, kv.second, kv.first, hit);
  }
}

const Json* element_by_ref(const Json& snapshot, const std::string& ref) {
  const Json* elements = snapshot.find("elements");
  if (!elements || !elements->is_array() || ref.empty()) return nullptr;
  for (const Json& el : elements->a) {
    if (get_string(el, "ref") == ref) return &el;
  }
  return nullptr;
}

bool element_secret(const Json& defaults, const Json& patterns, const Json& el) {
  if (get_bool(el, "secret", false)) return true;
  const std::string type = lower_copy(get_string(el, "type"));
  const Json* types = defaults.find("secret_types");
  if (types && types->is_array()) {
    for (const Json& t : types->a)
      if (t.is_string() && lower_copy(t.s) == type) return true;
  }
  const std::string ac = lower_copy(get_string(el, "autocomplete"));
  const Json* autos = defaults.find("secret_autocomplete");
  if (autos && autos->is_array()) {
    for (const Json& a : autos->a) {
      if (!a.is_string()) continue;
      const std::string needle = lower_copy(a.s);
      if (!needle.empty() && ac.find(needle) != std::string::npos) return true;
    }
  }
  const std::string name = get_string(el, "name") + " " + get_string(el, "ref");
  return regex_search_pack(patterns, "secret_name", name);
}

bool flag_or_elements(const Json& snapshot, const char* flag, bool computed) {
  return get_bool(snapshot, flag, false) || computed;
}

std::string scheme_of(const std::string& url) {
  const auto pos = url.find("://");
  if (pos == std::string::npos) {
    if (url.rfind("about:", 0) == 0) return "about";
    return {};
  }
  return lower_copy(url.substr(0, pos));
}

bool scheme_allowed(const Json& defaults, const std::string& scheme) {
  const Json* list = defaults.find("navigate_schemes");
  if (!list || !list->is_array()) return scheme == "http" || scheme == "https" || scheme == "about";
  for (const Json& s : list->a)
    if (s.is_string() && lower_copy(s.s) == scheme) return true;
  return false;
}

bool op_known(const Json& defaults, const std::string& op) {
  const Json* list = defaults.find("ops");
  if (!list || !list->is_array()) return false;
  for (const Json& s : list->a)
    if (s.is_string() && s.s == op) return true;
  return false;
}

bool in_string_array(const Json& arr, const std::string& value) {
  if (!arr.is_array()) return false;
  for (const Json& s : arr.a)
    if (s.is_string() && s.s == value) return true;
  return false;
}

Json reason_pair(const Json& rule, const char* en, const char* pl) {
  Json reason = Json::obj();
  if (const Json* r = rule.find("reason"); r && r->is_object()) {
    reason["en"] = Json::str(get_string(*r, "en", en));
    reason["pl"] = Json::str(get_string(*r, "pl", pl));
    return reason;
  }
  reason["en"] = Json::str(en);
  reason["pl"] = Json::str(pl);
  return reason;
}

Json make_decision(const std::string& effect, const std::string& rule, Json reason, bool fill_secret, bool promoted) {
  Json d = Json::obj();
  d["schema"] = Json::str("loom.weft.decision/1");
  d["effect"] = Json::str(effect);
  d["rule_id"] = Json::str(rule);
  d["reason"] = std::move(reason);
  d["fill_secret"] = Json::boolean(fill_secret);
  d["promoted"] = Json::boolean(promoted);
  return d;
}

bool match_when(const Json& when, const std::string& op, bool payload_secret, bool element_secret, bool login_url,
                const std::string& flag_password, const std::string& flag_payment, const std::string& flag_permission,
                const Json& snapshot, const Json* element, const Json& patterns) {
  for (const auto& kv : when.o) {
    const std::string& key = kv.first;
    const Json& cond = kv.second;
    if (key == "payload_secret") {
      if (!cond.is_bool() || cond.b != payload_secret) return false;
    } else if (key == "element_secret") {
      if (!cond.is_bool() || cond.b != element_secret) return false;
    } else if (key == "login_url") {
      if (!cond.is_bool() || cond.b != login_url) return false;
    } else if (key == "op_in") {
      if (!in_string_array(cond, op)) return false;
    } else if (key == "snapshot_flag") {
      if (!cond.is_string()) return false;
      bool on = false;
      if (cond.s == "has_password_field") on = flag_password == "1";
      else if (cond.s == "has_payment_field") on = flag_payment == "1";
      else if (cond.s == "permission_prompt") on = flag_permission == "1";
      else on = get_bool(snapshot, cond.s, false);
      if (!on) return false;
    } else if (key == "element_type_in") {
      if (!element || !in_string_array(cond, lower_copy(get_string(*element, "type")))) return false;
    } else if (key == "name_matches") {
      if (!cond.is_string() || !element) return false;
      const std::string blob = get_string(*element, "name") + " " + get_string(*element, "role");
      if (!regex_search_pack(patterns, cond.s.c_str(), blob)) return false;
    } else {
      return false;
    }
  }
  return true;
}

Json decide_with(const Json& pack, const Json& request, std::string& err) {
  const Json* defaults = defaults_of(pack);
  const Json* patterns = patterns_of(pack);
  if (!defaults || !patterns) {
    err = "pack defaults.patterns missing";
    return {};
  }
  if (get_string(pack, "schema") != "loom.runtime_profile/1" || get_string(pack, "domain") != "weft") {
    err = "pack schema must be loom.runtime_profile/1 domain weft";
    return {};
  }
  const std::string actor = get_string(request, "actor");
  const Json* snapshot = request.find("snapshot");
  const Json* action = request.find("action");
  if (!snapshot || !snapshot->is_object() || !action || !action->is_object()) {
    err = "request needs snapshot and action objects";
    return {};
  }
  const std::string op = get_string(*action, "op");
  const bool human_active = get_bool(request, "human_active", false);

  auto fixed = [&](const std::string& effect, const std::string& rule, const char* en, const char* pl) {
    Json dummy = Json::obj();
    return make_decision(effect, rule, reason_pair(dummy, en, pl), false, false);
  };

  if (actor != "agent" && actor != "person") {
    return fixed("deny", "bad_actor", "The actor must be agent or person.", "Aktor musi być agentem albo osobą.");
  }
  if (!op_known(*defaults, op)) {
    return fixed("deny", "unknown_op", "That operation is not in the Weft catalogue.",
                 "Tej operacji nie ma w katalogu Weft.");
  }
  if (actor == "agent" && human_active) {
    return fixed("preempt", "human_preempt", "You moved, so the agent waits.", "Ruszyłeś stronę, więc agent czeka.");
  }

  if (op == "navigate") {
    const std::string url = get_string(*action, "url");
    const std::string scheme = scheme_of(url);
    if (!scheme_allowed(*defaults, scheme) || value_is_secret(*patterns, url)) {
      return fixed("deny", "bad_navigation",
                   "Only plain http(s) and about:blank. No passwords in the address.",
                   "Tylko zwykłe http(s) i about:blank. Hasła nie wstawia się w adres.");
    }
  }

  bool payload_secret = false;
  walk_secret(*defaults, *patterns, *action, "", payload_secret);
  const Json* target = element_by_ref(*snapshot, get_string(*action, "ref"));
  const bool target_is_secret = target && element_secret(*defaults, *patterns, *target);
  const std::string typed = get_string(*action, "text");
  if (target_is_secret && !typed.empty()) payload_secret = true;
  if (payload_secret) {
    return fixed("deny", "secret_in_payload",
                 "A secret was inside the action. Ask for the field; the person supplies the secret.",
                 "W akcji było hasło albo sekret. Poproś o pole; sekret podaje osoba, nie model.");
  }

  bool any_password = false;
  bool any_payment = false;
  if (const Json* elements = snapshot->find("elements"); elements && elements->is_array()) {
    for (const Json& el : elements->a) {
      if (!element_secret(*defaults, *patterns, el)) continue;
      const std::string ac = lower_copy(get_string(el, "autocomplete"));
      const std::string type = lower_copy(get_string(el, "type"));
      if (type == "password" || ac.find("password") != std::string::npos) any_password = true;
      if (ac.rfind("cc-", 0) == 0) any_payment = true;
      if (element_secret(*defaults, *patterns, el) && type == "password") any_password = true;
    }
  }
  const std::string flag_password = flag_or_elements(*snapshot, "has_password_field", any_password) ? "1" : "0";
  const std::string flag_payment = flag_or_elements(*snapshot, "has_payment_field", any_payment) ? "1" : "0";
  const bool permission = get_bool(*snapshot, "permission_prompt", false) ||
                          (snapshot->find("permission_prompt") && snapshot->find("permission_prompt")->is_string() &&
                           !snapshot->find("permission_prompt")->s.empty());
  const std::string flag_permission = permission ? "1" : "0";
  const bool login_url = regex_search_pack(*patterns, "login_url", get_string(*snapshot, "url"));

  const Json* rules = defaults->find("rules");
  if (rules && rules->is_array()) {
    for (const Json& rule : rules->a) {
      if (!rule.is_object()) continue;
      const Json* when = rule.find("when");
      if (!when || !when->is_object()) continue;
      if (!match_when(*when, op, payload_secret, target_is_secret, login_url, flag_password, flag_payment,
                      flag_permission, *snapshot, target, *patterns))
        continue;
      std::string effect = get_string(rule, "effect", "deny");
      bool promoted = false;
      if (actor == "person" && effect == "approve" && get_bool(*defaults, "human_promotes_approve_to_allow", true)) {
        effect = "allow";
        promoted = true;
      }
      const bool fill = target_is_secret && (op == "type" || op == "fill");
      return make_decision(effect, get_string(rule, "id", "rule"),
                           reason_pair(rule, "Needs a person.", "Potrzebna jest osoba."), fill && effect != "deny",
                           promoted);
    }
  }

  Json none = Json::obj();
  return make_decision("allow", "default",
                       reason_pair(none, "Ordinary browsing. No credential involved.",
                                   "Zwykłe przeglądanie. Bez poświadczeń."),
                       false, false);
}

}  // namespace

std::string url_shape_for_receipt(const std::string& url) {
  static const std::regex userinfo("://[^/@\\s]+:[^/@\\s]+@", std::regex::ECMAScript | std::regex::icase);
  if (std::regex_search(url, userinfo)) return "redacted";
  std::string u = url;
  const auto q = u.find_first_of("?#");
  if (q != std::string::npos) u.erase(q);
  const auto scheme = u.find("://");
  if (scheme != std::string::npos) {
    const auto at = u.find('@', scheme + 3);
    const auto slash = u.find('/', scheme + 3);
    if (at != std::string::npos && (slash == std::string::npos || at < slash)) return "redacted";
  }
  if (u.size() > 180) u.resize(180);
  return u;
}

Outcome decide_json(const std::string& pack_json, const std::string& request_json) {
  Json pack;
  Json request;
  std::string err;
  if (!parse_json(pack_json, pack, err)) {
    Json e = Json::obj();
    e["error"] = Json::str("pack: " + err);
    return {false, e.dump()};
  }
  if (!parse_json(request_json, request, err)) {
    Json e = Json::obj();
    e["error"] = Json::str("request: " + err);
    return {false, e.dump()};
  }
  err.clear();
  Json decision = decide_with(pack, request, err);
  if (!err.empty()) {
    Json e = Json::obj();
    e["error"] = Json::str(err);
    return {false, e.dump()};
  }
  return {true, decision.dump()};
}

// Exposed for the session translation unit.
Json decide_parsed(const Json& pack, const Json& request, std::string& err) { return decide_with(pack, request, err); }

}  // namespace weft
