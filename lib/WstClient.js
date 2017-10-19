
let wst_client;
const net = require("net");
const WsStream = require("./WsStream");
const url = require('url');
const log = require("lawg");
const ClientConn = require("./httptunnel/ClientConn");
const etagHeader = require("./etagHeader");
const createWsClient = () => new (require('websocket').client)();
const http = require('http');
const https = require('https');
const querystring = require('querystring');

const debug = require('debug')('wst');
const DispatchMaxDepth = 7;    // despatchの最大深さ

module.exports = (wst_client = class wst_client extends require('events').EventEmitter {
  /*
  emit Events:
  'tunnel' (WsStream|ClientConn) when a tunnel is established
  'connectFailed' (err) when ws connection failed
  'connectHttpFailed' (err) when http tunnel connection failed
  */

  constructor() {
    super();
    this.tcpServer = net.createServer();
  }

  verbose() { //tunnelの開始/close及びエラーlog出力
    this.on('tunnel', (ws, sock) => {
      if (ws instanceof WsStream) {
        log('Websocket tunnel established');
      } else { log('Http tunnel established'); }
      return sock.on('close', () => log('Tunnel closed'));
    });
    this.on('connectHttpFailed', error => log(`HTTP connect error: ${error.toString()}`));
    return this.on('connectFailed', error => log(`WS connect error: ${error.toString()}`));
  }

  setHttpOnly(httpOnly) {
    this.httpOnly = httpOnly;
  }

  // example:  start(8081, "wss://ws.domain.com:454", "dst.domain.com:22")
  // meaning: tunnel *:localport to remoteAddr by using websocket connection to wsHost
  // or start("localhost:8081", "wss://ws.domain.com:454", "dst.domain.com:22")
  // @wsHostUrl:  ws:// denotes standard socket, wss:// denotes ssl socket
  //              may be changed at any time to change websocket server info
  start(localAddr, wsHostUrl, remoteAddr, optionalHeaders, cb) {
    let localHost, localPort;
    this.wsHostUrl = wsHostUrl;
    if (typeof optionalHeaders === 'function') {
      cb = optionalHeaders;
      optionalHeaders = {};
    }

    if (typeof localAddr === 'number') {
      localPort = localAddr; //数字だけだとPort
    } else {
      [localHost, localPort] = Array.from(localAddr.split(':'));
      if (/^\d+$/.test(localHost)) {  //TODO: ホスト名が数字だとPortに勘違いされる危険性
        localPort = localHost;
        localHost = null;
      }
      localPort = parseInt(localPort);
    }
    if (localHost == null) { localHost = '127.0.0.1'; }

    this.tcpServer.listen(localPort, localHost, cb);
    return this.tcpServer.on("connection", tcpConn => {
      const bind = (s, tcp) => {
        require("./bindStream")(s, tcp);
        return this.emit('tunnel', s, tcp);
      };
      debug("Cookie: " + optionalHeaders["cookie"]);
      if (this.httpOnly) {
        return this._httpConnect(this.wsHostUrl, remoteAddr, optionalHeaders, (err, httpConn) => {
          if (!err) {
            return bind(httpConn, tcpConn);
          } else { return tcpConn.end(); }
        });
      } else {
        return this._wsConnect(this.wsHostUrl, remoteAddr, optionalHeaders, (error, wsStream) => {
          if (!error) {
            return bind(wsStream, tcpConn);
          } else {
            debug("WebSocketコネクト失敗:" + error);
            //dispatchで呼べるように request()のリターン値の型に揃える
            let match = new RegExp("a non-101 status: (\\d+)").exec(error.toString());
            let statusCode = 0;
            if ( match != null ) {
              statusCode = parseInt(match[1]);
            }
            if ( statusCode == 302 ) {
              debug("Found 302\n");
              let location = RegExp("[lL]ocation: (https?://([\\w-]+\\.)+[\\w-]+(/[\\w- ./?%&=]*)?)").exec(error.toString());
              if ( location != null ) {
                let response = {};
                response.statusCode = statusCode;
                let headers = {};
                headers["location"] = location[1];
                response.headers = headers;
                this._dispatch(0, response, null, (cookie) => {
                  if ( cookie != null && typeof cookie === "object" ) { //Error ※nullもobject
                    //instanceof Error
                    debug("ERR: checkCAPTCHA()");
                    this.emit('connectFailed', cookie);
                    return tcpConn.end();
                  }
                  if ( cookie ) { //cookie !=null !=undefined
                    optionalHeaders["cookie"] = cookie;
                  }
                  return this._wsConnect(this.wsHostUrl, remoteAddr, optionalHeaders, (error, wsStream) => {
                    if (!error) {
                      debug("OK: After 302 Response WS:");
                      return bind(wsStream, tcpConn);
                    } else {
                      debug("ERR: After 302 Response WS:");
                      this.emit('connectFailed', error);
                      return tcpConn.end();
                    }
                  });
                });
                return true;
              }
              //302なのにlocationが無いなんて failsafe
              debug("Can not find location for 302.");
              this.emit('connectFailed', error);
              return tcpConn.end();
            } else { //!302
              debug("Can not find 302");
              this.emit('connectFailed', error);
              //ws -> http フェイルオーバー
              return this._httpConnect(this.wsHostUrl, remoteAddr, optionalHeaders, (err, httpConn) => {
                if (!err) {
                  return bind(httpConn, tcpConn);
                } else { return tcpConn.end(); }
              });
            }
          }
        });
      }
    }); //END on "connection"
  }

  /*
    _dispatch() HTTPレスポンス処理
    depth:number                        リカーシブコールの深さ DispatchMaxDepth以上になるとエラー
    response:http.IncomingMessage|null  Node.js HTTP | エラー時
    rawData:String|Error                HTTPのコンテンツ | エラー時のエラーコード
    cb:function (cookie, error)
         coookie:String                 追加されたCookie
         error:null|Error               正常|エラー時のコードコード
    (option)
    form:String                        CAPTCHA入力フォーム - GoogleVisionAPIからリターン時
  */
  _dispatch(depth, response, rawData,  cb, form) {
    if ( !response ) { //response == nullは エラーで rawDataにErrorが入っている
      debug("dispatch(%d): find error %s", ++depth,  rawData.message);
      cb(rawData);
      return;
    }
    debug("dispatch(%d): %s ", ++depth, response.statusCode + JSON.stringify(response.headers) );
    if ( depth > DispatchMaxDepth ) {
      let error = new Error("Too deep on dispatch.");
      debug(error.message);
      cb(error); //エラーリターン
      return;
    }
    if ( response.statusCode == 302 ) { // 302転送
      let cookieHeaders = response.headers["set-cookie"];
      let cookie = null;
      if ( cookieHeaders != null ) {
        cookie = /(^[^ ]+)/.exec(cookieHeaders[0])[1];
        debug("Found cookie: %s", cookie);
      }
      let locationURL = response.headers["location"];
      let location = url.parse(locationURL);
      let wsHost = url.parse(this.wsHostUrl)
      if ( location.host == wsHost.host && location.path == wsHost.path ) {
        // ついに通過して 元のURLに転送
        debug("Start 302 WS:");
        cb(cookie);//完成!
      } else {
        //転送するものは、転送する
        this._request(locationURL, (response, rawData) => {
          this._dispatch(depth, response, rawData, cb);
        });
      }
    } else if ( response.statusCode == 200 ) {
      try {
        let forms = /<form [^]* <\/form>/i.exec(rawData); //入力フォームが有るかcheck
        if ( forms != null ) {  // CAPTCHA入力フォームらしい
          debug("レスポンス画像解析");
          //データ取得
          let base64 = /src="data:image\/png;base64,([A-Za-z\d\/+]*=*)" width="[\d]+(|px)" height="[\d]+(|px)"/.exec(rawData)[1];
          //画像解析リクエストパラメータ設定
          const googleVisionAPI = "https://vision.googleapis.com/v1/images:annotate?key=" +
                process.env.APIKEY; //Google Vision API key
          const requests = JSON.stringify( { requests: [ {
            "image": { "content": base64 },
            "features": [ { "type": "TEXT_DETECTION", "maxResults": 1 } ]
          } ]} );
          const headers ={
            "Content-Type": "application/json",
            "Referer": response.req.path,
            "Accept":  "application/json, text/javascript, */*; q=0.01"
          };
          debug("POST GoogleVision:");
          //debug("%s\n%s\n", JSON.stringify(options), requests);
          this._request(googleVisionAPI, requests, headers, (response, rawData) => {
            this._dispatch(depth, response, rawData, cb, forms[0]);  //TODO: 複数フォーム //TODO: 見つからない場合
          });
        } else if ( response.headers["content-type"].match("application/json") ) {
          debug("GoogleVisionAPIからのリターン");
          //TODO: 答えが出なかったとき
          let ans = JSON.parse(rawData).responses[0].fullTextAnnotation.text.replace("\n", ""); //改行除去
          debug("FORM送信 ANS=%s", ans);
          let formAction = /<form method="(get|post)" action=([^>]+)>/i.exec(form)[2];
          let inputs = form.match(/<input [^>]+>/gi); //inputパラメータ取得
          let ansData = {}; //form input送信データ作成
          for ( let input of inputs ) {
            let type = /type=\"([^\"]+)\"/.exec(input)[1];
            let names = /name=\"([^\"]+)\"/.exec(input);
            if ( type == "text" ) {
              ansData[names[1]] = ans;
            } else if ( type == "hidden" ) {
              ansData[names[1]] = /value=\"([^\"]+)\"/.exec(input)[1];
            } else if ( type == "submit" || type == "button" || type == "reset" ||
                        type == "image" || type == "file" ) {
              //無視
            } else {
              log("Unexpected input type %s", type);
            }
          }
          //FORMに結果送信 form action
          this._request(formAction, querystring.stringify( ansData ), (response, rawData) => {
            this._dispatch(depth, response, rawData, cb);
          });
        } else { //どこからの200レスポンスか不明
          debug("知らない画面");
          let error = new Error('Unknow 200 Contents')
          cb(error); //とりあえずエラーにしてしまう
        }
      } catch (e) { //200処理中で例外発生
        let error = new Error("Exception in response.end: " + e.message);
        debug(error.message);
        cb(error);
      }
    } else { // 302でも200でも無い時は来ないけどFallsafe
      let error = new Error('Request Failed.\n' +`Status Code: ${response.statusCode}`);
      debug("Request Response Error: %s", error.message);
      cb(error);
    }
  }

  _request(location, data, headers, response) {
    if ( typeof data === 'function' ) {
      response = data;
      data = null;
      headers = null;
    } else if ( typeof headers === 'function' ) {
      response = headers;
      headers = null;
    }
    let options = url.parse(location);
    const protocol = (options.protocol == "https:") ? https : http;
    if ( data != null ) {
      if ( headers == null ) {
        options["headers"] = {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data)
        };
      } else {
        options["headers"] = headers;
        options["headers"]['Content-Length'] = Buffer.byteLength(data);
      }
      options["method"] =  'POST';
    } else {
      options["method"] =  'GET';
    }
    debug("Request: %s\n%s\n", JSON.stringify(options), data);
    let req =protocol.request(options, (res) => {
      debug(`STATUS: ${res.statusCode}`);
      debug(`HEADERS: ${JSON.stringify(res.headers)}`);
      //HTTPレスポンス 200,302以外はエラー
      if (res.statusCode != 200 && res.statusCode != 302  ) {
        let error = new Error('Request Failed.\n' +`Status Code: ${res.statusCode}`);
        debug("ERR POST ANS: %s", error.message);
        res.resume(); // .requestでもいるの?
        response(null, error);
        return;
      }
      let rawData = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => rawData += chunk);
      res.on('end', () => {
        debug("BODY\n%s", rawData);
        response(res, rawData);
      });
      // 'end'待ち
      debug("Wait BODY");
    });
    req.on('error', (error) => { //POST ANS
      debug(error.message);
      response(null, error);
    });
    // write data to request body
    if ( data != null ){
      req.write(data); //POST ANS
    }
    req.end();
  }


  startStdio(wsHostUrl, remoteAddr, optionalHeaders, cb) {
    this.wsHostUrl = wsHostUrl;
    const bind = s => {
      process.stdin.pipe(s);
      s.pipe(process.stdout);
      s.on('close', () => process.exit(0));
      return s.on('finish', () => process.exit(0));
    };

    if (this.httpOnly) {
      return this._httpConnect(this.wsHostUrl, remoteAddr, optionalHeaders, (err, httpConn) => {
        if (!err) { bind(httpConn); }
        return cb(err);
      });
    } else {
      return this._wsConnect(this.wsHostUrl, remoteAddr, optionalHeaders, (error, wsStream) => {
        if (!error) {
          bind(wsStream);
          return cb();
        } else {
          this.emit('connectFailed', error);
          return this._httpConnect(this.wsHostUrl, remoteAddr, optionalHeaders, (err, httpConn) => {
            if (!err) { bind(httpConn); }
            return cb(err);
          });
        }
      });
    }
  }

  _httpConnect(url, remoteAddr, optionalHeaders, cb) {
    let tunurl = url.replace(/^ws/, 'http');
    if (remoteAddr) { tunurl += `?dst=${remoteAddr}`; }
    const httpConn = new ClientConn(tunurl);
    return httpConn.connect(optionalHeaders, err => {
      if (err) {
        this.emit('connectHttpFailed', err);
        return cb(err);
      } else {
        return cb(null, httpConn);
      }
    });
  }

  _wsConnect(wsHostUrl, remoteAddr, optionalHeaders, cb) {
    let wsurl;
    if (remoteAddr) { wsurl = `${wsHostUrl}/?dst=${remoteAddr}`; } else { wsurl = `${wsHostUrl}`; }
    const wsClient = createWsClient();
    const urlo = url.parse(wsurl);
    if (urlo.auth) {
      optionalHeaders.Authorization = `Basic ${(new Buffer(urlo.auth)).toString('base64')}`;
    }
    wsClient.connect(wsurl, 'tunnel-protocol', undefined, optionalHeaders
                     , { agent: null } );
    wsClient.on('connectFailed', error => cb(error));
    return wsClient.on('connect', wsConn => {
      const wsStream = new WsStream(wsConn);
      return cb(null, wsStream);
    });
  }
});
