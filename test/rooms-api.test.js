'use strict';

// 共享排演房间的 HTTP 端到端测试：每个测试文件独立临时库，require server.js 时不自动监听，
// 由本文件用 app.listen(0) 起一个临时端口。
process.env.NODE_ENV = 'test';
process.env.DB_PATH = require('node:path').join(
  require('node:os').tmpdir(),
  `cue-rooms-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
);

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app } = require('../server.js');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function call(method, urlPath, body) {
  return new Promise((resolve) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      base + urlPath,
      {
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, raw: data });
        });
      }
    );
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 建一盏灯 + 一条指定时长渐变 Cue，发布版本，返回版本 id。
// 本文件各测试共用一个库（同版 API 语义），发布前清空草稿 Cue，
// 保证快照时长只由本次 Cue 决定（灯具累积不影响房间行为）。
async function publishVersion(label = '首演', cueDuration = 10) {
  const existingCues = await call('GET', '/api/cues');
  for (const c of existingCues.json) {
    await call('DELETE', `/api/cues/${c.id}`);
  }
  const r = await call('POST', '/api/lights', { name: `灯-${Math.random()}` });
  const lightId = r.json.id;
  await call('POST', '/api/cues', {
    light_id: lightId,
    time: 0,
    target: 100,
    duration: cueDuration,
  });
  const v = await call('POST', '/api/versions', { label });
  return { versionId: v.json.id, lightId, duration: cueDuration };
}

test('基于已发布版本创建房间：返回房间码、控制密钥、快照与初始暂停状态', async () => {
  const { versionId } = await publishVersion();
  const r = await call('POST', '/api/rooms', { version_id: versionId, label: '联排房' });
  assert.equal(r.status, 201);
  assert.match(r.json.code, /^[A-Z2-9]{6}$/);
  assert.match(r.json.control_key, /^[0-9a-f]{32}$/);
  assert.equal(r.json.version.id, versionId);
  assert.equal(r.json.playing, false);
  assert.equal(r.json.time, 0);
  assert.equal(r.json.speed, 1);
  assert.equal(r.json.revision, 0);
  assert.equal(r.json.duration, 10);
  assert.ok(Array.isArray(r.json.lights) && r.json.lights.length === 1);
  assert.ok(Array.isArray(r.json.cues) && r.json.cues.length === 1);
});

test('创建房间：无效版本编号 400，不存在版本 404', async () => {
  let r = await call('POST', '/api/rooms', { version_id: 'x' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /版本编号无效/);
  r = await call('POST', '/api/rooms', {});
  assert.equal(r.status, 400);
  r = await call('POST', '/api/rooms', { version_id: 999999 });
  assert.equal(r.status, 404);
  assert.match(r.json.error, /版本不存在/);
});

test('观看者凭房间码加入：无密钥也能取得状态与快照；错误房间码 404', async () => {
  const { versionId } = await publishVersion();
  const created = (await call('POST', '/api/rooms', { version_id: versionId })).json;

  const ok = await call('GET', `/api/rooms/${created.code}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.host, false);
  assert.equal(ok.json.code, created.code);

  assert.equal((await call('GET', '/api/rooms/ZZZZZZ')).status, 404);
  assert.equal((await call('GET', '/api/rooms/abc')).status, 404);
});

