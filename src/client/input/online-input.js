/** Browser input collection only. The shared human actor owns rule stepping. */
export function collectInput(player, game, aim) {
  const keys = player.keys;
  let dx = player.mouse.dx,
    dy = player.mouse.dy;
  player.mouse.dx = player.mouse.dy = 0;
  if (player.touchLook) {
    dx += player.touchLook.x;
    dy += player.touchLook.y;
    player.touchLook.x = player.touchLook.y = 0;
  }
  player.lookDX = dx;
  player.lookDY = dy;
  const scale =
    game.opts.sens * 0.0022 * (player.ads > 0.01 ? game.renderer.camera.fov / game.opts.fov : 1);
  aim.yaw = Math.atan2(Math.sin(aim.yaw - dx * scale), Math.cos(aim.yaw - dx * scale));
  aim.pitch = Math.max(-1.5, Math.min(1.5, aim.pitch - dy * scale));
  const f =
    Number(keys.has('KeyW') || keys.has('ArrowUp')) -
    Number(keys.has('KeyS') || keys.has('ArrowDown')) +
    player.touch.mz;
  const s =
    Number(keys.has('KeyD') || keys.has('ArrowRight')) -
    Number(keys.has('KeyA') || keys.has('ArrowLeft')) +
    player.touch.mx;
  const sy = Math.sin(aim.yaw),
    cy = Math.cos(aim.yaw),
    length = Math.max(1, Math.hypot(f, s));
  let sw = null;
  for (let slot = 0; slot < 4; slot++) if (player.consumePressed('Digit' + (slot + 1))) sw = slot;
  if (player.consumePressed('KeyQ')) sw = player.lastSlot;
  const cycle = player.touch.sw || player.mouse.wheel;
  if (cycle) {
    let n = player.slot;
    for (let i = 0; i < 4; i++) {
      n = (n + (cycle > 0 ? 1 : -1) + 4) % 4;
      if (player.inv?.[n] && !(player.inv[n].def.type === 'grenade' && player.inv[n].mag <= 0))
        break;
    }
    sw = n;
  }
  player.touch.sw = 0;
  const input = {
    sw,
    altPressed: !!player.mouse.rp || (!!player.touch.aim && !player.netAltHeld),
    yaw: aim.yaw,
    pitch: aim.pitch,
    moveX: (-sy * f + cy * s) / length,
    moveZ: (-cy * f - sy * s) / length,
    fire: player.mouse.l || player.touch.fire,
    firePressed: player.mouse.lp || player.touch.firePressed,
    alt: player.mouse.r || player.touch.aim,
    jump: player.consumePressed('Space') || player.touch.jump,
    crouch: keys.has('KeyC') || player.touch.crouch,
    walk: keys.has('ShiftLeft') || keys.has('ShiftRight'),
    left: keys.has('KeyA'),
    right: keys.has('KeyD'),
    reload: player.consumePressed('KeyR'),
  };
  player.netAltHeld = !!player.touch.aim;
  player.mouse.lp = player.mouse.rp = false;
  player.mouse.wheel = 0;
  player.touch.firePressed = player.touch.jump = false;
  player.pressed.clear();
  return input;
}
