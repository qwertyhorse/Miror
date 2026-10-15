import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createLanBroadcaster } from './lan-preview.mjs';

function fixture(platform = 'linux') {
  let time = 1000;
  const spawned = [];
  const broadcaster = createLanBroadcaster({ platform, hostname: 'xuxin.local', port: 10101,
    now: () => time, spawnChild(command, args) {
      const child = new EventEmitter();
      Object.assign(child, { exitCode: null, signalCode: null, killed: false,
        kill(signal) { child.killed = true; child.signalCode = signal; child.emit('exit', null, signal); } });
      spawned.push({ command, args, child });
      return child;
    } });
  return { broadcaster, spawned, advance(ms) { time += ms; } };
}

test('Linux publishes matching address and discoverable service without conflicting with the former Mac', () => {
  const f = fixture();
  f.broadcaster.update(['192.168.1.8']);
  assert.deepEqual(f.spawned.map(({ command, args }) => [command, args]), [
    ['/usr/bin/avahi-publish-address', ['--no-reverse', '--no-fail', 'xuxin.local', '192.168.1.8']],
    ['/usr/bin/avahi-publish-service', ['--no-fail', '--host=xuxin.local', 'Miror-xuxin', '_http._tcp', '10101', 'hostname=xuxin.local']],
  ]);
  f.broadcaster.update(['192.168.1.8']);
  assert.equal(f.spawned.length, 2);
  f.broadcaster.stop();
  assert.ok(f.spawned.every(({ child }) => child.killed));
  f.advance(100000); f.broadcaster.update(['192.168.1.9']);
  assert.equal(f.spawned.length, 2);
});

test('IP change and loss stop both old registrations; old exit cannot kill the new group', () => {
  const f = fixture();
  f.broadcaster.update(['192.168.1.8']);
  const old = [...f.spawned];
  f.broadcaster.update(['192.168.1.9']);
  assert.ok(old.every(({ child }) => child.killed));
  assert.equal(f.spawned[2].args.at(-1), '192.168.1.9');
  old[0].child.emit('error', new Error('late old process error'));
  assert.ok(f.spawned.slice(2).every(({ child }) => !child.killed));
  f.broadcaster.update([]);
  assert.ok(f.spawned.every(({ child }) => child.killed));
  f.broadcaster.update(['192.168.1.10']);
  assert.equal(f.spawned.length, 6);
  f.broadcaster.stop();
});

test('failure of either Linux registration tears down its sibling and retries with backoff', () => {
  const f = fixture();
  f.broadcaster.update(['192.168.1.8']);
  f.spawned[1].child.emit('error', new Error('daemon unavailable'));
  assert.ok(f.spawned.every(({ child }) => child.killed));
  f.broadcaster.update(['192.168.1.8']);
  assert.equal(f.spawned.length, 2);
  f.advance(2000); f.broadcaster.update(['192.168.1.8']);
  assert.equal(f.spawned.length, 4);
  f.spawned[2].child.emit('exit', 1, null);
  assert.ok(f.spawned[3].child.killed);
  f.advance(3999); f.broadcaster.update(['192.168.1.8']);
  assert.equal(f.spawned.length, 4);
  f.advance(1); f.broadcaster.update(['192.168.1.8']);
  assert.equal(f.spawned.length, 6);
  f.broadcaster.stop();
});

test('Mac retains one proxy DNS-SD registration and unsupported platforms stay idle', () => {
  const mac = fixture('darwin'); mac.broadcaster.update(['192.168.1.8']);
  assert.deepEqual(mac.spawned.map(({ command, args }) => [command, args]), [
    ['/usr/bin/dns-sd', ['-P', 'Miror', '_http._tcp', 'local', '10101', 'xuxin.local', '192.168.1.8']],
  ]);
  mac.broadcaster.stop();
  const other = fixture('win32'); other.broadcaster.update(['192.168.1.8']);
  assert.equal(other.spawned.length, 0);
});
