'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Rooms = require('../src/rooms.js');

const approx = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < eps, `${actual} !=~ ${expected}`);

// 构造一个房间行（与 rooms 表同构）：演出时长 10 秒
function room(over = {}) {
  return {
    code: 'ABC234',
    playing: 0,
    anchor_time: 0,
    anchor_wall: 1000,
    speed: 1,
    revision: 0,
    duration: 10,
    ...over,
  };
}

test('暂停时当前时码恒为基准时码，不随墙上时钟推进', () => {
  const r = room({ playing: 0, anchor_time: 4, anchor_wall: 1000 });
  assert.equal(Rooms.projectRoom(r, 1000).time, 4);
  assert.equal(Rooms.projectRoom(r, 2000).time, 4);
  assert.equal(Rooms.projectRoom(r, 5000).time, 4);
});

test('播放时按 anchor + 流逝墙钟 × 速度推算；速度 0.5/1/2', () => {
  for (const speed of [0.5, 1, 2]) {
    const r = room({ playing: 1, anchor_time: 2, anchor_wall: 1000, speed });
    const p = Rooms.projectRoom(r, 1003); // 墙钟流逝 3 秒
    approx(p.time, 2 + 3 * speed);
    assert.equal(p.ended, false);
  }
});

test('播放到版本末尾自动停住：时码截到 duration，ended=true，修订号不在纯函数中改变', () => {
  const r = room({ playing: 1, anchor_time: 9, anchor_wall: 1000, speed: 1 });
  const p = Rooms.projectRoom(r, 1002);
  assert.equal(p.time, 10);
  assert.equal(p.ended, true);
});

test('暂停且基准时码等于末尾时，ended=true', () => {
  const r = room({ playing: 0, anchor_time: 10 });
  assert.equal(Rooms.projectRoom(r, 9999).ended, true);
});

test('play：从当前位置继续并重锚墙上时钟', () => {
  const r = room({ playing: 0, anchor_time: 3, anchor_wall: 0 });
  const patch = Rooms.applyAction(r, 'play', {}, 5000);
  assert.equal(patch.playing, 1);
  assert.equal(patch.anchor_time, 3);
  assert.equal(patch.anchor_wall, 5000);
  assert.equal(patch.speed, 1);
});

test('已停在末尾时 play：从头播放', () => {
  const r = room({ playing: 0, anchor_time: 10, anchor_wall: 0 });
  const patch = Rooms.applyAction(r, 'play', {}, 5000);
  assert.equal(patch.playing, 1);
  assert.equal(patch.anchor_time, 0);
  assert.equal(patch.anchor_wall, 5000);
});

test('播放中越过末尾后 play（仍为播放态）：从头播放', () => {
  const r = room({ playing: 1, anchor_time: 9, anchor_wall: 0, speed: 1 });
  const patch = Rooms.applyAction(r, 'play', {}, 100); // 推算已到 10
  assert.equal(patch.playing, 1);
  assert.equal(patch.anchor_time, 0);
});

test('pause：把推算到的当前位置固化为暂停基准', () => {
  const r = room({ playing: 1, anchor_time: 0, anchor_wall: 1000, speed: 2 });
  const patch = Rooms.applyAction(r, 'pause', {}, 1002); // 推算到 4
  assert.equal(patch.playing, 0);
  approx(patch.anchor_time, 4);
  assert.equal(patch.anchor_wall, 1002);
});

test('seek：跳转到合法时码，播放状态沿用房间状态；越界/负数报错', () => {
  const paused = room({ playing: 0 });
  let patch = Rooms.applyAction(paused, 'seek', { time: 5.5 }, 2000);
  assert.equal(patch.playing, 0);
  assert.equal(patch.anchor_time, 5.5);
  assert.equal(patch.anchor_wall, 2000);

  const playing = room({ playing: 1 });
  patch = Rooms.applyAction(playing, 'seek', { time: 7 }, 2000);
  assert.equal(patch.playing, 1);
  assert.equal(patch.anchor_time, 7);

  // 边界 0 与 duration 合法；超出末尾拒绝；负数拒绝；非数字拒绝
  assert.equal(Rooms.applyAction(paused, 'seek', { time: 0 }, 2000).anchor_time, 0);
  assert.equal(Rooms.applyAction(paused, 'seek', { time: 10 }, 2000).anchor_time, 10);
  assert.throws(() => Rooms.applyAction(paused, 'seek', { time: 10.5 }, 2000), /超出房间固定版本/);
  assert.throws(() => Rooms.applyAction(paused, 'seek', { time: -0.01 }, 2000), /不得为负/);
  assert.throws(() => Rooms.applyAction(paused, 'seek', { time: 'x' }, 2000), /跳转时码无效/);
  assert.throws(() => Rooms.applyAction(paused, 'seek', {}, 2000), /跳转时码无效/);
});

test('speed：以当前推算位置重锚，切换瞬间时码连续；只接受 0.5/1/2', () => {
  const r = room({ playing: 1, anchor_time: 0, anchor_wall: 1000, speed: 1 });
  // 1002 时推算在 2；切到 0.5 后从 2 起步
  const patch = Rooms.applyAction(r, 'speed', { speed: 0.5 }, 1002);
  approx(patch.anchor_time, 2);
  assert.equal(patch.anchor_wall, 1002);
  assert.equal(patch.speed, 0.5);
  assert.equal(patch.playing, 1);

  // 数字字符串按数字处理；其他倍速与非数字拒绝
  assert.equal(Rooms.applyAction(r, 'speed', { speed: '2' }, 1000).speed, 2);
  assert.throws(() => Rooms.applyAction(r, 'speed', { speed: 3 }, 1000), /速度无效/);
  assert.throws(() => Rooms.applyAction(r, 'speed', { speed: 1.5 }, 1000), /速度无效/);
  assert.throws(() => Rooms.applyAction(r, 'speed', { speed: 'fast' }, 1000), /速度无效/);
});

test('未知动作与缺失动作明确报错', () => {
  const r = room();
  assert.throws(() => Rooms.applyAction(r, 'rewind', {}, 1), /未知控制动作/);
  assert.throws(() => Rooms.applyAction(r, '', {}, 1), /缺少控制动作/);
});
