// 简易补间动画调度：优先使用 canvas 节点自带的 requestAnimationFrame
function createTicker(renderFn, canvas) {
  let running = false;
  let handle = null;

  function frame() {
    if (!running) return;
    renderFn();
    schedule();
  }

  function schedule() {
    if (canvas && typeof canvas.requestAnimationFrame === 'function') {
      handle = canvas.requestAnimationFrame(frame);
    } else {
      handle = setTimeout(frame, 16);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    stop() {
      running = false;
      if (handle === null) return;
      if (canvas && typeof canvas.cancelAnimationFrame === 'function') {
        canvas.cancelAnimationFrame(handle);
      } else {
        clearTimeout(handle);
      }
      handle = null;
    },
    get running() {
      return running;
    }
  };
}

// 数值缓动
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// 抛物线插值（撞子飞回基地的弧线）：p0→p1，h 为拱高
function arcLerp(p0, p1, t, h) {
  const x = p0.x + (p1.x - p0.x) * t;
  const y = p0.y + (p1.y - p0.y) * t - Math.sin(Math.PI * t) * h;
  return { x: x, y: y };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { createTicker, easeInOut, easeOutBack, arcLerp, sleep };
