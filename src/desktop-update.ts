export function hasDesktopUpdateBridge(bridge: unknown): bridge is NonNullable<Window['aiframeDesktop']> {
  if (!bridge || typeof bridge !== 'object') return false;
  const candidate = bridge as Record<string, unknown>;
  return typeof candidate.checkForUpdate === 'function' && typeof candidate.installUpdate === 'function';
}
