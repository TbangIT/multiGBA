// Salvataggi (.sav) in rete: compressione PackBits + conversione dal formato sul filo.
// Dipende da SRAM_SIZE, base64ToUint8 (app.js) solo a runtime.
// PackBits: c<128 -> c+1 byte letterali; c>=128 -> il byte seguente ripetuto (c-128)+3 volte. Un .sav da 128 KB
// e' quasi tutto 0xFF: scende a pochi KB. Caso peggiore +0,8%.
function sramPack(u8) {
  const out = []; const n = u8.length; let i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && u8[j] === u8[i] && j - i < 130) j++;
    if (j - i >= 3) { out.push(128 + (j - i - 3), u8[i]); i = j; continue; }
    let k = i; const lim = Math.min(n, i + 128);
    while (k < lim && !(k + 2 < n && u8[k] === u8[k + 1] && u8[k] === u8[k + 2])) k++;
    if (k === i) k = i + 1;
    out.push(k - i - 1); for (let q = i; q < k; q++) out.push(u8[q]);
    i = k;
  }
  return new Uint8Array(out);
}
function sramUnpack(packed) {
  const src = new Uint8Array(packed); const out = new Uint8Array(SRAM_SIZE); let o = 0;
  for (let i = 0; i < src.length && o < SRAM_SIZE;) {
    const c = src[i++];
    if (c < 128) { for (let q = 0; q <= c && o < SRAM_SIZE; q++) out[o++] = src[i++]; }
    else { const v = src[i++]; for (let q = 0; q < c - 125 && o < SRAM_SIZE; q++) out[o++] = v; }
  }
  return o === SRAM_SIZE ? out : null;
}
const sramFromWire = (x) => (typeof x === "string" ? base64ToUint8(x) : sramUnpack(x));
