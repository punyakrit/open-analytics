// Generates the favicons and the apple-touch-icon into public/.
// Run with: node scripts/make-icons.mjs
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#15171c"/><path d="M24.69 13.67A9 9 0 1 1 18.33 7.31" fill="none" stroke="#ffffff" stroke-width="3.2" stroke-linecap="round"/><circle cx="22.6" cy="9.4" r="2.6" fill="#8b9cff"/></svg>`;
// iOS rounds corners itself, so the touch icon is a full square.
const square = mark.replace('rx="8"', 'rx="0"');

writeFileSync('public/favicon.svg', mark + '\n');
await sharp(Buffer.from(mark), { density: 300 }).resize(32, 32).png().toFile('public/favicon-32x32.png');
await sharp(Buffer.from(mark), { density: 300 }).resize(48, 48).png().toFile('public/favicon-48x48.png');

// favicon.ico: browsers and crawlers request it directly. Holds PNG frames at 16, 32 and 48px.
const frames = await Promise.all([16, 32, 48].map((n) => sharp(Buffer.from(mark), { density: 300 }).resize(n, n).png().toBuffer()));
const header = Buffer.alloc(6 + 16 * frames.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
frames.forEach((png, i) => {
  const n = [16, 32, 48][i];
  const e = 6 + 16 * i;
  header.writeUInt8(n, e);
  header.writeUInt8(n, e + 1);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(png.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
writeFileSync('public/favicon.ico', Buffer.concat([header, ...frames]));

await sharp(Buffer.from(square), { density: 600 }).resize(180, 180).png().toFile('public/apple-touch-icon.png');
await sharp(Buffer.from(square), { density: 600 }).resize(192, 192).png().toFile('public/icon-192.png');
await sharp(Buffer.from(square), { density: 1200 }).resize(512, 512).png().toFile('public/icon-512.png');

console.log('done');
