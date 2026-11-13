#include <jni.h>

#include <string>

#include "weft/weft.h"

namespace {

std::string from_java(JNIEnv* env, jstring value) {
  if (!value) return {};
  const char* chars = env->GetStringUTFChars(value, nullptr);
  std::string out = chars ? chars : "";
  if (chars) env->ReleaseStringUTFChars(value, chars);
  return out;
}

jstring to_java(JNIEnv* env, const std::string& value) {
  return env->NewStringUTF(value.c_str());
}

}  // namespace

extern "C" JNIEXPORT jlong JNICALL Java_dev_klbt_weft_NativePolicy_open(JNIEnv* env, jclass, jstring pack) {
  std::string error;
  weft::Session* session = weft::session_open(from_java(env, pack), &error);
  return reinterpret_cast<jlong>(session);
}

extern "C" JNIEXPORT jstring JNICALL Java_dev_klbt_weft_NativePolicy_command(JNIEnv* env, jclass, jlong handle, jstring command) {
  auto* session = reinterpret_cast<weft::Session*>(handle);
  const weft::Outcome out = weft::session_command(session, from_java(env, command));
  return to_java(env, out.json);
}

extern "C" JNIEXPORT void JNICALL Java_dev_klbt_weft_NativePolicy_close(JNIEnv*, jclass, jlong handle) {
  weft::session_close(reinterpret_cast<weft::Session*>(handle));
}
