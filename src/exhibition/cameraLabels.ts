interface CameraLabelInput { deviceId: string; label: string }

/** Matching cameras keep their numbers across pages, regardless of enumeration order. */
export function cameraLabels(cameras: readonly CameraLabelInput[]): string[] {
  const names = cameras.map((camera, index) => camera.label.trim() || `摄像头 ${index + 1}`);
  const groups = new Map<string, string[]>();
  cameras.forEach((camera, index) => {
    const group = groups.get(names[index]) ?? [];
    if (!group.includes(camera.deviceId)) group.push(camera.deviceId);
    groups.set(names[index], group);
  });
  groups.forEach(group => group.sort());
  return cameras.map((camera, index) => {
    const name = names[index];
    const group = groups.get(name)!;
    return group.length > 1 ? `${name} · ${group.indexOf(camera.deviceId) + 1}` : name;
  });
}
