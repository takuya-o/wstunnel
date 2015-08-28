// Generated by CoffeeScript 1.8.0
(function() {
  var client, config, exec, future, log, net, path, server, wst, _log;

  (require("source-map-support")).install();

  exec = require('child_process').exec;

  path = require('path');

  wst = require("../lib/wst");

  net = require("net");

  _log = require("lawg");

  future = require("phuture");

  log = function(msg) {
    return _log(msg + "\n");
  };

  config = {
    s_port: 19001,
    t_port: 22,
    ws_port: 19000,
    host: '127.0.0.1'
  };

  server = new wst.server;

  client = new wst.client;

  client.setHttpOnly(true);

  module.exports["setup ws tunnel"] = function(test) {
    return server.start("" + config.host + ":" + config.ws_port, function(err) {
      test.ifError(err);
      log('ws server is setup');
      return client.start("" + config.host + ":" + config.s_port, "ws://" + config.host + ":" + config.ws_port, "" + config.host + ":" + config.t_port, function(err) {
        test.ifError(err);
        log("tunnel is setup");
        return test.done();
      });
    });
  };

  module.exports['ssh'] = function(test) {
    var cmdline;
    cmdline = "ssh -oUserKnownHostsFile=/dev/null -oStrictHostKeyChecking=no -p " + config.s_port + " " + config.host + " \"echo 'echo'\"";
    return exec(cmdline, function(err, stdout, stderr) {
      if (err) {
        log(err);
      }
      log('ssh done ' + stdout);
      test.ok(/echo/.test(stdout));
      test.done();
      return future.once(200, function() {
        return process.exit(0);
      });
    });
  };

}).call(this);

//# sourceMappingURL=testssh.js.map
