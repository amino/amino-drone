var lockfile = require('lockfile')

function lockfileName (sha1sum) {
  return '/tmp/' + sha1sum + '.lock';
}

function lock (sha1sum, cb) {
  var opts = {
    stale: 60000,
    retries: 3,
    wait: 10000
  };
  lockfile.lock(lockfileName(sha1sum), opts, cb);
}
exports.lock = lock;

function unlock (sha1sum, cb) {
  lockfile.unlock(lockfileName(sha1sum), cb);
}
exports.unlock = unlock;