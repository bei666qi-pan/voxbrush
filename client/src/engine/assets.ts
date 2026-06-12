/**
 * Parametric flat-illustration sprite library.
 * Each sprite draws with Canvas2D using palette slots for voice-editable colors.
 * No runtime network — all local vector code.
 */

export interface SpriteDef {
  label: string;
  defaultPalette: string[];
  defaultW: number;
  defaultH: number;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) => void;
}

function p(palette: string[], i: number, fallback: string): string {
  return palette[i] ?? fallback;
}

function linGrad(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, stops: [number, string][]): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  stops.forEach(([o, c]) => g.addColorStop(o, c));
  return g;
}

function radGrad(ctx: CanvasRenderingContext2D, x: number, y: number, r0: number, r1: number, stops: [number, string][]): CanvasGradient {
  const g = ctx.createRadialGradient(x, y, r0, x, y, r1);
  stops.forEach(([o, c]) => g.addColorStop(o, c));
  return g;
}

function drawHouse(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const wall = p(palette, 0, '#f5deb3');
  const roof = p(palette, 1, '#c0392b');
  const door = p(palette, 2, '#8d6e63');
  const trim = p(palette, 3, '#ecf0f1');
  const chimney = p(palette, 4, '#95a5a6');
  const hw = w * 0.42, hh = h * 0.38;
  // wall
  ctx.fillStyle = linGrad(ctx, -hw, hh * 0.2, -hw, hh, [[0, wall], [1, shade(wall, -0.15)]]);
  roundRect(ctx, -hw, -hh * 0.1, hw * 2, hh * 1.1, 4);
  ctx.fill();
  // roof
  ctx.fillStyle = roof;
  ctx.beginPath();
  ctx.moveTo(-hw * 1.15, -hh * 0.1);
  ctx.lineTo(0, -h * 0.48);
  ctx.lineTo(hw * 1.15, -hh * 0.1);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = shade(roof, -0.2);
  ctx.lineWidth = 2;
  ctx.stroke();
  // chimney
  ctx.fillStyle = chimney;
  ctx.fillRect(hw * 0.55, -h * 0.42, w * 0.1, h * 0.18);
  // door
  ctx.fillStyle = door;
  roundRect(ctx, -w * 0.08, hh * 0.35, w * 0.16, hh * 0.55, 3);
  ctx.fill();
  ctx.fillStyle = trim;
  ctx.beginPath();
  ctx.arc(-w * 0.08 + w * 0.12, hh * 0.55, 3, 0, Math.PI * 2);
  ctx.fill();
  // windows
  ctx.fillStyle = linGrad(ctx, 0, 0, 0, 20, [[0, '#87ceeb'], [1, '#5dade2']]);
  [-0.28, 0.28].forEach(fx => {
    roundRect(ctx, w * fx - w * 0.1, hh * 0.05, w * 0.2, hh * 0.28, 2);
    ctx.fill();
    ctx.strokeStyle = trim;
    ctx.lineWidth = 2;
    ctx.strokeRect(w * fx - w * 0.1, hh * 0.05, w * 0.2, hh * 0.28);
  });
}

