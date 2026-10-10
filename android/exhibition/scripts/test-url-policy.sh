#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(dirname "$script_dir")
test_classes=$(mktemp -d "${TMPDIR:-/tmp}/openbuy-url-test.XXXXXX")
trap 'rm -rf "$test_classes"' EXIT HUP INT TERM
openbuy_javac=javac
openbuy_java=java
if [ -n "${JAVA_HOME:-}" ]; then
  openbuy_javac="$JAVA_HOME/bin/javac"
  openbuy_java="$JAVA_HOME/bin/java"
fi
"$openbuy_javac" -encoding UTF-8 -d "$test_classes" \
  "$project_dir/app/src/main/java/ai/openbuy/exhibition/UrlPolicy.java" \
  "$project_dir/tests/UrlPolicyTest.java"
"$openbuy_java" -cp "$test_classes" ai.openbuy.exhibition.UrlPolicyTest
