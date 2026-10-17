"""Offline evdev tests: no real input device is opened or reconfigured."""

from contextlib import ExitStack
import errno
import importlib.util
import itertools
from pathlib import Path
import signal
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import call, patch


SPEC = importlib.util.spec_from_file_location('presenter_linux', Path(__file__).with_name('presenter-linux.py'))
presenter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(presenter)


def binding(name='pen-a', path='/dev/input/by-path/usb-a-event-kbd'):
    return {'id': name, 'mirrorId': 'mirror-' + name, 'vendorId': 529, 'productId': 1,
            'linuxDevicePath': path, 'phys': 'usb-port-' + name}


def metadata(config, event='/dev/input/event7', physical='/sys/devices/usb1/1-1'):
    return {'vendorId': config['vendorId'], 'productId': config['productId'], 'phys': config['phys'],
            'uniq': '', 'eventPath': event, 'physicalDevicePath': physical}


def event(code, value, event_type=presenter.EV_KEY):
    return presenter.INPUT_EVENT.pack(0, 0, event_type, code, value)


class ConfigurationTests(unittest.TestCase):
    def test_stable_paths_bind_same_model_receivers_independently(self):
        first, second = binding(), binding('pen-b', '/dev/input/by-path/usb-b-event-kbd')
        actual = presenter.validate_config({'bindings': [first, second]})
        self.assertEqual(actual, [first, second])
        self.assertIsNot(actual[0], first)

    def test_rejects_broad_paths_and_raw_event_without_physical_identity(self):
        for path in ('/dev/input', '/dev/input/event*', '/dev/input/by-path/../event7', '/tmp/event7', '/dev/input/event7'):
            with self.subTest(path=path):
                value = binding(path=path)
                value.pop('phys')
                with self.assertRaises(presenter.PresenterError):
                    presenter.validate_config({'bindings': [value]})
        self.assertEqual(presenter.validate_config({'bindings': [binding(path='/dev/input/event7')]})[0]['phys'], 'usb-port-pen-a')

    def test_rejects_duplicate_receiver_or_mirror(self):
        first = binding()
        second = binding('pen-b', first['linuxDevicePath'])
        with self.assertRaises(presenter.PresenterError):
            presenter.validate_config({'bindings': [first, second]})
        second['linuxDevicePath'] = '/dev/input/by-path/usb-b-event-kbd'
        second['mirrorId'] = first['mirrorId']
        with self.assertRaises(presenter.PresenterError):
            presenter.validate_config({'bindings': [first, second]})


class IdentityTests(unittest.TestCase):
    def test_rejects_model_and_physical_identity_mismatch(self):
        configured = binding()
        found = metadata(configured)
        with patch.object(Path, 'resolve', return_value=Path(found['eventPath'])):
            self.assertEqual(presenter.find_bound_device(configured, [found]), found)
            for field, value in (('vendorId', 530), ('productId', 2), ('phys', 'another-port')):
                with self.subTest(field=field), self.assertRaises(presenter.PresenterError) as raised:
                    presenter.find_bound_device(configured, [{**found, field: value}])
                self.assertEqual(raised.exception.code, 'device_mismatch')

    def test_missing_receiver_waits_without_falling_back_to_same_model(self):
        configured = binding()
        with patch.object(Path, 'resolve', side_effect=FileNotFoundError):
            self.assertIsNone(presenter.find_bound_device(configured, [metadata(configured)]))

    def test_enumeration_requires_usb_ancestor_and_excludes_fixed_devices(self):
        with tempfile.TemporaryDirectory(prefix='presenter-sysfs-') as temporary:
            root = Path(temporary).resolve()
            sysfs, dev = root / 'class-input', root / 'dev-input'
            usb = root / 'devices/usb1/1-1'
            input_device = usb / 'input/input1'
            for directory in (sysfs / 'event7', dev / 'by-path', input_device / 'id', input_device / 'capabilities'):
                directory.mkdir(parents=True)
            (sysfs / 'event7/device').symlink_to(input_device)
            for filename, value in {'idVendor': '0211', 'idProduct': '0001', 'removable': 'removable'}.items():
                (usb / filename).write_text(value)
            for filename, value in {'bustype': '0003', 'vendor': '0211', 'product': '0001'}.items():
                (input_device / 'id' / filename).write_text(value)
            # Native unsigned-long words in sysfs are printed highest first.
            word_bits = presenter.struct.calcsize('@L') * 8
            key_bits = 1 << 109
            words = []
            while key_bits:
                words.append(format(key_bits & ((1 << word_bits) - 1), 'x'))
                key_bits >>= word_bits
            (input_device / 'capabilities/key').write_text(' '.join(reversed(words)))
            (input_device / 'capabilities/ev').write_text('3')
            (input_device / 'phys').write_text('usb-port-pen-a')
            (input_device / 'name').write_text('Test pointer')
            (dev / 'event7').touch()
            (dev / 'by-path/usb-a-event-kbd').symlink_to(dev / 'event7')
            found = presenter.enumerate_devices(sysfs, dev)
            self.assertEqual(len(found), 1)
            self.assertEqual(found[0]['linuxDevicePath'], str(dev / 'by-path/usb-a-event-kbd'))
            self.assertEqual(found[0]['physicalDevicePath'], str(usb))
            (usb / 'removable').write_text('fixed')
            self.assertEqual(presenter.enumerate_devices(sysfs, dev), [])
            (usb / 'removable').write_text('removable')
            (input_device / 'id/bustype').write_text('0019')
            self.assertEqual(presenter.enumerate_devices(sysfs, dev), [])


