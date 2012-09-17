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
  this.respawn = (function (code, signal) {
    if (this.uptime < 10000) {
      this.emit('error', new Error('spawned command ran for less than 10 seconds - respawn aborted'));
      this.emit('exit');
      return;
    }
    var status = signal ? 'signal ' + signal : 'code ' + code;
    this.emit('stderr', 'exited with ' + status + '! attempting respawn.');
    this.spawn();
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
  this.process.once('exit', this.emit.bind('exit'));
  this.process.kill();
};

Process.__defineGetter__('uptime', function () {
  return new Date().getTime() - this.started.getTime();
});