function drawTree(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const trunk = p(palette, 0, '#8d6e63');
  const leaf = p(palette, 1, '#27ae60');
  const leafHi = p(palette, 2, '#2ecc71');
  const tw = w * 0.14;
  ctx.fillStyle = linGrad(ctx, -tw, h * 0.1, tw, h * 0.45, [[0, trunk], [1, shade(trunk, -0.2)]]);
  roundRect(ctx, -tw / 2, h * 0.08, tw, h * 0.38, 3);
  ctx.fill();
  const r = w * 0.38;
  ctx.fillStyle = radGrad(ctx, 0, -h * 0.08, 0, r, [[0, leafHi], [0.7, leaf], [1, shade(leaf, -0.15)]]);
  ctx.beginPath();
  ctx.arc(0, -h * 0.08, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = leafHi;
  ctx.beginPath();
  ctx.arc(-r * 0.35, -h * 0.15, r * 0.35, 0, Math.PI * 2);
  ctx.arc(r * 0.3, -h * 0.12, r * 0.3, 0, Math.PI * 2);
  ctx.fill();
}

function drawPine(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const trunk = p(palette, 0, '#6d4c41');
  const leaf = p(palette, 1, '#1e8449');
  const leafHi = p(palette, 2, '#27ae60');
  ctx.fillStyle = trunk;
  roundRect(ctx, -w * 0.06, h * 0.2, w * 0.12, h * 0.32, 2);
  ctx.fill();
  const layers = [[0.45, leafHi], [0.32, leaf], [0.2, shade(leaf, -0.1)]];
  layers.forEach(([ratio, col], i) => {
    const y = -h * 0.35 + i * h * 0.18;
    const hw = w * (ratio as number);
    ctx.fillStyle = col as string;
    ctx.beginPath();
    ctx.moveTo(0, y - h * 0.12);
    ctx.lineTo(-hw, y + h * 0.1);
    ctx.lineTo(hw, y + h * 0.1);
    ctx.closePath();
    ctx.fill();
  });
}

function drawMountain(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const base = p(palette, 0, '#7f8c8d');
  const peak = p(palette, 1, '#bdc3c7');
  const snow = p(palette, 2, '#ecf0f1');
  ctx.fillStyle = linGrad(ctx, 0, -h * 0.4, 0, h * 0.35, [[0, peak], [0.5, base], [1, shade(base, -0.2)]]);
  ctx.beginPath();
  ctx.moveTo(-w * 0.5, h * 0.35);
  ctx.lineTo(-w * 0.05, -h * 0.42);
  ctx.lineTo(w * 0.35, h * 0.35);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = linGrad(ctx, 0, -h * 0.2, 0, h * 0.35, [[0, shade(base, 0.1)], [1, shade(base, -0.25)]]);
  ctx.beginPath();
  ctx.moveTo(-w * 0.15, h * 0.35);
  ctx.lineTo(w * 0.12, -h * 0.28);
  ctx.lineTo(w * 0.5, h * 0.35);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = snow;
  ctx.beginPath();
  ctx.moveTo(-w * 0.05, -h * 0.42);
  ctx.lineTo(w * 0.02, -h * 0.22);
  ctx.lineTo(-w * 0.12, -h * 0.28);
  ctx.closePath();
  ctx.fill();
}

function drawCloud(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const c = p(palette, 0, '#ecf0f1');
  const hi = p(palette, 1, '#ffffff');
  const sh = p(palette, 2, '#bdc3c7');
  ctx.fillStyle = sh;
  blob(ctx, 0, h * 0.05, w * 0.38, h * 0.22);
  ctx.fill();
  ctx.fillStyle = linGrad(ctx, 0, -h * 0.15, 0, h * 0.15, [[0, hi], [1, c]]);
  blob(ctx, -w * 0.12, 0, w * 0.32, h * 0.24);
  ctx.fill();
  blob(ctx, w * 0.15, -h * 0.02, w * 0.28, h * 0.2);
  ctx.fill();
  blob(ctx, -w * 0.28, h * 0.02, w * 0.24, h * 0.18);
  ctx.fill();
}

function drawSun(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const core = p(palette, 0, '#f1c40f');
  const glow = p(palette, 1, '#fdeaa7');
  const ray = p(palette, 2, '#f39c12');
  const r = w * 0.22;
  ctx.fillStyle = radGrad(ctx, 0, 0, r * 0.5, r * 2.2, [[0, glow], [0.4, glow + '88'], [1, 'transparent']]);
  ctx.beginPath();
  ctx.arc(0, 0, r * 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = ray;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI * 2 * i) / 8;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r * 1.3, Math.sin(a) * r * 1.3);
    ctx.lineTo(Math.cos(a) * r * 1.85, Math.sin(a) * r * 1.85);
    ctx.stroke();
  }
  ctx.fillStyle = radGrad(ctx, -r * 0.2, -r * 0.2, 0, r, [[0, '#fff9c4'], [0.5, core], [1, shade(core, -0.15)]]);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawMoon(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const c = p(palette, 0, '#f9e79f');
  const sh = p(palette, 1, '#f4d03f');
  const r = w * 0.28;
  ctx.fillStyle = radGrad(ctx, -r * 0.15, -r * 0.15, 0, r, [[0, '#fef9e7'], [0.6, c], [1, sh]]);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(r * 0.35, -r * 0.15, r * 0.82, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#ffffff22';
  ctx.beginPath();
  ctx.arc(-r * 0.25, -r * 0.2, r * 0.12, 0, Math.PI * 2);
  ctx.fill();
}

function drawFlower(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const petal = p(palette, 0, '#e74c3c');
  const center = p(palette, 1, '#f1c40f');
  const stem = p(palette, 2, '#27ae60');
  const leaf = p(palette, 3, '#2ecc71');
  ctx.strokeStyle = stem;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, h * 0.15);
  ctx.quadraticCurveTo(w * 0.08, h * 0.35, 0, h * 0.45);
  ctx.stroke();
  ctx.fillStyle = leaf;
  ctx.beginPath();
  ctx.ellipse(w * 0.1, h * 0.32, w * 0.12, h * 0.06, 0.5, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 * i) / 6 - Math.PI / 2;
    ctx.fillStyle = linGrad(ctx, 0, -h * 0.05, 0, h * 0.05, [[0, shade(petal, 0.15)], [1, petal]]);
    ctx.beginPath();
    ctx.ellipse(Math.cos(a) * w * 0.14, Math.sin(a) * h * 0.1 - h * 0.05, w * 0.1, h * 0.08, a, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = radGrad(ctx, 0, -h * 0.05, 0, w * 0.08, [[0, '#fff176'], [1, center]]);
  ctx.beginPath();
  ctx.arc(0, -h * 0.05, w * 0.08, 0, Math.PI * 2);
  ctx.fill();
}

function drawGrass(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const g1 = p(palette, 0, '#27ae60');
  const g2 = p(palette, 1, '#2ecc71');
  const g3 = p(palette, 2, '#1e8449');
  const blades = 7;
  for (let i = 0; i < blades; i++) {
    const x = (i / (blades - 1) - 0.5) * w * 0.9;
    const col = [g1, g2, g3][i % 3];
    ctx.strokeStyle = col;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, h * 0.35);
    ctx.quadraticCurveTo(x + w * 0.04 * (i % 2 ? 1 : -1), h * 0.05, x + w * 0.02, -h * 0.35);
    ctx.stroke();
  }
  ctx.fillStyle = linGrad(ctx, 0, h * 0.3, 0, h * 0.4, [[0, g3], [1, shade(g3, -0.1)]]);
  ctx.fillRect(-w * 0.48, h * 0.32, w * 0.96, h * 0.08);
}

