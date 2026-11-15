import * as THREE from 'three';
import { Game } from '../game.js';
import { MATCH_RULES } from '../sim/match-rules.js';
import { Player } from '../player.js';
import { Actor } from '../actor.js';
import { audio } from '../audio.js';
import { buildGunMerged } from '../guns.js';
import { WEAPONS } from '../weapons.js';
import { applyPoseSample } from '../sim/pose-sample.js';
import { restoreActor } from '../sim/actor-state.js';
import { OnlineSession } from '../net/session.js';
import { Prediction } from '../net/prediction.js';
import { collectInput } from './input/online-input.js';

/** S2 entry: reuses the existing renderer and controls, without starting the
 * offline simulation, local bots, damage, score or match timers. */
export class OnlineGame extends Game {
  async init() {
    await super.init();
    document.body.classList.add('online-sample');
    document.querySelector('.premise').textContent =
      `创建或加入房间，立即与小队进入 ${MATCH_RULES.durationSeconds / 60} 分钟的港区行动。`;
    document.querySelector('.seg[data-k="team"]')?.closest('.opt')?.remove();
    document.querySelector('#btnStartTdm span').textContent = '创建团队竞技';
    document.querySelector('#btnStartRelay span').textContent = '创建中继争夺';
    document.querySelector('.lab-entry').href = '/offline.html';
    document.querySelector('.lab-entry').textContent = '离线单文件 / 展示场 ↗';
    const entry = document.createElement('section');
    entry.className = 'online-rooms';
    entry.innerHTML =
      '<div class="room-heading"><h2>当前房间</h2><button id="refreshRooms">刷新</button></div><p id="roomNotice" role="status"></p><div id="roomList">正在连接…</div>';
    document.querySelector('.operation-select').prepend(entry);
    const identity = document.createElement('div');
    identity.className = 'opt';
    identity.innerHTML =
      '<label class="lab" for="onlineName">你的昵称</label><input id="onlineName" maxlength="24"><label class="lab" for="createPassword">创建房间密码（可不填）</label><input id="createPassword" type="password" maxlength="32" autocomplete="new-password">';
    document.querySelector('.opts').prepend(identity);
    document.querySelector('#onlineName').value =
      '港区队员' + String(Math.floor(Math.random() * 9000) + 1000);
    document.querySelector('#refreshRooms').onclick = () => {
      this.connectLobby();
      this.session?.send({ type: 'list' });
    };
    document.querySelector('#btnAgain').textContent = '返回房间列表';
    document.querySelector('#btnMenu').textContent = '返回房间列表';
    document.querySelector('#pause h2').textContent = '联网行动';
    this.status = document.createElement('div');
    this.status.id = 'onlineStatus';
    this.status.style.cssText =
      'position:fixed;left:12px;bottom:10px;z-index:60;color:#e4eef5;font:12px sans-serif;background:#10212cdd;padding:8px;pointer-events:none;max-width:80vw';
    document.body.append(this.status);
    this.setStatus('正在连接房间列表…');
    const button = document.createElement('button');
    button.id = 'btnOnlinePause';
    button.textContent = '暂停全场';
    button.style.cssText =
      'position:fixed;right:12px;top:12px;z-index:70;padding:9px;background:#12222b;color:#e6eef4;border:1px solid #778c98';
    button.addEventListener('click', () => this.pause('user'));
    document.body.append(button);
    window.addEventListener('pagehide', () => this.session?.close());
    this.connectLobby();
  }
  setStatus(text) {
    if (this.status) this.status.textContent = text;
  }
  showRooms(rooms) {
    const list = document.querySelector('#roomList');
    if (!list || list.contains(document.activeElement)) return;
    list.replaceChildren();
    if (!rooms.length) list.textContent = '暂无房间。选择下方玩法，创建并立即开始。';
    for (const room of rooms) {
      const row = document.createElement('div');
      row.className = 'room-row';
      const label = document.createElement('span');
      label.textContent = `房间 ${room.id} · ${room.mode === 'relay' ? '中继争夺' : '团队竞技'} · ${room.humans}/${room.capacity} 真人 · ${Math.ceil(room.remainingMs / 1000)} 秒${room.phase === 'paused' ? ' · 已暂停' : room.phase === 'countdown' ? ' · 恢复倒计时' : ''}`;
      row.append(label);
      let password;
      if (room.passwordRequired) {
        password = document.createElement('input');
        password.type = 'password';
        password.placeholder = '房间密码';
        password.maxLength = 32;
        password.setAttribute('aria-label', `房间 ${room.id} 密码`);
        row.append(password);
      }
      const join = document.createElement('button');
      join.dataset.roomId = room.id;
      join.textContent = room.humans >= room.capacity ? '已满' : '加入';
      join.disabled = room.humans >= room.capacity;
      join.onclick = () =>
        this.enterRoom({ type: 'join', roomId: room.id, password: password?.value || '' });
      row.append(join);
      list.append(row);
    }
  }
  connectLobby() {
    if (this.session && !this.session.closed) return;
    const session = new OnlineSession({
      onStatus: (text) => this.setStatus(text),
      onRooms: (rooms) => {
        this.showRooms(rooms);
        if (!this.player) this.setStatus('选择房间，或创建并开始');
      },
      onRejected: (code) => {
        this.entering = false;
        document.querySelector('#roomNotice').textContent =
          {
            WRONG_PASSWORD: '密码不正确，请重新输入',
            ROOM_FULL: '房间已满，请选择其他房间',
            ROOM_ENDED: '对局已结束，请选择其他房间',
            ROOM_NOT_FOUND: '房间不存在',
            SERVER_FULL: '当前房间数量已达上限，请稍后重试',
          }[code] || code;
      },
      onJoined: () => {
        this.entering = false;
        this.result = null;
        document.querySelector('#roomNotice').textContent = '';
      },
      onSnapshot: (snapshot, own) => this.receiveSnapshot(snapshot, own),
      onEvent: (event) => this.receiveEvent(event),
      onLeft: () => this.returnToEntry(),
      onResult: (result) => this.receiveResult(result),
      onClose: (reason) => {
        if (this.session !== session) return;
        this.session = null;
        this.entering = false;
        this.returnToEntry();
        this.setStatus(reason + ' · 点击创建或刷新以重新连接');
      },
    });
    this.session = session;
    session.connect();
  }
  startMatch() {
    if (this.result) {
      this.result = null;
      this.returnToEntry();
      this.session?.send({ type: 'list' });
      return;
    }
    this.enterRoom({
      type: 'create',
      mode: this.opts.mode,
      teamSize: this.opts.size,
      password: document.querySelector('#createPassword').value,
    });
  }
  enterRoom(request) {
    if (this.entering || this.player || !this.prepareMobileScreen()) return;
    if (!this.session || this.session.closed) {
      this.connectLobby();
      this.setStatus('正在连接，请连接后再选择房间');
      return;
    }
    if (!this.session.ready) return;
    audio.init();
    audio.setVolumes({ master: this.opts.vol });
    audio.startAmbient();
    this.entering = true;
    this.session.send({
      ...request,
      name: document.querySelector('#onlineName').value.trim() || '玩家',
      primary: this.opts.primary,
    });
  }
  receiveResult(result) {
    if (!this.player) return;
    const myId = this.player.id,
      myTeam = this.player.team;
    this.result = result;
    this.ended = true;
    this.playing = false;
    this.paused = true;
    this.clearInput();
    this.prediction?.clear();
    if (document.pointerLockElement) document.exitPointerLock();
    this.hud.endScreen(
      result.winner === null ? null : result.winner === myTeam,
      result.score,
      result.actors,
      myId,
    );
    this.setStatus('行动结束 · 返回列表可再次创建或加入');
  }
  receiveSnapshot(snapshot, own) {
    const first = !this.player;
    if (first) {
      this.clearMatchObjects();
      this.actors = [];
      this.tags = [];
      this.player = null;
      const mine = snapshot.actors.find((value) => value.id === own.actorId);
      this.player = new Player(this, mine);
      this.player.primary = own.state.primary;
      this.player.giveLoadout(own.state.primary);
      this.player.bind(document.getElementById('c'));
      this.actors.push(this.player);
      this.mode = snapshot.mode;
      this.opts.mode = snapshot.mode;
      this.goal = MATCH_RULES.scoreLimit;
      this.objective.reset(snapshot.mode === 'relay');
      this.vm.setTeam(mine.team);
      this.vm.equip(this.player.weapon.id, 0.3);
      this.hud.slots(this.player.inv, 0);
    }
    if (this.rosterVersion !== snapshot.rosterVersion) this.syncRoster(snapshot);
    this.prediction ||= new Prediction(this.world, (event) => this.predictEffect(event));
    const changed = this.prediction.reconcile(snapshot, own);
    if (changed || first) {
      this.clearInput();
      this.prediction.clear();
      this.session.clear();
      this.aim = { yaw: own.state.fields.yaw, pitch: own.state.fields.pitch };
    }
    this.copyOwn();
    this.score = snapshot.score;
    if (snapshot.objective) {
      Object.assign(this.objective.rules, snapshot.objective);
      this.objective.position.fromArray(snapshot.objective.position);
      this.objective.root.position.copy(this.objective.position);
    }
    this.syncNades(snapshot.nades || []);
    this.timeLeft =
      snapshot.remainingMs === undefined
        ? Math.max(0, MATCH_RULES.durationSeconds - snapshot.time)
        : snapshot.remainingMs / 1000;
    const phaseChanged = this.netPhase !== snapshot.phase;
    this.netPhase = snapshot.phase;
    this.playing = true;
    this.ended = snapshot.phase === 'ended';
    if (first) this.localInterrupted = false;
    this.paused = this.localInterrupted || snapshot.phase !== 'running';
    if (phaseChanged || first) {
      this.clearInput();
      this.simAccumulator = 0;
      this.hud.show(this.paused ? 'pause' : null);
      if (this.paused && document.pointerLockElement) document.exitPointerLock();
      if (!this.paused && (first || this.wantLock)) {
        this.wantLock = false;
        this.lock();
      }
    }
    if (this.ended) {
      this.hud.show('pause');
      this.setStatus('对局已结束 · 退出后可重新加入');
    }
    this.touch?.sync();
  }
  syncRoster(snapshot) {
    const ids = new Set(snapshot.actors.map((actor) => actor.id));
    for (const actor of this.actors)
      if (!ids.has(actor.id)) {
        this.renderer.scene.remove(actor.soldier.root);
        actor.soldier.mesh.skeleton.dispose();
        actor.soldier.material.dispose();
      }
    for (const tag of this.tags)
      if (!ids.has(tag.actor.id)) {
        this.renderer.scene.remove(tag.sprite);
        tag.sprite.material.map?.dispose();
        tag.sprite.material.dispose();
      }
    this.actors = this.actors.filter((actor) => ids.has(actor.id));
    this.tags = this.tags.filter((tag) => ids.has(tag.actor.id));
    for (const sample of snapshot.actors)
      if (!this.actors.some((actor) => actor.id === sample.id)) {
        const actor = new Actor(this, sample);
        actor.giveLoadout(
          sample.weaponId && ['m4a1', 'ak47', 'mp5', 'awm'].includes(sample.weaponId)
            ? sample.weaponId
            : 'm4a1',
        );
        this.actors.push(actor);
        this.addTag(actor);
      }
    this.rosterVersion = snapshot.rosterVersion;
  }
  copyOwn() {
    if (!this.player || !this.prediction?.actor) return;
    const oldWeapon = this.player.weapon.id;
    const alive = this.player.alive;
    const oldLife = this.player.lifeId;
    restoreActor(this.player, this.prediction.state());
    this.time = this.prediction.host.time;
    if (oldWeapon !== this.player.weapon.id) {
      this.vm.equip(this.player.weapon.id, this.player.weapon.def.draw);
      this.hud.slots(this.player.inv, this.player.slot);
    }
    this.player.soldier.root.visible = !this.player.alive;
    if (alive && !this.player.alive) {
      this.clearInput();
      this.player.startDeathCam(null);
    }
    if (oldLife !== this.player.lifeId) {
      this.player.deathCam = null;
      this.dmgFlash = this.lowHealthFX = 0;
      this.vm.equip(this.player.weapon.id, 0.3);
    }
    if (!this.player.weapon.reloading && this.vm.anim?.type === 'reload') this.vm.cancelAnim();
    this.player.updateCamera(0);
  }
  simulate() {
    if (!this.player || !this.session || this.paused || this.ended) return;
    if (this.player.consumePressed('KeyB')) {
      this.toggleLoadout();
      return;
    }
    if (this.player.consumePressed('KeyF')) this.vm.inspect();
    const frame = this.session.frame(collectInput(this.player, this, this.aim));
    if (!frame) return;
    try {
      this.prediction.submit(frame);
      this.copyOwn();
      this.session.send(frame);
    } catch (error) {
      this.session.fail(error.message);
    }
  }
  renderFrame(dt) {
    const sample = this.session?.sample();
    if (sample)
      for (const value of sample.actors) {
        const actor = this.actors.find((item) => item.id === value.id);
        if (!actor) continue;
        if (actor === this.player) {
          if (!actor.alive && !value.alive && actor.lifeId === value.lifeId)
            applyPoseSample(actor.soldier, value);
          continue;
        }
        Object.assign(actor, {
          alive: value.alive,
          hp: value.hp,
          armor: value.armor,
          stats: value.stats,
          lifeId: value.lifeId,
          radarT: value.radarT,
        });
        actor.pos.fromArray(value.pos);
        actor.vel.fromArray(value.vel);
        actor.yaw = value.yaw;
        actor.pitch = value.pitch;
        applyPoseSample(actor.soldier, value);
      }
    if (this.player && !this.player.alive && !this.paused) this.player.updateCamera(dt);
    if (this.session?.snapshot && !this.ended) {
      const s = this.session;
      const phase =
        this.netPhase === 'countdown'
          ? `恢复倒计时 ${Math.max(0, Math.ceil((s.snapshot.resumeAtMs - s.serverNow()) / 1000))}`
          : this.netPhase === 'paused'
            ? `全场暂停 · ${this.actors.find((a) => a.id === s.snapshot.pausedBy)?.name || '队员'}`
            : this.localInterrupted
              ? '本地输入已暂停 · 点击继续'
              : '联网交火';
      this.setStatus(`${phase} · 房间 ${s.roomId} · 延迟 ${Math.round(s.rttMs)} ms`);
    }
    const pauseButton = document.querySelector('#btnOnlinePause');
    if (pauseButton) pauseButton.hidden = !this.playing || this.ended;
    super.renderFrame(dt);
  }
  predictEffect(event) {
    if (!this.player) return;
    if (event.type === 'shot') {
      this.vm.fire();
      audio.playShot(event.weapon.def.sound, null);
      this.fx.light(event.shot.origin, 5, 0.06);
      this.ejectPlayerShell();
    } else if (event.type === 'melee') {
      this.vm.melee(event.heavy);
      audio.playKnife(event.heavy ? 'heavy' : 'light', 'miss');
    } else if (event.type === 'grenadeStart') {
      this.vm.throwNade();
      audio.playGrenadePin();
    } else if (event.type === 'grenade') audio.playGrenadeThrow();
    else if (event.type === 'switch')
      this.vm.equip(event.actor.weapon.id, event.actor.weapon.def.draw);
    else if (event.type === 'reload') this.vm.reload(event.actor.weapon.def.reload, event.empty);
    else if (event.type === 'step')
      audio.playFootstep(null, event.actor.ground?.surface || 'metal', {
        run: true,
        crouch: event.actor.crouch,
      });
    else if (event.type === 'jump') audio.playJump(null);
    else if (event.type === 'land')
      audio.playLand(null, event.actor.ground?.surface || 'metal', 0.5);
  }
  syncNades(samples) {
    this.netNades ||= new Map();
    const ids = new Set(samples.map((n) => n.id));
    for (const [id, mesh] of this.netNades)
      if (!ids.has(id)) {
        this.renderer.scene.remove(mesh);
        this.netNades.delete(id);
      }
    for (const sample of samples) {
      let mesh = this.netNades.get(sample.id);
      if (!mesh) {
        mesh = buildGunMerged('he');
        mesh.scale.setScalar(1.3);
        this.netNades.set(sample.id, mesh);
        this.renderer.scene.add(mesh);
      }
      mesh.position.fromArray(sample.pos);
    }
  }
  receiveEvent(event) {
    if (event.type === 'death') {
      const victim = this.actors.find((a) => a.id === event.actorId),
        attacker = this.actors.find((a) => a.id === event.attackerId) || event.attacker;
      if (victim) {
        this.hud.killFeed(
          attacker,
          victim,
          event.weaponId,
          event.headshot,
          event.wall,
          attacker?.id === this.player?.id || victim === this.player,
        );
        audio.playDeath(victim === this.player ? null : victim.pos);
      }
      if (attacker?.id === this.player?.id && victim !== this.player)
        audio.playKillConfirm(event.headshot, 1);
      if (victim === this.player) {
        const safe = String(attacker?.name || '环境').replace(
          /[&<>"']/g,
          (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
        );
        this.killedBy = `被 ${safe} 用 ${WEAPONS[event.weaponId]?.name || '武器'}击杀`;
      }
    }
    if (event.type === 'explosion') {
      const pos = new THREE.Vector3(...event.pos);
      this.fx.explosion(pos);
      audio.playExplosion(pos);
    }
    if (event.type === 'melee' && event.actorId !== this.player?.id)
      audio.playKnife(event.heavy ? 'heavy' : 'light', 'miss');
    if (event.type === 'shot') {
      const direction = new THREE.Vector3(...event.direction);
      this.fx.tracer(new THREE.Vector3(...event.origin), new THREE.Vector3(...event.end));
      for (const impact of event.impacts)
        this.fx.impact(
          new THREE.Vector3(...impact.point),
          new THREE.Vector3(...impact.normal),
          impact.surface,
          direction,
        );
    }
    if (event.type === 'shot' && event.actorId !== this.player?.id) {
      const origin = new THREE.Vector3(...event.origin),
        direction = new THREE.Vector3(...event.direction);
      this.fx.muzzle(origin, direction, 1);
      audio.playShot((WEAPONS[event.weaponId] || WEAPONS.m4a1).sound, origin);
      // Events are independent effects; remote skeletons are sampled only.
    }
    if (event.type === 'damage') {
      if (event.attackerId === this.player?.id)
        this.hud.hitmarker(event.part === 'head', event.killed);
      if (event.actorId === this.player?.id) this.dmgFlash = 0.7;
    }
  }
  pause(reason = 'input-interruption') {
    if (!this.playing || this.ended) return;
    this.clearInput();
    this.prediction?.clear();
    this.session?.send({ type: 'interrupt' });
    if (reason === 'user') this.session?.send({ type: 'pause' });
    else this.localInterrupted = true;
    this.paused = true;
    this.hud.show('pause');
    if (document.pointerLockElement) document.exitPointerLock();
  }
  resume() {
    if (!this.prepareMobileScreen()) return;
    this.localInterrupted = false;
    this.clearInput();
    this.session?.clear();
    this.wantLock = true;
    if (this.netPhase === 'paused') this.session?.send({ type: 'resume' });
    else if (this.netPhase === 'running') {
      this.paused = false;
      this.hud.show(null);
      this.lock();
    }
  }
  onLockChange() {
    this.locked = document.pointerLockElement === document.getElementById('c') || !!this.dragMode;
    document.body.classList.toggle('lk', this.locked);
    if (!this.locked && this.playing && !this.paused && !this.qs.has('nolock')) this.pause();
  }
  toggleLoadout() {
    if (!this.playing || this.ended) return;
    if (this.inLoadout) {
      this.closeLoadout();
      return;
    }
    this.pause();
    this.inLoadout = true;
    this.hud.show('loadout');
  }
  closeLoadout() {
    this.inLoadout = false;
    this.resume();
  }
  chooseLoadout(primary) {
    this.opts.primary = primary;
    this.hud.saveOpts();
    this.session?.send({ type: 'loadout', primary });
    this.hud.toast('出生区即时更换，区外复活后使用', 2);
  }
  quitToMenu() {
    this.clearInput();
    this.session?.resetRound();
    this.session?.send({ type: 'leave' });
    this.result = null;
    this.returnToEntry();
    this.session?.send({ type: 'list' });
  }
  returnToEntry() {
    super.quitToMenu();
    this.syncNades([]);
    this.entering = false;
    this.aim = null;
    this.inLoadout = false;
    this.prediction = null;
    this.rosterVersion = null;
    this.netPhase = null;
    this.localInterrupted = false;
    this.hud.el.btnStartTdm.disabled = false;
  }
}
