#include "weft/weft.h"

#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

namespace {

std::string read_all(std::istream& in) {
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

std::string read_file(const std::string& path, std::string& err) {
  std::ifstream in(path);
  if (!in) {
    err = "cannot read " + path;
    return {};
  }
  return read_all(in);
}

void usage() {
  std::cerr << "weft decide --pack <weft.pack>    decision for one request on stdin\n"
            << "weft serve  --pack <weft.pack>    session commands, one JSON object per line\n";
}

}  // namespace

int main(int argc, char** argv) {
  std::string cmd;
  std::string pack_path;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--pack" && i + 1 < argc) {
      pack_path = argv[++i];
    } else if (arg == "-h" || arg == "--help") {
      usage();
      return 0;
    } else if (cmd.empty()) {
      cmd = arg;
    } else {
      std::cerr << "unexpected " << arg << "\n";
      return 2;
    }
  }
  if (pack_path.empty() || (cmd != "decide" && cmd != "serve")) {
    usage();
    return 2;
  }
  std::string err;
  const std::string pack = read_file(pack_path, err);
  if (!err.empty()) {
    std::cerr << err << "\n";
    return 2;
  }
  if (cmd == "decide") {
    const weft::Outcome out = weft::decide_json(pack, read_all(std::cin));
    std::cout << out.json << "\n";
    return out.ok ? 0 : 2;
  }
  weft::Session* session = weft::session_open(pack, &err);
  if (!session) {
    std::cerr << err << "\n";
    return 2;
  }
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    const weft::Outcome out = weft::session_command(session, line);
    std::cout << out.json << "\n" << std::flush;
  }
  weft::session_close(session);
  return 0;
}
