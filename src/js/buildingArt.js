// Building icon art, drawn with Canvas 2D paths — once per distinct icon into
// the WebGL sprite atlas (buildingLayer.js), not every frame. The art is the
// one the overlay canvas used to draw per building per frame; the parts that
// spin (a gold mine's energy ring, an anti-air battery's reticle) are a
// separate layer the GPU rotates, and the per-building extras that change
// (construction bar, silo cooldown, anti-air charges) are drawn by the
// renderer on the overlay canvas.
//
// paintBuildingArt(ctx, spec, iconSize, layer): draws centred at (0, 0).
//   spec  { type, factionId, constructing, charged, lowGraphics }
//   layer 'base' (frame + icon) or 'spin' (the rotating part, at angle 0;
//         nothing for types that have none)
import { factionHexColors, factionRGB } from './constants.js';

export const HAS_SPIN = { mine: true, antiair: true };

export function paintBuildingArt(ctx, spec, iconSize, layer = 'base') {
  const { type, factionId, constructing, lowGraphics } = spec;
  const b = { charges: spec.charged ? 3 : 0 };
  const z = iconSize / 11; // the zoom this icon size corresponds to
  const pulse = 1;         // the pulse is a scale, applied by the GPU
  const color = factionHexColors[factionId] || '#888888';
  const rgb = factionRGB[factionId] || [136, 136, 136];
  const isSilo    = type === 'silo';
  const isMine    = type === 'mine';
  const isAntiAir = type === 'antiair';
  const isCity    = type === 'city';
  const [r, g, bl] = rgb;
  const hexColor = isMine ? '#f59e0b' : isCity ? '#a78bfa' : color;

  if (layer === 'spin') {
    const s = iconSize;
    if (isMine && !constructing) {
      const gr = s * 1.08;
          ctx.save();
          ctx.setLineDash([s * 0.27, s * 0.21]);
          ctx.beginPath(); ctx.arc(0, 0, gr * 0.55, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 220, 70, 0.65)';
          ctx.lineWidth = Math.max(0.8, z * 0.9);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
    } else if (isAntiAir) {
      // Rotating targeting reticle
      ctx.save();
      const rr = s * 0.92;
      if (!constructing && !lowGraphics) { ctx.shadowColor = hexColor; ctx.shadowBlur = s * 0.75; }
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2);
      ctx.strokeStyle = hexColor;
      ctx.lineWidth = Math.max(0.8, z * 1.0); ctx.stroke();
      // Crosshair arms with gap
      const gap = rr * 0.36;
      for (let i = 0; i < 4; i++) {
          const a = (Math.PI / 2) * i;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a)*gap, Math.sin(a)*gap);
          ctx.lineTo(Math.cos(a)*rr,  Math.sin(a)*rr);
          ctx.stroke();
      }
      ctx.shadowBlur = 0;
      // Tick marks
      ctx.lineWidth = Math.max(0.35, z * 0.45);
      ctx.strokeStyle = `rgba(${r},${g},${bl},0.45)`;
      for (let i = 0; i < 8; i++) {
          const a = (Math.PI / 4) * i + Math.PI / 8;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a)*rr*0.77, Math.sin(a)*rr*0.77);
          ctx.lineTo(Math.cos(a)*rr,      Math.sin(a)*rr);
          ctx.stroke();
      }
      ctx.restore();

    }
    return;
  }

  ctx.save();
  // ── Hex frame with neon glow ──
  const hexR = iconSize * 1.62 * pulse;
  const drawHex = (size, rot = Math.PI / 6) => {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i + rot;
          if (i === 0) ctx.moveTo(Math.cos(a) * size, Math.sin(a) * size);
          else         ctx.lineTo(Math.cos(a) * size, Math.sin(a) * size);
      }
      ctx.closePath();
  };

  const hexRgb   = isMine ? [245, 158, 11] : isCity ? [167, 139, 250] : rgb;

  drawHex(hexR);
  ctx.fillStyle = 'rgba(3, 5, 12, 0.92)';
  ctx.fill();

  if (!constructing && !lowGraphics) { ctx.shadowColor = hexColor; ctx.shadowBlur = iconSize * 2; }
  drawHex(hexR);
  ctx.strokeStyle = constructing ? 'rgba(255,255,255,0.18)' : hexColor;
  ctx.lineWidth = Math.max(1, 1.6 * z);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Dim inner hex ring — circuit frame detail
  if (!constructing) {
      drawHex(hexR * 0.76);
      ctx.strokeStyle = `rgba(${hexRgb[0]},${hexRgb[1]},${hexRgb[2]},0.22)`;
      ctx.lineWidth = Math.max(0.4, 0.5 * z);
      ctx.stroke();
  }

  if (constructing) ctx.globalAlpha = 0.55;
  const s = iconSize * pulse;

  if (isSilo) {
      // ── SILO: hypersonic angular missile ──
      const mh = s * 1.75, mw = s * 0.48;

      // Energy spine behind body
      ctx.beginPath();
      ctx.moveTo(0, -mh * 0.88); ctx.lineTo(0, mh * 0.56);
      ctx.strokeStyle = `rgba(${r},${g},${bl},0.6)`;
      ctx.lineWidth = Math.max(0.7, z * 0.8);
      if (!constructing && !lowGraphics) { ctx.shadowColor = hexColor; ctx.shadowBlur = s * 0.35; }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Angular missile body (no bezier — hard edges)
      ctx.beginPath();
      ctx.moveTo(0,        -mh);
      ctx.lineTo( mw*0.48, -mh*0.52);
      ctx.lineTo( mw,       mh*0.38);
      ctx.lineTo( mw,       mh*0.62);
      ctx.lineTo( mw*1.88,  mh);
      ctx.lineTo( mw*0.78,  mh*0.74);
      ctx.lineTo(-mw*0.78,  mh*0.74);
      ctx.lineTo(-mw*1.88,  mh);
      ctx.lineTo(-mw,       mh*0.62);
      ctx.lineTo(-mw,       mh*0.38);
      ctx.lineTo(-mw*0.48, -mh*0.52);
      ctx.closePath();
      const mGrad = ctx.createLinearGradient(-mw, -mh, mw, mh);
      mGrad.addColorStop(0,    '#e8f4ff');
      mGrad.addColorStop(0.15, hexColor);
      mGrad.addColorStop(0.65, `rgba(${Math.floor(r*0.38)},${Math.floor(g*0.38)},${Math.floor(bl*0.38)},1)`);
      mGrad.addColorStop(1,    '#010306');
      ctx.fillStyle = mGrad;
      ctx.fill();
      if (!constructing && !lowGraphics) { ctx.shadowColor = hexColor; ctx.shadowBlur = s * 0.55; }
      ctx.strokeStyle = constructing ? 'rgba(255,255,255,0.25)' : `rgba(${r},${g},${bl},0.8)`;
      ctx.lineWidth = Math.max(0.5, z * 0.65);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Nose tip dot
      if (s > 7) {
          ctx.beginPath();
          ctx.arc(0, -mh * 0.96, mw * 0.2, 0, Math.PI * 2);
          ctx.fillStyle = '#eef8ff';
          ctx.fill();
      }

      // Chevron detail lines
      if (s > 9) {
          ctx.strokeStyle = `rgba(${r},${g},${bl},0.45)`;
          ctx.lineWidth = Math.max(0.3, z * 0.4);
          for (const yOff of [-mh * 0.12, mh * 0.12]) {
              ctx.beginPath();
              ctx.moveTo(-mw * 0.32, yOff + mh * 0.1);
              ctx.lineTo(0,           yOff - mh * 0.04);
              ctx.lineTo( mw * 0.32,  yOff + mh * 0.1);
              ctx.stroke();
          }
      }

  } else if (isMine) {
      // ── GOLD MINE: octagonal power core with rotating energy ring ──
      const gr = s * 1.08;
      // Octagon
      const oct = gr * 0.88, cut = oct * 0.38;
      ctx.beginPath();
      ctx.moveTo(-oct + cut, -oct); ctx.lineTo( oct - cut, -oct);
      ctx.lineTo( oct,  -oct + cut); ctx.lineTo( oct,  oct - cut);
      ctx.lineTo( oct - cut,  oct); ctx.lineTo(-oct + cut,  oct);
      ctx.lineTo(-oct,  oct - cut); ctx.lineTo(-oct, -oct + cut);
      ctx.closePath();
      const cGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, gr);
      cGrad.addColorStop(0,    '#fff5c0');
      cGrad.addColorStop(0.28, '#fbbf24');
      cGrad.addColorStop(0.68, '#b45309');
      cGrad.addColorStop(1,    '#0c0700');
      ctx.fillStyle = cGrad;
      ctx.fill();
      if (!constructing && !lowGraphics) { ctx.shadowColor = '#f59e0b'; ctx.shadowBlur = s * 1.4; }
      ctx.strokeStyle = constructing ? 'rgba(245,158,11,0.28)' : '#f59e0b';
      ctx.lineWidth = Math.max(0.8, z * 1.0);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Inner hex
      drawHex(gr * 0.36);
      ctx.strokeStyle = 'rgba(255,240,140,0.45)';
      ctx.lineWidth = Math.max(0.4, z * 0.45);
      ctx.stroke();

      if (s > 7) {
          ctx.fillStyle = '#fff8d6';
          ctx.font = `bold ${Math.floor(s * 0.88)}px 'Orbitron', monospace`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('$', 0, 0);
      }

  } else if (isAntiAir) {
      // ── ANTI-AIR: rotating targeting reticle + angular base + twin barrels ──
      const baseGrad = ctx.createLinearGradient(0, s * 0.08, 0, s * 0.72);
      baseGrad.addColorStop(0, `rgba(${r},${g},${bl},0.88)`);
      baseGrad.addColorStop(1, 'rgba(3, 5, 12, 0.96)');
      ctx.beginPath();
      ctx.moveTo(-s*0.78, s*0.72); ctx.lineTo(-s*0.48, s*0.08);
      ctx.lineTo( s*0.48, s*0.08); ctx.lineTo( s*0.78, s*0.72);
      ctx.closePath();
      ctx.fillStyle = baseGrad; ctx.fill();
      ctx.strokeStyle = `rgba(${r},${g},${bl},0.55)`;
      ctx.lineWidth = Math.max(0.4, z * 0.6); ctx.stroke();

      // Twin barrels with muzzle highlight
      const charges = b.charges ?? 3;
      const barFill = charges > 0 ? hexColor : '#2a2a2a';
      if (!constructing && !lowGraphics) { ctx.shadowColor = barFill; ctx.shadowBlur = s * 0.4; }
      for (const bx of [-s*0.32, s*0.32]) {
          ctx.fillStyle = barFill;
          ctx.fillRect(bx - s*0.09, -s*0.55, s*0.18, s*0.64);
          if (!constructing && charges > 0) {
              ctx.fillStyle = '#d0eeff';
              ctx.fillRect(bx - s*0.09, -s*0.55, s*0.18, s*0.1);
          }
      }
      ctx.shadowBlur = 0;

  } else if (isCity) {
      // ── CITY: skyline silhouette — three towers of varying heights ──
      const [cr, cg, cb] = [167, 139, 250];
      const bw = s * 0.34, bh = s * 1.55;
      const buildings = [
          { x: -s*0.52, w: bw*0.9,  h: bh * 0.72 },
          { x: -s*0.13, w: bw*1.12, h: bh },
          { x:  s*0.29, w: bw*0.9,  h: bh * 0.85 },
      ];
      const baseY = s * 0.72;
      // Fill gradient
      const cityGrad = ctx.createLinearGradient(0, -bh, 0, baseY);
      cityGrad.addColorStop(0, `rgba(${cr},${cg},${cb},0.95)`);
      cityGrad.addColorStop(1, `rgba(${Math.floor(cr*0.3)},${Math.floor(cg*0.3)},${Math.floor(cb*0.3)},0.88)`);
      if (!constructing && !lowGraphics) { ctx.shadowColor = '#a78bfa'; ctx.shadowBlur = s * 1.2; }
      for (const bd of buildings) {
          ctx.beginPath();
          ctx.rect(bd.x, baseY - bd.h, bd.w, bd.h);
          ctx.fillStyle = cityGrad; ctx.fill();
          ctx.strokeStyle = constructing ? 'rgba(167,139,250,0.3)' : '#a78bfa';
          ctx.lineWidth = Math.max(0.5, z * 0.7); ctx.stroke();
      }
      ctx.shadowBlur = 0;
      // Windows — tiny bright dots
      if (!constructing && s > 6) {
          ctx.fillStyle = 'rgba(230,220,255,0.85)';
          for (const bd of buildings) {
              for (let wy = 0; wy < 3; wy++) {
                  for (let wx = 0; wx < 2; wx++) {
                      const wx0 = bd.x + bd.w * (0.22 + wx * 0.45);
                      const wy0 = baseY - bd.h * (0.25 + wy * 0.28);
                      ctx.fillRect(wx0, wy0, Math.max(1, s*0.09), Math.max(1, s*0.09));
                  }
              }
          }
      }

  } else {
      // ── DEFENSE TOWER: cyberpunk fortress with power conduits ──
      const tw = s * 1.05, th = s * 1.68;
      const tGrad = ctx.createLinearGradient(-tw, -th*0.45, tw*0.55, th*0.5);
      tGrad.addColorStop(0,    `rgba(${r},${g},${bl},0.9)`);
      tGrad.addColorStop(0.5,  `rgba(${Math.floor(r*0.38)},${Math.floor(g*0.38)},${Math.floor(bl*0.38)},0.9)`);
      tGrad.addColorStop(1,    'rgba(3,5,12,0.95)');
      ctx.beginPath();
      ctx.rect(-tw*0.58, -th*0.44, tw*1.16, th*0.94);
      ctx.fillStyle = tGrad; ctx.fill();

      // Angular battlements (notched tops)
      const mw = tw*0.3, mh = th*0.22, mTop = -th*0.44 - mh;
      ctx.fillStyle = `rgba(${r},${g},${bl},0.93)`;
      for (const mx of [-tw*0.5, 0, tw*0.5]) {
          ctx.beginPath();
          ctx.moveTo(mx - mw/2,    mTop + mh);
          ctx.lineTo(mx - mw/2,    mTop + mh*0.28);
          ctx.lineTo(mx - mw*0.14, mTop);
          ctx.lineTo(mx + mw*0.14, mTop);
          ctx.lineTo(mx + mw/2,    mTop + mh*0.28);
          ctx.lineTo(mx + mw/2,    mTop + mh);
          ctx.closePath(); ctx.fill();
      }

      // Neon outline
      if (!constructing && !lowGraphics) { ctx.shadowColor = hexColor; ctx.shadowBlur = s * 0.85; }
      ctx.strokeStyle = `rgba(${r},${g},${bl},0.78)`;
      ctx.lineWidth = Math.max(0.5, z * 0.75);
      ctx.strokeRect(-tw*0.58, -th*0.44, tw*1.16, th*0.94);
      ctx.shadowBlur = 0;

      // Power conduit lines
      ctx.strokeStyle = `rgba(${r},${g},${bl},0.4)`;
      ctx.lineWidth = Math.max(0.35, z * 0.45);
      ctx.beginPath(); ctx.moveTo(0, -th*0.3);  ctx.lineTo(0, th*0.46);  ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-tw*0.46, th*0.05); ctx.lineTo(tw*0.46, th*0.05); ctx.stroke();

      // Central target node
      if (s > 7) {
          ctx.beginPath();
          ctx.arc(0, th*0.05, s*0.18, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${r},${g},${bl},0.35)`; ctx.fill();
          if (!constructing && !lowGraphics) { ctx.shadowColor = hexColor; ctx.shadowBlur = s * 0.5; }
          ctx.strokeStyle = hexColor;
          ctx.lineWidth = Math.max(0.5, z * 0.65); ctx.stroke();
          ctx.shadowBlur = 0;
          ctx.beginPath(); ctx.arc(0, th*0.05, s*0.07, 0, Math.PI * 2);
          ctx.fillStyle = hexColor; ctx.fill();
      }

      // Corner tech brackets
      if (s > 10) {
          const bLen = tw * 0.24;
          ctx.strokeStyle = `rgba(${r},${g},${bl},0.55)`;
          ctx.lineWidth = Math.max(0.5, z * 0.55);
          for (const [cx, cy, dx, dy] of [
              [-tw*0.58, -th*0.44,  1,  1],
              [ tw*0.58, -th*0.44, -1,  1],
              [-tw*0.58,  th*0.5,   1, -1],
              [ tw*0.58,  th*0.5,  -1, -1],
          ]) {
              ctx.beginPath();
              ctx.moveTo(cx + dx*bLen, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + dy*bLen);
              ctx.stroke();
          }
      }
  }

  ctx.restore();
}
