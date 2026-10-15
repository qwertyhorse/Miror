import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createNativeGestureRuntime } from '../src/exhibition/nativeGestureRuntime';
import { runNativeGestureContract } from './fixtures/nativeGestureContract.js';
import { androidGestureBundlePath, buildAndroidGestureBundle } from '../scripts/build-android-gesture.mjs';

describe('offline Android runtime reuses the V1.1 gesture detector', () => {
  it('keeps the packaged bundle byte-for-byte current with the TypeScript source', async () => {
    expect(await readFile(androidGestureBundlePath, 'utf8')).toBe(await buildAndroidGestureBundle());
  });

  it('passes the same full state-machine contract without modern Array.at, DOM, WASM or network', async () => {
    const context = vm.createContext({});
    vm.runInContext('self = this; globalThis = undefined; WebAssembly = undefined; Array.prototype.at = undefined', context);
    vm.runInContext(await readFile(androidGestureBundlePath, 'utf8'), context);
    expect(runNativeGestureContract(context.NativeGestureBundle.createNativeGestureRuntime))
      .toEqual(runNativeGestureContract(createNativeGestureRuntime));
    expect(context.fetch).toBeUndefined();
    expect(context.document).toBeUndefined();
  });
});
