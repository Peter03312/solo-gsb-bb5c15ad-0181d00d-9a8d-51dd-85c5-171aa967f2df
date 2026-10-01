'use strict';

/*
 * 共享排演房间的纯函数状态逻辑（不依赖数据库，便于单元测试）。
 *
 * 房间固定某一已发布版本，保存：
 *  - playing：播放 / 暂停
 *  - anchor_time / anchor_wall：基准时码与对应的墙上时钟（Unix 秒）
 *  - speed：0.5 / 1 / 2 倍速
 *  - revision：修订号，每次成功控制 +1（乐观并发）
 *
 * 服务端只在「控制发生」的瞬间写入基准；任意时刻的当前时码由
 * anchor + (now - anchor_wall) * speed 推算，播放到版本末尾自动停住。
 * 因此服务重启只靠数据库里的基准行即可恢复进度。
 */

const SPEEDS = [0.5, 1, 2];

const EPS = 1e-9;

class RoomError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RoomError';
    this.status = status;
  }
}

// 与 server.js 的 toNum 同口径：数字或非空数字字符串通过，NaN/Infinity/其他类型拒绝
function toFiniteNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '' && v.trim() !== '-') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * 推算房间在 now（Unix 秒）时的状态。
 * 返回 { time, ended }：
 *  - 暂停：时码即基准时码（基准时码等于时长时视为已到末尾）；
 *  - 播放：基准时码 + 流逝墙钟 × 速度；到达/超过版本末尾则停在末尾（ended）。
 */
function projectRoom(room, now) {
  if (!room.playing) {
    return { time: room.anchor_time, ended: room.anchor_time >= room.duration - EPS };
  }
  const elapsed = Math.max(0, now - room.anchor_wall) * room.speed;
  const t = room.anchor_time + elapsed;
  if (t >= room.duration) return { time: room.duration, ended: true };
  return { time: t, ended: false };
}

/**
 * 应用一条持密钥者的控制动作，返回需要落库的字段补丁（revision 由调用方 +1）。
 * 任何非法输入抛 RoomError（携带 HTTP 状态码），且不产生补丁。
 *
 *  - play：从当前推算位置继续；已停在末尾时从头播放；
 *  - pause：以当前推算位置暂停；
 *  - seek：跳转到 0～duration 的时码（不改变播放/暂停状态）；
 *  - speed：设置 0.5/1/2 倍速，以当前推算位置重锚（改速不跳变）。
 */
function applyAction(room, action, body, now) {
  const cur = projectRoom(room, now);

  if (typeof action !== 'string' || action === '') {
    throw new RoomError(400, '缺少控制动作 action：须为 play / pause / seek / speed 之一');
  }

  switch (action) {
    case 'play': {
      if (cur.ended) {
        // 已停在版本末尾：再按播放从头开始（与单机播放器一致）
        return { playing: 1, anchor_time: 0, anchor_wall: now, speed: room.speed };
      }
      return { playing: 1, anchor_time: cur.time, anchor_wall: now, speed: room.speed };
    }

    case 'pause': {
      return { playing: 0, anchor_time: cur.time, anchor_wall: now, speed: room.speed };
    }

    case 'seek': {
      const t = toFiniteNum(body?.time);
      if (Number.isNaN(t)) {
        throw new RoomError(400, `跳转时码无效：${JSON.stringify(body?.time)}（须为非负数字秒数）`);
      }
      if (t < 0) throw new RoomError(400, `跳转时码无效：${t}（不得为负）`);
      if (t > room.duration + EPS) {
        throw new RoomError(
          400,
          `跳转时码 ${t} 超出房间固定版本的演出时长（末尾 ${room.duration} 秒）`
        );
      }
      const clamped = Math.min(Math.max(t, 0), room.duration);
      // 以跳转位置重锚；播放状态沿用房间当前状态
      return {
        playing: room.playing,
        anchor_time: clamped,
        anchor_wall: now,
        speed: room.speed,
      };
    }

    case 'speed': {
      const s = toFiniteNum(body?.speed);
      if (Number.isNaN(s) || !SPEEDS.some((x) => x === s)) {
        throw new RoomError(
          400,
          `速度无效：${JSON.stringify(body?.speed)}（仅支持现有倍速 0.5 / 1 / 2）`
        );
      }
      // 以当前推算位置重锚：速度切换瞬间时码连续、不跳变
      return { playing: room.playing, anchor_time: cur.time, anchor_wall: now, speed: s };
    }

    default:
      throw new RoomError(
        400,
        `未知控制动作：${JSON.stringify(action)}（须为 play / pause / seek / speed 之一）`
      );
  }
}

module.exports = { SPEEDS, EPS, RoomError, toFiniteNum, projectRoom, applyAction };
