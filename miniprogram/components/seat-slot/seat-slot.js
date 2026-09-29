// 座位卡：空位 / 真人 / AI 三态；房主可管理他人座位与 AI 配置
Component({
  properties: {
    seat: { type: Object, value: null },     // {index,color,type,openId,nickName,avatarUrl,aiLevel,isOnline,isHosted}
    isOwner: { type: Boolean, value: false },
    myOpenId: { type: String, value: '' }
  },

  data: {
    colorHex: '#e5484d',
    isMe: false,
    canManage: false
  },

  observers: {
    seat(s) {
      if (!s) return;
      const hexMap = { red: '#e5484d', yellow: '#f0a12a', blue: '#3f7bf5', green: '#27ae60' };
      this.setData({
        colorHex: hexMap[s.color] || '#e5484d',
        isMe: !!(s.type === 'human' && s.openId && s.openId === this.data.myOpenId),
        canManage: this.data.isOwner && s.type !== 'empty' &&
          !(s.type === 'human' && s.openId === this.data.myOpenId)
      });
    },
    isOwner(v) {
      const s = this.data.seat;
      this.setData({
        canManage: v && s && s.type !== 'empty' &&
          !(s.type === 'human' && s.openId === this.data.myOpenId)
      });
    }
  },

  methods: {
    onSit() { this.triggerEvent('sit', { index: this.data.seat.index }); },
    onAddAI() { this.triggerEvent('addai', { index: this.data.seat.index }); },
    onRemove() {
      const s = this.data.seat;
      this.triggerEvent(s.type === 'ai' ? 'removeai' : 'kick', { index: s.index });
    },
    onLevel(e) {
      this.triggerEvent('setlevel', { index: this.data.seat.index, aiLevel: Number(e.detail.value) + 1 });
    }
  }
});
