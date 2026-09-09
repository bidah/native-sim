const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const dim = c('2');
export const bold = c('1');
export const red = c('31');
export const green = c('32');
export const yellow = c('33');
export const cyan = c('36');

export const info = (msg) => console.log(`${cyan('›')} ${msg}`);
export const ok = (msg) => console.log(`${green('✓')} ${msg}`);
export const warn = (msg) => console.log(`${yellow('!')} ${msg}`);
export const step = (msg) => console.log(`\n${bold(msg)}`);

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Minimal spinner that degrades to plain lines when not a TTY. */
export function spinner(text) {
  let i = 0;
  let label = text;
  let timer = null;
  if (tty) {
    timer = setInterval(() => {
      process.stdout.write(`\r${cyan(FRAMES[i++ % FRAMES.length])} ${label}\x1b[K`);
    }, 80);
  } else {
    console.log(`… ${label}`);
  }
  return {
    update(next) {
      if (next === label) return;
      label = next;
      if (!tty) console.log(`… ${label}`);
    },
    stop(finalLine) {
      if (timer) {
        clearInterval(timer);
        process.stdout.write('\r\x1b[K');
      }
      if (finalLine) console.log(finalLine);
    },
  };
}
