#!/usr/bin/env python3
"""Route explicitly bound USB evdev receivers to the presenter's JSON protocol.

Only this helper's configured event descriptors are grabbed. No keyboard events
are synthesized, no input permissions are changed, and no third-party package is
required. --list and --validate do not open input devices.
"""

import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import struct
import sys
import time


EV_KEY = 1
EV_SYN = 0
SYN_REPORT = 0
SYN_DROPPED = 3
BUS_USB = 3
KEY_BYTES = 96
INPUT_EVENT = struct.Struct('@llHHi')
INPUT_ID = struct.Struct('@HHHH')
DIRECTIONS = {104: 75, 109: 78, 105: 80, 106: 79, 103: 82, 108: 81}
EVIOCGRAB = 0x40044590
EVIOCGID = 0x80084502
EVENT_NAME = re.compile(r'event[0-9]+\Z')
STABLE_PATH = re.compile(r'/dev/input/(?:by-id|by-path)/[^/\x00]+\Z')
RAW_PATH = re.compile(r'/dev/input/event[0-9]+\Z')


class PresenterError(Exception):
    def __init__(self, code, message, exit_code=78):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


def emit(event):
    print(json.dumps(event, ensure_ascii=False, separators=(',', ':')), flush=True)


def text_file(path):
    try:
        return path.read_text(encoding='utf-8').strip()
    except (OSError, UnicodeError):
        return ''


def bitmap(value):
    """sysfs prints most-significant native unsigned-long words first."""
    result = 0
    try:
        for word in value.split():
            result = (result << (struct.calcsize('@L') * 8)) | int(word, 16)
    except ValueError:
        return 0
    return result


def usb_identity(device, vendor, product):
    """Require an actual USB ancestor; exclude devices marked physically fixed."""
    try:
        ancestors = (device.resolve(), *device.resolve().parents)
    except OSError:
        return None
    for parent in ancestors:
        try:
            matching = int(text_file(parent / 'idVendor'), 16) == vendor and int(text_file(parent / 'idProduct'), 16) == product
        except ValueError:
            continue
        if matching:
            return str(parent) if text_file(parent / 'removable').lower() != 'fixed' else None
    return None


def enumerate_devices(sysfs_root=Path('/sys/class/input'), dev_root=Path('/dev/input')):
    aliases = {}
    for directory in ('by-id', 'by-path'):
        try:
            paths = sorted((dev_root / directory).iterdir())
        except OSError:
            continue
        for path in paths:
            try:
                target = str(path.resolve(strict=True))
            except (OSError, RuntimeError):
                continue
            aliases.setdefault(target, {}).setdefault(directory, []).append(str(path))
    result = []
    try:
        entries = sorted(sysfs_root.iterdir())
    except OSError:
        return result
    for entry in entries:
        if not EVENT_NAME.fullmatch(entry.name):
            continue
        device = entry / 'device'
        try:
            bus = int(text_file(device / 'id/bustype'), 16)
            vendor = int(text_file(device / 'id/vendor'), 16)
            product = int(text_file(device / 'id/product'), 16)
        except ValueError:
            continue
        keys = bitmap(text_file(device / 'capabilities/key'))
        if bus != BUS_USB or not (bitmap(text_file(device / 'capabilities/ev')) & (1 << EV_KEY)):
            continue
        physical_device = usb_identity(device, vendor, product)
        if not any(keys & (1 << code) for code in DIRECTIONS) or not physical_device:
            continue
        event_path = str(dev_root / entry.name)
        links = aliases.get(str((dev_root / entry.name).resolve()), {})
        by_id = links.get('by-id', [])
        by_path = links.get('by-path', [])
        result.append({'vendorId': vendor, 'productId': product, 'phys': text_file(device / 'phys'),
                       'uniq': text_file(device / 'uniq'), 'eventPath': event_path,
                       'name': text_file(device / 'name'), 'usagePage': 1, 'usage': 6, 'bus': 'usb',
                       'physicalDevicePath': physical_device,
                       'byId': by_id, 'byPath': by_path,
                       'linuxDevicePath': (by_path or by_id or [None])[0]})
    return result


