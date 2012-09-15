var http = require('http')
  , formidable = require('formidable')
  , npm = require('npm')
  , amino = require('amino')
  , middler = require('middler')
  , sha1 = require('./lib/sha1')

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

var program = require('commander')
  .version(require('./package').version)
  .option('-s, --service <name[@version]>', 'drone service to create, with optional semver (default: app-drone)', 'app-drone')
  .option('-r, --redis <port/host/host:port/list>', 'redis server(s) used by the service (can be comma-separated)', list)
  .option('-t, --threads <count>', 'number of threads to use for deployments. (default: cpu count)', require('os').cpus().length)

program.parse(process.argv);

amino.init({redis: program.redis});

npm.load(function (err) {
  ifErr(err);
  var server = http.createServer();
  var ps = []
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
      if (typeof deployments[req.params.id] !== 'undefined') {
        res.json({status: 'ok'});
      }
      else {
        res.json({status: 'error', error: 'deployment not found'}, 404);
      }
    })
    .put('/deployments/:id', function (req, res, next) {
      console.log('receiving deployment for sha1 ' + req.params.id);
      var form = new formidable.IncomingForm();
      form.once('error', function (err) {
        console.error(err.stack);
        return res.json({status: 'error', error: 'unable to parse upload: ' + err.message}, 400);
      });
      form.hash = 'sha1';
      form.parse(req, function (err, fields, files) {
        if (err) {
          console.error(err.stack);
          return res.json({status: 'error', error: 'unable to parse upload'}, 400);
        }
        if (typeof files.payload === 'undefined') {
          return res.json({status: 'error', error: 'no payload uploaded'}, 400);
        }
        if (files.payload.hash !== req.params.id) {
          return res.json({status: 'error', error: 'deployment id must match sha1 sum of payload'});
        }
        if (fields.sha1sum && fields.sha1sum.length && files.payload.hash !== fields.sha1sum) {
          return res.json({status: 'error', error: 'uploaded payload has bad sha1 sum: ' + files.payload.hash}, 400);
        }
        npm.commands.cache(['add', files.payload.path], function (err) {
          if (err) {
            console.error(err.stack);
            return res.json({status: 'error', error: 'npm could not install payload'}, 500);
          }
          deployments[files.payload.hash] = true;
          res.json({status: 'ok'}, 201);
          console.log('deployed ok');
        });
      });
    })
    .post('/spawn', function (req, res, next) {
      res.json({status: 'ok', pid: 123}, 200, {'Location': '/ps/123'});
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