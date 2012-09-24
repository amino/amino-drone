var http = require('http')
  , formidable = require('formidable')
  , npm = require('npm')
  , amino = require('amino')
  , log = require('amino-log')
  , middler = require('middler')
  , sha1 = require('./lib/sha1')
  , path = require('path')
  , fs = require('fs')
  , rimraf = require('rimraf')
  , Process = require('./lib/process')
  , idgen = require('idgen')
  , lock = require('./lib/lock').lock
  , unlock = require('./lib/lock').unlock

function list (str) {
  return str.split(/ *, */).map(function (val) {
    return val.match(/^\d+$/) ? parseInt(val, 10) : val;
  });
}

function ifErr (err, label) {
  if (err) {
    label || (label = 'error');
    if (err.stack) {
      console.error(err.stack, label);
    }
    else {
      console.error(err, label);
    }
    process.exit(1);
  }
}

var tmp = '/tmp';

var program = require('commander')
  .version(require('./package').version)
  .usage('[dir]')
  .option('-s, --service <name[@version]>', 'drone service to create, with optional semver (default: app-drone)', 'app-drone')
  .option('-h, --host <host>', 'host to expose the drone service on (default: autodetect)')
  .option('-r, --redis <port/host/host:port/list>', 'redis server(s) used by the service (can be comma-separated)', list)
  .option('-t, --threads <count>', 'number of threads per spawn. (default: cpu count)', require('os').cpus().length)
  .option('--maxThreads <count>', 'max number of threads per deployment. (default: cpu count)', require('os').cpus().length)

program.parse(process.argv);

amino
  .use(log)
  .init({redis: program.redis, service: {host: program.host}})

var dir = path.resolve(program.args[0] || process.cwd());
process.chdir(dir);

var server = http.createServer();
  var ps = {}
    , deployments = {}

function findProcs (id) {
  var ret = [];
  Object.keys(ps).forEach(function (procId) {
    if (!id || procId === id || ps[procId].sha1sum === id || ps[procId].commit === id) {
      ret.push(ps[procId]);
    }
  });
  return ret;
}

function spawn (cmd, args, options) {
  var proc = new Process(cmd, args, options);
  var prefix = 'proc#' + proc.id + ':';
  proc.on('error', function (err) {
    amino.error('%s %s', prefix, err.stack || err.message);
  });
  proc.on('stdout', function (data) {
    amino.log('%s %s', prefix, data.trim());
  });
  proc.on('stderr', function (data) {
    amino.error('%s %s', prefix, data.trim());
  });
  proc.once('exit', function (code) {
    delete ps[proc.id];
  });
  ps[proc.id] = proc;
}