function drawPerson(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const skin = p(palette, 0, '#ffcc80');
  const shirt = p(palette, 1, '#3498db');
  const pants = p(palette, 2, '#2c3e50');
  const hair = p(palette, 3, '#5d4037');
  // head
  ctx.fillStyle = radGrad(ctx, -w * 0.04, -h * 0.32, 0, w * 0.14, [[0, shade(skin, 0.1)], [1, skin]]);
  ctx.beginPath();
  ctx.arc(0, -h * 0.28, w * 0.14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = hair;
  ctx.beginPath();
  ctx.arc(0, -h * 0.34, w * 0.14, Math.PI, Math.PI * 2);
  ctx.fill();
  // body
  ctx.fillStyle = linGrad(ctx, 0, -h * 0.1, 0, h * 0.15, [[0, shirt], [1, shade(shirt, -0.15)]]);
  roundRect(ctx, -w * 0.12, -h * 0.12, w * 0.24, h * 0.22, 4);
  ctx.fill();
  // legs
  ctx.fillStyle = pants;
  [-0.06, 0.06].forEach(fx => {
    roundRect(ctx, w * fx - w * 0.05, h * 0.08, w * 0.1, h * 0.28, 2);
    ctx.fill();
  });
  // arms
  ctx.strokeStyle = shirt;
  ctx.lineWidth = w * 0.07;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-w * 0.12, -h * 0.02);
  ctx.quadraticCurveTo(-w * 0.28, h * 0.05, -w * 0.22, h * 0.15);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w * 0.12, -h * 0.02);
  ctx.quadraticCurveTo(w * 0.28, h * 0.05, w * 0.22, h * 0.15);
  ctx.stroke();
}

