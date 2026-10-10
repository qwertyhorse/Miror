import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mapMoXPoint, MoXDragController, type MoXInteraction } from '../src/exhibition/moxDrag';

describe('MoX contain coordinates', () => {
  it('maps portrait media in a landscape box and rejects pillarboxes', () => {
    const bounds = { left: 20, top: 40, width: 1000, height: 500 };
    expect(mapMoXPoint(520, 290, bounds, 400, 800)).toEqual([200, 400]);
    expect(mapMoXPoint(395, 40, bounds, 400, 800)).toEqual([0, 0]);
    expect(mapMoXPoint(645, 540, bounds, 400, 800)).toEqual([399, 799]);
    expect(mapMoXPoint(394, 290, bounds, 400, 800)).toBeNull();
    expect(mapMoXPoint(646, 290, bounds, 400, 800)).toBeNull();
  });
  it('maps landscape media in a portrait box and rejects letterboxes', () => {
    const bounds = { left: 5, top: 10, width: 200, height: 400 };
    expect(mapMoXPoint(105, 210, bounds, 800, 400)).toEqual([400, 200]);
    expect(mapMoXPoint(5, 160, bounds, 800, 400)).toEqual([0, 0]);
    expect(mapMoXPoint(205, 260, bounds, 800, 400)).toEqual([799, 399]);
    expect(mapMoXPoint(105, 159, bounds, 800, 400)).toBeNull();
    expect(mapMoXPoint(105, 261, bounds, 800, 400)).toBeNull();
  });
  it('rejects invalid geometry and reports actual stream pixels after resize', () => {
    const bounds = { left: 0, top: 0, width: 100, height: 100 };
    expect(mapMoXPoint(25, 75, bounds, 512, 512)).toEqual([128, 384]);
    expect(mapMoXPoint(50, 150, { ...bounds, width: 200, height: 200 }, 512, 512)).toEqual([128, 384]);
    expect(mapMoXPoint(-1, 75, bounds, 512, 512)).toBeNull();
    expect(mapMoXPoint(25, 75, bounds, 0, 512)).toBeNull();
    expect(mapMoXPoint(25, 75, { ...bounds, height: 0 }, 512, 512)).toBeNull();
    expect(mapMoXPoint(NaN, 75, bounds, 512, 512)).toBeNull();
  });
});

describe('MoX single pointer sampling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  function fixture() {
    const interaction: MoXInteraction = { width: 512, height: 512, beginDrag: vi.fn(), endDrag: vi.fn(), sendTracks: vi.fn(async () => {}) };
    const error = vi.fn();
    return { interaction, error, controller: new MoXDragController(interaction, error) };
  }
  it('samples current position every 30 ms, never a historical path', async () => {
    const { controller, interaction } = fixture();
    expect(controller.start(1, [10, 20])).toBe(true);
    expect(interaction.sendTracks).toHaveBeenLastCalledWith([[10, 20]]);
    controller.move(1, [20, 30]); controller.move(1, [30, 40]);
    await vi.advanceTimersByTimeAsync(29);
    expect(interaction.sendTracks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(interaction.sendTracks).toHaveBeenLastCalledWith([[30, 40]]);
    controller.end(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(interaction.sendTracks).toHaveBeenCalledTimes(2);
    expect(interaction.beginDrag).toHaveBeenCalledTimes(1);
    expect(interaction.endDrag).toHaveBeenCalledTimes(1);
  });
  it('rejects a second finger and its move/up without ending the first', async () => {
    const { controller, interaction } = fixture();
    controller.start(1, [10, 20]);
    expect(controller.start(2, [100, 200])).toBe(false);
    expect(controller.move(2, [100, 200])).toBe(false);
    expect(controller.end(2)).toBe(false);
    await vi.advanceTimersByTimeAsync(30);
    expect(interaction.sendTracks).toHaveBeenLastCalledWith([[10, 20]]);
    expect(interaction.endDrag).not.toHaveBeenCalled();
    controller.dispose();
    expect(interaction.endDrag).toHaveBeenCalledTimes(1);
  });
  it('serializes slow sends and drops pending samples after cancellation', async () => {
    const { controller, interaction } = fixture();
    let resolve!: () => void;
    vi.mocked(interaction.sendTracks).mockReturnValueOnce(new Promise<void>(yes => { resolve = yes; }));
    controller.start(1, [10, 20]); controller.move(1, [30, 40]);
    await vi.advanceTimersByTimeAsync(120);
    expect(interaction.sendTracks).toHaveBeenCalledTimes(1);
    controller.end(); resolve();
    await vi.advanceTimersByTimeAsync(120);
    expect(interaction.sendTracks).toHaveBeenCalledTimes(1);
    expect(interaction.endDrag).toHaveBeenCalledTimes(1);
    controller.start(3, [50, 60]);
    expect(interaction.sendTracks).toHaveBeenLastCalledWith([[50, 60]]);
    controller.dispose();
  });
  it('balances cancellation/disposal once and never restarts a disposed interaction', async () => {
    const { controller, interaction } = fixture();
    controller.start(1, [0, 0]); controller.end(); controller.end(1); controller.dispose();
    expect(controller.start(2, [10, 10])).toBe(false);
    await vi.advanceTimersByTimeAsync(120);
    expect(interaction.endDrag).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports send failures and allows the next sampled point', async () => {
    const { controller, interaction, error } = fixture();
    const failure = new Error('tracks unavailable');
    vi.mocked(interaction.sendTracks).mockRejectedValueOnce(failure);
    controller.start(1, [10, 20]);
    await vi.advanceTimersByTimeAsync(30);
    expect(error).toHaveBeenCalledWith(failure);
    expect(interaction.sendTracks).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
  it('does not overlap a new gesture with an unresolved send from the previous one', async () => {
    const { controller, interaction } = fixture();
    let resolve!: () => void;
    vi.mocked(interaction.sendTracks).mockReturnValueOnce(new Promise<void>(yes => { resolve = yes; }));
    controller.start(1, [10, 20]); controller.end(1); controller.start(2, [30, 40]);
    await vi.advanceTimersByTimeAsync(30);
    expect(interaction.sendTracks).toHaveBeenCalledTimes(1);
    resolve();
    await vi.advanceTimersByTimeAsync(30);
    expect(interaction.sendTracks).toHaveBeenLastCalledWith([[30, 40]]);
    controller.dispose();
    expect(interaction.endDrag).toHaveBeenCalledTimes(2);
  });
  it('does not leave timers or begin an active stroke when the SDK rejects its start', async () => {
    const { controller, interaction, error } = fixture();
    const failure = new Error('session closed');
    vi.mocked(interaction.beginDrag).mockImplementationOnce(() => { throw failure; });
    expect(controller.start(1, [10, 20])).toBe(false);
    expect(error).toHaveBeenCalledWith(failure);
    controller.dispose();
    await vi.advanceTimersByTimeAsync(60);
    expect(interaction.sendTracks).not.toHaveBeenCalled();
    expect(interaction.endDrag).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
