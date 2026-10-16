import { access, lstat } from 'node:fs/promises';
import path from 'node:path';

export async function browserExecutable(): Promise<string | undefined> {
  const candidates = [process.env.DESIGN_BROWSER,
    ...(process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium'] : []),
    ...(process.platform === 'win32' ? [process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES,'Google/Chrome/Application/chrome.exe'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA,'Google/Chrome/Application/chrome.exe')] : []),
    ...((process.env.PATH ?? '').split(path.delimiter).flatMap(directory => ['chromium','chromium-browser','google-chrome','microsoft-edge'].map(name => path.join(directory,name))))];
  for (const candidate of candidates) if (candidate) { try { if ((await lstat(candidate)).isFile()) { await access(candidate); return candidate; } } catch {} }
  return undefined;
}