class OpenTests(unittest.TestCase):
    def setUp(self):
        self.configured = binding()
        self.found = metadata(self.configured)
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        self.opened = self.patches.enter_context(patch.object(presenter.os, 'open', return_value=42))
        self.closed = self.patches.enter_context(patch.object(presenter.os, 'close'))
        self.patches.enter_context(patch.object(presenter.os, 'fstat', return_value=SimpleNamespace(st_mode=stat.S_IFCHR | 0o600)))
        self.resolved = self.patches.enter_context(patch.object(Path, 'resolve', return_value=Path(self.found['eventPath'])))
        self.patches.enter_context(patch.object(presenter, 'ioctl_text', side_effect=lambda fd, number: self.found['phys'] if number == 0x07 else self.found['uniq']))
        self.input_id = (presenter.BUS_USB, 529, 1, 1)
        self.grab_error = None

        def ioctl(fd, request, argument, *extra):
            if request == presenter.EVIOCGID:
                argument[:] = presenter.INPUT_ID.pack(*self.input_id)
            elif request == presenter.EVIOCGRAB and self.grab_error:
                raise self.grab_error
            return 0

        self.ioctl = self.patches.enter_context(patch.object(presenter.fcntl, 'ioctl', side_effect=ioctl))

    def test_grabs_only_verified_descriptor_and_readonly_check_does_not_grab(self):
        self.assertEqual(presenter.open_receiver(self.configured, self.found), 42)
        self.ioctl.assert_any_call(42, presenter.EVIOCGRAB, 1)
        self.closed.assert_not_called()
        self.ioctl.reset_mock()
        self.assertEqual(presenter.open_receiver(self.configured, self.found, grab=False), 42)
        self.assertFalse(any(item.args[1] == presenter.EVIOCGRAB for item in self.ioctl.call_args_list))
        self.assertEqual(self.opened.call_args.args[0], self.found['eventPath'])

    def test_revalidates_fd_identity_before_grab_and_closes_mismatch(self):
        self.input_id = (presenter.BUS_USB, 529, 2, 1)
        with self.assertRaises(presenter.PresenterError) as raised:
            presenter.open_receiver(self.configured, self.found)
        self.assertEqual(raised.exception.code, 'device_mismatch')
        self.closed.assert_called_once_with(42)
        self.assertFalse(any(item.args[1] == presenter.EVIOCGRAB for item in self.ioctl.call_args_list))

    def test_alias_change_before_grab_closes_descriptor(self):
        self.resolved.return_value = Path('/dev/input/event9')
        with self.assertRaises(presenter.PresenterError) as raised:
            presenter.open_receiver(self.configured, self.found)
        self.assertEqual(raised.exception.code, 'device_mismatch')
        self.closed.assert_called_once_with(42)
        self.assertFalse(any(item.args[1] == presenter.EVIOCGRAB for item in self.ioctl.call_args_list))

    def test_permission_and_busy_failures_do_not_fall_back_to_shared_mode(self):
        for error_number, expected, exit_code in ((errno.EACCES, 'input_permission_required', 77), (errno.EBUSY, 'device_busy', 1)):
            with self.subTest(errno=error_number):
                self.closed.reset_mock()
                self.grab_error = OSError(error_number, 'test failure')
                with self.assertRaises(presenter.PresenterError) as raised:
                    presenter.open_receiver(self.configured, self.found)
                self.assertEqual((raised.exception.code, raised.exception.exit_code), (expected, exit_code))
                self.closed.assert_called_once_with(42)


