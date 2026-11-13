#include "internal.hpp"
#include "weft/weft.h"

#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

namespace {

int fail(const std::string& message) {
  std::cerr << message << "\n";
  return 1;
}

std::string read_file(const std::string& path) {
  std::ifstream in(path);
  if (!in) return {};
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) return fail("usage: weft_test <root>");
  const std::string root = argv[1];
  const std::string pack = read_file(root + "/data/runtime/weft.pack");
  const std::string vectors_text = read_file(root + "/contract/vectors.json");
  if (pack.empty() || vectors_text.empty()) return fail("missing pack or vectors");

  weft::Json round;
  std::string err;
  if (!weft::parse_json("{\"a\":[1,true,null,\"x\\ny\"]}", round, err)) return fail(err);
  if (round.dump().find("\"a\"") == std::string::npos) return fail("dump lost a key");

  weft::Json vectors;
  if (!weft::parse_json(vectors_text, vectors, err)) return fail(err);
  if (!vectors.is_array()) return fail("vectors are an array");
  int ran = 0;
  for (const weft::Json& vector : vectors.a) {
    const std::string name = weft::get_string(vector, "name", "?");
    const weft::Json* request = vector.find("request");
    if (!request) return fail(name + " has no request");
    const weft::Outcome out = weft::decide_json(pack, request->dump());
    if (!out.ok) return fail(name + " decide failed: " + out.json);
    weft::Json decision;
    if (!weft::parse_json(out.json, decision, err)) return fail(name + " " + err);
    const std::string effect = weft::get_string(decision, "effect");
    const std::string rule = weft::get_string(decision, "rule_id");
    if (effect != weft::get_string(vector, "effect") || rule != weft::get_string(vector, "rule_id")) {
      return fail(name + " got " + effect + "/" + rule + " body " + out.json);
    }
    if (out.json.find("hunter2") != std::string::npos || out.json.find("4111111111111111") != std::string::npos) {
      return fail(name + " leaked a secret into the decision");
    }
    ++ran;
  }

  std::string open_err;
  weft::Session* session = weft::session_open(pack, &open_err);
  if (!session) return fail(open_err);
  const char* hold =
      "{\"cmd\":\"submit\",\"request\":{\"actor\":\"agent\",\"snapshot\":{\"url\":\"https://example.com/"
      "login\",\"elements\":[{\"ref\":\"pw\",\"name\":\"Hasło\",\"type\":\"password\",\"autocomplete\":\"current-"
      "password\"}]},\"action\":{\"op\":\"type\",\"ref\":\"pw\",\"text\":\"\"}}}";
  weft::Outcome held = weft::session_command(session, hold);
  if (!held.ok) return fail(held.json);
  weft::Json held_json;
  if (!weft::parse_json(held.json, held_json, err)) return fail(err);
  const weft::Json* result = held_json.find("result");
  if (!result) return fail("no result");
  const std::string approval = weft::get_string(*result, "approval_id");
  if (approval.empty()) return fail("expected an approval id");
  if (weft::get_bool(*result, "execute", true)) return fail("held action must not execute yet");
  weft::Outcome sneaky = weft::session_command(
      session, std::string("{\"cmd\":\"resolve\",\"actor\":\"agent\",\"id\":\"") + approval + "\",\"decision\":\"allow\"}");
  if (sneaky.ok) return fail("the agent resolved an approval");
  weft::Outcome released = weft::session_command(
      session, std::string("{\"cmd\":\"resolve\",\"actor\":\"person\",\"id\":\"") + approval + "\",\"decision\":\"allow\"}");
  if (!released.ok) return fail(released.json);
  weft::Json released_json;
  if (!weft::parse_json(released.json, released_json, err)) return fail(err);
  const weft::Json* released_result = released_json.find("result");
  if (!released_result || weft::get_string(*released_result, "effect") != "allow") return fail("person allow failed");
  weft::Outcome journal = weft::session_command(session, "{\"cmd\":\"journal\"}");
  if (!journal.ok || journal.json.find("hunter2") != std::string::npos) return fail("journal leaked or failed");
  weft::session_close(session);

  std::cout << "ok " << ran << " vectors\n";
  return 0;
}
