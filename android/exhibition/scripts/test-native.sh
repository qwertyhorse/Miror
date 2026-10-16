#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(dirname "$script_dir")
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'Python 3 未就绪。' >&2
  exit 1
fi

# Uses the existing local toolchain; does not install Java, Gradle, or Android SDK.
# Overrides: OPENBUY_ANDROID_TOOLCHAIN, JAVA_HOME, GRADLE_USER_HOME,
# OPENBUY_TEST_GRADLE_VERSION (default 9.3.1), OPENBUY_TEST_COMPILER_LIB.
exec python3 - "$project_dir" <<'PY'
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

PROJECT = Path(sys.argv[1])
SOURCE = PROJECT / 'app/src/main/java/ai/openbuy/exhibition'
TESTS = PROJECT / 'tests'
TOOLCHAIN = Path(os.environ.get('OPENBUY_ANDROID_TOOLCHAIN') or
                 str(Path.home() / '.local/share/openbuy-android')).expanduser()
JSON_VERSION = '20240303'
JSON_SHA256 = '3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed'
JSON_URL = f'https://repo.maven.apache.org/maven2/org/json/json/{JSON_VERSION}/json-{JSON_VERSION}.jar'
HTTP_MODULES = (
    ('com.squareup.okhttp3', 'okhttp', '3.12.6',
     'ab45b9be99d9f070662b722cece5bdc2a0449fd34b9d5e51cdcd34663ae7b610'),
    ('com.squareup.okio', 'okio', '1.15.0',
     '693fa319a7e8843300602b204023b7674f106ebcb577f2dd5807212b66118bd2'),
)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(arguments, timeout=None):
    subprocess.run([str(argument) for argument in arguments], cwd=PROJECT, check=True, timeout=timeout)


def one_jar(directory, pattern):
    matches = sorted(directory.glob(pattern))
    require(len(matches) == 1, f'需要唯一的 {pattern}：{directory}')
    return matches[0]


def verified_json(path):
    return path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == JSON_SHA256


def cached_http_modules(gradle_home):
    modules = []
    for group, artifact, version, expected_sha256 in HTTP_MODULES:
        directory = gradle_home / 'caches/modules-2/files-2.1' / group / artifact / version
        module = one_jar(directory, f'*/{artifact}-{version}.jar')
        require(hashlib.sha256(module.read_bytes()).hexdigest() == expected_sha256,
                f'{artifact} {version} 缓存 SHA256 校验失败。')
        modules.append(module)
    return modules