class IoctlTextTests(unittest.TestCase):
    def test_absent_optional_strings_are_empty_but_device_and_permission_errors_propagate(self):
        with patch.object(presenter, 'ioctl_read', side_effect=OSError(errno.ENOENT, 'no serial')):
            self.assertEqual(presenter.ioctl_text(42, 0x08), '')
        for number in (errno.ENODEV, errno.EACCES, errno.EIO):
            with self.subTest(errno=number), \
                    patch.object(presenter, 'ioctl_read', side_effect=OSError(number, 'read failed')), \
                    self.assertRaises(OSError) as raised:
                presenter.ioctl_text(42, 0x08)
            self.assertEqual(raised.exception.errno, number)

    def test_receiver_without_serial_can_be_verified_and_grabbed(self):
        configured = binding()
        found = metadata(configured)

        def ioctl(fd, request, argument, *extra):
            if request == presenter.EVIOCGID:
                argument[:] = presenter.INPUT_ID.pack(presenter.BUS_USB, 529, 1, 1)
            elif request & 0xff == 0x07:
                value = found['phys'].encode() + b'\0'
                argument[:len(value)] = value
            elif request & 0xff == 0x08:
                raise OSError(errno.ENOENT, 'receiver has no serial')
            return 0

        with patch.object(presenter.os, 'open', return_value=42), \
                patch.object(presenter.os, 'fstat', return_value=SimpleNamespace(st_mode=stat.S_IFCHR | 0o600)), \
                patch.object(Path, 'resolve', return_value=Path(found['eventPath'])), \
                patch.object(presenter.os, 'close') as closed, \
                patch.object(presenter.fcntl, 'ioctl', side_effect=ioctl) as ioctl_mock:
            self.assertEqual(presenter.open_receiver(configured, found), 42)
        ioctl_mock.assert_any_call(42, presenter.EVIOCGRAB, 1)
        closed.assert_not_called()


class EventTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        self.patches.enter_context(patch.object(presenter, 'emit', side_effect=self.events.append))
        self.current = self.patches.enter_context(patch.object(presenter, 'current_directions', return_value=set()))

    def receiver(self, name='pen-a', fd=42):
        configured = binding(name)
        return presenter.Receiver(configured, metadata(configured), fd)

    def test_two_receivers_have_independent_held_keys(self):
        first, second = self.receiver(), self.receiver('pen-b', 43)
        first.consume(event(109, 1))
        second.consume(event(109, 1))
        first.consume(event(109, 1) + event(109, 2))
        first.release_keys()
        self.assertEqual([(item['bindingId'], item['value']) for item in self.events], [('pen-a', 1), ('pen-b', 1), ('pen-a', 0)])
        self.assertEqual(second.held, {109})

    def test_partial_reads_repeat_and_all_six_navigation_keys(self):
        receiver = self.receiver()
        for code, usage in presenter.DIRECTIONS.items():
            packet = event(code, 1) + event(code, 2) + event(code, 1) + event(code, 0)
            receiver.consume(packet[:5])
            receiver.consume(packet[5:])
            self.assertEqual(self.events[-2:], [{'type': 'key', 'bindingId': 'pen-a', 'usage': usage, 'value': 1},
                                              {'type': 'key', 'bindingId': 'pen-a', 'usage': usage, 'value': 0}])
        self.assertEqual(len(self.events), 12)
        receiver.consume(event(30, 1))
        self.assertEqual(len(self.events), 12)

    def test_button_held_at_connection_requires_release_before_first_action(self):
        self.current.return_value = {109}
        receiver = self.receiver()
        receiver.consume(event(109, 1) + event(109, 2))
        self.assertEqual(self.events, [])
        receiver.consume(event(109, 0) + event(109, 1))
        self.assertEqual([item['value'] for item in self.events], [0, 1])

    def test_dropped_kernel_events_release_keys_and_resync_without_replaying(self):
        receiver = self.receiver()
        receiver.consume(event(109, 1))
        self.current.return_value = {109}
        receiver.consume(event(presenter.SYN_DROPPED, 0, presenter.EV_SYN) + event(104, 1)
                         + event(presenter.SYN_REPORT, 0, presenter.EV_SYN) + event(109, 1))
        self.assertEqual([item['value'] for item in self.events], [1, 0])
        receiver.consume(event(109, 0) + event(109, 1))
        self.assertEqual([item['value'] for item in self.events], [1, 0, 0, 1])


