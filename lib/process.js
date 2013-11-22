var inherits = require('util').inherits
  , spawn = require('child_process').spawn
  , idgen = require('idgen')

function Process (cmd, args, options) {
  this.cmd = cmd;
  this.args = args;
  this.options = {};
  Object.keys(options || {}).forEach(function (k) {
    this[k] = options[k];
  }, this.options);
  this.id = idgen();
  this.sha1sum = options.sha1sum;
  this.commit = options.commit;
  this.respawns = 0;
  this.respawn = (function (code, signal) {
    var status = signal ? 'signal ' + signal : 'code ' + code;
    this.emit('stderr', 'exited with ' + status);
    if (this.uptime < 10000) {
      this.emit('error', new Error('spawned command ran for less than 10 seconds - respawn aborted'));
      // Don't emit 'exit' when respawn is requested (as opposed to triggered on
      // process exit) because the process has not exited. If we emit, the
      // listener in ../index.js will delete the reference to this process
      // and we'll never be able to stop it. Even if we manually kill the process,
      // it will respawn!
      arguments.length && this.emit('exit');
      return;
    }
    if (arguments.length) {
      this.emit('stderr', 'respawning');
      this.respawns++;
      this.lastRespawn = new Date();
      this.spawn();
    }
    else {
      this.emit('stderr', 'respawn requested');
      this.process.kill();
    }
  }).bind(this);
  this.spawn();
  this.originallyStarted = new Date();
}
inherits(Process, require('events').EventEmitter);
module.exports = Process;

Process.prototype.spawn = function () {
  this.process = spawn(this.cmd, this.args, this.options);
  var self = this;
  this.process.stdout.on('data', function (chunk) {
    self.emit('stdout', chunk.toString().trim());
  });
  this.process.stderr.on('data', function (chunk) {
    self.emit('stderr', chunk.toString().trim());
  });
  this.pid = this.process.pid;
  this.started = new Date();
  this.process.once('exit', this.respawn);
};

Process.prototype.stop = function () {
  this.process.removeListener('exit', this.respawn);
  var self = this;
  this.process.once('exit', function (code, signal) {
    self.emit('stderr', 'exited');
    self.emit('exit');
  });
  this.process.kill();
};

Process.prototype.__defineGetter__('uptime', function () {
  return new Date().getTime() - this.started.getTime();
});

Process.prototype.toJSON = function () {
  return {
    id: this.id,
    pid: this.pid,
    uptime: this.uptime,
    cmd: this.cmd,
    args: this.args,
    env: this.options.env,
    respawns: this.respawns,
    lastRespawn: this.lastRespawn,
    sha1sum: this.sha1sum,
    commit: this.commit
  };
};