test('控制：持密钥者播放推进时码、暂停固化、跳转、改速，修订号每次 +1', async () => {
  const { versionId } = await publishVersion();
  const room = (await call('POST', '/api/rooms', { version_id: versionId })).json;

  let r = await call('POST', `/api/rooms/${room.code}/control`, {
    key: room.control_key,
    revision: 0,
    action: 'seek',
    time: 2,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.revision, 1);
  assert.equal(r.json.time, 2);
  assert.equal(r.json.playing, false);

  r = await call('POST', `/api/rooms/${room.code}/control`, {
    key: room.control_key,
    revision: 1,
    action: 'speed',
    speed: 2,
  });
  assert.equal(r.json.speed, 2);
  assert.equal(r.json.revision, 2);

  r = await call('POST', `/api/rooms/${room.code}/control`, {
    key: room.control_key,
    revision: 2,
    action: 'play',
  });
  assert.equal(r.json.playing, true);
  assert.equal(r.json.revision, 3);

  await sleep(1000);
  const watching = (await call('GET', `/api/rooms/${room.code}`)).json;
  assert.equal(watching.playing, true);
  // 2 倍速播放约 1 秒：应推进约 2 秒（放宽到 1.4~2.6，避免调度抖动）
  assert.ok(watching.time > 3.4 && watching.time < 4.6, `time=${watching.time}`);

  r = await call('POST', `/api/rooms/${room.code}/control`, {
    key: room.control_key,
    revision: 3,
    action: 'pause',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.playing, false);
  assert.equal(r.json.revision, 4);
  const pausedTime = r.json.time;
  await sleep(300);
  const still = (await call('GET', `/api/rooms/${room.code}`)).json;
  assert.equal(still.playing, false);
  approxAssert(still.time, pausedTime, 1e-6);
});

test('过期修订号返回 409 且不改房间（成功后旧号再提交仍冲突）', async () => {
  const { versionId } = await publishVersion();
  const room = (await call('POST', '/api/rooms', { version_id: versionId })).json;

  const first = await call('POST', `/api/rooms/${room.code}/control`, {
    key: room.control_key,
    revision: 0,
    action: 'seek',
    time: 3,
  });
  assert.equal(first.json.revision, 1);

  const stale = await call('POST', `/api/rooms/${room.code}/control`, {
    key: room.control_key,
    revision: 0,
    action: 'pause',
  });
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /修订号冲突/);

  const view = (await call('GET', `/api/rooms/${room.code}`)).json;
  assert.equal(view.revision, 1); // 仍是 1，过期提交没有产生控制
  approxAssert(view.time, 3, 1e-6);
  assert.equal(view.playing, false);
});

test('错误/缺失密钥：控制 403、观看带错 key 403；无 key 不允许控制 400', async () => {
  const { versionId } = await publishVersion();
  const room = (await call('POST', '/api/rooms', { version_id: versionId })).json;

  let r = await call('POST', `/api/rooms/${room.code}/control`, {
    key: '0'.repeat(32),
    revision: 0,
    action: 'play',
  });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /控制密钥无效/);

  r = await call('POST', `/api/rooms/${room.code}/control`, { revision: 0, action: 'play' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /控制密钥/);

  r = await call('GET', `/api/rooms/${room.code}?key=wrong`);
  assert.equal(r.status, 403);

  // 正确密钥以 query 携带时标记 host=true
  r = await call('GET', `/api/rooms/${room.code}?key=${room.control_key}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.host, true);
});

test('非法时码与非法速度返回 400，且修订号不变', async () => {
  const { versionId } = await publishVersion();
  const room = (await call('POST', '/api/rooms', { version_id: versionId })).json;
  const ctrl = (body) =>
    call('POST', `/api/rooms/${room.code}/control`, { key: room.control_key, revision: 0, ...body });

  let r = await ctrl({ action: 'seek', time: -1 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /不得为负/);
  r = await ctrl({ action: 'seek', time: 11 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /超出房间固定版本/);
  r = await ctrl({ action: 'seek', time: 'x' });
  assert.equal(r.status, 400);
  r = await ctrl({ action: 'speed', speed: 3 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /速度无效/);
  r = await ctrl({ action: 'speed', speed: 1.5 });
  assert.equal(r.status, 400);
  r = await ctrl({ action: 'explode' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /未知控制动作/);

  const view = (await call('GET', `/api/rooms/${room.code}`)).json;
  assert.equal(view.revision, 0);
  assert.equal(view.time, 0);
});

test('播放到版本末尾自动停住：到点后观看端看到 playing=false 且时码为末尾，修订号不变', async () => {
  const { versionId } = await publishVersion('短版', 1);
  const room = (await call('POST', '/api/rooms', { version_id: versionId })).json;

  await call('POST', `/api/rooms/${room.code}/control`, {
    key: room.control_key,
    revision: 0,
    action: 'play',
  });
  await sleep(2200); // 1 秒时长，留足调度余量，必然已到末尾

  const view = (await call('GET', `/api/rooms/${room.code}`)).json;
  assert.equal(view.playing, false);
  assert.equal(view.ended, true);
  assert.equal(view.time, 1);
  assert.equal(view.revision, 1); // 自动停住不增加修订号

  // 自动停住已惰性落库：再次播放从头开始
  const replay = await call('POST', `/api/rooms/${room.code}/control`, {
    key: room.control_key,
    revision: 1,
    action: 'play',
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.playing, true);
  assert.ok(replay.json.time < 0.1, `replay time=${replay.json.time}`);
});

test('房间固定创建时版本：之后改草稿并发新版，房间快照与进度不受影响', async () => {
  const v = await publishVersion('旧版');
  const room = (await call('POST', '/api/rooms', { version_id: v.versionId })).json;

  // 改草稿：新增灯具/Cue，再发布新版本
  const newLight = (await call('POST', '/api/lights', { name: `新增-${Math.random()}` })).json;
  await call('POST', '/api/cues', { light_id: newLight.id, time: 0, target: 10, duration: 0 });
  await call('POST', '/api/versions', { label: '新版' });

  // 做一次控制，确认返回的仍是旧版快照
  const ctrl = await call('POST', `/api/rooms/${room.code}/control`, {
    key: room.control_key,
    revision: 0,
    action: 'seek',
    time: 1,
  });
  assert.equal(ctrl.json.version.id, v.versionId);
  // 房间固定旧版快照：新版本发布后新增的灯具与其 Cue 不在房间快照中
  // （同库早期测试留下的草稿灯具/Cue 会进入 v 发布时的快照，故按新灯具编号判定）
  assert.ok(
    !ctrl.json.lights.some((l) => l.id === newLight.id),
    '房间快照意外包含了发布后新增的灯具'
  );
  assert.ok(
    !ctrl.json.cues.some((c) => c.light_id === newLight.id),
    '房间快照意外包含了发布后新增的 Cue'
  );
  assert.ok(ctrl.json.cues.some((c) => c.light_id === v.lightId));
});

function approxAssert(actual, expected, eps) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} !=~ ${expected}`);
}
