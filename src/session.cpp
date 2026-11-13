#include "internal.hpp"
#include "weft/weft.h"

#include <utility>

namespace weft {
namespace {

Json public_pending(const Json& pending) {
  if (!pending.is_object()) return Json::nul();
  Json view = Json::obj();
  view["schema"] = Json::str("loom.weft.approval/1");
  view["id"] = Json::str(get_string(pending, "id"));
  view["op"] = Json::str(get_string(pending, "op"));
  view["ref"] = Json::str(get_string(pending, "ref"));
  view["fill_secret"] = Json::boolean(get_bool(pending, "fill_secret", false));
  if (const Json* reason = pending.find("reason")) view["reason"] = *reason;
  view["url_shape"] = Json::str(get_string(pending, "url_shape"));
  return view;
}

Json receipt_for(int seq, const std::string& actor, const Json& action, const Json& decision, const Json& snapshot) {
  Json r = Json::obj();
  r["schema"] = Json::str("loom.weft.receipt/1");
  r["id"] = Json::str("rcpt_" + std::to_string(seq));
  r["actor"] = Json::str(actor);
  r["op"] = Json::str(get_string(action, "op"));
  r["ref"] = Json::str(get_string(action, "ref"));
  r["effect"] = Json::str(get_string(decision, "effect"));
  r["rule_id"] = Json::str(get_string(decision, "rule_id"));
  r["url_shape"] = Json::str(url_shape_for_receipt(get_string(snapshot, "url")));
  r["secret"] = Json::boolean(false);
  if (const Json* reason = decision.find("reason")) r["reason"] = *reason;
  return r;
}

Json ok_result(Json result) {
  Json wrap = Json::obj();
  wrap["ok"] = Json::boolean(true);
  wrap["result"] = std::move(result);
  return wrap;
}

Json fail_result(const std::string& message) {
  Json wrap = Json::obj();
  wrap["ok"] = Json::boolean(false);
  wrap["error"] = Json::str(message);
  return wrap;
}

}  // namespace

struct Session {
  Json pack = Json::obj();
  Json journal = Json::arr();
  Json pending = Json::nul();
  int seq = 0;
};

Session* session_open(const std::string& pack_json, std::string* error) {
  Json pack;
  std::string err;
  if (!parse_json(pack_json, pack, err)) {
    if (error) *error = err;
    return nullptr;
  }
  if (get_string(pack, "schema") != "loom.runtime_profile/1" || get_string(pack, "domain") != "weft") {
    if (error) *error = "pack schema must be loom.runtime_profile/1 domain weft";
    return nullptr;
  }
  auto* session = new Session();
  session->pack = std::move(pack);
  return session;
}

void session_close(Session* session) { delete session; }

Outcome session_command(Session* session, const std::string& command_json) {
  if (!session) return {false, fail_result("no session").dump()};
  Json cmd;
  std::string err;
  if (!parse_json(command_json, cmd, err)) return {false, fail_result(err).dump()};
  const std::string name = get_string(cmd, "cmd");

  if (name == "journal") {
    Json result = Json::obj();
    result["schema"] = Json::str("loom.weft.journal/1");
    result["receipts"] = session->journal;
    return {true, ok_result(std::move(result)).dump()};
  }
  if (name == "pending") {
    Json result = Json::obj();
    result["pending"] = public_pending(session->pending);
    return {true, ok_result(std::move(result)).dump()};
  }
  if (name == "submit") {
    const Json* request = cmd.find("request");
    if (!request || !request->is_object()) return {false, fail_result("submit needs request").dump()};
    err.clear();
    Json decision = decide_parsed(session->pack, *request, err);
    if (!err.empty()) return {false, fail_result(err).dump()};
    const Json* action = request->find("action");
    const Json* snapshot = request->find("snapshot");
    Json receipt = receipt_for(++session->seq, get_string(*request, "actor"), action ? *action : Json::obj(), decision,
                               snapshot ? *snapshot : Json::obj());
    session->journal.push(receipt);
    Json result = Json::obj();
    result["schema"] = Json::str("loom.weft.session/1");
    result["decision"] = decision;
    result["receipt"] = receipt;
    const std::string effect = get_string(decision, "effect");
    result["execute"] = Json::boolean(effect == "allow");
    if (effect == "approve" && action) {
      Json held = Json::obj();
      const std::string id = "apr_" + std::to_string(session->seq);
      held["id"] = Json::str(id);
      held["op"] = Json::str(get_string(*action, "op"));
      held["ref"] = Json::str(get_string(*action, "ref"));
      held["action"] = *action;
      held["fill_secret"] = Json::boolean(get_bool(decision, "fill_secret", false));
      held["url_shape"] = Json::str(url_shape_for_receipt(get_string(*snapshot, "url")));
      if (const Json* reason = decision.find("reason")) held["reason"] = *reason;
      session->pending = held;
      result["approval_id"] = Json::str(id);
      result["pending"] = public_pending(held);
    } else {
      result["approval_id"] = Json::nul();
      result["pending"] = Json::nul();
    }
    return {true, ok_result(std::move(result)).dump()};
  }
  if (name == "resolve") {
    if (get_string(cmd, "actor") != "person") {
      return {false, fail_result("only the person can resolve an approval").dump()};
    }
    if (!session->pending.is_object()) return {false, fail_result("nothing is waiting").dump()};
    if (get_string(cmd, "id") != get_string(session->pending, "id")) {
      return {false, fail_result("approval id does not match").dump()};
    }
    const std::string decision = get_string(cmd, "decision");
    if (decision != "allow" && decision != "deny") {
      return {false, fail_result("decision is allow or deny").dump()};
    }
    Json result = Json::obj();
    result["schema"] = Json::str("loom.weft.session/1");
    result["approval_id"] = Json::str(get_string(session->pending, "id"));
    result["effect"] = Json::str(decision);
    result["fill_secret"] = Json::boolean(decision == "allow" && get_bool(session->pending, "fill_secret", false));
    if (decision == "allow") result["action"] = session->pending["action"];
    else result["action"] = Json::nul();
    Json note = Json::obj();
    note["schema"] = Json::str("loom.weft.receipt/1");
    note["id"] = Json::str("rcpt_" + std::to_string(++session->seq));
    note["actor"] = Json::str("person");
    note["op"] = Json::str("resolve");
    note["ref"] = Json::str(get_string(session->pending, "ref"));
    note["effect"] = Json::str(decision);
    note["rule_id"] = Json::str("person_resolve");
    note["secret"] = Json::boolean(false);
    session->journal.push(note);
    result["receipt"] = note;
    session->pending = Json::nul();
    return {true, ok_result(std::move(result)).dump()};
  }
  return {false, fail_result("unknown command").dump()};
}

}  // namespace weft
