import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Browser regression configuration; no browser or server starts on import. */
export function browserOptions() {
  const candidates = process.env.CHROME_PATH
    ? [process.env.CHROME_PATH]
    : process.platform === 'win32'
      ? [
          `${process.env.PROGRAMFILES}/Google/Chrome/Application/chrome.exe`,
          `${process.env['PROGRAMFILES(X86)']}/Microsoft/Edge/Application/msedge.exe`,
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const executablePath = candidates.find((candidate) => existsSync(candidate));
  if (!executablePath) {
    throw new Error('Browser not found. Set CHROME_PATH to a Chrome/Edge executable.');
  }
  return { executablePath: resolve(executablePath), headless: true };
}

export function browserUrl(query = '') {
  return new URL(query, process.env.TEST_URL || 'http://127.0.0.1:4173/').href;
}
