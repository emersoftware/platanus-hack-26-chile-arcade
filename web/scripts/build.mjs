// Copies the game into the site so the repo keeps one source of truth:
//   ../game.js   -> public/game.js
//   ../cover.png -> public/cover.png       (social preview image)
//   FONT in game.js -> public/fonts/v.woff2 (the game's pixel typeface, for the landing)
// It only writes those three files. It never cleans public/: other files there (public/img/)
// are not generated.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const repo = new URL('../../', import.meta.url);
const pub = new URL('../public/', import.meta.url);

await mkdir(new URL('fonts/', pub), { recursive: true });

const game = await readFile(new URL('game.js', repo), 'utf8');
await writeFile(new URL('game.js', pub), game);
await copyFile(new URL('cover.png', repo), new URL('cover.png', pub));

// game.js carries VT323 (cut down to the characters the game uses) as base64 with `_` for `/`.
const m = game.match(/\bFONT\s*=\s*'([A-Za-z0-9+_=]+)'/);
const font = m && Buffer.from(m[1].replace(/_/g, '/'), 'base64');
if (font && font.subarray(0, 4).toString('latin1') === 'wOF2') {
  await writeFile(new URL('fonts/v.woff2', pub), font);
  console.log(`build: game.js, cover.png, fonts/v.woff2 (${font.length} bytes)`);
} else {
  // The landing still works without it: its font stacks fall back to the system faces.
  console.warn('build: WARNING: no WOFF2 FONT found in game.js; fonts/v.woff2 not updated');
}
