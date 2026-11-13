cmake_minimum_required(VERSION 3.16)
project(weft-jni)
set(ROOT ${CMAKE_CURRENT_LIST_DIR}/../../../../../)
add_library(weft-jni SHARED
    jni.cpp
    ${ROOT}/src/json.cpp
    ${ROOT}/src/policy.cpp
    ${ROOT}/src/session.cpp)
target_include_directories(weft-jni PRIVATE ${ROOT}/include ${ROOT}/src)
target_compile_features(weft-jni PRIVATE cxx_std_20)
target_link_libraries(weft-jni android log)
