// 头像组件：有图显示图片，无图显示首字色块
Component({
  properties: {
    url: { type: String, value: '' },
    name: { type: String, value: '' },
    color: { type: String, value: '#e8543f' },
    size: { type: Number, value: 80 }   // rpx
  },

  data: {
    initial: '飞'
  },

  observers: {
    name(n) {
      this.setData({ initial: (n || '飞').slice(0, 1) });
    }
  }
});
