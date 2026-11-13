// Public surface of libweft. Same on Android, Windows and Linux.
// Platform hosts only deliver Chromium; they do not decide policy.
#pragma once

#include <string>

namespace weft {

// ok == false is a broken request or pack, not a policy denial.
// json is one object: a decision, a session result, or {"error": "..."}.
struct Outcome {
  bool ok = false;
  std::string json;
};

// Stateless policy. pack_json is the loom.runtime_profile/1 document (the whole file).
// request_json is {"actor","snapshot","action","human_active"?}.
Outcome decide_json(const std::string& pack_json, const std::string& request_json);

struct Session;

// Empty error means success. The session owns the pack copy and the journal.
Session* session_open(const std::string& pack_json, std::string* error);
void session_close(Session* session);

// One command object: submit | resolve | pending | journal.
Outcome session_command(Session* session, const std::string& command_json);

}  // namespace weft
