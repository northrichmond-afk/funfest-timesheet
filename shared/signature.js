// Signature pad on a canvas (finger, stylus or mouse)
export function signaturePad(canvas) {
  const ctx2 = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  const size = () => { const r = canvas.getBoundingClientRect(); canvas.width = r.width * ratio; canvas.height = r.height * ratio; ctx2.scale(ratio, ratio); ctx2.lineWidth = 2.2; ctx2.lineCap = 'round'; ctx2.lineJoin = 'round'; ctx2.strokeStyle = '#1b1b1b'; };
  size();
  let drawing = false, empty = true, last = null;
  const pos = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', e => { drawing = true; last = pos(e); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!drawing) return;
    const p = pos(e);
    ctx2.beginPath(); ctx2.moveTo(...last); ctx2.lineTo(...p); ctx2.stroke();
    last = p; empty = false;
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop); canvas.addEventListener('pointercancel', stop);
  return {
    isEmpty: () => empty,
    clear: () => { ctx2.clearRect(0, 0, canvas.width, canvas.height); empty = true; },
    toDataURL: () => {
      // white background so the PDF shows it cleanly
      const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(canvas, 0, 0);
      return c.toDataURL('image/png');
    },
  };
}
