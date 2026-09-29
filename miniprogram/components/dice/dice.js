// 骰子组件：CSS 点阵 + 翻滚动画，rollTo(v) 返回 Promise
const PIP_MAP = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8]
};

Component({
  properties: {
    value: { type: Number, value: 1 }
  },

  data: {
    face: 1,
    pips: [false, false, false, false, true, false, false, false, false],
    rolling: false
  },

  observers: {
    value(v) {
      if (!this.data.rolling && v >= 1 && v <= 6) this.setFace(v);
    }
  },

  methods: {
    setFace(v) {
      const on = {};
      (PIP_MAP[v] || PIP_MAP[1]).forEach((i) => { on[i] = true; });
      const pips = [];
      for (let i = 0; i < 9; i++) pips.push(!!on[i]);
      this.setData({ face: v, pips: pips });
    },

    rollTo(target) {
      if (this._rolling) return this._rolling;
      this._rolling = true;
      this.setData({ rolling: true });
      const audio = require('../../utils/audio.js');
      audio.dice();
      let ticks = 0;
      const timer = setInterval(() => {
        this.setFace(1 + Math.floor(Math.random() * 6));
        ticks++;
      }, 75);
      return new Promise((resolve) => {
        setTimeout(() => {
          clearInterval(timer);
          this._rolling = false;
          this.setData({ rolling: false });
          this.setFace(target);
          resolve(target);
        }, 620);
      });
    }
  }
});
