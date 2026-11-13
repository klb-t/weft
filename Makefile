CXX ?= g++
CXXFLAGS ?= -std=c++20 -Wall -Wextra -Werror -Iinclude -Isrc -pthread
SRCS = src/json.cpp src/policy.cpp src/session.cpp

.PHONY: all test clean

all: build/weft build/weft_test

build/weft: $(SRCS) src/cli.cpp include/weft/weft.h src/json.hpp src/internal.hpp
	mkdir -p build
	$(CXX) $(CXXFLAGS) -o $@ $(SRCS) src/cli.cpp

build/weft_test: $(SRCS) tests/test_main.cpp include/weft/weft.h src/json.hpp src/internal.hpp
	mkdir -p build
	$(CXX) $(CXXFLAGS) -o $@ $(SRCS) tests/test_main.cpp

test: build/weft_test
	./build/weft_test "$(CURDIR)"

clean:
	rm -rf build