def validate_config(config):
    if not isinstance(config, dict) or not isinstance(config.get('bindings'), list) or not config['bindings']:
        raise PresenterError('invalid_config', '配置 bindings 不能为空。')
    bindings = []
    ids, mirrors, paths = set(), set(), set()
    for original in config['bindings']:
        if not isinstance(original, dict):
            raise PresenterError('invalid_config', '翻页笔绑定格式无效。')
        binding = dict(original)
        binding_id, mirror_id = binding.get('id'), binding.get('mirrorId')
        if not isinstance(binding_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', binding_id):
            raise PresenterError('invalid_config', '翻页笔 id 无效。')
        if not isinstance(mirror_id, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', mirror_id):
            raise PresenterError('invalid_config', '翻页笔镜端编号无效。')
        if type(binding.get('vendorId')) is not int or not 1 <= binding['vendorId'] <= 65535:
            raise PresenterError('invalid_config', '翻页笔 vendorId 无效。')
        if type(binding.get('productId')) is not int or not 0 <= binding['productId'] <= 65535:
            raise PresenterError('invalid_config', '翻页笔 productId 无效。')
        path = binding.get('linuxDevicePath') or binding.get('byPath')
        if binding.get('linuxDevicePath') and binding.get('byPath') and binding['linuxDevicePath'] != binding['byPath']:
            raise PresenterError('invalid_config', f'{binding_id} 的 Linux 设备路径不一致。')
        if not isinstance(path, str) or not (STABLE_PATH.fullmatch(path) or RAW_PATH.fullmatch(path)):
            raise PresenterError('invalid_config', f'{binding_id} 必须绑定明确的 /dev/input/by-path 或 by-id 接口。')
        if any(part in ('.', '..') for part in path.split('/')):
            raise PresenterError('invalid_config', f'{binding_id} 的设备路径无效。')
        for field in ('phys', 'uniq'):
            if binding.get(field) is not None and (not isinstance(binding[field], str) or not binding[field].strip() or '\x00' in binding[field]):
                raise PresenterError('invalid_config', f'{binding_id} 的 {field} 无效。')
        if RAW_PATH.fullmatch(path) and not binding.get('phys'):
            raise PresenterError('invalid_config', f'{binding_id} 使用 event 编号时必须同时指定 phys；建议使用稳定 by-path 链接。')
        if binding_id in ids or mirror_id in mirrors or path in paths:
            raise PresenterError('invalid_config', '每个接收器须通过独立路径绑定一台设备。')
        ids.add(binding_id)
        mirrors.add(mirror_id)
        paths.add(path)
        binding['linuxDevicePath'] = path
        bindings.append(binding)
    return bindings


def load_config(path):
    try:
        with open(path, 'rb') as source:
            raw = source.read(65537)
        if len(raw) > 65536:
            raise ValueError('oversized')
        config = json.loads(raw)
    except (OSError, ValueError, UnicodeError):
        raise PresenterError('invalid_config', '无法读取有效的翻页笔 JSON 配置。') from None
    return validate_config(config)


def ioctl_read(fd, number, length):
    value = bytearray(length)
    request = (2 << 30) | (length << 16) | (ord('E') << 8) | number
    fcntl.ioctl(fd, request, value, True)
    return bytes(value)


def ioctl_text(fd, number):
    try:
        return ioctl_read(fd, number, 256).split(b'\0', 1)[0].decode('utf-8', 'replace')
    except OSError as error:
        # Devices without a serial/physical string return ENOENT, not an empty buffer.
        if error.errno == errno.ENOENT:
            return ''
        raise


def current_directions(fd):
    value = int.from_bytes(ioctl_read(fd, 0x18, KEY_BYTES), 'little')
    return {code for code in DIRECTIONS if value & (1 << code)}


def permission_error(binding_id):
    return PresenterError('input_permission_required',
                          f'无法读取翻页笔 {binding_id}。请在本机桌面终端运行翻页笔安装器，'
                          '仅为所选接收器设置 udev 访问规则，然后重新启动服务。', 77)


def find_bound_device(binding, devices):
    try:
        target = Path(binding['linuxDevicePath']).resolve(strict=True)
    except FileNotFoundError:
        return None
    except PermissionError:
        raise permission_error(binding['id']) from None
    except (OSError, RuntimeError):
        raise PresenterError('invalid_device', f'{binding["id"]} 的输入设备路径不可用。') from None
    if not RAW_PATH.fullmatch(str(target)):
        raise PresenterError('invalid_device', f'{binding["id"]} 的路径未指向明确的 evdev 接口。')
    metadata = next((item for item in devices if item['eventPath'] == str(target)), None)
    if metadata is None:
        if not Path('/sys/class/input', target.name, 'device').exists():
            return None
        # A path exists but is no longer an eligible external USB keyboard.
        raise PresenterError('invalid_device', f'{binding["id"]} 不是支持翻页键的外接 USB 键盘接口，未接管。')
    if metadata['vendorId'] != binding['vendorId'] or metadata['productId'] != binding['productId']:
        raise PresenterError('device_mismatch', f'{binding["id"]} 的接收器型号与配置不符，未接管。')
    for field in ('phys', 'uniq'):
        if binding.get(field) and binding[field] != metadata[field]:
            raise PresenterError('device_mismatch', f'{binding["id"]} 的物理设备身份与配置不符，未接管。')
    return metadata


def open_receiver(binding, metadata, grab=True):
    fd = None
    try:
        flags = os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC | getattr(os, 'O_NOFOLLOW', 0)
        fd = os.open(metadata['eventPath'], flags)
        if not stat.S_ISCHR(os.fstat(fd).st_mode):
            raise PresenterError('invalid_device', f'{binding["id"]} 不是输入设备节点。')
        identity = bytearray(INPUT_ID.size)
        fcntl.ioctl(fd, EVIOCGID, identity, True)
        bus, vendor, product, _version = INPUT_ID.unpack(identity)
        if (bus, vendor, product) != (BUS_USB, binding['vendorId'], binding['productId']):
            raise PresenterError('device_mismatch', f'{binding["id"]} 的输入设备身份已变化，未接管。')
        if ioctl_text(fd, 0x07) != metadata['phys'] or ioctl_text(fd, 0x08) != metadata['uniq']:
            raise PresenterError('device_mismatch', f'{binding["id"]} 的物理输入接口已变化，未接管。')
        if Path(binding['linuxDevicePath']).resolve(strict=True) != Path(metadata['eventPath']):
            raise PresenterError('device_mismatch', f'{binding["id"]} 的输入路径已变化，未接管。')
        if grab:
            fcntl.ioctl(fd, EVIOCGRAB, 1)
        return fd
    except OSError as error:
        if fd is not None:
            os.close(fd)
        if error.errno in (errno.EACCES, errno.EPERM):
            raise permission_error(binding['id']) from None
        if error.errno == errno.EBUSY:
            raise PresenterError('device_busy', f'翻页笔 {binding["id"]} 已被其他程序独占。', 1) from None
        if error.errno in (errno.ENOENT, errno.ENODEV, errno.ENXIO):
            return None
        raise PresenterError('input_error', f'无法打开翻页笔 {binding["id"]} 的输入接口。', 1) from None
    except Exception:
        if fd is not None:
            os.close(fd)
        raise


class Receiver:
    def __init__(self, binding, metadata, fd):
        self.binding = binding
        self.metadata = metadata
        self.fd = fd
        self.buffer = bytearray()
        self.held = set()
        # A receiver plugged in while a button is held must wait for its release.
        self.suppressed = current_directions(fd)
        self.dropped = False

    def release_keys(self):
        for code in sorted(self.held):
            emit({'type': 'key', 'bindingId': self.binding['id'], 'usage': DIRECTIONS[code], 'value': 0})
        self.held.clear()

    def consume(self, data):
        self.buffer.extend(data)
        while len(self.buffer) >= INPUT_EVENT.size:
            _sec, _usec, event_type, code, value = INPUT_EVENT.unpack_from(self.buffer)
            del self.buffer[:INPUT_EVENT.size]
            if event_type == EV_SYN and code == SYN_DROPPED:
                self.release_keys()
                self.dropped = True
                continue
            if self.dropped:
                if event_type == EV_SYN and code == SYN_REPORT:
                    self.suppressed = current_directions(self.fd)
                    self.dropped = False
                continue
            if event_type != EV_KEY or code not in DIRECTIONS or value not in (0, 1):
                continue
            if value == 0:
                self.suppressed.discard(code)
                self.held.discard(code)
            else:
                if code in self.suppressed or code in self.held:
                    continue
                self.held.add(code)
            emit({'type': 'key', 'bindingId': self.binding['id'], 'usage': DIRECTIONS[code], 'value': value})


def check_access(bindings):
    devices = enumerate_devices()
    available = 0
    seen = set()
    for binding in bindings:
        metadata = find_bound_device(binding, devices)
        if metadata is None:
            continue
        if metadata['physicalDevicePath'] in seen:
            raise PresenterError('ambiguous_device', '两个绑定指向同一物理接收器，未接管。')
        seen.add(metadata['physicalDevicePath'])
        fd = open_receiver(binding, metadata, grab=False)
        if fd is not None:
            os.close(fd)
            available += 1
    emit({'type': 'permission', 'permission': 'linux-input', 'status': 'granted' if available else 'unknown',
          'connected': available, 'bindings': len(bindings)})
    return 0


def run_receivers(bindings):
    poller = selectors.DefaultSelector()
    receivers = {}
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def disconnect(binding_id):
        receiver = receivers.pop(binding_id, None)
        if receiver is None:
            return
        receiver.release_keys()
        try:
            poller.unregister(receiver.fd)
        except (KeyError, OSError):
            pass
        try:
            fcntl.ioctl(receiver.fd, EVIOCGRAB, 0)
        except OSError:
            pass
        os.close(receiver.fd)
        emit({'type': 'disconnected', 'bindingId': binding_id})

    def reconcile():
        devices = enumerate_devices()
        desired = []
        paths = set()
        for binding in bindings:
            metadata = find_bound_device(binding, devices)
            if metadata is not None:
                if metadata['physicalDevicePath'] in paths:
                    raise PresenterError('ambiguous_device', '两个绑定指向同一物理接收器，未接管。')
                paths.add(metadata['physicalDevicePath'])
            desired.append((binding, metadata))
        # Validate every present receiver before grabbing any new one.
        for binding, metadata in desired:
            current = receivers.get(binding['id'])
            if current and (metadata is None or metadata != current.metadata):
                disconnect(binding['id'])
            if metadata is None or binding['id'] in receivers:
                continue
            fd = open_receiver(binding, metadata)
            if fd is None:
                continue
            try:
                receiver = Receiver(binding, metadata, fd)
                poller.register(fd, selectors.EVENT_READ, binding['id'])
            except Exception as error:
                try:
                    fcntl.ioctl(fd, EVIOCGRAB, 0)
                except OSError:
                    pass
                finally:
                    os.close(fd)
                if isinstance(error, OSError):
                    if error.errno in (errno.ENOENT, errno.ENODEV, errno.ENXIO, errno.EIO):
                        continue
                    if error.errno in (errno.EACCES, errno.EPERM):
                        raise permission_error(binding['id']) from None
                raise
            receivers[binding['id']] = receiver
            emit({'type': 'permission', 'permission': 'linux-input', 'status': 'granted', 'bindingId': binding['id']})
            emit({'type': 'connected', 'bindingId': binding['id']})

    try:
        reconcile()
        emit({'type': 'ready', 'connected': len(receivers), 'bindings': len(bindings)})
        next_scan = time.monotonic() + 1
        while not stopping:
            for selected, _mask in poller.select(timeout=0.25):
                receiver = receivers.get(selected.data)
                if receiver is None:
                    continue
                try:
                    data = os.read(receiver.fd, INPUT_EVENT.size * 64)
                    if data:
                        receiver.consume(data)
                    else:
                        disconnect(selected.data)
                except BlockingIOError:
                    pass
                except OSError as error:
                    if error.errno in (errno.ENODEV, errno.ENOENT, errno.EIO, errno.ENXIO):
                        disconnect(selected.data)
                    elif error.errno in (errno.EACCES, errno.EPERM):
                        raise permission_error(selected.data) from None
                    else:
                        raise PresenterError('input_error', '读取已绑定翻页笔失败。', 1) from None
            if time.monotonic() >= next_scan:
                reconcile()
                next_scan = time.monotonic() + 1
    finally:
        for binding_id in list(receivers):
            disconnect(binding_id)
        poller.close()
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description='按独立 USB 接收器控制对应智能镜。')
    parser.add_argument('--list', action='store_true', help='只读枚举外接 USB 键盘接口')
    parser.add_argument('--validate', metavar='PATH', help='仅检查绑定配置，不打开设备')
    parser.add_argument('--check', action='store_true', help='只读检查已绑定设备的访问权限')
    parser.add_argument('--config', metavar='PATH', help='运行绑定配置')
    args = parser.parse_args(argv)
    if args.validate and not (args.list or args.check or args.config):
        bindings = load_config(args.validate)
        emit({'type': 'valid', 'bindings': len(bindings)})
        return 0
    if not sys.platform.startswith('linux'):
        raise PresenterError('platform_unsupported', '此输入接收器仅用于 Linux。', 69)
    if args.list and not (args.check or args.config or args.validate):
        emit({'type': 'devices', 'devices': enumerate_devices()})
        return 0
    if args.config and not (args.list or args.validate):
        bindings = load_config(args.config)
        return check_access(bindings) if args.check else run_receivers(bindings)
    parser.error('使用 --list、--validate PATH、--check --config PATH 或 --config PATH。')


if __name__ == '__main__':
    try:
        sys.exit(main())
    except PresenterError as error:
        emit({'type': 'error', 'code': error.code, 'message': str(error)})
        sys.exit(error.exit_code)
    except (BrokenPipeError, KeyboardInterrupt):
        sys.exit(0)
    except OSError:
        emit({'type': 'error', 'code': 'input_error', 'message': 'Linux 输入接口不可用，请检查设备与运行权限。'})
        sys.exit(1)