npm.load(function (err) {
  ifErr(err, 'npm load');

  middler()
    .add(function (req, res, next) {
      res.json = function json (data, status, headers) {
        status || (status = 200);
        headers || (headers = {});
        headers['Content-Type'] = 'application/json; charset=utf-8';
        data = JSON.stringify(data, null, 2);
        headers['Content-Length'] = data.length;
        res.writeHead(status, headers);
        res.end(data);
      };
      next();
    })
    .get(['/ps/:id', '/ps'], function (req, res, next) {
      var procs = findProcs(req.params.id);
      res.json({status: 'ok', ps: procs.reduce(function (prev, proc) {
        prev[proc.id] = proc;
        return prev;
      }, {})});
    })
    .post(['/ps/:id/respawn', '/respawn'], function (req, res, next) {
      var count = 0;
      findProcs(req.params.id).map(function (proc) {
        proc.respawn();
        count++;
      });
      res.json({status: 'ok', count: count});
    })
    .delete(['/ps/:id', '/ps'], function (req, res, next) {
      var count = 0;
      findProcs(req.params.id).map(function (proc) {
        proc.stop();
        count++;
      });
      res.json({status: 'ok', count: count});
    })
    .get('/deployments', function (req, res, next) {
      res.json({status: 'ok', deployments: Object.keys(deployments)});
    })
    .get('/deployments/:id', function (req, res, next) {
      if (typeof deployments[req.params.id] !== 'undefined' || fs.existsSync(req.params.id)) {
        res.json({status: 'ok'});
      }
      else {
        res.json({status: 'error', error: 'deployment not found'}, 404);
      }
    })
    .put('/deployments/:id', function (req, res, next) {
      console.log('receiving deployment for sha1 ' + req.params.id);
      var form = new formidable.IncomingForm();
      function ifErr (err, label) {
        if (err) {
          label || (label = 'deployment error');
          console.error(err.stack, label);
          unlock(req.params.id, function (){});
          res.json({status: 'error', error: label + ': ' + err.message}, 400);
          return true;
        }
      }
      form.once('error', function (err) {
        ifErr(err, 'form');
      });
      form.hash = 'sha1';
      form.parse(req, function (err, fields, files) {
        if (ifErr(err, 'form parse')) return;
        console.log('payload received');
        if (typeof files.payload === 'undefined') {
          console.log('error: no payload uploaded');
          return res.json({status: 'error', error: 'no payload uploaded'}, 400);
        }
        if (files.payload.hash !== req.params.id) {
          console.log('error: deployment id does not match sha1 sum of payload');
          return res.json({status: 'error', error: 'deployment id in URL must match sha1 sum of payload'}, 400);
        }
        if (fields.sha1sum && fields.sha1sum.length && files.payload.hash !== fields.sha1sum) {
          console.log('error: uploaded payload has bad sha1 sum');
          return res.json({status: 'error', error: 'uploaded payload has bad sha1 sum: ' + files.payload.hash}, 400);
        }

        var tmpInstall = path.join(tmp, idgen());
        lock(req.params.id, function (err) {
          ifErr(err, 'lock');
          npm.commands.install(tmpInstall, [files.payload.path], function (err) {
            if (ifErr(err, 'npm install')) return;
            fs.unlink(files.payload.path, function () {
              if (ifErr(err, 'delete upload')) return;
              fs.rename(path.join(tmpInstall, 'node_modules', fields.name), req.params.id, function (err) {
                if (ifErr(err, 'move deploy')) return;
                unlock(req.params.id, function () {
                  rimraf(tmpInstall, function (err) {
                    if (ifErr(err, 'delete tmp')) return;
                    deployments[req.params.id] = true;
                    res.json({status: 'ok'}, 201);
                    console.log('deployed ok');
                  });
                });
              });
            });
          });
        });
      });
    })
    .post('/deployments/:id/spawn', function (req, res, next) {
      if (!deployments[req.params.id] && !fs.existsSync(req.params.id)) {
        return res.json({status: 'error', error: 'deployment not found'}, 404);
      }
      deployments[req.params.id] = true;
      function ifErr (err, label) {
        if (err) {
          label || (label = 'spawn error');
          console.error(err.stack, label);
          res.json({status: 'error', error: label + ': ' + err.message}, 400);
          return true;
        }
      }
      var form = new formidable.IncomingForm();
      form.once('error', function (err) {
        ifErr(err, 'form');
      });
      form.parse(req, function (err, fields, files) {
        if (ifErr(err, 'form parse')) return;
        var running = Object.keys(ps).reduce(function (count, id) {
          if (ps[id].sha1sum === req.params.id) count++;
          return count;
        }, 0);
        var threads = parseInt(fields.threads, 10) || program.threads;
        if (threads + running > program.maxThreads) {
          threads = program.maxThreads - running;
        }
        for (var i = 0; i < threads; i++) {
          var cmd = fields.cmd
            , args = JSON.parse(fields.args)
            , env = JSON.parse(fields.env)
          Object.keys(process.env).forEach(function (k) {
            if (typeof this[k] === 'undefined') this[k] = process.env[k];
          }, env);
          spawn(cmd, args, {
            cwd: req.params.id,
            env: env,
            sha1sum: req.params.id,
            commit: fields.commit
          });
        }
        res.json({status: 'ok'}, 200);
      });
    })
    .post('/deployments/:id/redeploy', function (req, res, next) {
      function ifErr (err, label) {
        if (err) {
          label || (label = 'redeploy error');
          console.error(err.stack, label);
          res.json({status: 'error', error: label + ': ' + err.message}, 400);
          return true;
        }
      }
      if (!deployments[req.params.id] && !fs.existsSync(req.params.id)) {
        return res.json({status: 'error', error: 'deployment not found'}, 404);
      }
      function redeploy (err, fields, files) {
        if (ifErr(err, 'form parse')) return;
        var count = 0;
        Object.keys(ps).forEach(function (id) {
          var proc = ps[id];
          if (proc.sha1sum !== req.params.id) {
            count++;
            proc.stop();
            spawn(proc.cmd, proc.args, {
              cwd: req.params.id,
              env: proc.options.env,
              sha1sum: req.params.id,
              commit: fields.commit
            });
          }
        });
        res.json({status: 'ok', count: count});
      }
      var form = new formidable.IncomingForm();
      form.once('error', function (err) {
        if (err.message && err.message.match(/no content\-type/)) return redeploy(null, {}, {});
        ifErr(err, 'form');
      });
      form.parse(req, redeploy);
    })
    .add(function (req, res, next) {
      res.json({status: 'error', error: 'resource not found'}, 404);
    })
    .attach(server)

  var service = amino.createService(program.service, server);
  server.once('listening', function () {
    console.log(service.spec + ' started');
  });
});