#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(dirname "$script_dir")
openbuy_toolchain_dir="${OPENBUY_ANDROID_TOOLCHAIN:-$HOME/.local/share/openbuy-android}"
openbuy_default_java="$openbuy_toolchain_dir/jdk-17/Contents/Home"
if [ ! -x "$openbuy_default_java/bin/java" ]; then
  openbuy_default_java="$openbuy_toolchain_dir/jdk-17"
fi
openbuy_java_home="${JAVA_HOME:-$openbuy_default_java}"
openbuy_default_sdk="$HOME/Library/Android/sdk"
if [ ! -d "$openbuy_default_sdk" ]; then
  openbuy_default_sdk="$openbuy_toolchain_dir/sdk"
fi
openbuy_sdk_root="${ANDROID_HOME:-$openbuy_default_sdk}"
if [ ! -x "$openbuy_java_home/bin/java" ]; then
  printf '%s\n' "JDK 未就绪：$openbuy_java_home" >&2
  exit 1
fi
if [ ! -f "$openbuy_sdk_root/platforms/android-37.0/android.jar" ]; then
  printf '%s\n' "Android SDK 37 未就绪：$openbuy_sdk_root" >&2
  exit 1
fi
cd "$project_dir"
if [ "$#" -eq 0 ]; then set -- assembleDebug; fi
# These values apply only to this build process, never to a shell profile or system setting.
exec env JAVA_HOME="$openbuy_java_home" ANDROID_HOME="$openbuy_sdk_root" \
  GRADLE_USER_HOME="${GRADLE_USER_HOME:-$openbuy_toolchain_dir/gradle-home}" \
  "$project_dir/gradlew" --no-daemon "$@"
