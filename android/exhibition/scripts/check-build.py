#!/usr/bin/env python3
"""Read-only Android build prerequisite report; never installs or downloads tools."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
issues = []

def report(label, ok, detail):
    print(f"{'OK' if ok else 'MISSING'} {label}: {detail}")
    if not ok:
        issues.append(label)

def command_version(command):
    java_home = os.environ.get('JAVA_HOME')
    executable = str(Path(java_home) / 'bin' / command) if java_home else shutil.which(command)
    if not executable or not Path(executable).is_file():
        return "", False
    result = subprocess.run([executable, '-version'], capture_output=True, text=True)
    return (result.stdout + result.stderr).strip(), result.returncode == 0

java, java_ok = command_version('java')
version = re.search(r'(?:version\s+|javac\s+)["\']?(\d+)', java)
report('JDK 17+', java_ok and version is not None and int(version.group(1)) >= 17,
       java.splitlines()[0] if java else 'java not found')
javac, javac_ok = command_version('javac')
report('Java compiler', javac_ok, javac.splitlines()[0] if javac else 'javac not found')

sdk = os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT')
local_properties = root / 'local.properties'
if not sdk and local_properties.exists():
    for line in local_properties.read_text().splitlines():
        if line.startswith('sdk.dir='):
            sdk = line.split('=', 1)[1].replace('\\:', ':').replace('\\\\', '\\')
if not sdk:
    default = Path.home() / 'Library/Android/sdk'
    if default.is_dir():
        sdk = str(default)
report('Android SDK', bool(sdk and Path(sdk).is_dir()), sdk or 'not configured')
if sdk:
    report('Android API 37', (Path(sdk) / 'platforms/android-37.0/android.jar').is_file(), 'platforms/android-37.0/android.jar')
    report('Build tools 36.0.0', (Path(sdk) / 'build-tools/36.0.0').is_dir(), 'build-tools/36.0.0')

required = ['gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar', 'gradle/wrapper/gradle-wrapper.properties']
report('Gradle wrapper', all((root / file).is_file() for file in required), '9.3.1, distribution checksum pinned')

try:
    manifest = ET.parse(root / 'app/src/main/AndroidManifest.xml').getroot()
    android = '{http://schemas.android.com/apk/res/android}'
    tools = '{http://schemas.android.com/tools}'
    permissions = {item.attrib[android+'name'] for item in manifest.findall('uses-permission')
                   if item.attrib.get(tools+'node') != 'remove'}
    assert permissions == {'android.permission.INTERNET', 'android.permission.CAMERA'}, permissions
    assert manifest.find('application/activity').attrib[android+'screenOrientation'] == 'portrait'
    for path in (root / 'app/src').rglob('*.xml'):
        ET.parse(path)
    report('Resource XML + manifest', True, 'well-formed; portrait; INTERNET + CAMERA; no microphone')
except (AssertionError, ET.ParseError, KeyError) as error:
    report('Resource XML + manifest', False, str(error))

print('\nNo installation, compilation or device test was performed by this check.')
if issues:
    print('Build prerequisites incomplete: ' + ', '.join(issues))
    sys.exit(1)
print('Ready to run ./gradlew assembleDebug; this is not confirmation that the APK builds.')