class LifecycleTests(unittest.TestCase):
    def test_device_removed_during_initial_key_snapshot_releases_grab_and_waits(self):
        configured = binding()
        found = metadata(configured)
        signals, emitted = {}, []
        poller = unittest.mock.Mock()

        def stop_on_poll(timeout):
            signals[signal.SIGTERM](signal.SIGTERM, None)
            return []

        poller.select.side_effect = stop_on_poll
        with ExitStack() as mocks:
            mocks.enter_context(patch.object(presenter.selectors, 'DefaultSelector', return_value=poller))
            mocks.enter_context(patch.object(presenter.signal, 'signal', side_effect=lambda signum, callback: signals.update({signum: callback})))
            mocks.enter_context(patch.object(presenter.time, 'monotonic', return_value=0))
            mocks.enter_context(patch.object(presenter, 'enumerate_devices', return_value=[found]))
            mocks.enter_context(patch.object(presenter, 'find_bound_device', return_value=found))
            mocks.enter_context(patch.object(presenter, 'open_receiver', return_value=42))
            mocks.enter_context(patch.object(presenter, 'current_directions', side_effect=OSError(errno.ENODEV, 'removed')))
            mocks.enter_context(patch.object(presenter, 'emit', side_effect=emitted.append))
            closed = mocks.enter_context(patch.object(presenter.os, 'close'))
            ioctl = mocks.enter_context(patch.object(presenter.fcntl, 'ioctl'))
            self.assertEqual(presenter.run_receivers([configured]), 0)
        ioctl.assert_called_once_with(42, presenter.EVIOCGRAB, 0)
        closed.assert_called_once_with(42)
        poller.register.assert_not_called()
        self.assertEqual(emitted, [{'type': 'ready', 'connected': 0, 'bindings': 1}])

    def test_enodev_during_read_disconnects_without_fatal_error(self):
        configured = binding()
        found = metadata(configured)
        signals, emitted = {}, []
        poller = unittest.mock.Mock()

        def stop_after_read(timeout):
            signals[signal.SIGTERM](signal.SIGTERM, None)
            return [(SimpleNamespace(data='pen-a'), 1)]

        poller.select.side_effect = stop_after_read
        with ExitStack() as mocks:
            mocks.enter_context(patch.object(presenter.selectors, 'DefaultSelector', return_value=poller))
            mocks.enter_context(patch.object(presenter.signal, 'signal', side_effect=lambda signum, callback: signals.update({signum: callback})))
            mocks.enter_context(patch.object(presenter.time, 'monotonic', return_value=0))
            mocks.enter_context(patch.object(presenter, 'enumerate_devices', return_value=[found]))
            mocks.enter_context(patch.object(presenter, 'find_bound_device', return_value=found))
            mocks.enter_context(patch.object(presenter, 'open_receiver', return_value=42))
            mocks.enter_context(patch.object(presenter, 'current_directions', return_value=set()))
            mocks.enter_context(patch.object(presenter, 'emit', side_effect=emitted.append))
            mocks.enter_context(patch.object(presenter.os, 'read', side_effect=OSError(errno.ENODEV, 'removed')))
            closed = mocks.enter_context(patch.object(presenter.os, 'close'))
            ioctl = mocks.enter_context(patch.object(presenter.fcntl, 'ioctl'))
            self.assertEqual(presenter.run_receivers([configured]), 0)
        ioctl.assert_called_once_with(42, presenter.EVIOCGRAB, 0)
        closed.assert_called_once_with(42)
        self.assertEqual(emitted[-1], {'type': 'disconnected', 'bindingId': 'pen-a'})
        self.assertFalse(any(item['type'] == 'error' for item in emitted))

    def test_unplug_replug_keeps_other_receiver_active_and_releases_all_grabs_on_stop(self):
        first, second = binding(), binding('pen-b', '/dev/input/by-path/usb-b-event-kbd')
        first_device = metadata(first)
        second_device = metadata(second, '/dev/input/event8', '/sys/devices/usb1/1-2')
        new_device = metadata(first, '/dev/input/event9')
        signals, emitted = {}, []
        poller = unittest.mock.Mock()
        ticks = itertools.count(0, 2)
        passes = iter([[(SimpleNamespace(data='pen-a'), 1), (SimpleNamespace(data='pen-b'), 1)],
                       [(SimpleNamespace(data='pen-b'), 1)], [(SimpleNamespace(data='pen-a'), 1)]])

        def select(timeout):
            try:
                return next(passes)
            except StopIteration:
                signals[signal.SIGTERM](signal.SIGTERM, None)
                return []

        poller.select.side_effect = select
        snapshots = iter([[first_device, second_device], [second_device], [new_device, second_device]])
        latest = []

        def enumerate_next():
            nonlocal latest
            latest = next(snapshots, latest)
            return latest

        def find(configured, devices):
            return next((item for item in devices if item['phys'] == configured['phys']), None)

        with ExitStack() as mocks:
            mocks.enter_context(patch.object(presenter.selectors, 'DefaultSelector', return_value=poller))
            mocks.enter_context(patch.object(presenter.signal, 'signal', side_effect=lambda signum, callback: signals.update({signum: callback})))
            mocks.enter_context(patch.object(presenter.time, 'monotonic', side_effect=lambda: next(ticks)))
            mocks.enter_context(patch.object(presenter, 'enumerate_devices', side_effect=enumerate_next))
            mocks.enter_context(patch.object(presenter, 'find_bound_device', side_effect=find))
            opened = mocks.enter_context(patch.object(presenter, 'open_receiver', side_effect=[10, 20, 11]))
            mocks.enter_context(patch.object(presenter, 'current_directions', return_value=set()))
            mocks.enter_context(patch.object(presenter, 'emit', side_effect=emitted.append))
            mocks.enter_context(patch.object(presenter.os, 'read', side_effect=[event(109, 1), event(104, 1), event(104, 2) + event(104, 0) + event(104, 1), event(109, 1)]))
            closed = mocks.enter_context(patch.object(presenter.os, 'close'))
            ioctl = mocks.enter_context(patch.object(presenter.fcntl, 'ioctl'))
            self.assertEqual(presenter.run_receivers([first, second]), 0)
        self.assertEqual(opened.call_count, 3)
        self.assertEqual([item['bindingId'] for item in emitted if item['type'] == 'connected'], ['pen-a', 'pen-b', 'pen-a'])
        presses = [item['bindingId'] for item in emitted if item['type'] == 'key' and item['value'] == 1]
        self.assertEqual(presses, ['pen-a', 'pen-b', 'pen-b', 'pen-a'])
        self.assertCountEqual(closed.call_args_list, [call(10), call(20), call(11)])
        self.assertCountEqual(ioctl.call_args_list, [call(10, presenter.EVIOCGRAB, 0), call(20, presenter.EVIOCGRAB, 0), call(11, presenter.EVIOCGRAB, 0)])
        poller.close.assert_called_once()

    def test_two_aliases_of_one_physical_receiver_are_rejected_before_grab(self):
        first, second = binding(), binding('pen-b', '/dev/input/by-path/usb-b-event-kbd')
        poller = unittest.mock.Mock()
        with patch.object(presenter.selectors, 'DefaultSelector', return_value=poller), \
                patch.object(presenter.signal, 'signal'), patch.object(presenter, 'enumerate_devices', return_value=[]), \
                patch.object(presenter, 'find_bound_device', side_effect=[metadata(first), metadata(second)]), \
                patch.object(presenter, 'open_receiver') as opened:
            with self.assertRaises(presenter.PresenterError) as raised:
                presenter.run_receivers([first, second])
        self.assertEqual(raised.exception.code, 'ambiguous_device')
        opened.assert_not_called()
        poller.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
