var http = require('http')
  , formidable = require('formidable')
  , npm = require('npm')
  , amino = require('amino')
  , middler = require('middler')
  , sha1 = require('./lib/sha1')
  , path = require('path')
  , fs = require('fs')
  , rimraf = require('rimraf')
  , Process = require('./lib/process')
  , idgen = require('idgen')

function list (str) {
  return str.split(/ *, */).map(function (val) {
    return val.match(/^\d+$/) ? parseInt(val, 10) : val;
  });
}

function ifErr (err) {
  if (err) {
    if (err.stack) {
      console.error(err.stack);
    }
    else {
      console.error(err);
    }
    process.exit(1);
  }
}

var tmp = '/tmp';

var program = require('commander')
  .version(require('./package').version)
  .usage('[dir]')
  .option('-s, --service <name[@version]>', 'drone service to create, with optional semver (default: app-drone)', 'app-drone')
  .option('-r, --redis <port/host/host:port/list>', 'redis server(s) used by the service (can be comma-separated)', list)
  .option('-t, --threads <count>', 'number of threads to use for deployments. (default: cpu count)', require('os').cpus().length)

program.parse(process.argv);

amino.init({redis: program.redis});

var dir = path.resolve(program.args[0] || process.cwd());
process.chdir(dir);

npm.load(function (err) {
  ifErr(err);
  var server = http.createServer();
  var ps = {}
    , deployments = {}

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
    .get('/ps', function (req, res, next) {

    })
    .get('/ps/:id', function (req, res, next) {

    })
    .get('/deployments', function (req, res, next) {

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
      function ifErr (err) {
        if (err) {
          console.error(err.stack);
          res.json({status: 'error', error: 'deployment error: ' + err.message}, 400);
          return true;
        }
      }
      form.once('error', ifErr);
      form.hash = 'sha1';
      form.parse(req, function (err, fields, files) {
        if (ifErr(err)) return;
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
        npm.commands.install(tmpInstall, [files.payload.path], function (err) {
          fs.unlink(files.payload.path, function () {
            if (ifErr(err)) return;
            fs.rename(path.join(tmpInstall, 'node_modules', fields.name), req.params.id, function (err) {
              if (ifErr(err)) return;
              rimraf(tmpInstall, function () {
                deployments[req.params.id] = true;
                res.json({status: 'ok'}, 201);
                console.log('deployed ok');
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
      function ifErr (err) {
        if (err) {
          console.error(err.stack);
          res.json({status: 'error', error: 'spawn error: ' + err.message}, 400);
          return true;
        }
      }
      var form = new formidable.IncomingForm();
      form.once('error', ifErr);
      form.parse(req, function (err, fields, files) {
        if (ifErr(err)) return;
        var threads = parseInt(fields.threads, 10) || program.threads;
        for (var i = 0; i < threads; i++) {
          var cmd = fields.cmd
            , args = JSON.parse(fields.args)
            , env = JSON.parse(fields.env)
          Object.keys(process.env).forEach(function (k) {
            if (typeof this[k] === 'undefined') this[k] = process.env[k];
          }, env);
          (function (proc) {
            var prefix = 'proc#' + proc.id + ':';
            proc.on('error', console.error.bind(console, prefix));
            proc.on('stdout', console.log.bind(console, prefix));
            proc.on('stderr', console.error.bind(console, prefix));
            proc.once('exit', function () {
              delete ps[proc.id];
            });
            ps[proc.id] = proc;
          })(new Process(cmd, args, {
            cwd: req.params.id,
            env: env,
            sha1sum: req.params.id,
            commit: fields.commit
          }));
        }
        res.json({status: 'ok'}, 200);
      });
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