def main():
    default_java = TOOLCHAIN / 'jdk-17/Contents/Home'
    if not (default_java / 'bin/java').is_file():
        default_java = TOOLCHAIN / 'jdk-17'
    java_home = Path(os.environ.get('JAVA_HOME') or str(default_java)).expanduser()
    java, javac, keytool = (java_home / 'bin' / tool for tool in ('java', 'javac', 'keytool'))
    require(all(os.access(tool, os.X_OK) for tool in (java, javac, keytool)),
            f'JDK 17 未就绪：{java_home}')
    version = subprocess.run([str(java), '-XshowSettings:properties', '-version'],
                             capture_output=True, text=True, check=True)
    specification = re.search(r'java\.specification\.version = (\S+)', version.stdout + version.stderr)
    require(specification is not None and specification.group(1) == '17',
            '测试需要 Java 17，请通过 JAVA_HOME 指向 JDK 17。')

    gradle_home = Path(os.environ.get('GRADLE_USER_HOME') or str(TOOLCHAIN / 'gradle-home')).expanduser()
    http_modules = cached_http_modules(gradle_home)
    compiler_override = os.environ.get('OPENBUY_TEST_COMPILER_LIB')
    if compiler_override:
        compiler_lib = Path(compiler_override).expanduser()
    else:
        gradle_version = os.environ.get('OPENBUY_TEST_GRADLE_VERSION') or '9.3.1'
        require(re.fullmatch(r'[A-Za-z0-9.-]+', gradle_version) is not None, 'Gradle 版本无效。')
        candidates = sorted((gradle_home / 'wrapper/dists').glob(
            f'gradle-{gradle_version}-*/**/gradle-{gradle_version}/lib'))
        candidates = [path for path in candidates if list(path.glob('kotlin-compiler-embeddable-*.jar'))]
        require(bool(candidates), f'未找到缓存的 Gradle {gradle_version} Kotlin compiler；'
                '请准备本机工具链或设置 OPENBUY_TEST_COMPILER_LIB。')
        compiler_lib = candidates[0]
    one_jar(compiler_lib, 'kotlin-compiler-embeddable-*.jar')
    stdlib = one_jar(compiler_lib, 'kotlin-stdlib-[0-9]*.jar')
    coroutines = one_jar(compiler_lib, 'kotlinx-coroutines-core-jvm-*.jar')
    compiler = [java, '-cp', compiler_lib / '*', 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
                '-no-stdlib', '-no-reflect', '-jvm-target', '17']

    with tempfile.TemporaryDirectory(prefix='openbuy-native-tests-') as temporary:
        temporary = Path(temporary)
        json_jar = TOOLCHAIN / 'test-deps' / f'json-{JSON_VERSION}.jar'
        if not verified_json(json_jar):
            require(shutil.which('curl') is not None, '缺少 JSON 测试依赖，且 curl 未就绪。')
            print(f'Download verified JSON {JSON_VERSION} test dependency.', flush=True)
            download = temporary / 'json.jar'
            run(['curl', '--fail', '--location', '--silent', '--show-error', '--connect-timeout', '15',
                 '--max-time', '90', '--retry', '2', '--output', download, JSON_URL])
            require(verified_json(download), 'JSON 测试依赖 SHA256 校验失败。')
            json_jar.parent.mkdir(parents=True, exist_ok=True)
            # Copy within the cache directory, then atomically publish only verified bytes.
            with tempfile.NamedTemporaryFile(prefix='.json-', dir=json_jar.parent, delete=False) as cached:
                cached_path = Path(cached.name)
            try:
                shutil.copyfile(download, cached_path)
                os.replace(cached_path, json_jar)
            finally:
                cached_path.unlink(missing_ok=True)
        require(verified_json(json_jar), 'JSON 测试依赖 SHA256 校验失败。')

        api_classes = temporary / 'api/classes'
        api_classes.mkdir(parents=True)
        api_classpath = os.pathsep.join(map(str, [api_classes, stdlib, coroutines, json_jar] + http_modules))
        print('Run ExhibitionApi contract fixtures.', flush=True)
        run([javac, '-encoding', 'UTF-8', '--release', '17', '-d', api_classes,
             SOURCE / 'UrlPolicy.java', TESTS / 'UrlPolicyTest.java'])
        run([java, '-cp', api_classes, 'ai.openbuy.exhibition.UrlPolicyTest'], timeout=60)
        run(compiler + ['-classpath', api_classpath, '-d', api_classes,
                        SOURCE / 'ExhibitionApi.kt', SOURCE / 'NativeMaterialCatalog.kt', TESTS / 'ExhibitionApiContractTest.kt'])
        run([java, '-Dsun.net.http.allowRestrictedHeaders=true', '--add-modules', 'jdk.httpserver',
             '-cp', api_classpath, 'ai.openbuy.exhibition.ExhibitionApiContractTestKt'], timeout=60)

        upload_classes = temporary / 'gesture-upload/classes'
        upload_classes.mkdir(parents=True)
        upload_classpath = os.pathsep.join(map(str, [upload_classes, stdlib, coroutines, json_jar] + http_modules))
        upload_stubs = sorted((TESTS / 'remote-gesture-stubs').rglob('*.kt'))
        print('Run bounded remote gesture uploads against an isolated HTTP peer.', flush=True)
        run([javac, '-encoding', 'UTF-8', '--release', '17', '-d', upload_classes, SOURCE / 'UrlPolicy.java'])
        run(compiler + ['-classpath', upload_classpath, '-d', upload_classes,
                        SOURCE / 'ExhibitionApi.kt', SOURCE / 'NativeCameraFrame.kt', SOURCE / 'NativeGestureSampling.kt', SOURCE / 'NativeRemoteGestures.kt',
                        TESTS / 'NativeRemoteGesturesTest.kt', TESTS / 'NativeGestureSamplingTest.kt'] + upload_stubs)
        run([java, '-Dsun.net.http.allowRestrictedHeaders=true', '--add-modules', 'jdk.httpserver',
             '-cp', upload_classpath, 'ai.openbuy.exhibition.NativeRemoteGesturesTestKt'], timeout=60)
        run([java, '-cp', upload_classpath, 'ai.openbuy.exhibition.NativeGestureSamplingTestKt'], timeout=60)

        tls_dir = temporary / 'tls'
        tls_classes = tls_dir / 'classes'
        tls_classes.mkdir(parents=True)
        tls_classpath = os.pathsep.join(map(str, [tls_classes, stdlib, coroutines, json_jar] + http_modules))
        print('Run isolated LAN DNS and TLS transport fixtures.', flush=True)
        for name in ('trusted', 'untrusted'):
            # Disposable loopback fixture identities only; never project or APK signing keys.
            run([keytool, '-genkeypair', '-alias', 'fixture', '-keyalg', 'RSA', '-keysize', '2048',
                 '-keystore', tls_dir / f'{name}.jks', '-storetype', 'JKS',
                 '-storepass', 'fixturepass', '-keypass', 'fixturepass',
                 '-dname', 'CN=xuminghong.local', '-ext', 'SAN=dns:xuminghong.local',
                 '-validity', '2', '-noprompt'], timeout=60)
        run([javac, '-encoding', 'UTF-8', '--release', '17', '-d', tls_classes, SOURCE / 'UrlPolicy.java'])
        run(compiler + ['-classpath', tls_classpath, '-d', tls_classes,
                        SOURCE / 'ExhibitionApi.kt', TESTS / 'ExhibitionLanTlsTest.kt'])
        run([java, '--add-modules', 'jdk.httpserver',
             f'-Dfixture.trustedKeystore={tls_dir / "trusted.jks"}',
             f'-Dfixture.untrustedKeystore={tls_dir / "untrusted.jks"}',
             f'-Djavax.net.ssl.trustStore={tls_dir / "trusted.jks"}',
             '-Djavax.net.ssl.trustStorePassword=fixturepass', '-Djavax.net.ssl.trustStoreType=JKS',
             '-cp', tls_classpath, 'ai.openbuy.exhibition.ExhibitionLanTlsTest'], timeout=60)

        lan_classes = temporary / 'lan/classes'
        lan_classes.mkdir(parents=True)
        lan_classpath = os.pathsep.join(map(str, [lan_classes, stdlib]))
        print('Run LAN backend address selection fixtures.', flush=True)
        run(compiler + ['-classpath', lan_classpath, '-d', lan_classes,
                        SOURCE / 'LanBackendAddress.kt', TESTS / 'LanBackendDnsTest.kt'])
        run([java, '-cp', lan_classpath, 'ai.openbuy.exhibition.LanBackendDnsTestKt'], timeout=60)

        nsd_classes = temporary / 'lan-nsd/classes'
        nsd_classes.mkdir(parents=True)
        nsd_classpath = os.pathsep.join(map(str, [nsd_classes, stdlib]))
        nsd_stubs = sorted((TESTS / 'nsd-stubs').rglob('*.kt'))
        require(bool(nsd_stubs), 'NSD 回调顺序测试的 Android 替身未就绪。')
        print('Run actual NSD discovery callback ordering fixtures.', flush=True)
        run([javac, '-encoding', 'UTF-8', '--release', '17', '-d', nsd_classes, SOURCE / 'UrlPolicy.java'])
        run(compiler + ['-classpath', nsd_classpath, '-d', nsd_classes,
                        SOURCE / 'LanBackendAddress.kt', SOURCE / 'LanBackendDns.kt',
                        TESTS / 'LanNsdDiscoveryTest.kt'] + nsd_stubs)
        run([java, '-cp', nsd_classpath, 'ai.openbuy.exhibition.LanNsdDiscoveryTestKt'], timeout=60)

        camera_classes = temporary / 'camera/classes'
        camera_classes.mkdir(parents=True)
        camera_classpath = os.pathsep.join(map(str, [camera_classes, stdlib]))
        print('Run native camera identity and selection fixtures.', flush=True)
        run(compiler + ['-classpath', camera_classpath, '-d', camera_classes,
                        SOURCE / 'NativeCameraSelection.kt', SOURCE / 'NativeCameraCaptureSelection.kt',
                        TESTS / 'NativeCameraSelectionTest.kt', TESTS / 'NativeCameraCaptureSelectionTest.kt'])
        run([java, '-cp', camera_classpath, 'ai.openbuy.exhibition.NativeCameraSelectionTestKt'], timeout=60)
        run([java, '-cp', camera_classpath, 'ai.openbuy.exhibition.NativeCameraCaptureSelectionTestKt'], timeout=60)

        pixels_classes = temporary / 'camera-pixels/classes'
        pixels_classes.mkdir(parents=True)
        pixels_classpath = os.pathsep.join(map(str, [pixels_classes, stdlib]))
        print('Run native I420 stride, rotation and reduced-allocation fixtures.', flush=True)
        run(compiler + ['-classpath', pixels_classpath, '-d', pixels_classes,
                        SOURCE / 'NativeCameraPixels.kt', TESTS / 'NativeCameraPixelsTest.kt'])
        run([java, '-cp', pixels_classpath, 'ai.openbuy.exhibition.NativeCameraPixelsTestKt'], timeout=60)

        tracker_classes = temporary / 'hand-tracker/classes'
        tracker_classes.mkdir(parents=True)
        tracker_classpath = os.pathsep.join(map(str, [tracker_classes, stdlib]))
        tracker_stubs = sorted((TESTS / 'hand-tracker-stubs').rglob('*.kt'))
        require(bool(tracker_stubs), '原生手势推理测试的 Android/MediaPipe 替身未就绪。')
        print('Run native inference scheduling and frame ownership fixtures.', flush=True)
        run(compiler + ['-classpath', tracker_classpath, '-d', tracker_classes,
                        SOURCE / 'NativeCameraFrame.kt', SOURCE / 'NativeHandTracker.kt',
                        TESTS / 'NativeHandTrackerTest.kt'] + tracker_stubs)
        run([java, '-cp', tracker_classpath, 'ai.openbuy.exhibition.NativeHandTrackerTestKt'], timeout=60)

        gesture_classes = temporary / 'gesture/classes'
        gesture_classes.mkdir(parents=True)
        gesture_classpath = os.pathsep.join(map(str, [gesture_classes, stdlib]))
        print('Run native gesture single-flight and stale-callback fixtures.', flush=True)
        run(compiler + ['-classpath', gesture_classpath, '-d', gesture_classes,
                        SOURCE / 'NativeGestureFrameGate.kt', SOURCE / 'NativeGestureReleaseFence.kt',
                        TESTS / 'NativeGestureFrameGateTest.kt', TESTS / 'NativeGestureReleaseFenceTest.kt'])
        run([java, '-cp', gesture_classpath, 'ai.openbuy.exhibition.NativeGestureFrameGateTestKt'], timeout=60)
        run([java, '-cp', gesture_classpath, 'ai.openbuy.exhibition.NativeGestureReleaseFenceTestKt'], timeout=60)

        ui_classes = temporary / 'mirror-ui/classes'
        ui_classes.mkdir(parents=True)
        ui_classpath = os.pathsep.join(map(str, [ui_classes, stdlib]))
        print('Run native mirror presentation state fixtures.', flush=True)
        run(compiler + ['-classpath', ui_classpath, '-d', ui_classes,
                        SOURCE / 'NativeMirrorUiState.kt', TESTS / 'NativeMirrorUiStateTest.kt'])
        run([java, '-cp', ui_classpath, 'ai.openbuy.exhibition.NativeMirrorUiStateTestKt'], timeout=60)

        remote_classes = temporary / 'camera-remote/classes'
        remote_classes.mkdir(parents=True)
        remote_classpath = os.pathsep.join(map(str, [remote_classes, stdlib, json_jar]))
        print('Run native per-mirror camera request and metadata fixtures.', flush=True)
        run(compiler + ['-classpath', remote_classpath, '-d', remote_classes,
                        SOURCE / 'NativeCameraSelection.kt', SOURCE / 'NativeCameraRemote.kt', TESTS / 'NativeCameraRemoteTest.kt'])
        run([java, '-cp', remote_classpath, 'ai.openbuy.exhibition.NativeCameraRemoteTestKt'], timeout=60)

        metadata_dir = temporary / 'metadata'
        metadata_classes = metadata_dir / 'classes'
        metadata_classes.mkdir(parents=True)
        round_source = (SOURCE / 'NativeGenerationRound.kt').read_text(encoding='utf-8')
        marker = 'internal object NativeRoundMetadata'
        require(round_source.count(marker) == 1, '无法唯一定位真实 NativeRoundMetadata。')
        metadata_source = metadata_dir / 'Metadata.kt'
        metadata_source.write_text(
            'package ai.openbuy.exhibition\nimport org.json.JSONObject\n'
            'import java.net.URI\nimport java.io.IOException\n'
            'import java.time.OffsetDateTime\nimport java.time.format.DateTimeFormatter\n' + round_source[round_source.index(marker):],
            encoding='utf-8')
        metadata_classpath = os.pathsep.join(map(str, [metadata_classes, stdlib, json_jar]))
        print('Run extracted NativeRoundMetadata fixtures.', flush=True)
        run(compiler + ['-classpath', metadata_classpath, '-d', metadata_classes,
                        metadata_source, TESTS / 'NativeRoundMetadataTest.kt'])
        run([java, '-cp', metadata_classpath, 'ai.openbuy.exhibition.NativeRoundMetadataTestKt'], timeout=60)

        flow_classes = temporary / 'flow/classes'
        flow_classes.mkdir(parents=True)
        flow_classpath = os.pathsep.join(map(str, [flow_classes, stdlib, coroutines, json_jar] + http_modules))
        stubs = TESTS / 'stubs'
        stub_sources = sorted(stubs.rglob('*.kt'))
        services = stubs / 'META-INF/services/kotlinx.coroutines.internal.MainDispatcherFactory'
        require(bool(stub_sources) and services.is_file(), '隔离 flow 测试的 SDK/Main dispatcher 替身未就绪。')
        print('Run isolated NativeGenerationRound flow fixtures.', flush=True)
        run([javac, '-encoding', 'UTF-8', '--release', '17', '-d', flow_classes, SOURCE / 'UrlPolicy.java'])
        run(compiler + ['-classpath', flow_classpath, '-d', flow_classes,
                        SOURCE / 'ExhibitionApi.kt', SOURCE / 'NativeGenerationRound.kt',
                        SOURCE / 'NativeCameraSelection.kt', SOURCE / 'NativeCameraCaptureSelection.kt',
                        TESTS / 'NativeRoundFlowTest.kt'] + stub_sources)
        shutil.copytree(stubs / 'META-INF', flow_classes / 'META-INF', dirs_exist_ok=True)
        run([java, '-Dsun.net.http.allowRestrictedHeaders=true', '--add-modules', 'jdk.httpserver',
             '-cp', flow_classpath, 'ai.openbuy.exhibition.NativeRoundFlowTestKt'], timeout=60)

    print('Native JVM tests passed; no live service calls.', flush=True)


try:
    main()
except (RuntimeError, OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as failure:
    print(f'Native JVM tests failed: {failure}', file=sys.stderr)
    sys.exit(1)
PY
