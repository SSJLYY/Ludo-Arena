// Canvas 2D 棋盘组件：静态层(bg) + 动态层(fx) 双画布
// 引擎同源的 board.js 计算几何；playSnapshot 按事件流播放动画
const rules = require('../../engine/rules.js');
const board = require('../../engine/board.js');
const animator = require('../../utils/animator.js');
const audio = require('../../utils/audio.js');

const SEAT_COLORS = ['#e5484d', '#f0a12a', '#3f7bf5', '#27ae60'];
const SEAT_LIGHTS = ['#fadfdd', '#fdeed2', '#dce8fd', '#daf2e3'];

Component({
  properties: {
    size: { type: Number, value: 340 },
    state: { type: Object, value: null },
    mySeat: { type: Number, value: -1 },
    interactive: { type: Boolean, value: false },
    movablePlanes: { type: Array, value: [] },
    showFly: { type: Boolean, value: true }
  },

  observers: {
    'state': function (st) {
      // 页面 setData 后的兜底渲染（动画路径由 playSnapshot 负责）
      if (!st || !this.ctxFx) return;
      if (this.animating) return;
      if ((st.seq || 0) <= (this.lastSeq === undefined ? -1 : this.lastSeq)) return;
      this.applyState(st);
    },
    'interactive, movablePlanes': function () {
      this.ensureTicker();
    }
  },

  lifetimes: {
    ready() {
      this.lastSeq = -1;
      this.tokens = [];
      this.tokenMap = {};
      const query = this.createSelectorQuery();
      query.select('#bg').fields({ node: true, size: true });
      query.select('#fx').fields({ node: true, size: true, rect: true });
      query.exec((res) => {
        if (!res || !res[0] || !res[1]) return;
        const dpr = (wx.getSystemInfoSync().pixelRatio) || 2;
        const size = this.data.size;
        this.L = board.layout(size);
        this.canvasRect = res[1];

        const bg = res[0].node;
        bg.width = size * dpr;
        bg.height = size * dpr;
        const bgCtx = bg.getContext('2d');
        bgCtx.scale(dpr, dpr);
        this.ctxBg = bgCtx;
        this.drawStatic();

        const fx = res[1].node;
        fx.width = size * dpr;
        fx.height = size * dpr;
        const fxCtx = fx.getContext('2d');
        fxCtx.scale(dpr, dpr);
        this.ctxFx = fxCtx;
        this.fxCanvas = fx;

        this.ticker = animator.createTicker(() => this.renderFx(), fx);
        if (this.data.state) this.applyState(this.data.state);
        else this.renderFx();
        this.ensureTicker();
      });
    },
    detached() {
      if (this.ticker) this.ticker.stop();
    }
  },

  methods: {
    // ---------- 渲染 ----------
    drawStatic() {
      const ctx = this.ctxBg;
      const L = this.L;
      const cs = L.cs;
      const size = this.data.size;
      ctx.clearRect(0, 0, size, size);

      // 底板
      this.roundRect(ctx, 2, 2, size - 4, size - 4, 14);
      ctx.fillStyle = '#fffdf6';
      ctx.fill();
      ctx.strokeStyle = '#eae4d2';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 四角停机坪
      for (let s = 0; s < 4; s++) {
        const area = L.baseAreas[s];
        const x = area[0] * cs + 4;
        const y = area[1] * cs + 4;
        const w = 6 * cs - 8;
        this.roundRect(ctx, x, y, w, w, 12);
        ctx.fillStyle = SEAT_LIGHTS[s];
        ctx.fill();
        ctx.strokeStyle = SEAT_COLORS[s];
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
        // 停机位
        for (const p of L.bases[s]) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, cs * 0.38, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.fill();
          ctx.strokeStyle = SEAT_COLORS[s];
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        // 起飞箭头：指向起飞格
        const takeoff = L.track[rules.START_OFFSET[s]];
        const entrance = L.track[rules.laneEntranceAbs(s)];
        const dir = { x: takeoff.x - entrance.x, y: takeoff.y - entrance.y };
        const mag = Math.hypot(dir.x, dir.y) || 1;
        dir.x /= mag; dir.y /= mag;
        const bx = takeoff.x - dir.x * cs * 0.75;
        const by = takeoff.y - dir.y * cs * 0.75;
        ctx.beginPath();
        ctx.moveTo(bx + dir.x * cs * 0.28, by + dir.y * cs * 0.28);
        ctx.lineTo(bx - dir.y * cs * 0.16, by + dir.x * cs * 0.16);
        ctx.lineTo(bx + dir.y * cs * 0.16, by - dir.x * cs * 0.16);
        ctx.closePath();
        ctx.fillStyle = SEAT_COLORS[s];
        ctx.fill();
      }

      // 主环 52 格
      const showFly = this.data.showFly !== false;
      for (let abs = 0; abs < 52; abs++) {
        const p = L.track[abs];
        const owner = rules.colorOfAbs(abs);
        const isTakeoff = rules.isSafeAbs(abs);
        const isArrow = showFly && abs === rules.arrowAbsOf(owner);
        const half = cs * (isTakeoff ? 0.46 : 0.42);
        this.roundRect(ctx, p.x - half, p.y - half, half * 2, half * 2, 5);
        if (isTakeoff) {
          ctx.fillStyle = SEAT_COLORS[owner];
          ctx.fill();
        } else {
          ctx.fillStyle = SEAT_LIGHTS[owner];
          ctx.fill();
          ctx.strokeStyle = isArrow ? SEAT_COLORS[owner] : 'rgba(35,36,58,0.08)';
          ctx.lineWidth = isArrow ? 2 : 1;
          if (isArrow) ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // 起飞格画白色小飞机
        if (isTakeoff) {
          this.drawDart(ctx, p.x, p.y, cs * 0.26, '#ffffff');
        }
        // 飞行箭头格画同色小飞机图标
        if (isArrow) {
          this.drawDart(ctx, p.x, p.y, cs * 0.2, SEAT_COLORS[owner]);
        }
        // 归航道口画同色小箭头指向航道
        if (abs === rules.laneEntranceAbs(owner)) {
          const head = L.lanes[owner][0];
          const d = { x: head.x - p.x, y: head.y - p.y };
          const mag = Math.hypot(d.x, d.y) || 1;
          d.x /= mag; d.y /= mag;
          ctx.beginPath();
          ctx.moveTo(p.x + d.x * half * 1.35, p.y + d.y * half * 1.35);
          ctx.lineTo(p.x + d.x * half * 0.7 - d.y * half * 0.42, p.y + d.y * half * 0.7 + d.x * half * 0.42);
          ctx.lineTo(p.x + d.x * half * 0.7 + d.y * half * 0.42, p.y + d.y * half * 0.7 - d.x * half * 0.42);
          ctx.closePath();
          ctx.fillStyle = SEAT_COLORS[owner];
          ctx.fill();
        }
      }

      // 飞行箭头虚线航线：箭头格 → 12 格外的落点
      if (showFly) {
        const center = L.center;
        for (let s = 0; s < 4; s++) {
        const from = L.track[rules.arrowAbsOf(s)];
        const to = L.track[rules.absOfRp(s, rules.FLY_RP + rules.FLY_DIST)];
        const mx = (from.x + to.x) / 2;
        const my = (from.y + to.y) / 2;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.quadraticCurveTo(
          mx + (center.x - mx) * 0.55,
          my + (center.y - my) * 0.55,
          to.x, to.y
        );
        ctx.strokeStyle = SEAT_COLORS[s];
        ctx.globalAlpha = 0.35;
        ctx.setLineDash([5, 6]);
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        // 落点小箭头
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const mag = Math.hypot(dx, dy) || 1;
        const ux = dx / mag;
        const uy = dy / mag;
        ctx.beginPath();
        ctx.moveTo(to.x + ux * cs * 0.3, to.y + uy * cs * 0.3);
        ctx.lineTo(to.x - uy * cs * 0.16, to.y + ux * cs * 0.16);
        ctx.lineTo(to.x + uy * cs * 0.16, to.y - ux * cs * 0.16);
        ctx.closePath();
        ctx.fillStyle = SEAT_COLORS[s];
        ctx.globalAlpha = 0.6;
        ctx.fill();
        ctx.globalAlpha = 1;
        }
      }

      // 归航道 5 格
      for (let s = 0; s < 4; s++) {
        for (const p of L.lanes[s]) {
          const half = cs * 0.42;
          this.roundRect(ctx, p.x - half, p.y - half, half * 2, half * 2, 5);
          ctx.fillStyle = SEAT_LIGHTS[s];
          ctx.fill();
          ctx.strokeStyle = SEAT_COLORS[s];
          ctx.globalAlpha = 0.55;
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // 中心终点区：4 色三角
      const c0 = { x: 6 * cs, y: 6 * cs };
      const c1 = { x: 9 * cs, y: 6 * cs };
      const c2 = { x: 9 * cs, y: 9 * cs };
      const c3 = { x: 6 * cs, y: 9 * cs };
      const mid = { x: 7.5 * cs, y: 7.5 * cs };
      const tris = [
        [c0, c3], // 红（左）
        [c0, c1], // 黄（上）
        [c1, c2], // 蓝（右）
        [c3, c2]  // 绿（下）
      ];
      for (let s = 0; s < 4; s++) {
        ctx.beginPath();
        ctx.moveTo(tris[s][0].x, tris[s][0].y);
        ctx.lineTo(tris[s][1].x, tris[s][1].y);
        ctx.lineTo(mid.x, mid.y);
        ctx.closePath();
        ctx.fillStyle = SEAT_COLORS[s];
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(mid.x, mid.y, cs * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fffdf6';
      ctx.fill();
      ctx.fillStyle = '#e8543f';
      ctx.font = 'bold ' + (cs * 0.52) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('END', mid.x, mid.y + 1);
    },

    roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    },

    // 纸飞机图形（朝上）
    drawDart(ctx, x, y, r, color) {
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r * 0.95, y + r * 0.6);
      ctx.lineTo(x, y + r * 0.14);
      ctx.lineTo(x - r * 0.95, y + r * 0.6);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    },

    // 由对局快照重建棋子位置表
    applyState(st) {
      this.lastSeq = st.seq === undefined ? this.lastSeq : st.seq;
      this._state = st;
      const L = this.L;
      const tokens = [];
      const map = {};
      for (let s = 0; s < 4; s++) {
        const player = st.players && st.players[s];
        if (!player) continue;
        // 落点分组 → 叠子错位
        const groups = {};
        for (const pl of player.planes) {
          if (pl.state === 'base' || pl.state === 'home') continue;
          let key;
          if (pl.state === 'lane') key = 'lane:' + s + ':' + (pl.rp - rules.LANE_START);
          else key = 'track:' + rules.absOfRp(s, pl.rp);
          (groups[key] = groups[key] || []).push(pl.id);
        }
        for (const pl of player.planes) {
          const pt = board.pointFor(s, pl, L);
          let scale = 1;
          if (pl.state !== 'base' && pl.state !== 'home') {
            let key;
            if (pl.state === 'lane') key = 'lane:' + s + ':' + (pl.rp - rules.LANE_START);
            else key = 'track:' + rules.absOfRp(s, pl.rp);
            const group = groups[key];
            if (group.length > 1) {
              const k = group.indexOf(pl.id);
              pt.x += (k - (group.length - 1) / 2) * L.cs * 0.5;
              pt.y -= Math.abs(k - (group.length - 1) / 2) * L.cs * 0.18;
              scale = 0.82;
            }
          }
          const token = {
            seat: s, planeId: pl.id, state: pl.state, rp: pl.rp,
            shield: !!pl.shield,
            x: pt.x, y: pt.y, scale: scale
          };
          tokens.push(token);
          map[s + ':' + pl.id] = token;
        }
      }
      this.tokens = tokens;
      this.tokenMap = map;
      this.renderFx();
    },

    renderFx() {
      const ctx = this.ctxFx;
      if (!ctx) return;
      const size = this.data.size;
      const cs = this.L ? this.L.cs : 20;
      ctx.clearRect(0, 0, size, size);
      const now = Date.now();

      // 可动棋子呼吸圈
      if (this.data.interactive && this.data.movablePlanes.length) {
        const t = (now % 1100) / 1100;
        for (const token of this.tokens) {
          if (token.seat !== this.data.mySeat) continue;
          if (this.data.movablePlanes.indexOf(token.planeId) < 0) continue;
          ctx.beginPath();
          ctx.arc(token.x, token.y, cs * 0.36 + t * cs * 0.34, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(232,84,63,' + (0.75 * (1 - t)).toFixed(3) + ')';
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }
      }

      // 棋子：底座圆 + 白描边 + 纸飞机；带盾飞机加金色护盾环
      for (const token of this.tokens) {
        const r = cs * 0.36 * (token.scale || 1);
        if (token.shield) {
          ctx.beginPath();
          ctx.arc(token.x, token.y, r + 3.5, 0, Math.PI * 2);
          ctx.strokeStyle = '#ffb03a';
          ctx.lineWidth = 3;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(token.x, token.y, r, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = SEAT_COLORS[token.seat];
        ctx.stroke();
        this.drawDart(ctx, token.x, token.y - 0.5, r * 0.62, SEAT_COLORS[token.seat]);
      }
    },

    ensureTicker() {
      const need = this.animating ||
        (this.data.interactive && this.data.movablePlanes.length > 0);
      if (need && this.ticker && !this.ticker.running) this.ticker.start();
      if (!need && this.ticker && this.ticker.running && !this.animating) this.ticker.stop();
    },

    // ---------- 动画 ----------
    rpToPoint(seat, rp) {
      const L = this.L;
      if (rp <= 51) return L.track[rules.absOfRp(seat, rp)];
      if (rp < rules.HOME_RP) return L.lanes[seat][rp - rules.LANE_START];
      return L.home[seat];
    },

    tween(token, to, dur, arc) {
      const from = { x: token.x, y: token.y };
      const start = Date.now();
      return new Promise((resolve) => {
        const step = () => {
          const t = Math.min(1, (Date.now() - start) / dur);
          if (arc) {
            const p = animator.arcLerp(from, to, t, this.L.cs * 1.2);
            token.x = p.x; token.y = p.y;
          } else {
            const k = animator.easeInOut(t);
            token.x = from.x + (to.x - from.x) * k;
            token.y = from.y + (to.y - from.y) * k;
          }
          this.renderFx();
          if (t < 1) {
            if (this.fxCanvas && this.fxCanvas.requestAnimationFrame) {
              this.fxCanvas.requestAnimationFrame(step);
            } else {
              setTimeout(step, 16);
            }
          } else {
            resolve();
          }
        };
        step();
      });
    },

    async playSnapshot(doc) {
      const seq = doc.seq || 0;
      const last = this.lastSeq === undefined ? -1 : this.lastSeq;
      if (seq <= last) return; // 重复快照（watch 与兜底轮询可能重叠），跳过
      this.animating = true;
      this.ensureTicker();
      try {
        if (seq > last + 1 && last >= 0) {
          // 快进：追不上就直接落最新状态
          this.animating = false;
          this.applyState(doc);
          return;
        }
        const events = doc.events || [];
        for (const ev of events) {
          if (ev.type === 'move') await this.playMove(ev);
          // roll 由骰子组件表现；skip/void 无棋盘动画
        }
        this.animating = false;
        this.applyState(doc);
      } finally {
        this.ensureTicker();
      }
    },

    async playMove(ev) {
      const token = this.tokenMap[ev.seat + ':' + ev.planeId];
      if (!token) return;
      const pts = (ev.path || []).map((rp) => this.rpToPoint(ev.seat, rp));
      if (ev.kind === 'takeoff') audio.takeoff();
      for (let idx = 0; idx < pts.length; idx++) {
        // 飞行箭头：最后一跳为 12 格长跳，放慢并单独配音
        const isFlyHop = ev.fly !== null && ev.fly !== undefined &&
          idx === pts.length - 1 && pts.length > 1;
        await this.tween(token, pts[idx], isFlyHop ? 420 : (ev.kind === 'takeoff' ? 260 : 130));
        if (ev.kind !== 'takeoff') {
          if (isFlyHop) audio.takeoff();
          else audio.hop();
        }
      }
      const allKills = ev.kills || [];
      const realKills = allKills.filter((k) => !k.blocked);
      const blockedKills = allKills.filter((k) => k.blocked);
      if (realKills.length) {
        audio.kill();
        await Promise.all(realKills.map((k, i) => this.flyBack(k, i * 100)));
      }
      if (blockedKills.length) {
        // v1.6 护盾反震：进攻方飞机被撞回基地
        audio.kill();
        await this.flyBack({ seat: ev.seat, planeId: ev.planeId }, 0);
      }
      if (ev.finished) audio.home();
    },

    // 回放跳转：不做动画，直接落到指定状态
    jumpTo(doc) {
      this.animating = false;
      this.applyState(doc);
    },

    async flyBack(killed, delay) {
      const token = this.tokenMap[killed.seat + ':' + killed.planeId];
      if (!token) return;
      if (delay) await animator.sleep(delay);
      const to = this.L.bases[killed.seat][killed.planeId];
      await this.tween(token, to, 520, true);
      token.state = 'base';
      token.rp = -1;
    },

    // ---------- 点选 ----------
    onTap(e) {
      if (!this.data.interactive || !this.data.movablePlanes.length) return;
      if (!this.canvasRect) return;
      const x = e.detail.x - this.canvasRect.left;
      const y = e.detail.y - this.canvasRect.top;
      const cs = this.L.cs;
      let best = null;
      let bestD = Infinity;
      for (const token of this.tokens) {
        if (token.seat !== this.data.mySeat) continue;
        if (this.data.movablePlanes.indexOf(token.planeId) < 0) continue;
        const d = Math.hypot(token.x - x, token.y - y);
        if (d < cs * 0.75 && d < bestD) {
          bestD = d;
          best = token;
        }
      }
      if (best) {
        audio.hop();
        this.triggerEvent('planetap', { planeId: best.planeId });
      }
    }
  }
});
