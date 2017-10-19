# CAPTCHA認証付きのproxyサーバ対応

proxyの認証として、HTTPプロトコルのBASIC認証やDigest認証ではなく
画像中の文字の入力を求めるCAPTCHAを利用して認証を行うproxyサーバにも対応。

# しくみ

proxyで中継するにあたり、HTTPレス不ポンス302 Foundを受けてCAPTCHA
ページに移動した場合、
[Google Vision API](https://cloud.google.com/vision/)により、
画像のテキストを抽出して、自動的に入力することによりCAPTCHA認証を
パスする。

親戚: Chrome拡張
「[AutoCAPTCHA](https://chrome.google.com/webstore/detail/autocaptcha/npgklhnojgnokoapbmkcafdodkkklgmd)」
同様なしくみにより、Chromeブラウザ上で認識と自動入力を実現しています。

## 制限事項

Google Vision APIを利用しているため以下のような制限が有ります。

* Google Vision APIはCAPTCHA無しでアクセスできる必要がある。
* Google Vision APIに登録してAPI Keyを取得する必要がある。
  参照: [Cloud API サービスに対する認証 - APIキーの設定](https://cloud.google.com/vision/docs/common/auth?hl=ja#set_up_an_api_key)

# 使い方

## インストール

```shell
$ git clone https://github.com/takuya-o/wstunnel.github
$ cd wstunnel
$ npm install -g
```

## 実行方法

### サーバ側

WebSocketを8022ポートで受けて、SSHの22ポートに転送する例

```shell
$ wstunnel -s 0.0.0.0:8022 -t example.com:22
```

#### サーバ側 Docker版

```shell
$ SERVER=example.com docker run --name=wstunnel -p 8022 -p 8080 -restart always takuya-o/wstunnel:latest
```

このDockerイメージの転送先
* 8022ポートで受けたWebSocketをSERVER:22へ転送 = sshdを想定
* 8080ポートで受けたWebSocketをSERVER:3128へ転送 = squidを想定


### クライアント側

```shell
$ APIKEY=GoogleVisionAPIkey wstunnel -c 8022 --proxy http://proxy.example.com:8080/ wss://example.com:8022/
```

#### 接続例

```shell
$ ssh user@localhost -p 8022
```
