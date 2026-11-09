// Copies the staff app into www/ for the iPhone build (Capacitor).
// The web version on GitHub Pages is unchanged; this just packages the same files.
import { cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';

rmSync('www', { recursive: true, force: true });
mkdirSync('www');
cpSync('app', 'www/app', { recursive: true });
cpSync('shared', 'www/shared', { recursive: true });
rmSync('www/app/sw.js'); // no service worker inside the native app
writeFileSync('www/index.html',
  '<!doctype html><meta charset="utf-8"><script>location.replace("app/index.html")</script>');
console.log('www/ ready');
