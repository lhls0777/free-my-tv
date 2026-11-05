/*
 * Free My TV's service on LG webOS: one call to the TV's remote control API (127.0.0.1:3000) for the web app, and the
 * TV's processor and memory use for the performance card (stats: from /proc, which the page can't read).
 * Newer webOS gives each app's page its own origin (file://io.freemytv-webos), and the API closes any connection
 * that isn't from file:// ("invalid origin"); from here the handshake says file://.
 * Plain ES5 with Node's net only: older webOS ships an old Node.
 */
var fs = require('fs');
var net = require('net');
var Service = require('webos-service');

var service = new Service(require('./package.json').name);

function buffer(x) {   // Buffer.from is missing before Node 4.5
  return Buffer.from ? Buffer.from(x) : new Buffer(x);
}

/** A client's text frame: masked, as the protocol asks. */
function frame(text) {
  var data = buffer(text), n = data.length;
  var mask = buffer([Math.random() * 256 | 0, Math.random() * 256 | 0, Math.random() * 256 | 0, Math.random() * 256 | 0]);
  for (var i = 0; i < n; i++) data[i] ^= mask[i % 4];
  return Buffer.concat([buffer(n < 126 ? [0x81, 0x80 | n] : [0x81, 0xfe, n >> 8, n & 0xff]), mask, data]);
}

/** done({clientKey, payload}), {refused: true} when the person said no on the TV, or null. */
function call(uri, clientKey, done) {
  var socket = net.connect(3000, '127.0.0.1'), buf = buffer([]), open = false, text = '', finished = false;
  var timer = setTimeout(function () { finish(null); }, 90000);   // time to answer the TV's prompt
  function finish(result) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    socket.destroy();
    done(result);
  }
  function send(obj) {
    socket.write(frame(JSON.stringify(obj)));
  }
  function onMessage(m) {
    if (m.type === 'registered') {
      clientKey = m.payload['client-key'];
      send({type: 'request', id: 'call', uri: 'ssap://' + uri});
    } else if (m.id === 'call') {
      finish(m.type === 'error' ? null : {clientKey: clientKey, payload: m.payload});
    } else if (m.type === 'error') {
      finish(m.id === 'register' ? {refused: true} : null);
    }
  }
  socket.on('connect', function () {
    socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nOrigin: file://\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ZnJlZW15dHYtd2Vib3MtYXBp\r\n\r\n');
  });
  socket.on('data', function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    if (!open) {
      var end = buf.toString('binary').indexOf('\r\n\r\n');
      if (end < 0) return;
      if (!/^HTTP\/1\.1 101/.test(buf.toString('utf8', 0, 12))) { finish(null); return; }
      open = true;
      buf = buf.slice(end + 4);
      var payload = {forcePairing: false, pairingType: 'PROMPT',
        manifest: {manifestVersion: 1, appVersion: '1.0', permissions: ['READ_INSTALLED_APPS']}};
      if (clientKey) payload['client-key'] = clientKey;
      send({type: 'register', id: 'register', payload: payload});
    }
    // The server's frames: unmasked, a message possibly in several (continuation frames until FIN).
    while (buf.length >= 2) {
      var fin = buf[0] & 0x80, op = buf[0] & 0x0f, n = buf[1] & 0x7f, off = 2;
      if (n === 126) {
        if (buf.length < 4) return;
        n = buf.readUInt16BE(2);
        off = 4;
      } else if (n === 127) {
        if (buf.length < 10) return;
        n = buf.readUInt32BE(6);
        off = 10;
      }
      if (buf.length < off + n) return;
      var data = buf.slice(off, off + n);
      buf = buf.slice(off + n);
      if (op === 8) { finish(null); return; }
      if (op !== 1 && op !== 0) continue;
      text += data.toString('utf8');
      if (!fin) continue;
      var m = null;
      try { m = JSON.parse(text); } catch (e) {}
      text = '';
      if (m) onMessage(m);
    }
  });
  socket.on('error', function () { finish(null); });
  socket.on('close', function () { finish(null); });
}

service.register('ssap', function (message) {
  var p = message.payload || {};
  // Only the app list, the one call the page makes: nothing else goes to the TV's API, nor gets its client key.
  if (p.uri !== 'com.webos.applicationManager/listLaunchPoints') {
    message.respond({returnValue: false, errorText: 'Only listLaunchPoints'});
    return;
  }
  call(p.uri, p.clientKey, function (result) {
    if (!result) message.respond({returnValue: false, errorText: 'No answer from the remote control API'});
    else {
      result.returnValue = true;
      message.respond(result);
    }
  });
});

/** The processor's time so far, from the first line of /proc/stat: {idle, total} in clock ticks. */
function cpuTimes() {
  var line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0], parts = line.split(/\s+/), idle = 0, total = 0;
  for (var i = 1; i < parts.length; i++) {
    var n = parseInt(parts[i], 10);
    if (isNaN(n)) continue;
    total += n;
    if (i === 4 || i === 5) idle += n;   // idle and iowait
  }
  return {idle: idle, total: total};
}

/** The memory, in kB, from /proc/meminfo: {total, available}. */
function memory() {
  var lines = fs.readFileSync('/proc/meminfo', 'utf8').split('\n'), v = {};
  for (var i = 0; i < lines.length; i++) {
    var m = /^(\w+):\s+(\d+)/.exec(lines[i]);
    if (m) v[m[1]] = parseInt(m[2], 10);
  }
  // MemAvailable is there from Linux 3.14; before it, what's free plus the caches the kernel gives back.
  var available = v.MemAvailable !== undefined ? v.MemAvailable : (v.MemFree || 0) + (v.Buffers || 0) + (v.Cached || 0);
  return {total: v.MemTotal || 0, available: available};
}

function cores() {
  var n = (fs.readFileSync('/proc/stat', 'utf8').match(/^cpu\d+/gm) || []).length;
  return n || 1;
}

var lastCpu = null, lastAt = 0;

service.register('stats', function (message) {
  var first;
  try { first = cpuTimes(); } catch (e) {
    message.respond({returnValue: false, errorText: 'No /proc/stat: ' + e.message});
    return;
  }
  // The use since the last call, when there was one a moment ago (the card asks every 2 s); else over 500 ms now.
  var recent = lastCpu && Date.now() - lastAt < 10000;
  setTimeout(function () {
    var now = cpuTimes(), from = recent ? lastCpu : first;
    var total = now.total - from.total, idle = now.idle - from.idle;
    lastCpu = now;
    lastAt = Date.now();
    var result = {returnValue: true, cpu: total > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / total))) : null};
    try { result.cores = cores(); } catch (e) {}
    try {
      var mem = memory();
      result.memTotal = mem.total;
      result.memAvailable = mem.available;
    } catch (e) {}
    message.respond(result);
  }, recent ? 0 : 500);
});
