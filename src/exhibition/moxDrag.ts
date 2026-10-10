export type MoXPoint = [number, number];

export interface MoXInteraction {
  width: number;
  height: number;
  beginDrag(): void;
  endDrag(): void;
  sendTracks(points: MoXPoint[]): Promise<void>;
}

export interface MoXBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Map a contain-fitted image to the SDK's stream pixels; black bars are not input. */
export function mapMoXPoint(clientX: number, clientY: number, bounds: MoXBounds, width: number, height: number): MoXPoint | null {
  if (![clientX, clientY, bounds.left, bounds.top, bounds.width, bounds.height, width, height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0 || width < 1 || height < 1) return null;
  const scale = Math.min(bounds.width / width, bounds.height / height);
  const left = bounds.left + (bounds.width - width * scale) / 2;
  const top = bounds.top + (bounds.height - height * scale) / 2;
  const x = (clientX - left) / scale;
  const y = (clientY - top) / scale;
  if (x < 0 || x > width || y < 0 || y > height) return null;
  return [Math.min(Math.round(x), Math.floor(width) - 1), Math.min(Math.round(y), Math.floor(height) - 1)];
}

/** Match the SDK's 30 ms active-touch sampling, without overlapping sends. */
export class MoXDragController {
  private pointer: number | null = null;
  private point: MoXPoint | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sending = false;
  private disposed = false;

  constructor(private interaction: MoXInteraction, private onError: (error: unknown) => void = () => {}) {}

  start(pointerId: number, point: MoXPoint): boolean {
    if (this.disposed || this.pointer !== null) return false;
    try { this.interaction.beginDrag(); }
    catch (error) { this.onError(error); return false; }
    this.pointer = pointerId;
    this.point = [...point];
    this.flush();
    this.timer = setInterval(() => this.flush(), 30);
    return true;
  }

  move(pointerId: number, point: MoXPoint): boolean {
    if (this.pointer !== pointerId) return false;
    this.point = [...point];
    return true;
  }

  end(pointerId?: number): boolean {
    if (this.pointer === null || (pointerId !== undefined && this.pointer !== pointerId)) return false;
    this.pointer = null;
    this.point = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    try { this.interaction.endDrag(); }
    catch (error) { this.onError(error); }
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.end();
  }

  private flush(): void {
    if (this.sending || this.pointer === null || !this.point || this.disposed) return;
    this.sending = true;
    try {
      Promise.resolve(this.interaction.sendTracks([[...this.point]])).catch(error => {
        if (!this.disposed) this.onError(error);
      }).finally(() => { this.sending = false; });
    } catch (error) {
      this.sending = false;
      this.onError(error);
    }
  }
}
