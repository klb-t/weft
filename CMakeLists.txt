cmake_minimum_required(VERSION 3.16)
project(weft LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(weft STATIC src/json.cpp src/policy.cpp src/session.cpp)
target_include_directories(weft PUBLIC include PRIVATE src)

add_executable(weft-cli src/cli.cpp)
target_link_libraries(weft-cli PRIVATE weft)
set_target_properties(weft-cli PROPERTIES OUTPUT_NAME weft)

enable_testing()
add_executable(weft_test tests/test_main.cpp)
target_link_libraries(weft_test PRIVATE weft)
add_test(NAME vectors COMMAND weft_test ${CMAKE_SOURCE_DIR})
