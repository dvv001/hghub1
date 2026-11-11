/* 网页版窗口垫片 —— 替代 @tauri-apps/api/window（由 vite.web.config.ts 别名注入）。
 * 仅 DesktopChrome / ResizeHandles 在桌面端使用；网页版没有原生窗口，
 * 全部方法做无害空实现（组件本身在移动端不会渲染，桌面浏览器渲染时也不应报错）。
 */

type Unlisten = () => void;

const noopAsync = async (): Promise<void> => {};
const unlisten = async (): Promise<Unlisten> => () => {};

export class Window {
  label = "main";
  close = noopAsync;
  minimize = noopAsync;
  maximize = noopAsync;
  unmaximize = noopAsync;
  toggleMaximize = noopAsync;
  show = noopAsync;
  hide = noopAsync;
  setFocus = noopAsync;
  startDragging = noopAsync;
  setFullscreen = noopAsync;
  setResizable = noopAsync;
  center = noopAsync;
  requestUserAttention = noopAsync;
  isMaximized = async (): Promise<boolean> => false;
  isMinimized = async (): Promise<boolean> => false;
  isFullscreen = async (): Promise<boolean> => !!document.fullscreenElement;
  isVisible = async (): Promise<boolean> => true;
  isFocused = async (): Promise<boolean> => document.hasFocus();
  scaleFactor = async (): Promise<number> => window.devicePixelRatio || 1;
  outerPosition = async () => ({ x: 0, y: 0 });
  outerSize = async () => ({ width: window.innerWidth, height: window.innerHeight });
  innerPosition = async () => ({ x: 0, y: 0 });
  innerSize = async () => ({ width: window.innerWidth, height: window.innerHeight });
  onResized = unlisten;
  onMoved = unlisten;
  onFocusChanged = unlisten;
  onCloseRequested = unlisten;
  onScaleChanged = unlisten;
  once = unlisten;
  listen = unlisten;
  emit = noopAsync;
}

const current = new Window();

export function getCurrentWindow(): Window {
  return current;
}

export async function getAllWindows(): Promise<Window[]> {
  return [current];
}