function drawBird(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const body = p(palette, 0, '#3498db');
  const wing = p(palette, 1, '#2980b9');
  const beak = p(palette, 2, '#f39c12');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(0, 0, w * 0.22, h * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = wing;
  ctx.beginPath();
  ctx.moveTo(-w * 0.05, -h * 0.02);
  ctx.quadraticCurveTo(-w * 0.35, -h * 0.35, -w * 0.15, -h * 0.08);
  ctx.quadraticCurveTo(-w * 0.05, -h * 0.12, -w * 0.05, -h * 0.02);
  ctx.fill();
  ctx.fillStyle = beak;
  ctx.beginPath();
  ctx.moveTo(w * 0.2, 0);
  ctx.lineTo(w * 0.32, -h * 0.04);
  ctx.lineTo(w * 0.32, h * 0.04);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#2c3e50';
  ctx.beginPath();
  ctx.arc(w * 0.12, -h * 0.03, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawFish(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const body = p(palette, 0, '#e67e22');
  const fin = p(palette, 1, '#d35400');
  const stripe = p(palette, 2, '#f39c12');
  ctx.fillStyle = linGrad(ctx, -w * 0.2, 0, w * 0.2, 0, [[0, fin], [0.3, body], [1, shade(body, -0.1)]]);
  ctx.beginPath();
  ctx.ellipse(0, 0, w * 0.32, h * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = fin;
  ctx.beginPath();
  ctx.moveTo(-w * 0.3, 0);
  ctx.lineTo(-w * 0.48, -h * 0.18);
  ctx.lineTo(-w * 0.48, h * 0.18);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = stripe;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-w * 0.05, -h * 0.12);
  ctx.quadraticCurveTo(w * 0.1, 0, -w * 0.05, h * 0.12);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(w * 0.15, -h * 0.04, w * 0.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2c3e50';
  ctx.beginPath();
  ctx.arc(w * 0.17, -h * 0.04, 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawBoat(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const hull = p(palette, 0, '#8d6e63');
  const sail = p(palette, 1, '#ecf0f1');
  const mast = p(palette, 2, '#5d4037');
  const flag = p(palette, 3, '#e74c3c');
  ctx.fillStyle = linGrad(ctx, 0, h * 0.05, 0, h * 0.3, [[0, shade(hull, 0.1)], [1, hull]]);
  ctx.beginPath();
  ctx.moveTo(-w * 0.4, h * 0.15);
  ctx.quadraticCurveTo(0, h * 0.35, w * 0.4, h * 0.15);
  ctx.lineTo(w * 0.32, h * 0.05);
  ctx.lineTo(-w * 0.32, h * 0.05);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = mast;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.05);
  ctx.lineTo(0, -h * 0.38);
  ctx.stroke();
  ctx.fillStyle = sail;
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.35);
  ctx.lineTo(w * 0.28, h * 0.02);
  ctx.lineTo(0, h * 0.02);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = flag;
  ctx.beginPath();
  ctx.moveTo(0, -h * 0.38);
  ctx.lineTo(w * 0.12, -h * 0.32);
  ctx.lineTo(0, -h * 0.26);
  ctx.closePath();
  ctx.fill();
}

function drawCar(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const body = p(palette, 0, '#e74c3c');
  const window = p(palette, 1, '#85c1e9');
  const wheel = p(palette, 2, '#2c3e50');
  const trim = p(palette, 3, '#bdc3c7');
  ctx.fillStyle = linGrad(ctx, 0, -h * 0.1, 0, h * 0.2, [[0, shade(body, 0.15)], [1, body]]);
  roundRect(ctx, -w * 0.42, -h * 0.05, w * 0.84, h * 0.22, 6);
  ctx.fill();
  ctx.fillStyle = linGrad(ctx, 0, -h * 0.2, 0, 0, [[0, shade(body, 0.2)], [1, body]]);
  roundRect(ctx, -w * 0.22, -h * 0.22, w * 0.44, h * 0.18, 4);
  ctx.fill();
  ctx.fillStyle = window;
  roundRect(ctx, -w * 0.18, -h * 0.19, w * 0.16, h * 0.12, 2);
  ctx.fill();
  roundRect(ctx, w * 0.02, -h * 0.19, w * 0.16, h * 0.12, 2);
  ctx.fill();
  ctx.strokeStyle = trim;
  ctx.lineWidth = 2;
  ctx.strokeRect(-w * 0.42, -h * 0.05, w * 0.84, h * 0.22);
  [-0.22, 0.22].forEach(fx => {
    ctx.fillStyle = wheel;
    ctx.beginPath();
    ctx.arc(w * fx, h * 0.18, w * 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = trim;
    ctx.beginPath();
    ctx.arc(w * fx, h * 0.18, w * 0.04, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawRainbow(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const colors = palette.length >= 6 ? palette.slice(0, 6) : ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6'];
  const bands = colors.length;
  const maxR = w * 0.45;
  for (let i = 0; i < bands; i++) {
    ctx.strokeStyle = colors[i];
    ctx.lineWidth = h * 0.12;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(0, h * 0.35, maxR - i * (h * 0.1), Math.PI, 0);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, h * 0.35, maxR + h * 0.05, Math.PI, 0);
  ctx.lineTo(w * 0.5, h * 0.35);
  ctx.lineTo(-w * 0.5, h * 0.35);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawSnowman(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const snow = p(palette, 0, '#ecf0f1');
  const shadow = p(palette, 1, '#bdc3c7');
  const nose = p(palette, 2, '#e67e22');
  const hat = p(palette, 3, '#2c3e50');
  const scarf = p(palette, 4, '#e74c3c');
  const radii = [w * 0.22, w * 0.16, w * 0.12];
  const ys = [h * 0.18, -h * 0.06, -h * 0.28];
  radii.forEach((r, i) => {
    ctx.fillStyle = radGrad(ctx, -r * 0.2, ys[i] - r * 0.2, 0, r, [[0, '#ffffff'], [0.6, snow], [1, shadow]]);
    ctx.beginPath();
    ctx.arc(0, ys[i], r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = hat;
  ctx.fillRect(-w * 0.12, -h * 0.42, w * 0.24, h * 0.06);
  ctx.fillRect(-w * 0.08, -h * 0.48, w * 0.16, h * 0.08);
  ctx.fillStyle = nose;
  ctx.beginPath();
  ctx.moveTo(w * 0.1, -h * 0.28);
  ctx.lineTo(w * 0.22, -h * 0.26);
  ctx.lineTo(w * 0.1, -h * 0.24);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = scarf;
  ctx.fillRect(-w * 0.14, -h * 0.04, w * 0.28, h * 0.05);
  ctx.fillStyle = '#2c3e50';
  [[-0.04, -0.02], [0.04, -0.02], [0, 0.02]].forEach(([fx, fy]) => {
    ctx.beginPath();
    ctx.arc(w * fx, -h * 0.28 + h * fy, 2, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawBalloon(ctx: CanvasRenderingContext2D, w: number, h: number, palette: string[]) {
  const ball = p(palette, 0, '#e74c3c');
  const ball2 = p(palette, 1, '#3498db');
  const string = p(palette, 2, '#95a5a6');
  const pairs: [number, string][] = [[-0.15, ball], [0.15, ball2]];
  pairs.forEach(([fx, col]) => {
    ctx.fillStyle = radGrad(ctx, w * fx - w * 0.04, -h * 0.15, 0, w * 0.14, [[0, shade(col, 0.25)], [0.5, col], [1, shade(col, -0.2)]]);
    ctx.beginPath();
    ctx.ellipse(w * fx, -h * 0.12, w * 0.12, h * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = string;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(w * fx, h * 0.05);
    ctx.quadraticCurveTo(w * fx + w * 0.05, h * 0.25, 0, h * 0.42);
    ctx.stroke();
    ctx.fillStyle = '#ffffff55';
    ctx.beginPath();
    ctx.ellipse(w * fx - w * 0.03, -h * 0.18, w * 0.03, h * 0.05, -0.4, 0, Math.PI * 2);
    ctx.fill();
  });
}

// ---------- helpers ----------
function shade(hex: string, k: number): string {
  const v = hex.replace('#', '').slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(v)) return hex;
  const f = (i: number) => {
    const c = parseInt(v.slice(i, i + 2), 16);
    const n = k > 0 ? c + (255 - c) * k : c * (1 + k);
    return Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(2)}${f(4)}`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function blob(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
}

export const SPRITES: Record<string, SpriteDef> = {
  house: { label: '房子', defaultPalette: ['#f5deb3', '#c0392b', '#8d6e63', '#ecf0f1', '#95a5a6'], defaultW: 140, defaultH: 120, draw: drawHouse },
  tree: { label: '树', defaultPalette: ['#8d6e63', '#27ae60', '#2ecc71'], defaultW: 100, defaultH: 130, draw: drawTree },
  pine: { label: '松树', defaultPalette: ['#6d4c41', '#1e8449', '#27ae60'], defaultW: 90, defaultH: 130, draw: drawPine },
  mountain: { label: '山', defaultPalette: ['#7f8c8d', '#bdc3c7', '#ecf0f1'], defaultW: 180, defaultH: 100, draw: drawMountain },
  cloud: { label: '云', defaultPalette: ['#ecf0f1', '#ffffff', '#bdc3c7'], defaultW: 120, defaultH: 60, draw: drawCloud },
  sun: { label: '太阳', defaultPalette: ['#f1c40f', '#fdeaa7', '#f39c12'], defaultW: 100, defaultH: 100, draw: drawSun },
  moon: { label: '月亮', defaultPalette: ['#f9e79f', '#f4d03f'], defaultW: 80, defaultH: 80, draw: drawMoon },
  flower: { label: '花', defaultPalette: ['#e74c3c', '#f1c40f', '#27ae60', '#2ecc71'], defaultW: 80, defaultH: 100, draw: drawFlower },
  grass: { label: '草丛', defaultPalette: ['#27ae60', '#2ecc71', '#1e8449'], defaultW: 100, defaultH: 50, draw: drawGrass },
  person: { label: '小人', defaultPalette: ['#ffcc80', '#3498db', '#2c3e50', '#5d4037'], defaultW: 70, defaultH: 110, draw: drawPerson },
  bird: { label: '鸟', defaultPalette: ['#3498db', '#2980b9', '#f39c12'], defaultW: 80, defaultH: 50, draw: drawBird },
  fish: { label: '鱼', defaultPalette: ['#e67e22', '#d35400', '#f39c12'], defaultW: 90, defaultH: 50, draw: drawFish },
  boat: { label: '船', defaultPalette: ['#8d6e63', '#ecf0f1', '#5d4037', '#e74c3c'], defaultW: 110, defaultH: 90, draw: drawBoat },
  car: { label: '车', defaultPalette: ['#e74c3c', '#85c1e9', '#2c3e50', '#bdc3c7'], defaultW: 130, defaultH: 70, draw: drawCar },
  rainbow: { label: '彩虹', defaultPalette: ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6'], defaultW: 160, defaultH: 80, draw: drawRainbow },
  snowman: { label: '雪人', defaultPalette: ['#ecf0f1', '#bdc3c7', '#e67e22', '#2c3e50', '#e74c3c'], defaultW: 90, defaultH: 120, draw: drawSnowman },
  balloon: { label: '气球', defaultPalette: ['#e74c3c', '#3498db', '#95a5a6'], defaultW: 90, defaultH: 110, draw: drawBalloon },
};

export const SPRITE_NAMES = Object.entries(SPRITES).map(([k, v]) => `${k}(${v.label})`);

export function resolvePalette(asset: string, fill?: string, palette?: string[]): string[] {
  const def = SPRITES[asset];
  const base = def ? [...def.defaultPalette] : ['#3498db', '#2ecc71', '#e74c3c'];
  if (palette?.length) palette.forEach((c, i) => { base[i] = c; });
  if (fill) base[0] = fill;
  return base;
}

export function drawSprite(ctx: CanvasRenderingContext2D, asset: string, w: number, h: number, palette: string[]) {
  const def = SPRITES[asset];
  if (!def) {
    ctx.fillStyle = palette[0] ?? '#3498db';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    return;
  }
  def.draw(ctx, w, h, palette);
}
